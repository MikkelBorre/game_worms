import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../../src/core/math';
import { initPhysics } from '../../../src/sim/physics';
import { GRENADE_DAMAGE, GRENADE_RADIUS } from '../../../src/sim/weapons/grenade';
import { WORM_MAX_HP } from '../../../src/sim/worm';
import type { Harness } from '../simHarness';
import { aim, arena, ARENA_TOP } from './arena';

beforeAll(async () => {
  await initPhysics();
});

let current: Harness | null = null;
afterEach(() => {
  current?.dispose();
  current = null;
});

describe('grenade (flat arena, headless)', () => {
  it('bounces, ignores wind, and explodes exactly when the fuse runs out – not before', () => {
    const { h, ids } = arena({ wind: [10, 10], worms: [[0, 0]] });
    current = h;
    const fireTick = h.sim.tick;
    h.run(1, [
      { type: 'fire', wormId: ids[0]!, weapon: 'grenade', dir: aim(1, 0, 40), power: 0.6, timer: 3 },
    ]);
    expect(h.events('weaponFired')[0]!.timerTicks).toBe(180);
    const g = h.sim.projectiles[0]!;
    expect(g.weapon).toBe('grenade');
    expect(g.fuseTicks).toBe(179);

    let bounces = 0;
    let lastVy = g.vel[1];
    let minY = Infinity;
    while (h.events('explosion').length === 0 && h.sim.tick < fireTick + 400) {
      h.sim.step([]);
      if (h.sim.projectiles.length === 0) break;
      if (lastVy < -0.5 && g.vel[1] > 0.3) bounces++;
      lastVy = g.vel[1];
      minY = Math.min(minY, g.pos[1]);
      // No drift sideways: grenades are not affected by wind.
      expect(Math.abs(g.pos[2])).toBeLessThan(1e-3);
    }
    const ex = h.events('explosion');
    expect(ex).toHaveLength(1);
    expect(ex[0]!.tick).toBe(fireTick + 180);
    expect(ex[0]!.weapon).toBe('grenade');
    expect(ex[0]!.radius).toBe(GRENADE_RADIUS);
    console.log(
      `[grenade] ${bounces} bounces, exploded at x ${ex[0]!.pos[0].toFixed(2)} after ${ex[0]!.tick - fireTick} ticks`,
    );
    expect(bounces).toBeGreaterThanOrEqual(1);
    expect(minY).toBeGreaterThan(ARENA_TOP); // never tunnelled into the ground
    expect(ex[0]!.pos[1]).toBeLessThan(ARENA_TOP + 0.5); // resting/rolling on the ground by then
    expect(ex[0]!.pos[0]).toBeGreaterThan(5);
    expect(h.events('projectileRemoved')[0]!.reason).toBe('exploded');
    expect(h.sim.projectiles).toHaveLength(0);
  });

  it('timer: 1 s and clamping (0.2 → 1 s, 9 → 5 s, default 3 s)', () => {
    const fuse = (timer: number | undefined) => {
      const { h, ids } = arena({ worms: [[0, 0]] });
      const t0 = h.sim.tick;
      h.run(1, [
        {
          type: 'fire',
          wormId: ids[0]!,
          weapon: 'grenade',
          dir: [0, 1, 0],
          power: 0.1,
          ...(timer === undefined ? {} : { timer }),
        },
      ]);
      while (h.events('explosion').length === 0 && h.sim.tick < t0 + 400) h.sim.step([]);
      const dt = h.events('explosion')[0]!.tick - t0;
      h.dispose();
      return dt;
    };
    expect(fuse(1)).toBe(60);
    expect(fuse(0.2)).toBe(60);
    expect(fuse(9)).toBe(300);
    expect(fuse(undefined)).toBe(180);
  });

  it('passes through worms (no push) and hurts them only when it goes off', () => {
    const { h, ids } = arena({
      worms: [
        [0, 0],
        [2, 0],
      ],
    });
    current = h;
    const [a, b] = ids as [number, number];
    const bPos: Vec3 = [...h.worm(b).pos];
    // Low throw straight at worm b.
    h.run(1, [{ type: 'fire', wormId: a, weapon: 'grenade', dir: [1, 0, 0], power: 0, timer: 2 }]);
    let passed = false;
    h.run(110, [], () => {
      const g = h.sim.projectiles[0];
      if (g && g.pos[0] > bPos[0] + 0.3) passed = true;
    });
    expect(h.events('explosion')).toHaveLength(0);
    expect(passed).toBe(true); // went through b's capsule (x 1.7..2.3) instead of bouncing back
    for (let i = 0; i < 3; i++) expect(Math.abs(h.worm(b).pos[i]! - bPos[i]!)).toBeLessThan(1e-3);
    expect(h.worm(b).hp).toBe(WORM_MAX_HP);
    h.run(20);
    const ex = h.events('explosion');
    expect(ex).toHaveLength(1);
    const hb = ex[0]!.hits.find((x) => x.id === b);
    console.log(`[grenade] went off at x ${ex[0]!.pos[0].toFixed(2)}: worm b took ${hb?.damage}`);
    expect(hb).toBeDefined();
    expect(hb!.damage).toBeGreaterThan(10);
    expect(hb!.damage).toBeLessThanOrEqual(GRENADE_DAMAGE);
  });
});
