/**
 * Mesher backends. In the browser, chunks are meshed in a pool of Web Workers (the main thread never runs
 * marching cubes). In node (unit tests, benchmarks) there is no Worker global, so an inline backend calls
 * the pure mesher directly.
 */
import { meshChunk, type MeshInput } from './marchingCubes';
import type { MeshRequest, MeshResponse } from './mesher.worker';
import type { ChunkMeshData } from './types';

export interface MesherBackend {
  /** Mesh one chunk. The input buffers may be transferred (do not reuse them). */
  mesh(input: MeshInput): Promise<ChunkMeshData>;
  readonly kind: 'worker' | 'inline';
  readonly concurrency: number;
  /** Total time spent inside the mesher (worker-side for the worker backend), ms. */
  readonly busyMs: number;
  dispose(): void;
}

/** Rejection reason for jobs pending when a backend is disposed. */
export class MesherDisposedError extends Error {
  constructor() {
    super('mesher disposed');
    this.name = 'MesherDisposedError';
  }
}

export function defaultWorkerCount(): number {
  const hc = typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 2;
  return Math.min(Math.max(1, hc - 1), 4);
}

interface Pending {
  job: number;
  input: MeshInput;
  resolve: (m: ChunkMeshData) => void;
  reject: (e: unknown) => void;
}

export function createWorkerMesher(count = defaultWorkerCount()): MesherBackend {
  const workers: Worker[] = [];
  const idle: Worker[] = [];
  const inflight = new Map<number, Pending>();
  const queue: Pending[] = [];
  let nextJob = 1;
  let disposed = false;
  let busyMs = 0;

  const pump = () => {
    while (idle.length > 0 && queue.length > 0) {
      const w = idle.pop()!;
      const p = queue.shift()!;
      inflight.set(p.job, p);
      const req: MeshRequest = { job: p.job, input: p.input };
      w.postMessage(req, [p.input.density.buffer as ArrayBuffer, p.input.columnTops.buffer as ArrayBuffer]);
    }
  };

  for (let i = 0; i < count; i++) {
    const w = new Worker(new URL('./mesher.worker.ts', import.meta.url), { type: 'module', name: `mesher-${i}` });
    w.onmessage = (e: MessageEvent<MeshResponse>) => {
      const res = e.data;
      const p = inflight.get(res.job);
      inflight.delete(res.job);
      idle.push(w);
      if (p) {
        if ('error' in res) p.reject(new Error(`mesher worker: ${res.error}`));
        else {
          busyMs += res.ms;
          p.resolve(res.mesh);
        }
      }
      pump();
    };
    w.onerror = (e) => {
      // A worker-level failure (e.g. module load error): fail everything in flight on this worker.
      e.preventDefault();
      for (const [job, p] of inflight) {
        inflight.delete(job);
        p.reject(new Error(`mesher worker error: ${e.message}`));
      }
    };
    workers.push(w);
    idle.push(w);
  }

  return {
    kind: 'worker',
    concurrency: count,
    get busyMs() {
      return busyMs;
    },
    mesh(input) {
      if (disposed) return Promise.reject(new MesherDisposedError());
      return new Promise<ChunkMeshData>((resolve, reject) => {
        queue.push({ job: nextJob++, input, resolve, reject });
        pump();
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const w of workers) w.terminate();
      const err = new MesherDisposedError();
      for (const p of inflight.values()) p.reject(err);
      for (const p of queue) p.reject(err);
      inflight.clear();
      queue.length = 0;
    },
  };
}

/** Synchronous mesher behind a Promise. Only for node (tests/bench) or environments without Worker. */
export function createInlineMesher(): MesherBackend {
  let disposed = false;
  let busyMs = 0;
  return {
    kind: 'inline',
    concurrency: 1,
    get busyMs() {
      return busyMs;
    },
    mesh(input) {
      if (disposed) return Promise.reject(new MesherDisposedError());
      const t0 = performance.now();
      const m = meshChunk(input);
      busyMs += performance.now() - t0;
      return Promise.resolve(m);
    },
    dispose() {
      disposed = true;
    },
  };
}

/** Workers when available (browser), inline otherwise (node). */
export function createDefaultMesher(): MesherBackend {
  return typeof Worker !== 'undefined' ? createWorkerMesher() : createInlineMesher();
}
