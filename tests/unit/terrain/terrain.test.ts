import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initPhysics, RAPIER } from '../../../src/sim/physics';
import { SimWorld } from '../../../src/sim/world';
import { createTerrain, type TerrainSystem } from '../../../src/terrain';
import { createInlineMesher } from '../../../src/terrain/mesherPool';
import { WATER_LEVEL, type ChunkMeshData } from '../../../src/terrain/types';

function rayDown(sim: SimWorld, x: number, z: number): number | null {
  sim.physics.step(); // refresh the query structures after collider changes
  const hit = sim.physics.castRay(new RAPIER.Ray({ x, y: 60, z }, { x: 0, y: -1, z: 0 }), 200, true);
  return hit ? 60 - hit.timeOfImpact : null;
}

describe('TerrainSystem (inline mesher, Rapier colliders)', () => {
  let sim: SimWorld;
  let terrain: TerrainSystem;
  const received = new Map<string, ChunkMeshData>();

  beforeAll(async () => {
    await initPhysics();
    sim = new SimWorld({ seed: 1234 });
    terrain = createTerrain({ seed: 1234, sim, mesher: createInlineMesher() });
    terrain.onChunkMesh((m) => received.set(m.id, m));
    await terrain.generate();
  });

  afterAll(() => {
    terrain.dispose();
    sim.dispose();
  });

  it('generates, meshes and reports stats', () => {
    const s = terrain.stats();
    expect(s.chunkCount).toBe(300);
    expect(s.nonEmptyChunks).toBeGreaterThan(30);
    expect(s.triangles).toBeGreaterThan(50_000);
    expect(s.generateMs).toBeGreaterThan(0);
    expect(s.fullBuildMs).toBeGreaterThanOrEqual(s.generateMs);
    expect(s.densityBytes).toBeGreaterThan(0);
    expect(received.size).toBe(s.nonEmptyChunks);
    let tris = 0;
    for (const m of received.values()) tris += m.triangleCount;
    expect(tris).toBe(s.triangles);
    expect(terrain.info()?.village).toBeDefined();
  });

  it('a ray cast down at the island centre hits the terrain surface', () => {
    const y = rayDown(sim, 0.3, 0.2);
    expect(y).not.toBeNull();
    expect(y!).toBeGreaterThan(WATER_LEVEL);
    expect(Math.abs(y! - terrain.heightAt(0.3, 0.2))).toBeLessThan(0.6);
  });

  it('a ray over open ocean finds no collider (deep sea floor is culled)', () => {
    expect(rayDown(sim, 76, 76)).toBeNull();
  });

  it('carveSphere rebuilds only affected chunks, colliders and heightmap', async () => {
    const x = 12.3;
    const z = -8.1;
    const before = terrain.heightAt(x, z);
    const hitBefore = rayDown(sim, x, z)!;
    expect(Math.abs(hitBefore - before)).toBeLessThan(0.6);
    received.clear();
    await terrain.carveSphere([x, before, z], 3);
    const s = terrain.stats();
    expect(s.lastRebuildMs).toBeGreaterThan(0);
    expect(received.size).toBeGreaterThan(0);
    expect(received.size).toBeLessThanOrEqual(8);
    const after = terrain.heightAt(x, z);
    expect(after).toBeLessThan(before - 2.5);
    const hitAfter = rayDown(sim, x, z)!;
    expect(hitAfter).toBeLessThan(hitBefore - 2.5);
    expect(Math.abs(hitAfter - after)).toBeLessThan(0.6);
    const hm = terrain.heightmap(161); // 1 m spacing -> sample exactly at integer metres
    expect(hm.heights.length).toBe(161 * 161);
    expect(terrain.densityAt([x, before - 1, z])).toBeLessThan(0);
  });

  it('addSphere adds terrain back', async () => {
    await terrain.addSphere([-20, 30, 10], 2);
    expect(terrain.heightAt(-20, 10)).toBeGreaterThan(31.5);
    const y = rayDown(sim, -20, 10)!;
    expect(y).toBeGreaterThan(31.5);
  });

  it('dispose removes all terrain colliders', async () => {
    const sim2 = new SimWorld({ seed: 5 });
    const t2 = createTerrain({ seed: 5, sim: sim2, mesher: createInlineMesher() });
    await t2.generate();
    expect(sim2.physics.colliders.len()).toBeGreaterThan(10);
    t2.dispose();
    expect(sim2.physics.colliders.len()).toBe(0);
    sim2.dispose();
  });
});
