/// <reference lib="webworker" />
/**
 * Mesher worker: thin wrapper around the pure marching-cubes function. Input buffers arrive transferred;
 * output buffers are transferred back.
 */
import { meshChunk, meshTransferables, type MeshInput } from './marchingCubes';

export interface MeshRequest {
  job: number;
  input: MeshInput;
}

export type MeshResponse =
  { job: number; mesh: import('./types').ChunkMeshData; ms: number } | { job: number; error: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = (e: MessageEvent<MeshRequest>) => {
  const { job, input } = e.data;
  try {
    const t0 = performance.now();
    const mesh = meshChunk(input);
    const res: MeshResponse = { job, mesh, ms: performance.now() - t0 };
    scope.postMessage(res, meshTransferables(mesh));
  } catch (err) {
    const res: MeshResponse = { job, error: err instanceof Error ? (err.stack ?? err.message) : String(err) };
    scope.postMessage(res);
  }
};
