import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { initPhysics } from '../../../src/sim/physics';
import { BAZOOKA_DAMAGE, BAZOOKA_RADIUS } from '../../../src/sim/weapons/bazooka';
import { WORM_MAX_HP } from '../../../src/sim/worm';
import type { Harness } from '../simHarness';
import { aim, arena, ARENA_TOP, runUntil } from './arena';

beforeAll(async () => {
  await initPhysics();
});

let current: Harness | null = null;
afterEach(() => {
  current?.dispose();
  current = null;
});

/** Fire a bazooka and return where it went off (explosion or removal point). */
function landing(h: Harness) {
  runUntil(h, () => h.events('projectileRemoved').length > 0, 900);
  const removed = h.events('projectileRemoved');
  expect(removed).toHaveLength(1);
  return { removed: removed[0]!, explosion: h.events('explosion')[0] };
}

describe('bazooka (flat arena, headless)', () => {
  it('direct hit: damage in range, knockback throws the target away and up, shooter unharmed', () => {
    const { h, ids } = arena({
      worms: [
        [0, 0],
        [10, 0],
      ],
    });
    current = h;
    const [a, b] = ids as [number, number];
    const target = h.worm(b);
    const x0 = target.pos[0];
    h.run(1, [{ type: 'fire', wormId: a, weapon: 'bazooka', dir: [1, 0, 0], power: 1 }]);
    expect(h.sim.projectiles).toHaveLength(1);
    expect(h.worm(a).yaw).toBeCloseTo(Math.PI / 2, 6); // turned to face +x

    let peakY = target.pos[1];
    let peakX = target.pos[0];
    const ticks = runUntil(h, () => h.events('explosion').length > 0, 120);
    expect(ticks).toBeLessThan(30); // 10 m at 40 m/s ≈ 15 ticks
    const ex = h.events('explosion')[0]!;
    expect(ex.weapon).toBe('bazooka');
    expect(ex.kind).toBe('weapon');
    expect(ex.sourceWormId).toBe(a);
    expect(ex.radius).toBe(BAZOOKA_RADIUS);
    expect(ex.pos[0]).toBeGreaterThan(9.3);
    expect(ex.pos[0]).toBeLessThan(9.8);
    expect(ex.hits.map((x) => x.id)).toEqual([b]);
    const dmg = ex.hits[0]!.damage;
    expect(dmg).toBeGreaterThanOrEqual(40);
    expect(dmg).toBeLessThanOrEqual(BAZOOKA_DAMAGE);
    expect(target.hp).toBe(WORM_MAX_HP - dmg);
    expect(h.worm(a).hp).toBe(WORM_MAX_HP);
    expect(h.sim.projectiles).toHaveLength(0);
    expect(h.events('projectileRemoved')[0]!.reason).toBe('exploded');
    expect(target.state).toBe('knocked');

    h.run(240, [], () => {
      peakY = Math.max(peakY, target.pos[1]);
      peakX = Math.max(peakX, target.pos[0]);
    });
    console.log(
      `[bazooka] direct hit ${dmg} dmg, knockback ${ex.hits[0]!.knockback.map((v) => v.toFixed(2)).join(',')} m/s, ` +
        `flew ${(target.pos[0] - x0).toFixed(2)} m, peak +${(peakY - (ARENA_TOP + 0.6)).toFixed(2)} m`,
    );
    expect(target.pos[0] - x0).toBeGreaterThan(3);
    expect(peakY).toBeGreaterThan(ARENA_TOP + 1.5);
    expect(target.alive).toBe(true);
    expect(target.grounded).toBe(true);
    expect(target.state).toBe('idle'); // recovered after landing
  });

  it('ground hit next to a worm: falloff damage, no damage outside the radius', () => {
    const shot = { weapon: 'bazooka', dir: aim(1, 0, 20), power: 0.25 };
    // Calibration: where does this shot land on an empty arena?
    const cal = arena({ worms: [[0, 0]] });
    cal.h.run(1, [{ type: 'fire', wormId: cal.ids[0]!, ...shot }]);
    const land = landing(cal.h).explosion!.pos;
    cal.h.dispose();
    expect(land[1]).toBeCloseTo(ARENA_TOP + 0.12, 1);

    const { h, ids } = arena({
      worms: [
        [0, 0],
        [land[0] + 1.5, 0],
        [land[0] + 1.5, 4],
      ],
    });
    current = h;
    const [a, near, far] = ids as [number, number, number];
    h.run(1, [{ type: 'fire', wormId: a, ...shot }]);
    const { explosion } = landing(h);
    expect(explosion!.pos[0]).toBeCloseTo(land[0], 1);
    const hit = explosion!.hits.find((x) => x.id === near);
    expect(hit).toBeDefined();
    console.log(`[bazooka] ground hit 1.5 m from a worm: ${hit!.damage} dmg`);
    expect(hit!.damage).toBeGreaterThan(15);
    expect(hit!.damage).toBeLessThan(40);
    expect(hit!.knockback[0]).toBeGreaterThan(0);
    expect(hit!.knockback[1]).toBeGreaterThan(0);
    expect(explosion!.hits.find((x) => x.id === far)).toBeUndefined();
    expect(h.worm(far).hp).toBe(WORM_MAX_HP);
  });

  it('wind deflects the shot: +z wind lands at +z, −z wind mirrors it', () => {
    const shoot = (wind: number) => {
      const { h, ids } = arena({ wind: [0, wind], worms: [[-20, 0]] });
      h.run(1, [{ type: 'fire', wormId: ids[0]!, weapon: 'bazooka', dir: aim(1, 0, 45), power: 0.3 }]);
      const { removed } = landing(h);
      h.dispose();
      return removed.pos;
    };
    const calm = shoot(0);
    const plus = shoot(5);
    const minus = shoot(-5);
    console.log(
      `[bazooka] wind landing z: calm ${calm[2].toFixed(2)}, +5 ${plus[2].toFixed(2)}, -5 ${minus[2].toFixed(2)} ` +
        `(x ${calm[0].toFixed(1)} / ${plus[0].toFixed(1)} / ${minus[0].toFixed(1)})`,
    );
    expect(Math.abs(calm[2])).toBeLessThan(0.05);
    expect(plus[2]).toBeGreaterThan(8);
    expect(minus[2]).toBeLessThan(-8);
    expect(plus[2] + minus[2]).toBeCloseTo(0, 1);
    expect(plus[0]).toBeCloseTo(calm[0], 0);
  });

  it('shooting straight up in strong wind lands downwind and spares the shooter', () => {
    const { h, ids } = arena({ wind: [4, 0], worms: [[0, 0]] });
    current = h;
    h.run(1, [{ type: 'fire', wormId: ids[0]!, weapon: 'bazooka', dir: [0, 1, 0], power: 0.3 }]);
    const { removed, explosion } = landing(h);
    console.log(
      `[bazooka] straight up, wind +4 x: landed at x ${removed.pos[0].toFixed(2)} z ${removed.pos[2].toFixed(2)}`,
    );
    expect(removed.reason).toBe('exploded');
    expect(explosion!.pos[0]).toBeGreaterThan(15);
    expect(Math.abs(explosion!.pos[2])).toBeLessThan(0.05);
    expect(h.worm(ids[0]!).hp).toBe(WORM_MAX_HP);
  });

  it('straight up without wind comes back down on the shooter (owner grace only covers launch)', () => {
    const { h, ids } = arena({ worms: [[0, 0]] });
    current = h;
    h.run(1, [{ type: 'fire', wormId: ids[0]!, weapon: 'bazooka', dir: [0, 1, 0], power: 0 }]);
    const { explosion } = landing(h);
    expect(explosion!.hits.map((x) => x.id)).toEqual([ids[0]!]);
    expect(explosion!.hits[0]!.damage).toBeGreaterThan(40);
  });

  it('shots into the sea are removed as "water" without exploding', () => {
    const { h, ids } = arena({ half: 8, worms: [[0, 0]] });
    current = h;
    h.run(1, [{ type: 'fire', wormId: ids[0]!, weapon: 'bazooka', dir: aim(1, 0, 30), power: 0.5 }]);
    const { removed, explosion } = landing(h);
    expect(removed.reason).toBe('water');
    expect(removed.pos[1]).toBeLessThan(h.sim.waterLevel);
    expect(explosion).toBeUndefined();
  });

  it('dead worms (gravestones) do not block shots', () => {
    const { h, ids } = arena({
      worms: [
        [0, 0],
        [5, 0],
        [10, 0],
      ],
    });
    current = h;
    const [a, dead, b] = ids as [number, number, number];
    h.sim.worm(dead)!.damage(WORM_MAX_HP, 'fall');
    h.run(5); // its small death blast goes off (and pushes nobody: 5 m away)
    expect(h.worm(dead).alive).toBe(false);
    h.run(1, [{ type: 'fire', wormId: a, weapon: 'bazooka', dir: [1, 0, 0], power: 1 }]);
    runUntil(h, () => h.events('explosion').length > 1, 120);
    const ex = h.events('explosion')[1]!;
    expect(ex.weapon).toBe('bazooka');
    expect(ex.pos[0]).toBeGreaterThan(9);
    expect(ex.hits.map((x) => x.id)).toEqual([b]);
  });

  it('ignores invalid fire commands (dead/unknown worm, unknown weapon, zero dir, no ammo)', () => {
    const { h, ids } = arena({ worms: [[0, 0]] });
    current = h;
    const id = ids[0]!;
    h.sim.setAmmo(0, 'bazooka', 1);
    h.run(1, [
      { type: 'fire', wormId: 99, weapon: 'bazooka', dir: [1, 0, 0], power: 1 },
      { type: 'fire', wormId: id, weapon: 'nope', dir: [1, 0, 0], power: 1 },
      { type: 'fire', wormId: id, weapon: 'bazooka', dir: [0, 0, 0], power: 1 },
      { type: 'fire', wormId: id, weapon: 'bazooka', dir: [1, 0, 0], power: 1 },
      { type: 'fire', wormId: id, weapon: 'bazooka', dir: [1, 0, 0], power: 1 },
    ]);
    expect(h.events('commandIgnored').map((e) => e.reason)).toEqual([
      'no worm 99',
      'unknown weapon nope',
      'invalid aim direction',
      'out of ammo: bazooka',
    ]);
    expect(h.events('weaponFired')).toHaveLength(1);
    expect(h.sim.getAmmo(0, 'bazooka')).toBe(0);
    expect(h.sim.getAmmo(1, 'bazooka')).toBe(-1);
  });
});
