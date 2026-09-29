/**
 * Terrain contract shared by terrain/ (producer) and render/ (consumer).
 * Plain data only – no three.js here.
 */

/** Edge length of one voxel in metres. */
export const VOXEL_SIZE = 0.5;
/** Cells per chunk edge (a chunk is CHUNK_SIZE³ cells). */
export const CHUNK_SIZE = 32;
/** Chunk edge length in metres. */
export const CHUNK_WORLD = CHUNK_SIZE * VOXEL_SIZE;

export const CHUNKS_X = 10;
export const CHUNKS_Y = 3;
export const CHUNKS_Z = 10;

/** World-space minimum corner of the voxel volume (metres). The island is centred on x = z = 0. */
export const WORLD_MIN = { x: -80, y: -8, z: -80 } as const;
/** World-space size of the voxel volume (metres). */
export const WORLD_SIZE = {
  x: CHUNKS_X * CHUNK_WORLD,
  y: CHUNKS_Y * CHUNK_WORLD,
  z: CHUNKS_Z * CHUNK_WORLD,
} as const;

/** Sea level (metres). Anything below is water; touching it kills worms. */
export const WATER_LEVEL = 0;

export interface ChunkCoord {
  cx: number;
  cy: number;
  cz: number;
}

export const chunkId = (c: ChunkCoord): string => `${c.cx},${c.cy},${c.cz}`;

/**
 * Output of the mesher for one chunk. Positions are in WORLD space (metres).
 * An empty chunk has triangleCount 0 and zero-length arrays.
 */
export interface ChunkMeshData {
  id: string;
  coord: ChunkCoord;
  /** xyz per vertex. */
  positions: Float32Array;
  /** xyz per vertex, normalised. */
  normals: Float32Array;
  /** rgb per vertex in [0,1] (linear), picked by height/slope: sand, grass, rock. */
  colors: Float32Array;
  /** Triangle indices, or null for non-indexed triangle soup. */
  indices: Uint32Array | null;
  triangleCount: number;
  /**
   * Terrain-internal: collision geometry split into sub-blocks of the chunk so an edit only rebuilds the
   * physics colliders of the sub-blocks that actually changed. Renderers ignore this.
   */
  colliderBlocks?: ColliderBlock[];
}

/** Compact collision triangles of one sub-block of a chunk (world-space positions). */
export interface ColliderBlock {
  /** Sub-block index within the chunk (bx + n * (by + n * bz)). */
  index: number;
  positions: Float32Array;
  indices: Uint32Array;
}

/**
 * Top-down heightmap of the terrain surface, used by water shoreline foam, the minimap and spawning.
 * heights[z * resolution + x] = highest solid surface y (metres) at that column, or WORLD_MIN.y if none.
 * Sample (0,0) is at (minX, minZ); sample (res-1,res-1) is at (minX+size, minZ+size).
 */
export interface HeightmapData {
  resolution: number;
  minX: number;
  minZ: number;
  size: number;
  heights: Float32Array;
}

export interface TerrainStats {
  chunkCount: number;
  nonEmptyChunks: number;
  triangles: number;
  /** Wall time to generate the density field (ms). */
  generateMs: number;
  /** Wall time from generate() start until all chunks are meshed and collidable (ms). */
  fullBuildMs: number;
  /** Main-thread time of the last carve rebuild (ms), or 0. */
  lastRebuildMs: number;
  /** Bytes held by the density field (quantised chunk arrays + column cache). */
  densityBytes: number;
  /** Breakdown of the last rebuild: density edit + worker input extraction (ms). */
  lastEditMs: number;
  /** Breakdown of the last rebuild: collider replacement (ms). */
  lastColliderMs: number;
  /** Breakdown of the last rebuild: onChunkMesh listeners, i.e. the render upload prep (ms). */
  lastEmitMs: number;
  /** Chunks re-meshed / collider sub-blocks rebuilt by the last edit. */
  lastRebuildChunks: number;
  lastRebuildBlocks: number;
}
