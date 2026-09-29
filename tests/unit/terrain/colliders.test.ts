import { beforeAll, describe, expect, it } from 'vitest';
import { initPhysics, RAPIER } from '../../../src/sim/physics';
import { ChunkColliders } from '../../../src/terrain/colliders';
import { meshChunk } from '../../../src/terrain/marchingCubes';
import { VoxelField, sampleX, sampleY, sampleZ } from '../../../src/terrain/voxels';
import type { ChunkCoord } from '../../../src/terrain/types';

beforeAll(async () => {
  await initPhysics();
});

const mesh = (f: VoxelField, c: ChunkCoord) =>
  meshChunk({ coord: c, density: f.extractPadded(c), columnTops: f.extractColumnTops(c), cullBelow: null });

describe('ChunkColliders', () => {
  it('sub-blocks cover every triangle; identical meshes rebuild nothing; edits rebuild only touched blocks', () => {
    const f = new VoxelField();
    const c = { cx: 3, cy: 1, cz: 3 };
    // A slab across the whole chunk.
    for (let x = 0; x <= 16; x += 2) for (let z = 0; z <= 16; z += 2) f.addSphere([sampleX(96) + x, sampleY(40), sampleZ(96) + z], 1.6);
    const m = mesh(f, c);
    expect(m.triangleCount).toBeGreaterThan(500);
    const blockTris = (m.colliderBlocks ?? []).reduce((s, b) => s + b.indices.length / 3, 0);
    expect(blockTris).toBe(m.triangleCount);
    expect(m.colliderBlocks!.length).toBeGreaterThan(4);

    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    const cols = new ChunkColliders(world);
    const first = cols.set(m);
    expect(first).toBe(m.colliderBlocks!.length);
    expect(world.colliders.len()).toBe(first);
    expect(cols.set(mesh(f, c))).toBe(0);

    // Small carve in one corner of the slab: only the sub-blocks around it change.
    f.carveSphere([sampleX(96) + 1, sampleY(40), sampleZ(96) + 1], 1);
    const rebuilt = cols.set(mesh(f, c));
    expect(rebuilt).toBeGreaterThan(0);
    expect(rebuilt).toBeLessThan(first / 2);

    // Empty mesh removes everything.
    f.carveSphere([sampleX(96) + 8, sampleY(40), sampleZ(96) + 8], 20);
    cols.set(mesh(f, c));
    expect(world.colliders.len()).toBe(0);
    expect(cols.size).toBe(0);
    world.free();
  });
});
