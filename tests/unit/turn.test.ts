/**
 * Turn system (M4) – headless rule tests on a flat arena: startMatch, gating, timers, retreat, settle, rotation,
 * deaths, game over, ammo, per-turn wind and determinism. Real-terrain settle: turnTerrain.test.ts.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Command } from '../../src/core/commands';
import { TICK_RATE } from '../../src/core/loop';
import { initPhysics } from '../../src/sim/physics';
import {
  RETREAT_SECONDS,
  SETTLE_MAX_SECONDS,
  SETTLE_QUIET_TICKS,
  TURN_SECONDS,
  type TurnPhase,
} from '../../src/sim/turn';
import { windFromSeed } from '../../src/sim/wind';
import { Harness } from './simHarness';
import { aim, ARENA_TOP, norm, runUntil, standing } from './weapons/arena';

beforeAll(async () => {
  await initPhysics();
});

let current: Harness | null = null;
afterEach(() => {
  current?.dispose();
  current = null;
});

type Spawn = [team: number, x: number, z: number];
/** Two teams × two worms, spawned interleaved like spawnTeams(): ids 1 (A0), 2 (B0), 3 (A1), 4 (B1). */
const TWO_BY_TWO: Spawn[] = [
  [0, -20, 0],
  [1, 20, 0],
  [0, -20, 20],
  [1, 20, 20],
];

type StartOpts = Omit<Extract<Command, { type: 'startMatch' }>, 'type'>;

/** Flat arena (top ARENA_TOP, ±60 m, no wind), worms settled, then (unless start === false) startMatch. */
function match(opts: { worms?: Spawn[]; start?: StartOpts | false; seed?: number } = {}) {
  const h = (current = new Harness(opts.seed ?? 7));
  h.ground(ARENA_TOP, 60);
  h.run(1, [{ type: 'setWind', wind: [0, 0] }]);
  const ids = (opts.worms ?? TWO_BY_TWO).map(([team, x, z]) => h.spawn(standing(x, z), team));
  h.run(60);
  if (opts.start !== false) h.run(1, [{ type: 'startMatch', ...(opts.start ?? {}) }]);
  return { h, ids, t: h.sim.turn };
}

const started = (h: Harness) => h.events('turnStarted');
const ignored = (h: Harness) => h.events('commandIgnored');
const lastIgnored = (h: Harness) => ignored(h)[ignored(h).length - 1];
/** Tick at which each phase change happened (harness log ticks = sim.tick before the increment). */
const phaseLog = (h: Harness) =>
  h.log
    .filter((e) => e.type === 'turnPhase')
    .map((e) => ({ tick: e.tick, ...(e.payload as { phase: TurnPhase }) }));

/** Run until the next turn starts (or the game ends). Returns the ticks run. */
function untilNextTurn(h: Harness, max = 1200): number {
  const n = started(h).length;
  const ran = runUntil(h, () => started(h).length > n || h.sim.turn.phase === 'gameOver', max);
  expect(ran).toBeLessThan(max);
  return ran;
}

/** endTurn, then run through settle into the next turn. */
function skipTurn(h: Harness): void {
  h.run(1, [{ type: 'endTurn' }]);
  untilNextTurn(h);
}

describe('turn system (flat arena, headless)', () => {
  it('startMatch: 2 teams × 2 worms → turn 1 is team 0, its first worm, full timer, new wind', () => {
    const { h, ids, t } = match();
    expect(t.enabled).toBe(true);
    expect(t.phase).toBe('move');
    expect(t.turn).toBe(1);
    expect(t.team).toBe(0);
    expect(t.wormId).toBe(ids[0]);
    expect(t.teams).toEqual([0, 1]);
    expect(t.shotsLeft).toBe(1);
    expect(t.winner).toBeNull();
    // The start tick already counted down once.
    expect(t.phaseTicksLeft).toBe(TURN_SECONDS * TICK_RATE - 1);
    expect(t.turnTicksLeft).toBe(t.phaseTicksLeft);
    const wind = windFromSeed(7, 1);
    expect(started(h)).toEqual([{ turn: 1, team: 0, wormId: ids[0], wind }]);
    expect(h.sim.wind).toEqual(wind);
    expect(h.events('windChanged').at(-1)).toEqual({ wind });
    expect(h.events('turnPhase')).toEqual([{ phase: 'move', turn: 1 }]);
    expect(h.sim.snapshot().turn).toEqual({ ...t });

    // A second startMatch is ignored.
    h.run(1, [{ type: 'startMatch' }]);
    expect(lastIgnored(h)).toEqual({ type: 'startMatch', reason: 'match already started' });
    expect(t.turn).toBe(1);
  });

  it('firstTeam picks the starting team; order stays ascending (wrapping)', () => {
    const { h, ids, t } = match({
      worms: [
        [0, -20, 0],
        [1, 20, 0],
        [2, 0, 20],
      ],
      start: { firstTeam: 1 },
    });
    expect(t.order).toEqual([1, 2, 0]);
    expect(t.wormId).toBe(ids[1]);
    skipTurn(h);
    expect(t.team).toBe(2);
    skipTurn(h);
    expect(t.team).toBe(0);
    skipTurn(h);
    expect(t.team).toBe(1);
  });

  it('only the active worm accepts move/jump/face/fire; the others get "not your turn"', () => {
    const { h, ids } = match();
    const [a0, b0, a1] = ids as [number, number, number];
    const b0x = h.worm(b0).pos[0];
    const a1x = h.worm(a1).pos[0];
    h.run(30, [
      { type: 'move', wormId: b0, dir: [1, 0] },
      { type: 'jump', wormId: a1, kind: 'forward' },
      { type: 'face', wormId: b0, yaw: 1 },
      { type: 'fire', wormId: b0, weapon: 'bazooka', dir: [1, 0, 0], power: 1 },
      { type: 'move', wormId: a0, dir: [1, 0] },
    ]);
    expect(ignored(h)).toEqual([
      { type: 'move', reason: 'not your turn' },
      { type: 'jump', reason: 'not your turn' },
      { type: 'face', reason: 'not your turn' },
      { type: 'fire', reason: 'not your turn' },
    ]);
    expect(h.worm(b0).pos[0]).toBe(b0x);
    expect(h.worm(a1).pos[0]).toBe(a1x);
    expect(h.sim.projectiles).toHaveLength(0);
    expect(h.worm(a0).pos[0]).toBeGreaterThan(-20 + 1); // the active worm walks
  });

  it('turn timer runs out → settle (worm stops walking) → next team', () => {
    const { h, ids, t } = match({ start: { turnSeconds: 5 } });
    const [a0, b0] = ids as [number, number];
    const startTick = h.sim.tick - 1;
    h.run(1, [{ type: 'move', wormId: a0, dir: [1, 0] }]);
    runUntil(h, () => t.phase !== 'move', 400);
    expect(t.phase).toBe('settle');
    const toSettle = phaseLog(h).find((p) => p.phase === 'settle')!;
    expect(toSettle.tick - startTick + 1).toBe(5 * TICK_RATE); // the move phase lasted exactly 5 s
    expect(t.turnTicksLeft).toBe(0);
    expect(t.phaseTicksLeft).toBe(SETTLE_MAX_SECONDS * TICK_RATE);

    // The worm stops on its own (held move intent cleared) and further input is refused.
    h.run(5);
    const x = h.worm(a0).pos[0];
    h.run(5, [{ type: 'move', wormId: a0, dir: [1, 0] }]);
    expect(lastIgnored(h)).toEqual({ type: 'move', reason: 'turn is settling' });
    expect(h.worm(a0).pos[0]).toBe(x);
    expect(x).toBeGreaterThan(-20 + 10); // it did walk ~5 s × 3 m/s

    const settleTicks = untilNextTurn(h) + 10;
    expect(settleTicks).toBeGreaterThanOrEqual(SETTLE_QUIET_TICKS);
    expect(settleTicks).toBeLessThan(SETTLE_QUIET_TICKS + 15);
    expect(h.events('turnEnded')).toEqual([{ turn: 1, team: 0, wormId: a0 }]);
    expect(t).toMatchObject({ turn: 2, team: 1, wormId: b0, phase: 'move', shotsLeft: 1 });
    expect(phaseLog(h).map((p) => p.phase)).toEqual(['move', 'settle', 'move']);
  });

  it('fire → retreat (default 5 s: move yes, fire no, turn timer frozen) → settle → next team', () => {
    const { h, ids, t } = match();
    const [a0, b0] = ids as [number, number];
    h.run(60);
    const frozen = t.turnTicksLeft;
    // Bazooka into the ground, away from everyone.
    h.run(1, [{ type: 'fire', wormId: a0, weapon: 'bazooka', dir: aim(-1, 0, -5), power: 0.5 }]);
    const fireTick = h.sim.tick - 1;
    expect(t.phase).toBe('retreat');
    expect(t.shotsLeft).toBe(0);
    expect(t.phaseTicksLeft).toBe(RETREAT_SECONDS * TICK_RATE - 1);

    const x0 = h.worm(a0).pos[0];
    h.run(60, [
      { type: 'move', wormId: a0, dir: [1, 0] },
      { type: 'fire', wormId: a0, weapon: 'grenade', dir: [1, 0, 0], power: 1 },
    ]);
    expect(lastIgnored(h)).toEqual({ type: 'fire', reason: 'no shots left' });
    expect(h.worm(a0).pos[0]).toBeGreaterThan(x0 + 2);
    expect(t.turnTicksLeft).toBe(frozen);
    expect(h.events('explosion')).toHaveLength(1);

    runUntil(h, () => t.phase !== 'retreat', 400);
    const settle = phaseLog(h).find((p) => p.phase === 'settle')!;
    expect(settle.tick - fireTick + 1).toBe(RETREAT_SECONDS * TICK_RATE); // incl. the fire tick
    expect(t.turnTicksLeft).toBe(frozen);
    untilNextTurn(h);
    expect(t).toMatchObject({ turn: 2, team: 1, wormId: b0, phase: 'move' });
  });

  it('settle waits for the projectile, its explosion and knocked worms to come to rest', () => {
    const { h, ids, t } = match({ start: { retreatSeconds: 1 } });
    const [a0] = ids as [number];
    // Near-vertical lob of a 3 s grenade: it lands next to the thrower, who gets blown up by it.
    h.run(1, [{ type: 'fire', wormId: a0, weapon: 'grenade', dir: aim(1, 0, 80), power: 0.1, timer: 3 }]);
    const fireTick = h.sim.tick - 1;
    let settleAt = -1;
    let quietWhileBusy = false;
    let resolvedAt = -1;
    runUntil(
      h,
      () => {
        if (t.phase === 'settle' && settleAt < 0) settleAt = h.sim.tick;
        if (t.phase === 'settle' && (h.sim.projectiles.length > 0 || h.worm(a0).state === 'knocked'))
          quietWhileBusy ||= t.quietTicks > 0;
        if (started(h).length === 2) {
          resolvedAt = h.sim.tick;
          return true;
        }
        return false;
      },
      1000,
    );
    const ex = h.events('explosion');
    expect(ex).toHaveLength(1);
    expect(ex[0]!.tick).toBe(fireTick + 180);
    expect(ex[0]!.hits.map((x) => x.id)).toContain(a0);
    expect(settleAt).toBe(fireTick + TICK_RATE); // retreat 1 s (incl. the fire tick), then settle while the fuse still burns
    expect(quietWhileBusy).toBe(false);
    // The worm flew, landed, stopped – then SETTLE_QUIET_TICKS more.
    expect(resolvedAt - ex[0]!.tick).toBeGreaterThan(SETTLE_QUIET_TICKS);
    expect(resolvedAt - settleAt).toBeLessThan(SETTLE_MAX_SECONDS * TICK_RATE); // not the timeout
    const w = h.worm(a0);
    expect(w.alive).toBe(true);
    expect(w.hp).toBeLessThan(100);
    expect(w.grounded).toBe(true);
    expect(w.state).not.toBe('knocked');
    expect(t.team).toBe(1);
    console.log(
      `[turn] grenade settle: explosion +${ex[0]!.tick - fireTick} ticks, resolved ${resolvedAt - ex[0]!.tick} ticks later`,
    );
  });

  it('settle times out after SETTLE_MAX_SECONDS even if something keeps moving', () => {
    const { h, ids, t } = match({ start: { retreatSeconds: 0 } });
    const [a0] = ids as [number];
    // A long-fused grenade keeps the settle busy, and it is re-armed forever by a test hook (never quiet).
    h.run(1, [{ type: 'fire', wormId: a0, weapon: 'grenade', dir: aim(-1, 0, 30), power: 0.2, timer: 5 }]);
    expect(t.phase).toBe('settle'); // retreat 0 ⇒ straight to settle
    const settleTick = h.sim.tick - 1;
    runUntil(
      h,
      () => {
        const g = h.sim.projectiles[0];
        if (g && g.fuseTicks !== null) g.fuseTicks = 1000;
        return started(h).length === 2;
      },
      SETTLE_MAX_SECONDS * TICK_RATE + 5,
    );
    expect(started(h)).toHaveLength(2);
    expect(h.events('turnEnded')[0]!.turn).toBe(1);
    const ended = h.log.find((e) => e.type === 'turnEnded')!.tick;
    expect(ended - settleTick + 1).toBe(SETTLE_MAX_SECONDS * TICK_RATE);
    expect(h.sim.projectiles).toHaveLength(1); // still there, the next turn simply begins
  });

  it('per-team rotation skips dead worms', () => {
    const { h, ids } = match({
      worms: [
        [0, -30, -20],
        [1, 30, -20],
        [0, -30, 0],
        [1, 30, 0],
        [0, -30, 20],
      ],
    });
    const [a0, b0, a1, b1, a2] = ids as [number, number, number, number, number];
    const order = [h.sim.turn.wormId];
    skipTurn(h); // B0
    order.push(h.sim.turn.wormId);
    h.sim.worm(a1)!.damage(1000, 'fall'); // A1 dies during team 1's turn
    for (let i = 0; i < 5; i++) {
      skipTurn(h);
      order.push(h.sim.turn.wormId);
    }
    expect(order).toEqual([a0, b0, a2, b1, a0, b0, a2]);
  });

  it('the active worm drowning ends the turn at once; its team plays on with the next worm', () => {
    const { h, ids, t } = match({
      worms: [
        [0, -57, 0],
        [1, 20, 0],
        [0, -20, 20],
        [1, 20, 20],
      ],
    });
    const [a0, b0, a1] = ids as [number, number, number];
    h.run(1, [{ type: 'move', wormId: a0, dir: [-1, 0] }]);
    runUntil(h, () => !h.worm(a0).alive, 400);
    const died = h.log.find((e) => e.type === 'wormDied')!;
    expect(died.payload).toMatchObject({ id: a0, cause: 'water' });
    expect(t.phase).toBe('settle');
    expect(phaseLog(h).find((p) => p.phase === 'settle')!.tick).toBe(died.tick);
    expect(t.turnTicksLeft).toBeGreaterThan(40 * TICK_RATE); // long before the timer
    untilNextTurn(h);
    expect(t).toMatchObject({ turn: 2, team: 1, wormId: b0 });
    expect(t.teams).toEqual([0, 1]);
    skipTurn(h);
    expect(t).toMatchObject({ turn: 3, team: 0, wormId: a1 });
  });

  it('game over when only one team has living worms; afterwards everything is refused', () => {
    const { h, ids, t } = match({
      worms: [
        [0, 0, 0],
        [1, 6, 0],
      ],
    });
    const [a, b] = ids as [number, number];
    h.sim.worm(b)!.damage(90, 'fall');
    const wa = h.worm(a);
    const wb = h.worm(b);
    const dir = norm([wb.pos[0] - wa.pos[0], wb.pos[1] - (wa.pos[1] + 0.3), wb.pos[2] - wa.pos[2]]);
    h.run(1, [{ type: 'fire', wormId: a, weapon: 'bazooka', dir, power: 1 }]);
    runUntil(h, () => t.phase === 'gameOver', 1200);
    expect(wb.alive).toBe(false);
    expect(wa.alive).toBe(true);
    expect(t).toMatchObject({ phase: 'gameOver', winner: 0, teams: [0], wormId: null, shotsLeft: 0 });
    expect(h.events('gameOver')).toEqual([{ winner: 0 }]);
    expect(h.events('turnEnded')).toEqual([{ turn: 1, team: 0, wormId: a }]);
    expect(h.events('turnPhase').map((p) => p.phase)).toEqual(['move', 'retreat', 'settle', 'gameOver']);

    const x = wa.pos[0];
    const tick = h.sim.tick;
    h.run(120, [
      { type: 'move', wormId: a, dir: [1, 0] },
      { type: 'fire', wormId: a, weapon: 'bazooka', dir: [1, 0, 0], power: 1 },
      { type: 'endTurn' },
    ]);
    expect(ignored(h).slice(-3)).toEqual([
      { type: 'move', reason: 'game over' },
      { type: 'fire', reason: 'game over' },
      { type: 'endTurn', reason: 'cannot end turn in gameOver phase' },
    ]);
    expect(wa.pos[0]).toBe(x);
    expect(h.sim.tick).toBe(tick + 120);
    expect(t.phase).toBe('gameOver');
    expect(h.events('gameOver')).toHaveLength(1);
  });

  it('draw (-1) when the last worms of both teams die in the same blast', () => {
    const { h, ids, t } = match({
      worms: [
        [0, 0, 0],
        [1, 3, 0],
      ],
    });
    const [a, b] = ids as [number, number];
    h.sim.worm(a)!.damage(90, 'fall');
    h.sim.worm(b)!.damage(90, 'fall');
    h.run(1, [{ type: 'fire', wormId: a, weapon: 'bazooka', dir: aim(1, 0, -30), power: 0.5 }]);
    runUntil(h, () => t.phase === 'gameOver', 1200);
    expect(h.worm(a).alive).toBe(false);
    expect(h.worm(b).alive).toBe(false);
    expect(t.winner).toBe(-1);
    expect(t.teams).toEqual([]);
    expect(h.events('gameOver')).toEqual([{ winner: -1 }]);
    // The shooter died in its own blast ⇒ straight to settle (no retreat wait), then resolve.
    expect(h.events('turnPhase').map((p) => p.phase)).toEqual(['move', 'retreat', 'settle', 'gameOver']);
  });

  it('endTurn: move → settle and retreat → settle; refused in settle and without a match', () => {
    const { h, ids, t } = match({ start: false });
    h.run(1, [{ type: 'endTurn' }]);
    expect(lastIgnored(h)).toEqual({ type: 'endTurn', reason: 'no match running' });
    h.run(1, [{ type: 'startMatch' }]);
    h.run(1, [{ type: 'endTurn' }]);
    expect(t.phase).toBe('settle');
    h.run(1, [{ type: 'endTurn' }]);
    expect(lastIgnored(h)).toEqual({ type: 'endTurn', reason: 'cannot end turn in settle phase' });
    untilNextTurn(h);
    expect(t.team).toBe(1);
    h.run(1, [{ type: 'fire', wormId: ids[1]!, weapon: 'bazooka', dir: aim(1, 0, -5), power: 0.5 }]);
    expect(t.phase).toBe('retreat');
    h.run(1, [{ type: 'endTurn' }]);
    expect(t.phase).toBe('settle');
    untilNextTurn(h);
    expect(t).toMatchObject({ turn: 3, team: 0, wormId: ids[2] });
  });

  it('ammo: non-infinite ammo is decremented per team; firing with 0 ammo is refused and costs no shot', () => {
    const { h, ids, t } = match({ start: false });
    const [a0, b0, a1] = ids as [number, number, number];
    h.sim.setAmmo(0, 'bazooka', 1);
    h.run(1, [{ type: 'startMatch' }]);
    h.run(1, [{ type: 'fire', wormId: a0, weapon: 'bazooka', dir: aim(-1, 0, -5), power: 0.5 }]);
    expect(t.phase).toBe('retreat');
    expect(h.sim.getAmmo(0, 'bazooka')).toBe(0);
    expect(h.sim.getAmmo(1, 'bazooka')).toBe(-1);
    untilNextTurn(h);
    expect(t.wormId).toBe(b0);
    skipTurn(h);
    expect(t.wormId).toBe(a1);
    h.run(1, [{ type: 'fire', wormId: a1, weapon: 'bazooka', dir: aim(-1, 0, -5), power: 0.5 }]);
    expect(lastIgnored(h)).toEqual({ type: 'fire', reason: 'out of ammo: bazooka' });
    expect(t).toMatchObject({ phase: 'move', shotsLeft: 1 });
    h.run(1, [{ type: 'fire', wormId: a1, weapon: 'grenade', dir: aim(-1, 0, 30), power: 0.5 }]);
    expect(t).toMatchObject({ phase: 'retreat', shotsLeft: 0 });
    expect(h.sim.getAmmo(0, 'grenade')).toBe(-1);
  });

  it('wind changes every turn, deterministically from (seed, turn)', () => {
    const winds = (seed: number) => {
      const { h } = match({ seed });
      for (let i = 0; i < 4; i++) skipTurn(h);
      const out = started(h).map((s) => s.wind);
      expect(
        h
          .events('windChanged')
          .slice(-5)
          .map((e) => e.wind),
      ).toEqual(out);
      expect(h.sim.wind).toEqual(out[4]);
      h.dispose();
      return out;
    };
    const a = winds(11);
    expect(a).toEqual([1, 2, 3, 4, 5].map((n) => windFromSeed(11, n)));
    expect(new Set(a.map((w) => w.join())).size).toBe(5);
    expect(winds(11)).toEqual(a);
    expect(winds(12)).not.toEqual(a);
  });

  it('determinism: same seed + command log over several turns ⇒ identical hash trace', () => {
    const play = (power: number) => {
      const { h, ids } = match({ seed: 3 });
      const [a0, b0, a1] = ids as [number, number, number];
      const hashes: number[] = [];
      const script: Record<number, Command[]> = {
        5: [{ type: 'move', wormId: a0, dir: [1, 0.3] }],
        60: [{ type: 'jump', wormId: a0 }],
        150: [{ type: 'fire', wormId: a0, weapon: 'grenade', dir: aim(0, 1, 45), power, timer: 2 }],
      };
      for (let i = 0; i < 700; i++) {
        h.sim.step(script[i] ?? []);
        if (i % 30 === 0) hashes.push(h.sim.hash());
      }
      // Turn 2 (B0): fire at team 0, then turn 3 (A1) ends early.
      expect(h.sim.turn.wormId).toBe(b0);
      h.run(1, [{ type: 'fire', wormId: b0, weapon: 'bazooka', dir: aim(-1, 0, 5), power: 0.8 }]);
      untilNextTurn(h);
      expect(h.sim.turn.wormId).toBe(a1);
      h.run(10, [{ type: 'face', wormId: a1, yaw: 2 }]);
      skipTurn(h);
      hashes.push(h.sim.hash());
      const out = { hashes, snap: h.sim.snapshot() };
      h.dispose();
      return out;
    };
    const r1 = play(0.7);
    const r2 = play(0.7);
    expect(r2.hashes).toEqual(r1.hashes);
    expect(r2.snap).toEqual(r1.snap);
    expect(r1.snap.turn.turn).toBe(4);
    expect(play(0.71).hashes).not.toEqual(r1.hashes);
  });

  it('hash covers the turn state', () => {
    const { h, t } = match();
    const h0 = h.sim.hash();
    t.phaseTicksLeft++;
    expect(h.sim.hash()).not.toBe(h0);
    t.phaseTicksLeft--;
    expect(h.sim.hash()).toBe(h0);
  });

  it('disabled (no startMatch): every worm obeys, repeated fire works, turn state stays idle', () => {
    const { h, ids, t } = match({ start: false });
    const [a0, b0] = ids as [number, number];
    h.run(30, [
      { type: 'move', wormId: a0, dir: [1, 0] },
      { type: 'move', wormId: b0, dir: [-1, 0] },
    ]);
    h.run(1, [{ type: 'fire', wormId: a0, weapon: 'grenade', dir: aim(0, 1, 30), power: 0.3 }]);
    h.run(1, [{ type: 'fire', wormId: b0, weapon: 'grenade', dir: aim(0, 1, 30), power: 0.3 }]);
    h.run(1, [{ type: 'fire', wormId: b0, weapon: 'grenade', dir: aim(0, -1, 30), power: 0.3 }]);
    expect(ignored(h)).toEqual([]);
    expect(h.sim.projectiles).toHaveLength(3);
    expect(h.worm(a0).pos[0]).toBeGreaterThan(-19);
    expect(h.worm(b0).pos[0]).toBeLessThan(19);
    expect(t).toMatchObject({ enabled: false, phase: 'idle', turn: 0, wormId: null, winner: null });
    expect(h.events('turnPhase')).toEqual([]);
  });

  it('startMatch needs two teams with living worms', () => {
    const { h, t } = match({
      worms: [
        [0, -10, 0],
        [0, 10, 0],
      ],
    });
    expect(lastIgnored(h)).toEqual({ type: 'startMatch', reason: 'need at least 2 teams with living worms' });
    expect(t.enabled).toBe(false);
  });

  it('invalid phase transitions throw (dev)', () => {
    const { h } = match();
    const turns = (h.sim as unknown as { turns: { to(p: TurnPhase): void } }).turns;
    expect(() => turns.to('retreat')).not.toThrow(); // move → retreat is legal
    expect(() => turns.to('move')).toThrow(/invalid turn transition retreat → move/);
    expect(() => turns.to('gameOver')).toThrow(/invalid turn transition/);
  });
});
