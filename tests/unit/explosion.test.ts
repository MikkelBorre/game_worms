import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/core/math';
import {
  DAMAGE_DISTANCE_SLACK,
  DEATH_EXPLOSION_DAMAGE,
  DEATH_EXPLOSION_RADIUS,
  explode,
  explosionDamage,
  knockback,
  KNOCKBACK_PER_DAMAGE,
} from '../../src/sim/explosion';
import { initPhysics } from '../../src/sim/physics';
import { WORM_MAX_HP } from '../../src/sim/worm';
import type { Harness } from './simHarness';
import { arena, ARENA_TOP } from './weapons/arena';

beforeAll(async () => {
  await initPhysics();
});

let current: Harness | null = null;
afterEach(() => {
  current?.dispose();
  current = null;
});

describe('explosion math', () => {
  it('linear falloff from the capsule surface, rounded, 0 outside', () => {
    expect(explosionDamage(0, 3, 50)).toBe(50);
    expect(explosionDamage(DAMAGE_DISTANCE_SLACK, 3, 50)).toBe(50);
    expect(explosionDamage(DAMAGE_DISTANCE_SLACK + 1.5, 3, 50)).toBe(25);
    expect(explosionDamage(DAMAGE_DISTANCE_SLACK + 2.95, 3, 50)).toBe(1);
    expect(explosionDamage(DAMAGE_DISTANCE_SLACK + 3, 3, 50)).toBe(0);
    expect(explosionDamage(100, 3, 50)).toBe(0);
    expect(explosionDamage(1, 0, 50)).toBe(0);
    expect(explosionDamage(1, 3, 0)).toBe(0);
  });

  it('knockback ∝ damage, away from the centre and always upward', () => {
    const side = knockback([2, 0, 0], 50);
    expect(Math.hypot(...side)).toBeCloseTo(50 * KNOCKBACK_PER_DAMAGE, 9);
    expect(side[0]).toBeGreaterThan(0);
    expect(side[1]).toBeGreaterThan(0);
    expect(side[2]).toBe(0);
    // Blast above the worm still throws it up, never into the ground.
    const above = knockback([0.5, -1, 0], 20);
    expect(above[1]).toBeGreaterThan(0);
    expect(above[0]).toBeGreaterThan(0);
    // Dead centre: straight up.
    const centre = knockback([0, 0, 0], 10);
    expect(centre[0]).toBe(0);
    expect(centre[2]).toBe(0);
    expect(centre[1]).toBeCloseTo(10 * KNOCKBACK_PER_DAMAGE, 9);
  });
});

describe('explosions in the sim (flat arena, headless)', () => {
  it('two bazookas hitting the same worm on the same tick: both count, knockbacks cancel sideways', () => {
    const { h, ids } = arena({
      worms: [
        [-10, 0],
        [0, 0],
        [10, 0],
      ],
    });
    current = h;
    const [a, b, c] = ids as [number, number, number];
    const target = h.worm(b);
    h.run(1, [
      { type: 'fire', wormId: a, weapon: 'bazooka', dir: [1, 0, 0], power: 1 },
      { type: 'fire', wormId: c, weapon: 'bazooka', dir: [-1, 0, 0], power: 1 },
    ]);
    while (h.events('explosion').length === 0 && h.sim.tick < 200) h.sim.step([]);
    const ex = h.events('explosion');
    expect(ex).toHaveLength(2);
    expect(ex[0]!.tick).toBe(ex[1]!.tick);
    const total = ex.reduce((s, e) => s + e.hits.find((x) => x.id === b)!.damage, 0);
    expect(total).toBeGreaterThan(80);
    expect(target.hp).toBe(WORM_MAX_HP - total);
    expect(target.alive).toBe(true);
    let peak = target.pos[1];
    h.run(120, [], () => (peak = Math.max(peak, target.pos[1])));
    expect(Math.abs(target.pos[0])).toBeLessThan(0.3); // pushed from both sides equally
    expect(peak).toBeGreaterThan(ARENA_TOP + 2);
    expect(h.worm(a).hp).toBe(WORM_MAX_HP);
    expect(h.worm(c).hp).toBe(WORM_MAX_HP);
  });

  it('a worm killed by an explosion dies (cause explosion) and explodes small on the next tick', () => {
    const { h, ids } = arena({
      worms: [
        [0, 0],
        [10, 0],
        [11.5, 0.5],
      ],
    });
    current = h;
    const [a, b, c] = ids as [number, number, number];
    h.sim.worm(b)!.s.hp = 10;
    h.run(1, [{ type: 'fire', wormId: a, weapon: 'bazooka', dir: [1, 0, 0], power: 1 }]);
    while (h.events('wormDied').length === 0 && h.sim.tick < 200) h.sim.step([]);
    const died = h.events('wormDied');
    expect(died).toHaveLength(1);
    expect(died[0]!.id).toBe(b);
    expect(died[0]!.cause).toBe('explosion');
    const killTick = h.log.find((e) => e.type === 'wormDied')!.tick;
    const worm = h.worm(b);
    expect(worm.alive).toBe(false);
    expect(worm.state).toBe('dead');
    expect(worm.hp).toBe(0);
    expect(h.events('explosion')).toHaveLength(1);
    const cBefore = h.worm(c).hp;

    h.run(1);
    const ex = h.events('explosion');
    expect(ex).toHaveLength(2);
    const death = ex[1]!;
    expect(death.tick).toBe(killTick + 1);
    expect(death.kind).toBe('wormDeath');
    expect(death.weapon).toBeNull();
    expect(death.sourceWormId).toBe(b);
    expect(death.radius).toBe(DEATH_EXPLOSION_RADIUS);
    expect(death.maxDamage).toBe(DEATH_EXPLOSION_DAMAGE);
    expect(death.pos).toEqual(died[0]!.pos);
    // Worm c (1.6 m from b) is hit by the death blast as well.
    const hc = death.hits.find((x) => x.id === c);
    expect(hc).toBeDefined();
    expect(h.worm(c).hp).toBe(cBefore - hc!.damage);
    h.run(60);
    expect(h.events('explosion')).toHaveLength(2); // no chain: c survived
  });

  it('fall deaths explode too, drowning does not', () => {
    const { h, ids } = arena({
      half: 5,
      worms: [
        [0, 0],
        [3, 0],
      ],
    });
    current = h;
    const [a, b] = ids as [number, number];
    h.sim.worm(a)!.damage(WORM_MAX_HP, 'fall');
    // Killed between ticks (sim.tick = N, the next step is N): explodes at the start of step N + 1.
    h.run(1);
    expect(h.events('explosion')).toHaveLength(0);
    h.run(1);
    expect(h.events('explosion').map((e) => e.sourceWormId)).toEqual([a]);
    // b walks off the 5 m platform into the sea.
    h.run(300, [{ type: 'move', wormId: b, dir: [1, 0] }]);
    expect(h.worm(b).alive).toBe(false);
    expect(h.events('wormDied').map((d) => d.cause)).toEqual(['fall', 'water']);
    expect(h.events('explosion')).toHaveLength(1);
  });

  it('explode() without a TerrainEditor does not carve or block stepping', () => {
    const { h } = arena({ worms: [[0, 0]] });
    current = h;
    const pos: Vec3 = [5, ARENA_TOP, 0];
    const r = explode({ sim: h.sim }, pos, 3, 50);
    expect(r.hits).toEqual([]);
    expect(h.sim.pendingTerrainEdits).toBe(0);
    expect(h.sim.canStep()).toBe(true);
    h.run(1);
  });
});

describe('terrain edit gate', () => {
  it('step() throws while a carve is pending; carves run one at a time in order', async () => {
    const { h } = arena();
    current = h;
    const order: string[] = [];
    const resolvers: (() => void)[] = [];
    h.sim.setTerrainEditor({
      carveSphere: (c, r) => {
        order.push(`start ${c[0]} ${r}`);
        return new Promise<void>((res) =>
          resolvers.push(() => {
            order.push(`done ${c[0]}`);
            res();
          }),
        );
      },
    });
    explode({ sim: h.sim }, [1, ARENA_TOP, 0], 3, 0);
    explode({ sim: h.sim }, [2, ARENA_TOP, 0], 2, 0);
    expect(h.sim.pendingTerrainEdits).toBe(2);
    expect(h.sim.canStep()).toBe(false);
    expect(() => h.sim.step([])).toThrow(/pending/);
    expect(order).toEqual(['start 1 3']); // second waits for the first
    resolvers.shift()!();
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(['start 1 3', 'done 1', 'start 2 2']);
    expect(h.sim.pendingTerrainEdits).toBe(1);
    const idle = h.sim.whenTerrainIdle();
    resolvers.shift()!();
    await idle;
    expect(h.sim.pendingTerrainEdits).toBe(0);
    expect(h.sim.canStep()).toBe(true);
    h.run(1);
  });

  it('a failing carve is reported and does not wedge the sim', async () => {
    const { h } = arena();
    current = h;
    h.sim.setTerrainEditor({ carveSphere: () => Promise.reject(new Error('worker died')) });
    explode({ sim: h.sim }, [1, ARENA_TOP, 0], 3, 0);
    await h.sim.whenTerrainIdle();
    expect(h.events('terrainEditFailed')[0]!.error).toMatch(/worker died/);
    expect(h.sim.canStep()).toBe(true);
  });
});
