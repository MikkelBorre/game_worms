import type { SimWorld } from '../sim/world';
import type { Vec3 } from '../core/math';
import { WORLD_MIN, WORLD_SIZE, type ChunkMeshData, type HeightmapData, type TerrainStats } from './types';

export * from './types';

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
  stats(): TerrainStats;
  dispose(): void;
}

export interface TerrainOptions {
  seed: number;
  sim: SimWorld;
}

/**
 * M0 STUB – replaced by the terrain-engineer in M1.
 * Produces no meshes and an analytic dome heightmap so the rest of the app can run.
 */
export function createTerrain(opts: TerrainOptions): TerrainSystem {
  const stats: TerrainStats = {
    chunkCount: 0,
    nonEmptyChunks: 0,
    triangles: 0,
    generateMs: 0,
    fullBuildMs: 0,
    lastRebuildMs: 0,
  };
  return {
    seed: opts.seed,
    generate: async () => {},
    onChunkMesh: () => () => {},
    heightmap(resolution) {
      const heights = new Float32Array(resolution * resolution);
      for (let z = 0; z < resolution; z++)
        for (let x = 0; x < resolution; x++) {
          const u = (x / (resolution - 1)) * 2 - 1;
          const v = (z / (resolution - 1)) * 2 - 1;
          heights[z * resolution + x] = 20 * (1 - Math.hypot(u, v) * 1.4);
        }
      return { resolution, minX: WORLD_MIN.x, minZ: WORLD_MIN.z, size: WORLD_SIZE.x, heights };
    },
    carveSphere: async () => {},
    stats: () => stats,
    dispose: () => {},
  };
}
