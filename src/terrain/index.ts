import type { SimWorld } from '../sim/world';
import type { Vec3 } from '../core/math';
import { ChunkColliders } from './colliders';
import { generateIsland, type IslandInfo, type IslandParams } from './generate';
import { buildHeightmap, surfaceHeightAt } from './heightmap';
import { DEFAULT_CULL_BELOW } from './marchingCubes';
import { MesherDisposedError, createDefaultMesher, type MesherBackend } from './mesherPool';
import { chunkId, type ChunkCoord, type ChunkMeshData, type HeightmapData, type TerrainStats } from './types';
import { CHUNK_COUNT, VoxelField, chunkCoordOf, chunkIndex, type EditResult } from './voxels';

export * from './types';
export { DEFAULT_ISLAND, type IslandInfo, type IslandParams } from './generate';

export interface TerrainSystem {
  readonly seed: number;
  /** Generate the island, mesh every chunk (in workers) and build colliders. Resolves when complete. */
  generate(): Promise<void>;
  /** Called for each (re)meshed chunk. Returns an unsubscribe function. */
  onChunkMesh(cb: (mesh: ChunkMeshData) => void): () => void;
  /** Top-down heightmap of the current terrain. */
  heightmap(resolution: number): HeightmapData;
  /** Remove a sphere of terrain and rebuild affected chunks + colliders. */
  carveSphere(center: Vec3, radius: number): Promise<void>;
  /** Add a sphere of terrain (girders/structures later) and rebuild affected chunks + colliders. */
  addSphere(center: Vec3, radius: number): Promise<void>;
  /** Highest solid surface y (m) at world (x, z), WORLD_MIN.y if the column is empty. Reflects carves. */
  heightAt(x: number, z: number): number;
  /** Density (m, ≈ signed distance, > 0 = solid) at a world point, trilinear. */
  densityAt(p: Vec3): number;
  /** Island layout (village plateau, peaks), or null before generate(). */
  info(): IslandInfo | null;
  stats(): TerrainStats;
  dispose(): void;
}

export interface TerrainOptions {
  seed: number;
  /** Only `physics` is used (terrain colliders are added to it). */
  sim: Pick<SimWorld, 'physics'>;
  /** Mesher backend; defaults to a worker pool in browsers and inline meshing in node. */
  mesher?: MesherBackend;
  /** Island generation overrides. */
  island?: Partial<IslandParams>;
  /** Triangles entirely below this height are not meshed (opaque water). null keeps the sea floor. */
  cullBelow?: number | null;
}

const emptyMesh = (coord: ChunkCoord): ChunkMeshData => ({
  id: chunkId(coord),
  coord: { ...coord },
  positions: new Float32Array(0),
  normals: new Float32Array(0),
  colors: new Float32Array(0),
  indices: new Uint32Array(0),
  triangleCount: 0,
});

export function createTerrain(opts: TerrainOptions): TerrainSystem {
  const mesher = opts.mesher ?? createDefaultMesher();
  const colliders = new ChunkColliders(opts.sim.physics);
  const cullBelow = opts.cullBelow === undefined ? DEFAULT_CULL_BELOW : opts.cullBelow;
  const listeners = new Set<(m: ChunkMeshData) => void>();
  /** Latest job version per chunk; results from older jobs are dropped. */
  const version = new Uint32Array(CHUNK_COUNT);
  const triCount = new Uint32Array(CHUNK_COUNT);
  let field: VoxelField | null = null;
  let island: IslandInfo | null = null;
  let disposed = false;
  const stats: TerrainStats = {
    chunkCount: CHUNK_COUNT,
    nonEmptyChunks: 0,
    triangles: 0,
    generateMs: 0,
    fullBuildMs: 0,
    lastRebuildMs: 0,
    densityBytes: 0,
    lastEditMs: 0,
    lastColliderMs: 0,
    lastEmitMs: 0,
    lastRebuildChunks: 0,
    lastRebuildBlocks: 0,
  };

  const emit = (m: ChunkMeshData) => {
    for (const cb of listeners) cb(m);
  };

  const refreshCounts = () => {
    let tris = 0;
    let nonEmpty = 0;
    for (let i = 0; i < CHUNK_COUNT; i++) {
      tris += triCount[i]!;
      if (triCount[i]! > 0) nonEmpty++;
    }
    stats.triangles = tris;
    stats.nonEmptyChunks = nonEmpty;
    stats.densityBytes = field ? field.bytes() : 0;
  };

  /** Snapshot a chunk's mesher input and queue it; resolves to null if superseded or disposed. */
  const request = (f: VoxelField, c: ChunkCoord): Promise<ChunkMeshData | null> => {
    const ci = chunkIndex(c.cx, c.cy, c.cz);
    const v = ++version[ci]!;
    const job = f.isTriviallyEmpty(c)
      ? Promise.resolve(emptyMesh(c))
      : mesher.mesh({ coord: c, density: f.extractPadded(c), columnTops: f.extractColumnTops(c), cullBelow });
    return job.then(
      (m) => (disposed || version[ci] !== v ? null : m),
      (err: unknown) => {
        if (err instanceof MesherDisposedError || disposed) return null;
        throw err;
      },
    );
  };

  /** Apply finished meshes (sorted by chunk index for deterministic collider creation order). */
  const apply = (meshes: (ChunkMeshData | null)[]) => {
    const t0 = performance.now();
    let blocks = 0;
    for (const m of meshes) {
      if (!m) continue;
      blocks += colliders.set(m);
      triCount[chunkIndex(m.coord.cx, m.coord.cy, m.coord.cz)] = m.triangleCount;
    }
    const t1 = performance.now();
    for (const m of meshes) if (m) emit(m);
    stats.lastColliderMs = t1 - t0;
    stats.lastEmitMs = performance.now() - t1;
    stats.lastRebuildBlocks = blocks;
    refreshCounts();
  };

  const edit = async (res: EditResult, t0: number, f: VoxelField): Promise<void> => {
    if (res.dirty.length === 0) {
      stats.lastRebuildMs = stats.lastEditMs = performance.now() - t0;
      stats.lastColliderMs = stats.lastEmitMs = stats.lastRebuildChunks = stats.lastRebuildBlocks = 0;
      return;
    }
    const jobs = res.dirty.map((c) => request(f, c));
    let mainMs = performance.now() - t0;
    stats.lastEditMs = mainMs;
    stats.lastRebuildChunks = res.dirty.length;
    const meshes = await Promise.all(jobs);
    if (disposed) return;
    const t1 = performance.now();
    apply(meshes);
    mainMs += performance.now() - t1;
    stats.lastRebuildMs = mainMs;
  };

  return {
    seed: opts.seed,

    async generate() {
      const t0 = performance.now();
      const gen = generateIsland(opts.seed, opts.island);
      if (disposed) return;
      field = gen.field;
      island = gen.info;
      stats.generateMs = performance.now() - t0;
      const f = field;
      // Mesh everything; show meshes as they arrive but create colliders in chunk order once all are done,
      // so collider handles do not depend on worker timing.
      const jobs: Promise<ChunkMeshData | null>[] = [];
      for (let ci = 0; ci < CHUNK_COUNT; ci++) {
        triCount[ci] = 0;
        const c = chunkCoordOf(ci);
        if (f.isTriviallyEmpty(c)) continue;
        jobs.push(
          request(f, c).then((m) => {
            if (m && m.triangleCount > 0) emit(m);
            return m;
          }),
        );
      }
      const meshes = await Promise.all(jobs);
      if (disposed) return;
      for (const m of meshes) {
        if (!m) continue;
        colliders.set(m);
        triCount[chunkIndex(m.coord.cx, m.coord.cy, m.coord.cz)] = m.triangleCount;
      }
      refreshCounts();
      stats.fullBuildMs = performance.now() - t0;
    },

    onChunkMesh(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },

    heightmap(resolution) {
      if (!field) throw new Error('terrain.heightmap() before generate()');
      return buildHeightmap(field, resolution);
    },

    carveSphere(center, radius) {
      if (!field || disposed) return Promise.resolve();
      const t0 = performance.now();
      return edit(field.carveSphere(center, radius), t0, field);
    },

    addSphere(center, radius) {
      if (!field || disposed) return Promise.resolve();
      const t0 = performance.now();
      return edit(field.addSphere(center, radius), t0, field);
    },

    heightAt(x, z) {
      if (!field) throw new Error('terrain.heightAt() before generate()');
      return surfaceHeightAt(field, x, z);
    },

    densityAt(p) {
      if (!field) throw new Error('terrain.densityAt() before generate()');
      return field.densityAt(p[0], p[1], p[2]);
    },

    info: () => island,

    stats: () => ({ ...stats }),

    dispose() {
      if (disposed) return;
      disposed = true;
      mesher.dispose();
      colliders.dispose();
      listeners.clear();
      field = null;
    },
  };
}
