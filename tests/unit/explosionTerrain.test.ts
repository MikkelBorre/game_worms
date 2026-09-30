/**
 * Weapons & explosions on the real generated island (seed 1234, inline mesher, Rapier trimesh colliders).
 * Every sim here has the TerrainSystem attached as its TerrainEditor, so explosions really carve; the tests await
 * pending edits between steps exactly like the game loop gates on sim.canStep().
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Command } from '../../src/core/commands';
import type { Vec3 } from '../../src/core/math';
import { explode } from '../../src/sim/explosion';
import { initPhysics } from '../../src/sim/physics';
import { spawnTeams } from '../../src/sim/spawn';
import { SimWorld, type ExplosionResult } from '../../src/sim/world';
import { WORM_CENTER_TO_FEET, WORM_MAX_HP } from '../../src/sim/worm';
import { CHUNK_WORLD, createTerrain, WORLD_MIN, type TerrainSystem } from '../../src/terrain';
import { createInlineMesher } from '../../src/terrain/mesherPool';

const SEED = 1234;
const FEET = WORM_CENTER_TO_FEET;

beforeAll(async () => {
  await initPhysics();
});

interface World {
  sim: SimWorld;
  terrain: TerrainSystem;
  mesher: ReturnType<typeof createInlineMesher>;
  explosions: ExplosionResult[];
  /** Step once, first waiting for pending terrain edits (the game loop's canStep() gate). */
  step(cmds?: Command[]): Promise<void>;
  run(n: number, cmds?: Command[]): Promise<void>;
  spawn(pos: Vec3, team?: number): Promise<number>;
  dispose(): void;
}

async function world(): Promise<World> {
  const sim = new SimWorld({ seed: SEED, wind: [0, 0] });
  const mesher = createInlineMesher();
  const terrain = createTerrain({ seed: SEED, sim, mesher });
  await terrain.generate();
  sim.setTerrainEditor(terrain);
  const explosions: ExplosionResult[] = [];
  sim.events.on('explosion', (e) => explosions.push(e));
  const step = async (cmds: Command[] = []) => {
    if (!sim.canStep()) await sim.whenTerrainIdle();
    sim.step(cmds);
  };
  return {
    sim,
    terrain,
    mesher,
    explosions,
    step,
    async run(n, cmds = []) {
      for (let i = 0; i < n; i++) await step(i === 0 ? cmds : []);
    },
    async spawn(pos, team = 0) {
      await step([{ type: 'spawnWorm', team, pos }]);
      return sim.worms[sim.worms.length - 1]!.id;
    },
    dispose() {
      terrain.dispose();
      sim.dispose();
    },
  };
}

let current: World | null = null;
afterEach(() => {
  current?.dispose();
  current = null;
});

/** A chunk corner (XZ) on dry, fairly flat land. */
function findChunkCorner(t: TerrainSystem): { x: number; z: number; h: number } {
  const v = t.info()!.village;
  const corners: { x: number; z: number; h: number; d: number }[] = [];
  for (let i = 1; i < 10; i++)
    for (let j = 1; j < 10; j++) {
      const x = WORLD_MIN.x + i * CHUNK_WORLD;
      const z = WORLD_MIN.z + j * CHUNK_WORLD;
      const h = t.heightAt(x, z);
      if (h < 2.5) continue;
      const flat = [-2, 2].every(
        (d) => Math.abs(t.heightAt(x + d, z) - h) < 0.8 && Math.abs(t.heightAt(x, z + d) - h) < 0.8,
      );
      if (flat) corners.push({ x, z, h, d: Math.hypot(x - v.x, z - v.z) });
    }
  corners.sort((a, b) => a.d - b.d);
  expect(corners.length).toBeGreaterThan(0);
  return corners[0]!;
}

describe('explosions on real terrain (seed 1234)', () => {
  it('a blast at a chunk corner carves across chunks and resting worms fall into the crater', async () => {
    const w = (current = await world());
    const { x, z, h } = findChunkCorner(w.terrain);
    const a = await w.spawn([x + 0.3, h + FEET + 0.4, z + 0.3]);
    const b = await w.spawn([x - 1.2, w.terrain.heightAt(x - 1.2, z) + FEET + 0.4, z]);
    await w.run(60);
    const wa = w.sim.worms.find((s) => s.id === a)!;
    const wb = w.sim.worms.find((s) => s.id === b)!;
    expect(w.sim.worm(a)!.resting).toBe(true);
    expect(w.sim.worm(b)!.resting).toBe(true);
    const ya = wa.pos[1];
    const yb = wb.pos[1];

    // Damage-free blast (pure crater) so only the carve moves the worms.
    explode({ sim: w.sim }, [x, h, z], 3, 0);
    expect(w.sim.pendingTerrainEdits).toBe(1);
    expect(w.sim.canStep()).toBe(false);
    await w.sim.whenTerrainIdle();
    const stats = w.terrain.stats();
    console.log(
      `[crater] chunk corner (${x}, ${z}) h ${h.toFixed(2)}: ${stats.lastRebuildChunks} chunks, ` +
        `${stats.lastRebuildBlocks} collider blocks, height now ${w.terrain.heightAt(x, z).toFixed(2)}`,
    );
    expect(stats.lastRebuildChunks).toBeGreaterThanOrEqual(4); // corner ⇒ ≥ 4 chunks
    expect(w.terrain.heightAt(x, z)).toBeLessThan(h - 2);

    await w.run(120);
    for (const [s, y0] of [
      [wa, ya],
      [wb, yb],
    ] as const) {
      expect(s.alive).toBe(true);
      expect(s.hp).toBe(WORM_MAX_HP);
      expect(s.pos[1]).toBeLessThan(y0 - 1);
      expect(s.grounded).toBe(true);
      expect(w.terrain.densityAt(s.pos)).toBeLessThan(0.15); // not inside rock
    }
    expect(wa.pos[1] - FEET).toBeLessThan(h - 2);
  }, 60_000);

  it('bazooka into the ground at a worm on the island: crater, damage, knockback, landing', async () => {
    const w = (current = await world());
    const { x, z, h } = findChunkCorner(w.terrain);
    const victim = await w.spawn([x + 0.5, h + FEET + 0.4, z]);
    // Shooter 7 m away with a clear, flat line of fire, aiming at the ground under the victim.
    let sx = NaN;
    let sz = NaN;
    for (let k = 0; k < 16 && Number.isNaN(sx); k++) {
      const a = (k * Math.PI) / 8;
      const [dx, dz] = [Math.sin(a), Math.cos(a)];
      let clear = true;
      for (let d = 0.5; d <= 7; d += 0.5)
        if (Math.abs(w.terrain.heightAt(x + dx * d, z + dz * d) - h) > 0.6) clear = false;
      if (clear) [sx, sz] = [x + dx * 7, z + dz * 7];
    }
    expect(Number.isNaN(sx)).toBe(false);
    const shooter = await w.spawn([sx, w.terrain.heightAt(sx, sz) + FEET + 0.4, sz], 1);
    await w.run(60);
    const s = w.sim.worms.find((q) => q.id === shooter)!;
    const target: Vec3 = [x, h + 0.1, z];
    const dir: Vec3 = [target[0] - s.pos[0], target[1] - s.pos[1] - 0.1, target[2] - s.pos[2]];
    await w.step([{ type: 'fire', wormId: shooter, weapon: 'bazooka', dir, power: 1 }]);
    for (let i = 0; i < 60 && w.explosions.length === 0; i++) await w.step();
    expect(w.explosions).toHaveLength(1);
    const ex = w.explosions[0]!;
    expect(Math.hypot(ex.pos[0] - x, ex.pos[2] - z)).toBeLessThan(1.5);
    const hit = ex.hits.find((q) => q.id === victim);
    expect(hit).toBeDefined();
    expect(hit!.damage).toBeGreaterThan(25);
    await w.run(240);
    const v = w.sim.worms.find((q) => q.id === victim)!;
    expect(v.hp).toBe(WORM_MAX_HP - hit!.damage);
    expect(w.terrain.heightAt(ex.pos[0], ex.pos[2])).toBeLessThan(ex.pos[1] - 1.5);
    if (v.alive) {
      expect(v.grounded).toBe(true);
      expect(w.terrain.densityAt(v.pos)).toBeLessThan(0.15);
    }
    console.log(
      `[island bazooka] ${hit!.damage} dmg, victim moved ${Math.hypot(v.pos[0] - x - 0.5, v.pos[2] - z).toFixed(2)} m, ` +
        `alive ${v.alive}`,
    );
  }, 60_000);
});

describe('determinism & perf with real carves', () => {
  /** Same seed + fire log ⇒ identical hashes, twice, with real terrain carves (incl. two blasts on one tick). */
  async function match() {
    const w = await world();
    const list = spawnTeams({
      seed: SEED,
      teams: 2,
      wormsPerTeam: 2,
      heightAt: (x, z) => w.terrain.heightAt(x, z),
      waterLevel: w.sim.waterLevel,
    });
    await w.step([
      ...list.map((s) => ({ type: 'spawnWorm' as const, team: s.team, pos: s.pos })),
      { type: 'setWind', wind: [3, -2] },
    ]);
    await w.run(60);
    const ids = w.sim.worms.map((s) => s.id);
    const pos = (id: number) => w.sim.worms.find((s) => s.id === id)!.pos;
    const toward = (from: number, to: number, up: number): Vec3 => {
      const a = pos(from);
      const b = pos(to);
      const d = Math.hypot(b[0] - a[0], b[2] - a[2]);
      return [b[0] - a[0], d * up, b[2] - a[2]];
    };
    // Point-blank shot at the ground next to a worm.
    const atFeet = (dx: number, dz: number): Vec3 => [dx, -1, dz];
    const log = new Map<number, () => Command[]>([
      [
        10,
        () => [
          {
            type: 'fire',
            wormId: ids[0]!,
            weapon: 'bazooka',
            dir: toward(ids[0]!, ids[1]!, 0.25),
            power: 0.8,
          },
        ],
      ],
      [
        150,
        () => [
          {
            type: 'fire',
            wormId: ids[1]!,
            weapon: 'grenade',
            dir: toward(ids[1]!, ids[2]!, 0.8),
            power: 0.4,
            timer: 2,
          },
        ],
      ],
      [300, () => [{ type: 'fire', wormId: ids[2]!, weapon: 'bazooka', dir: atFeet(1, 0.3), power: 0.5 }]],
      [
        450,
        () => [
          // Two grenades with the same fuse ⇒ two explosions (and two carves) on the same tick.
          { type: 'fire', wormId: ids[3]!, weapon: 'grenade', dir: [0.3, 1, 0], power: 0.2, timer: 2 },
          { type: 'fire', wormId: ids[0]!, weapon: 'grenade', dir: [-0.3, 1, 0.2], power: 0.2, timer: 2 },
        ],
      ],
      [600, () => [{ type: 'fire', wormId: ids[3]!, weapon: 'bazooka', dir: [0, 1, 0], power: 0.4 }]],
    ]);
    const hashes: number[] = [];
    let maxPending = 0;
    const explosionStepMs: number[] = [];
    const meshMs: number[] = [];
    for (let t = 1; t <= 900; t++) {
      const cmds = log.get(t)?.() ?? [];
      if (!w.sim.canStep()) await w.sim.whenTerrainIdle();
      const before = w.explosions.length;
      const mesh0 = w.mesher.busyMs;
      const t0 = performance.now();
      w.sim.step(cmds);
      const ms = performance.now() - t0;
      maxPending = Math.max(maxPending, w.sim.pendingTerrainEdits);
      if (w.explosions.length > before) {
        explosionStepMs.push(ms);
        meshMs.push(w.mesher.busyMs - mesh0);
      }
      if (t % 60 === 0) hashes.push(w.sim.hash());
    }
    await w.sim.whenTerrainIdle();
    const out = {
      hashes,
      snap: w.sim.snapshot(),
      explosions: w.explosions.map((e) => ({ tick: e.tick, pos: e.pos, hits: e.hits })),
      craterHeights: w.explosions.map((e) => w.terrain.heightAt(e.pos[0], e.pos[2])),
      maxPending,
      explosionStepMs,
      meshMs,
      stats: w.terrain.stats(),
    };
    w.dispose();
    return out;
  }

  it('same seed + fire log ⇒ identical hash every 60 ticks, twice (real carves)', async () => {
    const a = await match();
    const b = await match();
    console.log(
      `[determinism] ${a.explosions.length} explosions at ticks ${a.explosions.map((e) => e.tick).join(',')}, ` +
        `max pending carves ${a.maxPending}, hits ${a.explosions.map((e) => e.hits.map((q) => `${q.id}:${q.damage}`).join('/')).join(' ')}`,
    );
    expect(a.explosions.length).toBeGreaterThanOrEqual(5);
    expect(a.maxPending).toBeGreaterThanOrEqual(2); // two carves queued on one tick
    const ticks = a.explosions.map((e) => e.tick);
    expect(ticks.some((t, i) => ticks.indexOf(t) !== i)).toBe(true);
    expect(a.explosions.some((e) => e.hits.length > 0)).toBe(true);
    expect(b.hashes).toEqual(a.hashes);
    expect(b.snap).toEqual(a.snap);
    expect(b.explosions).toEqual(a.explosions);
    expect(b.craterHeights).toEqual(a.craterHeights);
    expect(new Set(a.hashes).size).toBeGreaterThan(10);

    // Timing of the match's explosion ticks is only reported here (5 samples, cold JIT); the budget is asserted in
    // the dedicated perf test below.
    const mainMs = a.explosionStepMs.map((ms, i) => ms - a.meshMs[i]!);
    console.log(
      `[perf] match explosion ticks: main thread ≈ ${mainMs.map((m) => m.toFixed(2)).join(', ')} ms ` +
        `(inline meshing excluded: ${a.meshMs.map((m) => m.toFixed(2)).join(', ')} ms)`,
    );
  }, 120_000);

  it('explosion main-thread cost (blast + density edit + collider rebuild) < 16 ms', async () => {
    const w = (current = await world());
    const { x, z, h } = findChunkCorner(w.terrain);
    const worm = await w.spawn([x + 1, h + FEET + 0.4, z + 1]);
    await w.run(30);
    // 1 warm-up blast + 8 measured ones in a ring around a chunk corner (multi-chunk carves).
    const samples: { blast: number; colliders: number; emit: number; chunks: number }[] = [];
    for (let i = 0; i <= 8; i++) {
      const a = (i * Math.PI) / 4;
      const px = x + Math.sin(a) * 2.5;
      const pz = z + Math.cos(a) * 2.5;
      const pos: Vec3 = [px, w.terrain.heightAt(px, pz), pz];
      const mesh0 = w.mesher.busyMs;
      const t0 = performance.now();
      explode({ sim: w.sim }, pos, 3, 50, { weapon: 'bazooka' });
      // Main-thread part of the blast: damage, density edit, worker input extraction. In node the mesher runs
      // inline inside this call; in the browser that is worker time, so it is subtracted.
      const blast = performance.now() - t0 - (w.mesher.busyMs - mesh0);
      await w.sim.whenTerrainIdle();
      const st = w.terrain.stats();
      if (i > 0)
        samples.push({
          blast,
          colliders: st.lastColliderMs,
          emit: st.lastEmitMs,
          chunks: st.lastRebuildChunks,
        });
      await w.run(2);
    }
    const totals = samples.map((q) => q.blast + q.colliders + q.emit).sort((p, q) => p - q);
    const median = totals[Math.floor(totals.length / 2)]!;
    console.log(
      `[perf] explosion main thread (blast + colliders + emit), 8 blasts: median ${median.toFixed(2)} ms, ` +
        `max ${totals[totals.length - 1]!.toFixed(2)} ms; per blast ` +
        samples
          .map((q) => `${q.blast.toFixed(1)}+${q.colliders.toFixed(1)}+${q.emit.toFixed(1)} (${q.chunks}ch)`)
          .join(', '),
    );
    // Median: other test files run in parallel and CPU contention spikes single samples.
    expect(median).toBeLessThan(16);
    expect(w.explosions.some((e) => e.hits.some((q) => q.id === worm))).toBe(true); // blasts really hit the worm
  }, 60_000);

  it('sim step with 4 projectiles in flight on the island < 3 ms', async () => {
    const w = (current = await world());
    const list = spawnTeams({
      seed: SEED,
      teams: 2,
      wormsPerTeam: 2,
      heightAt: (x, z) => w.terrain.heightAt(x, z),
      waterLevel: w.sim.waterLevel,
    });
    await w.step(list.map((s) => ({ type: 'spawnWorm' as const, team: s.team, pos: s.pos })));
    await w.run(90);
    const ids = w.sim.worms.map((s) => s.id);
    await w.step([
      { type: 'fire', wormId: ids[0]!, weapon: 'bazooka', dir: [0.3, 1, 0.1], power: 1 },
      { type: 'fire', wormId: ids[1]!, weapon: 'bazooka', dir: [-0.2, 1, 0.3], power: 1 },
      { type: 'fire', wormId: ids[2]!, weapon: 'grenade', dir: [1, 0.5, 0], power: 0.5, timer: 5 },
      { type: 'fire', wormId: ids[3]!, weapon: 'grenade', dir: [0, 0.5, 1], power: 0.5, timer: 5 },
    ]);
    const times: number[] = [];
    let flying = 0;
    for (let i = 0; i < 240; i++) {
      if (!w.sim.canStep()) await w.sim.whenTerrainIdle();
      if (w.sim.projectiles.length === 4) flying++;
      const t0 = performance.now();
      w.sim.step([]);
      times.push(performance.now() - t0);
    }
    const avg = times.reduce((s, v) => s + v, 0) / times.length;
    const sorted = [...times].sort((x, y) => x - y);
    const p95 = sorted[Math.floor(times.length * 0.95)]!;
    const median = sorted[Math.floor(times.length / 2)]!;
    console.log(
      `[perf] 4 projectiles + 4 worms on the island: avg ${avg.toFixed(3)} ms/tick, median ${median.toFixed(3)}, p95 ${p95.toFixed(3)} ms`,
    );
    expect(flying).toBeGreaterThan(200);
    // Median, not mean: other test files run in parallel and CPU contention spikes single ticks.
    expect(median).toBeLessThan(3);
  }, 60_000);
});
