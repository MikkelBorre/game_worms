/**
 * Turn system on the real generated island (seed 1234, inline mesher, Rapier trimesh colliders): spawns from
 * spawnTeams(), explosions really carve, and the test awaits pending terrain edits between steps exactly like the
 * game loop gates on sim.canStep(). Checks that settle ends by quiet (worms at rest on marching-cubes ground),
 * not by the 8 s timeout.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Command } from '../../src/core/commands';
import type { Vec3 } from '../../src/core/math';
import { TICK_RATE } from '../../src/core/loop';
import { initPhysics } from '../../src/sim/physics';
import { spawnTeams } from '../../src/sim/spawn';
import { SETTLE_MAX_SECONDS, SETTLE_QUIET_TICKS } from '../../src/sim/turn';
import { SimWorld, type SimEvents } from '../../src/sim/world';
import { createTerrain, type TerrainSystem } from '../../src/terrain';
import { createInlineMesher } from '../../src/terrain/mesherPool';

const SEED = 1234;

beforeAll(async () => {
  await initPhysics();
});

let dispose: (() => void) | null = null;
afterEach(() => {
  dispose?.();
  dispose = null;
});

async function island() {
  const sim = new SimWorld({ seed: SEED });
  const terrain: TerrainSystem = createTerrain({ seed: SEED, sim, mesher: createInlineMesher() });
  await terrain.generate();
  sim.setTerrainEditor(terrain);
  dispose = () => {
    terrain.dispose();
    sim.dispose();
  };
  const log: { tick: number; type: keyof SimEvents; payload: unknown }[] = [];
  for (const type of ['turnStarted', 'turnPhase', 'turnEnded', 'explosion', 'wormDied'] as const)
    sim.events.on(type, (payload) => log.push({ tick: sim.tick, type, payload }));
  let pendingWaits = 0;
  const step = async (cmds: Command[] = []) => {
    if (!sim.canStep()) {
      pendingWaits++;
      await sim.whenTerrainIdle();
    }
    sim.step(cmds);
  };
  return {
    sim,
    terrain,
    log,
    step,
    pendingWaits: () => pendingWaits,
    async run(n: number, cmds: Command[] = []) {
      for (let i = 0; i < n; i++) await step(i === 0 ? cmds : []);
    },
  };
}

describe('turn system on the real island (seed 1234)', () => {
  it('fire → settle waits for blast, carve and resting worms → next team', async () => {
    const w = await island();
    const spawns = spawnTeams({
      seed: SEED,
      teams: 2,
      wormsPerTeam: 2,
      heightAt: (x, z) => w.terrain.heightAt(x, z),
      waterLevel: w.sim.waterLevel,
    });
    await w.step(spawns.map((s) => ({ type: 'spawnWorm' as const, team: s.team, pos: s.pos })));
    await w.run(90);
    // No retreat: settle starts on the fire tick and has to wait for flight, blast, carve and knockback.
    await w.step([{ type: 'startMatch', retreatSeconds: 0 }]);
    const t = w.sim.turn;
    expect(t).toMatchObject({ enabled: true, phase: 'move', turn: 1, team: 0 });
    const shooter = t.wormId!;
    expect(w.sim.worms.find((q) => q.id === shooter)!.team).toBe(0);

    // Bazooka into the ground a few metres in front of the shooter: crater (pending carve), knockback.
    const dir: Vec3 = [1, -0.3, 0.3];
    await w.step([{ type: 'fire', wormId: shooter, weapon: 'bazooka', dir, power: 0.6 }]);
    const fireTick = w.sim.tick - 1;
    expect(t.phase).toBe('settle');
    for (let i = 0; i < 1200 && t.turn === 1 && t.phase !== 'gameOver'; i++) await w.step();
    const explosions = w.log.filter((e) => e.type === 'explosion');
    expect(explosions.length).toBeGreaterThanOrEqual(1);
    expect(w.pendingWaits()).toBeGreaterThanOrEqual(1); // the carve really gated the sim
    expect(t).toMatchObject({ turn: 2, team: 1, phase: 'move' });
    const ended = w.log.find((e) => e.type === 'turnEnded')!.tick;
    const lastBlast = explosions[explosions.length - 1]!.tick;
    const hits = explosions.flatMap((e) => (e.payload as { hits: { id: number; damage: number }[] }).hits);
    console.log(
      `[turn island] blast +${explosions[0]!.tick - fireTick} ticks after firing (${explosions.length} blasts, hits ` +
        `${hits.map((q) => `${q.id}:${q.damage}`).join(' ') || 'none'}), settle took ${ended - fireTick + 1} ticks ` +
        `(quiet ${SETTLE_QUIET_TICKS}, max ${SETTLE_MAX_SECONDS * TICK_RATE})`,
    );
    expect(ended - lastBlast).toBeGreaterThanOrEqual(SETTLE_QUIET_TICKS);
    expect(ended - fireTick + 1).toBeLessThan(SETTLE_MAX_SECONDS * TICK_RATE); // ended by quiet, not timeout
    // All living worms at rest on the ground when the turn resolved (still true one tick later).
    for (const s of w.sim.worms) if (s.alive) expect(s.grounded).toBe(true);
    // The next team's worm is in control.
    const next = w.sim.worms.find((q) => q.id === t.wormId)!;
    expect(next.team).toBe(1);
    expect(next.alive).toBe(true);
  }, 60_000);
});
