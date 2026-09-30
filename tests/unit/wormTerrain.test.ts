/**
 * Worm controller + spawning on the real generated island (headless: inline mesher, Rapier trimesh colliders).
 *
 * Each island is generated once (beforeAll); tests get a fresh SimWorld with the same terrain colliders cloned
 * from the captured chunk meshes, so they do not disturb each other. The determinism test builds two complete,
 * independent SimWorld + TerrainSystem instances.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Command } from '../../src/core/commands';
import type { Vec2, Vec3 } from '../../src/core/math';
import { Rng } from '../../src/core/rng';
import { initPhysics } from '../../src/sim/physics';
import { findSpawnPointsDetailed, SPAWN_DROP, SPAWN_MIN_ABOVE_WATER, spawnTeams } from '../../src/sim/spawn';
import { SimWorld, type SimEvents } from '../../src/sim/world';
import { FALL_DAMAGE_MIN_DROP, fallDamage, WORM_CENTER_TO_FEET, WORM_MAX_HP } from '../../src/sim/worm';
import { createTerrain, type ChunkMeshData, type TerrainSystem } from '../../src/terrain';
import { ChunkColliders } from '../../src/terrain/colliders';
import { createInlineMesher } from '../../src/terrain/mesherPool';
import { chunkIndex } from '../../src/terrain/voxels';

const SEEDS = [1234, 1, 42] as const;
const FEET = WORM_CENTER_TO_FEET;

interface Island {
  seed: number;
  host: SimWorld;
  terrain: TerrainSystem;
  /** Chunk meshes from generate(), in chunk-index order (the order generate() creates colliders in). */
  meshes: ChunkMeshData[];
  heightAt: (x: number, z: number) => number;
}

async function buildIsland(seed: number): Promise<Island> {
  const host = new SimWorld({ seed });
  const terrain = createTerrain({ seed, sim: host, mesher: createInlineMesher() });
  const meshes: ChunkMeshData[] = [];
  const off = terrain.onChunkMesh((m) => meshes.push(m));
  await terrain.generate();
  off();
  const ci = (m: ChunkMeshData) => chunkIndex(m.coord.cx, m.coord.cy, m.coord.cz);
  meshes.sort((a, b) => ci(a) - ci(b));
  return { seed, host, terrain, meshes, heightAt: (x, z) => terrain.heightAt(x, z) };
}

/** A fresh sim with the island's terrain colliders and an event log. */
function world(isl: Island) {
  const sim = new SimWorld({ seed: isl.seed });
  const colliders = new ChunkColliders(sim.physics);
  for (const m of isl.meshes) colliders.set(m);
  sim.physics.step(); // make the new colliders visible to scene queries
  const log: { tick: number; type: keyof SimEvents; payload: unknown }[] = [];
  for (const type of ['wormLanded', 'wormDamaged', 'wormDied', 'wormJumped'] as const)
    sim.events.on(type, (payload) => log.push({ tick: sim.tick, type, payload }));
  const events = <K extends keyof SimEvents>(type: K) =>
    log.filter((e) => e.type === type).map((e) => e.payload as SimEvents[K]);
  const spawn = (pos: Vec3, team = 0) => {
    sim.step([{ type: 'spawnWorm', team, pos }]);
    return sim.worms[sim.worms.length - 1]!;
  };
  const run = (n: number, cmds: Command[] = [], each?: () => void) => {
    for (let i = 0; i < n; i++) {
      sim.step(i === 0 ? cmds : []);
      each?.();
    }
  };
  return { sim, events, spawn, run, dispose: () => sim.dispose() };
}

const dist2d = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[2] - b[2]);

function minPairDist(points: Vec3[]): number {
  let d = Infinity;
  for (let i = 0; i < points.length; i++)
    for (let j = i + 1; j < points.length; j++) d = Math.min(d, dist2d(points[i]!, points[j]!));
  return d;
}

/**
 * Terrain-penetration check for a worm. heightAt is the TOP surface of a column, so a worm in a cave or under
 * an overhang is legitimately below it; there its centre must be in open air (density < 0).
 */
function inRock(isl: Island, p: Vec3): boolean {
  return isl.terrain.densityAt(p) > 0.15;
}

const islands = new Map<number, Island>();
const island = (seed: number) => islands.get(seed)!;

beforeAll(async () => {
  await initPhysics();
  for (const seed of SEEDS) islands.set(seed, await buildIsland(seed));
}, 120_000);

afterAll(() => {
  for (const isl of islands.values()) {
    isl.terrain.dispose();
    isl.host.dispose();
  }
});

describe.each(SEEDS)('spawning on island %i', (seed) => {
  it('spawnTeams(4×4): dry land, spaced, deterministic', () => {
    const isl = island(seed);
    const opts = { seed, teams: 4, wormsPerTeam: 4, heightAt: isl.heightAt, waterLevel: isl.host.waterLevel };
    const list = spawnTeams(opts);
    expect(list).toHaveLength(16);
    expect(list.map((s) => s.team)).toEqual([0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3]);
    for (const { pos } of list) {
      const hgt = isl.heightAt(pos[0], pos[2]);
      expect(hgt).toBeGreaterThanOrEqual(isl.host.waterLevel + SPAWN_MIN_ABOVE_WATER);
      expect(pos[1]).toBeCloseTo(hgt + FEET + SPAWN_DROP, 6);
    }
    // No relaxation needed on the standard island: full default spacing.
    const detailed = findSpawnPointsDetailed({ ...opts, count: 16 });
    expect(detailed.spacing).toBe(14);
    expect(minPairDist(list.map((s) => s.pos))).toBeGreaterThanOrEqual(14);
    expect(spawnTeams(opts)).toEqual(list);
    expect(spawnTeams({ ...opts, seed: seed + 1 })).not.toEqual(list);
  });

  it('16 spawned worms settle on the terrain: grounded, alive, on the surface', () => {
    const isl = island(seed);
    const w = world(isl);
    const list = spawnTeams({ seed, teams: 4, wormsPerTeam: 4, heightAt: isl.heightAt, waterLevel: 0 });
    w.sim.step(list.map((s) => ({ type: 'spawnWorm' as const, team: s.team, pos: s.pos })));
    w.run(180);
    expect(w.sim.worms).toHaveLength(16);
    for (const worm of w.sim.worms) {
      expect(worm.alive).toBe(true);
      expect(worm.hp).toBe(WORM_MAX_HP);
      expect(worm.grounded).toBe(true);
      expect(worm.state).toBe('idle');
      // Landed on the column top: no fall-through at trimesh sub-block seams.
      const feet = worm.pos[1] - FEET;
      expect(Math.abs(feet - isl.heightAt(worm.pos[0], worm.pos[2]))).toBeLessThan(1);
      expect(inRock(isl, worm.pos)).toBe(false);
    }
    // Everyone is resting (not burning controller time) once settled.
    expect(w.sim.worms.every((s) => w.sim.worm(s.id)!.resting)).toBe(true);
    w.dispose();
  });
});

describe('walking on island 1234', () => {
  it('walks 10 s in 8 directions from the village without falling through the terrain', () => {
    const isl = island(1234);
    const v = isl.terrain.info()!.village;
    const w = world(isl);
    const dirs: Vec2[] = [];
    for (let d = 0; d < 8; d++) {
      const a = (d * Math.PI) / 4;
      dirs.push([Math.sin(a), Math.cos(a)]);
      const x = v.x + dirs[d]![0] * 2;
      const z = v.z + dirs[d]![1] * 2;
      w.spawn([x, isl.heightAt(x, z) + FEET + 0.6, z]);
    }
    w.run(60);
    const starts = w.sim.worms.map((s) => [...s.pos] as Vec3);
    const problems: string[] = [];
    let caveTicks = 0;
    w.run(
      600,
      w.sim.worms.map((s, i) => ({ type: 'move' as const, wormId: s.id, dir: dirs[i]! })),
      () => {
        for (const s of w.sim.worms) {
          if (!s.alive) continue;
          const at = `worm ${s.id} at ${s.pos.map((q) => q.toFixed(2)).join(',')}`;
          if (inRock(isl, s.pos)) problems.push(`${at}: inside rock`);
          if (!s.grounded) continue;
          const feet = s.pos[1] - FEET;
          if (isl.heightAt(s.pos[0], s.pos[2]) - feet <= 1) continue;
          // More than 1 m below the column top while grounded: only fine in a cave / under an overhang, i.e.
          // standing on real rock (solid within ~0.5 m below the feet), not having dropped through a seam.
          caveTicks++;
          if (isl.terrain.densityAt([s.pos[0], feet - 0.25, s.pos[2]]) < -0.25)
            problems.push(`${at}: no floor`);
        }
      },
    );
    expect(problems.slice(0, 5)).toEqual([]);
    expect(caveTicks).toBeLessThan(600 * 8); // sanity: not everyone permanently "below the surface"

    // Every worm either walked far, walked into the sea, or is blocked by steep terrain ahead.
    const outcome = w.sim.worms.map((s, i) => {
      const walked = dist2d(s.pos, starts[i]!);
      if (!s.alive) return 'sea';
      if (walked > 20) return 'far';
      const [dx, dz] = dirs[i]!;
      const h0 = isl.heightAt(s.pos[0], s.pos[2]);
      let steepest = 0;
      for (const d of [0.5, 1, 1.5]) {
        const rise = isl.heightAt(s.pos[0] + dx * d, s.pos[2] + dz * d) - h0;
        steepest = Math.max(steepest, rise / d);
      }
      return steepest > 0.7
        ? 'blocked'
        : `stuck after ${walked.toFixed(1)} m (slope ahead ${steepest.toFixed(2)})`;
    });
    console.log(`[walk] 8 directions from the village: ${outcome.join(', ')}`);
    for (const o of outcome) expect(['far', 'sea', 'blocked']).toContain(o);
    expect(outcome.filter((o) => o === 'far' || o === 'sea').length).toBeGreaterThanOrEqual(4);
    for (const died of w.events('wormDied')) expect(died.cause).toBe('water');
    w.dispose();
  });

  /** Walkable beach: a start point ~6 m inland from where the terrain dips below the water. */
  function findBeach(isl: Island): { start: Vec3; dir: Vec2 } | null {
    const v = isl.terrain.info()!.village;
    for (let k = 0; k < 32; k++) {
      const a = (k * Math.PI) / 16;
      const dx = Math.sin(a);
      const dz = Math.cos(a);
      const hs: number[] = [];
      let coast = -1;
      for (let r = 0; r < 110; r += 0.5) {
        const h = isl.heightAt(v.x + dx * r, v.z + dz * r);
        hs.push(h);
        if (h < -0.3) {
          coast = hs.length - 1;
          break;
        }
      }
      if (coast < 14) continue;
      const from = coast - 12; // 6 m inland
      if (hs[from]! < 0.8) continue;
      let gentle = true;
      for (let i = from; i < coast; i++) if (Math.abs(hs[i + 1]! - hs[i]!) > 0.25) gentle = false;
      if (!gentle) continue;
      const r = from * 0.5;
      const x = v.x + dx * r;
      const z = v.z + dz * r;
      return { start: [x, hs[from]! + FEET + 0.3, z], dir: [dx, dz] };
    }
    return null;
  }

  it('walking off the beach into the sea kills (water) and freezes the worm', () => {
    const isl = island(1234);
    const beach = findBeach(isl);
    expect(beach).not.toBeNull();
    const w = world(isl);
    const s = w.spawn(beach!.start);
    w.run(60);
    expect(s.alive).toBe(true);
    expect(s.grounded).toBe(true);
    w.run(600, [{ type: 'move', wormId: s.id, dir: beach!.dir }]);
    expect(s.alive).toBe(false);
    const died = w.events('wormDied');
    expect(died).toHaveLength(1);
    expect(died[0]!.cause).toBe('water');
    expect(died[0]!.pos[1]).toBeLessThan(w.sim.waterLevel);
    expect(died[0]!.pos[1]).toBeGreaterThan(w.sim.waterLevel - 0.7);
    // Dead worms stop costing CPU and never keep falling (QA once saw y ≈ -15000).
    const worm = w.sim.worm(s.id)!;
    expect(worm.body.isEnabled()).toBe(false);
    const frozen = [...s.pos];
    const body = worm.body.translation();
    w.run(1200, [{ type: 'move', wormId: s.id, dir: beach!.dir }]);
    expect(s.pos).toEqual(frozen);
    expect(s.prevPos).toEqual(frozen);
    expect(worm.body.translation()).toEqual(body);
    expect(s.state).toBe('dead');
    w.dispose();
  });
});

describe('fall damage on real terrain', () => {
  it('a spawn drop from 20 m onto the village plateau does not hurt', () => {
    const isl = island(1234);
    const v = isl.terrain.info()!.village;
    const w = world(isl);
    const s = w.spawn([v.x, isl.heightAt(v.x, v.z) + FEET + 20, v.z]);
    w.run(180);
    expect(s.grounded).toBe(true);
    expect(s.hp).toBe(WORM_MAX_HP);
    const landed = w.events('wormLanded');
    expect(landed[0]!.drop).toBeGreaterThan(19);
    expect(landed[0]!.damage).toBe(0);
    w.dispose();
  });

  /** A sheer drop of ≥ 8 m onto dry land with a flat run-up, on any of the test islands. */
  function findCliff(): { isl: Island; start: Vec3; dir: Vec2; drop: number } | null {
    for (const seed of SEEDS) {
      const isl = island(seed);
      const H = isl.heightAt;
      for (let x = -60; x <= 60; x += 1)
        for (let z = -60; z <= 60; z += 1) {
          const h = H(x, z);
          if (h < 9) continue;
          for (let k = 0; k < 16; k++) {
            const a = (k * Math.PI) / 8;
            const dx = Math.sin(a);
            const dz = Math.cos(a);
            const at = (d: number) => H(x + dx * d, z + dz * d);
            const below = at(2.5);
            if (h - at(1.2) < 6 || h - below < 8 || below < SPAWN_MIN_ABOVE_WATER + 0.5) continue;
            if ([-0.5, -1, -1.5, -2, -2.5].some((d) => Math.abs(at(d) - h) > 0.25)) continue; // flat run-up
            if (Math.abs(at(3.5) - below) > 0.5) continue; // flat landing
            const sx = x - dx * 2.5;
            const sz = z - dz * 2.5;
            return { isl, start: [sx, H(sx, sz) + FEET + 0.3, sz], dir: [dx, dz], drop: h - below };
          }
        }
    }
    return null;
  }

  it('walking off a real cliff (≥ 8 m) hurts by the fall-damage curve', (ctx) => {
    const cliff = findCliff();
    // The generator does not guarantee a sheer ≥ 8 m cliff on every seed; skip rather than fake one.
    if (!cliff) {
      ctx.skip();
      return;
    }
    const w = world(cliff.isl);
    const s = w.spawn(cliff.start);
    w.run(60);
    expect(s.grounded).toBe(true);
    const before = w.events('wormLanded').length;
    let next: Command[] = [{ type: 'move', wormId: s.id, dir: cliff.dir }];
    let stopped = false;
    for (let i = 0; i < 300; i++) {
      w.sim.step(next);
      next = [];
      // Stop walking once down, so the worm does not wander into the sea afterwards.
      if (
        !stopped &&
        w
          .events('wormLanded')
          .slice(before)
          .some((l) => l.drop > 2)
      ) {
        stopped = true;
        next = [{ type: 'move', wormId: s.id, dir: [0, 0] }];
      }
    }
    const falls = w.events('wormLanded').slice(before);
    const big = falls.find((l) => l.drop > FALL_DAMAGE_MIN_DROP + 1);
    expect(big, `landings: ${JSON.stringify(falls)}`).toBeDefined();
    console.log(
      `[cliff] island ${cliff.isl.seed}: heightmap drop ${cliff.drop.toFixed(1)} m, ` +
        `landed drop ${big!.drop.toFixed(1)} m, damage ${big!.damage}`,
    );
    expect(big!.damage).toBe(fallDamage(big!.drop));
    expect(big!.damage).toBeGreaterThan(0);
    const total = w.events('wormDamaged').reduce((sum, d) => sum + d.amount, 0);
    expect(s.hp).toBe(WORM_MAX_HP - total);
    w.dispose();
  });
});

describe('determinism & perf on real terrain', () => {
  /** Two fully independent sim + terrain instances, same seed and seeded random command log. */
  it('same seed + command log ⇒ identical hash every 60 ticks over 900 ticks', async () => {
    const run = async () => {
      const sim = new SimWorld({ seed: 1234 });
      const terrain = createTerrain({ seed: 1234, sim, mesher: createInlineMesher() });
      await terrain.generate();
      const heightAt = (x: number, z: number) => terrain.heightAt(x, z);
      const list = spawnTeams({
        seed: 1234,
        teams: 4,
        wormsPerTeam: 4,
        heightAt,
        waterLevel: sim.waterLevel,
      });
      sim.step(list.map((s) => ({ type: 'spawnWorm' as const, team: s.team, pos: s.pos })));
      const ids = sim.worms.map((s) => s.id);
      const rng = new Rng(99);
      const hashes: number[] = [];
      for (let t = 1; t <= 900; t++) {
        const cmds: Command[] = [];
        for (const id of ids) {
          const r = rng.next();
          if (r < 0.03) {
            const a = rng.range(-Math.PI, Math.PI);
            cmds.push({ type: 'move', wormId: id, dir: [Math.sin(a), Math.cos(a)] });
          } else if (r < 0.035) cmds.push({ type: 'jump', wormId: id });
          else if (r < 0.037) cmds.push({ type: 'move', wormId: id, dir: [0, 0] });
          else if (r < 0.038) sim.worm(id)!.applyImpulse([rng.range(-5, 5), 4, rng.range(-5, 5)]);
        }
        sim.step(cmds);
        if (t % 60 === 0) hashes.push(sim.hash());
      }
      const snap = sim.snapshot();
      terrain.dispose();
      sim.dispose();
      return { hashes, snap };
    };
    const a = await run();
    const b = await run();
    expect(a.hashes).toHaveLength(15);
    expect(b.hashes).toEqual(a.hashes);
    expect(b.snap).toEqual(a.snap);
    // Something happened: worms moved around and some are still alive.
    expect(a.snap.worms.some((s) => s.alive)).toBe(true);
    expect(new Set(a.hashes).size).toBe(15);
  }, 60_000);

  it('16 worms walking on the island: sim step < 3 ms (median of 60-tick windows); idle worms are cheap', () => {
    const isl = island(1234);
    const w = world(isl);
    const list = spawnTeams({ seed: 1234, teams: 4, wormsPerTeam: 4, heightAt: isl.heightAt, waterLevel: 0 });
    w.sim.step(list.map((s) => ({ type: 'spawnWorm' as const, team: s.team, pos: s.pos })));
    w.run(120);
    const rng = new Rng(3);
    const walk: number[] = [];
    for (let t = 0; t < 600; t++) {
      const cmds: Command[] = [];
      if (t % 120 === 0)
        for (const s of w.sim.worms)
          if (s.alive) {
            const a = rng.range(-Math.PI, Math.PI);
            cmds.push({ type: 'move', wormId: s.id, dir: [Math.sin(a), Math.cos(a)] });
          }
      const t0 = performance.now();
      w.sim.step(cmds);
      walk.push(performance.now() - t0);
    }
    w.run(
      60,
      w.sim.worms.filter((s) => s.alive).map((s) => ({ type: 'move' as const, wormId: s.id, dir: [0, 0] })),
    );
    const idle: number[] = [];
    for (let t = 0; t < 300; t++) {
      const t0 = performance.now();
      w.sim.step([]);
      idle.push(performance.now() - t0);
    }
    const avg = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length;
    const p95 = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length * 0.95)]!;
    const alive = w.sim.worms.filter((s) => s.alive).length;
    console.log(
      `[perf] real terrain, 16 worms (${alive} alive at end): walking avg ${avg(walk).toFixed(3)} ms/tick ` +
        `(p95 ${p95(walk).toFixed(3)}), idle avg ${avg(idle).toFixed(3)} ms/tick`,
    );
    // Median of per-window averages: robust against CPU contention bursts on shared CI runners,
    // while still failing if the typical cost exceeds the 3 ms budget.
    const windows: number[] = [];
    for (let i = 0; i + 60 <= walk.length; i += 60) windows.push(avg(walk.slice(i, i + 60)));
    const median = [...windows].sort((x, y) => x - y)[Math.floor(windows.length / 2)]!;
    expect(median).toBeLessThan(3);
    expect(avg(idle)).toBeLessThan(avg(walk));
    w.dispose();
  });
});

describe('terrain edits under resting worms', () => {
  it('carving the ground away under a resting worm + wakeWorms ⇒ it falls into the crater', async () => {
    const sim = new SimWorld({ seed: 1234 });
    const terrain = createTerrain({ seed: 1234, sim, mesher: createInlineMesher() });
    await terrain.generate();
    const v = terrain.info()!.village;
    sim.step([{ type: 'spawnWorm', team: 0, pos: [v.x, terrain.heightAt(v.x, v.z) + FEET + 0.6, v.z] }]);
    for (let i = 0; i < 60; i++) sim.step([]);
    const s = sim.worms[0]!;
    expect(sim.worm(s.id)!.resting).toBe(true);
    const y0 = s.pos[1];
    await terrain.carveSphere([v.x, y0 - FEET, v.z], 2.5);
    sim.wakeWorms([v.x, y0, v.z], 3);
    for (let i = 0; i < 120; i++) sim.step([]);
    expect(s.pos[1]).toBeLessThan(y0 - 1.5);
    expect(s.grounded).toBe(true);
    expect(Math.abs(s.pos[1] - FEET - terrain.heightAt(s.pos[0], s.pos[2]))).toBeLessThan(0.6);
    terrain.dispose();
    sim.dispose();
  }, 30_000);
});
