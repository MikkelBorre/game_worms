/**
 * Top-down heightmap sampled from the voxel field's per-column surface cache (kept current by carves).
 */
import { VOXEL_SIZE, WORLD_MIN, WORLD_SIZE, type HeightmapData } from './types';
import { SX, SZ, type VoxelField } from './voxels';

/** Bilinear surface height (highest solid, m) at world (x, z); WORLD_MIN.y where a column is all air. */
export function surfaceHeightAt(field: VoxelField, x: number, z: number): number {
  let fx = (x - WORLD_MIN.x) / VOXEL_SIZE;
  let fz = (z - WORLD_MIN.z) / VOXEL_SIZE;
  fx = fx < 0 ? 0 : fx > SX - 1 ? SX - 1 : fx;
  fz = fz < 0 ? 0 : fz > SZ - 1 ? SZ - 1 : fz;
  const i = Math.min(Math.floor(fx), SX - 2);
  const k = Math.min(Math.floor(fz), SZ - 2);
  const tx = fx - i;
  const tz = fz - k;
  const t = field.columnTop;
  const a = t[i + k * SX]!;
  const b = t[i + 1 + k * SX]!;
  const c = t[i + (k + 1) * SX]!;
  const d = t[i + 1 + (k + 1) * SX]!;
  return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
}

/** heights[z * res + x] at (minX + size * x / (res - 1), minZ + size * z / (res - 1)). */
export function buildHeightmap(field: VoxelField, resolution: number): HeightmapData {
  const res = Math.max(2, Math.floor(resolution));
  const size = WORLD_SIZE.x;
  const heights = new Float32Array(res * res);
  for (let z = 0; z < res; z++) {
    const wz = WORLD_MIN.z + (size * z) / (res - 1);
    for (let x = 0; x < res; x++)
      heights[z * res + x] = surfaceHeightAt(field, WORLD_MIN.x + (size * x) / (res - 1), wz);
  }
  return { resolution: res, minX: WORLD_MIN.x, minZ: WORLD_MIN.z, size, heights };
}
