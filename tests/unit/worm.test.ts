import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Command } from '../../src/core/commands';
import { Rng } from '../../src/core/rng';
import { initPhysics } from '../../src/sim/physics';
import {
  BACKFLIP_WINDOW_TICKS,
  fallDamage,
  FALL_DAMAGE_MIN_DROP,
  REST_AFTER_TICKS,
  REST_RECHECK_TICKS,
  WALK_SPEED,
  WORM_CENTER_TO_FEET,
  WORM_MAX_HP,
} from '../../src/sim/worm';
import { Harness } from './simHarness';

beforeAll(async () => {
  await initPhysics();
});

let h: Harness;
afterEach(() => h?.dispose());

/** Flat ground at y=0 with one worm standing (settled) at the origin. */
function flat(spawn: [number, number, number] = [0, 0.6, 0]) {
  h = new Harness().ground();
  const id = h.spawn(spawn);
  h.run(30);
  return id;
}

const STAND_Y = WORM_CENTER_TO_FEET;

describe('worm: walking', () => {
  it('settles on the ground after spawning', () => {
    const id = flat();
    const w = h.worm(id);
    expect(w.grounded).toBe(true);
    expect(w.state).toBe('idle');
    expect(w.pos[1]).toBeGreaterThan(STAND_Y - 0.02);
    expect(w.pos[1]).toBeLessThan(STAND_Y + 0.05);
    expect(w.hp).toBe(WORM_MAX_HP);
  });

  it('walks WALK_SPEED m/s in the commanded world direction and faces it', () => {
    const id = flat();
    h.run(120, [{ type: 'move', wormId: id, dir: [1, 0] }]);
    const w = h.worm(id);
    expect(w.pos[0]).toBeGreaterThan(WALK_SPEED * 2 * 0.99);
    expect(w.pos[0]).toBeLessThan(WALK_SPEED * 2 * 1.02);
    expect(Math.abs(w.pos[2])).toBeLessThan(0.01);
    expect(w.yaw).toBeCloseTo(Math.PI / 2, 5);
    expect(w.state).toBe('walk');
    expect(w.grounded).toBe(true);

    // Held intent persists until replaced; [0,0] stops.
    h.run(10, [{ type: 'move', wormId: id, dir: [0, 0] }]);
    const x = w.pos[0];
    h.run(30);
    expect(w.pos[0]).toBe(x);
    expect(w.state).toBe('idle');
  });

  it('clamps analog intent to length 1 and scales below it', () => {
    const id = flat();
    h.run(60, [{ type: 'move', wormId: id, dir: [0, 10] }]);
    expect(h.worm(id).pos[2]).toBeCloseTo(WALK_SPEED, 1);
    const z = h.worm(id).pos[2];
    h.run(60, [{ type: 'move', wormId: id, dir: [0, 0.5] }]);
    expect(h.worm(id).pos[2] - z).toBeCloseTo(WALK_SPEED * 0.5, 1);
  });

  it('face command sets yaw without moving', () => {
    const id = flat();
    h.run(5, [{ type: 'face', wormId: id, yaw: -Math.PI / 2 }]);
    expect(h.worm(id).yaw).toBeCloseTo(-Math.PI / 2, 6);
    expect(Math.abs(h.worm(id).pos[0])).toBeLessThan(1e-6);
  });

  it('climbs a 30° slope', () => {
    h = new Harness().ground().ramp(30, 2, 30);
    const id = h.spawn([0, 0.6, 0]);
    h.run(30).run(180, [{ type: 'move', wormId: id, dir: [1, 0] }]);
    const w = h.worm(id);
    expect(w.pos[1]).toBeGreaterThan(3);
    // On the ramp surface (not floating): y ≈ (x - 2)·tan30 + feet offset / cos30.
    const surf = (w.pos[0] - 2) * Math.tan(Math.PI / 6);
    expect(w.pos[1] - surf).toBeGreaterThan(0.3);
    expect(w.pos[1] - surf).toBeLessThan(1.0);
    expect(w.grounded).toBe(true);
  });

  it('cannot climb a 60° slope', () => {
    h = new Harness().ground().ramp(60, 2, 30);
    const id = h.spawn([0, 0.6, 0]);
    let maxY = 0;
    h.run(30).run(240, [{ type: 'move', wormId: id, dir: [1, 0] }], () => {
      maxY = Math.max(maxY, h.worm(id).pos[1]);
    });
    expect(maxY).toBeLessThan(1.0);
    expect(h.worm(id).pos[0]).toBeLessThan(2.5);
  });

  it('autosteps a 0.25 m ledge but is blocked by a 0.8 m wall', () => {
    h = new Harness().ground().box([4, 0.125, 0], [2, 0.125, 5]); // ledge top 0.25, x ∈ [2,6]
    const id = h.spawn([0, 0.6, 0]);
    h.run(30).run(120, [{ type: 'move', wormId: id, dir: [1, 0] }]);
    const w = h.worm(id);
    expect(w.pos[0]).toBeGreaterThan(4);
    expect(w.pos[1]).toBeGreaterThan(0.25 + STAND_Y - 0.02);
    h.dispose();

    h = new Harness().ground().box([4, 0.4, 0], [2, 0.4, 5]); // wall top 0.8
    const id2 = h.spawn([0, 0.6, 0]);
    h.run(30).run(120, [{ type: 'move', wormId: id2, dir: [1, 0] }]);
    expect(h.worm(id2).pos[0]).toBeLessThan(2);
    expect(h.worm(id2).pos[1]).toBeLessThan(STAND_Y + 0.1);
  });
});

describe('worm: jumping', () => {
  function track(id: number, ticks: number, cmds: Command[]) {
    const w = h.worm(id);
    const y0 = w.pos[1];
    let apex = y0;
    let liftoff = -1;
    let landed = -1;
    let i = 0;
    h.run(ticks, cmds, () => {
      i++;
      apex = Math.max(apex, w.pos[1]);
      if (liftoff < 0 && !w.grounded) liftoff = i;
      if (liftoff >= 0 && landed < 0 && w.grounded) landed = i;
    });
    return { rise: apex - y0, liftoff, landed };
  }

  it('single press: wind-up for the backflip window, then a forward jump along facing', () => {
    const id = flat();
    h.run(1, [{ type: 'face', wormId: id, yaw: 0 }]); // facing +Z
    const w = h.worm(id);
    h.run(1, [{ type: 'jump', wormId: id }]);
    expect(w.state).toBe('windup');
    const r = track(id, 150, []);
    expect(r.liftoff).toBe(BACKFLIP_WINDOW_TICKS - 1);
    expect(r.rise).toBeGreaterThan(1.0);
    expect(r.rise).toBeLessThan(1.6);
    expect(r.landed).toBeGreaterThan(0);
    expect(w.pos[2]).toBeGreaterThan(2.0);
    expect(w.pos[2]).toBeLessThan(3.0);
    expect(Math.abs(w.pos[0])).toBeLessThan(0.01);
    expect(w.hp).toBe(WORM_MAX_HP);
    expect(h.events('wormJumped')).toEqual([{ id, kind: 'forward' }]);
  });

  it('double press within the window: backflip goes backwards and higher', () => {
    const id = flat();
    h.run(1, [{ type: 'face', wormId: id, yaw: 0 }]);
    const w = h.worm(id);
    h.run(5, [{ type: 'jump', wormId: id }]);
    const r = track(id, 180, [{ type: 'jump', wormId: id }]);
    expect(r.liftoff).toBe(1);
    expect(r.rise).toBeGreaterThan(2.0);
    expect(r.rise).toBeLessThan(3.0);
    expect(w.pos[2]).toBeLessThan(-1.2);
    expect(w.pos[2]).toBeGreaterThan(-2.5);
    expect(w.yaw).toBe(0); // still facing forward
    expect(h.events('wormJumped')).toEqual([{ id, kind: 'backflip' }]);
  });

  it('explicit kind jumps immediately; cannot double-jump in the air', () => {
    const id = flat();
    h.run(1, [{ type: 'jump', wormId: id, kind: 'forward' }]);
    expect(h.worm(id).grounded).toBe(false);
    expect(h.worm(id).state).toBe('jump');
    h.run(10, [{ type: 'jump', wormId: id, kind: 'backflip' }]);
    h.run(10, [{ type: 'jump', wormId: id }]);
    h.run(60);
    expect(h.events('wormJumped')).toHaveLength(1);
    expect(h.worm(id).grounded).toBe(true);
  });

  it('air control is reduced compared to walking', () => {
    const id = flat();
    h.run(1, [{ type: 'jump', wormId: id, kind: 'forward' }]); // +Z
    h.run(40, [{ type: 'move', wormId: id, dir: [1, 0] }]);
    const w = h.worm(id);
    expect(w.grounded).toBe(false);
    expect(w.pos[0]).toBeGreaterThan(0.2);
    expect(w.pos[0]).toBeLessThan(WALK_SPEED * (40 / 60) * 0.6);
  });
});

describe('worm: fall damage', () => {
  it('fallDamage curve', () => {
    expect(fallDamage(4)).toBe(0);
    expect(fallDamage(6)).toBe(0);
    expect(fallDamage(10)).toBe(20);
    expect(fallDamage(100)).toBe(50);
  });

  function dropFrom(height: number) {
    h = new Harness().ground().box([0, height / 2, 0], [1, height / 2, 1]);
    const id = h.spawn([0, height + 0.6, 0]);
    h.run(30);
    expect(h.worm(id).grounded).toBe(true);
    h.run(150, [{ type: 'move', wormId: id, dir: [1, 0] }]);
    return h.worm(id);
  }

  it('walking off a 10 m pillar hurts', () => {
    const w = dropFrom(10);
    expect(w.grounded).toBe(true);
    expect(w.pos[1]).toBeLessThan(1);
    // Landing is detected within the controller's ground-prediction distance, so allow ±0.5 m.
    expect(WORM_MAX_HP - w.hp).toBeGreaterThanOrEqual(fallDamage(9.5));
    expect(WORM_MAX_HP - w.hp).toBeLessThanOrEqual(fallDamage(10.5));
    const dmg = h.events('wormDamaged');
    expect(dmg).toHaveLength(1);
    expect(dmg[0]!.cause).toBe('fall');
  });

  it('walking off a 4 m pillar does not', () => {
    const w = dropFrom(4);
    expect(w.pos[1]).toBeLessThan(1);
    expect(w.hp).toBe(WORM_MAX_HP);
    expect(h.events('wormLanded').at(-1)!.drop).toBeGreaterThan(3.5);
  });

  it('the spawn drop never hurts', () => {
    const id = flat([0, 30, 0]);
    h.run(120);
    expect(h.worm(id).grounded).toBe(true);
    expect(h.worm(id).hp).toBe(WORM_MAX_HP);
  });
});

describe('worm: water', () => {
  it('walking off the island into the sea kills instantly and freezes the body', () => {
    h = new Harness()
      .box([-5, 1.5, 0], [8, 0.5, 5]) // cliff top y=2, x ∈ [-13, 3]
      .box([0, -6, 0], [50, 0.5, 50]); // sea floor
    const id = h.spawn([0, 2.6, 0]);
    h.run(30).run(180, [{ type: 'move', wormId: id, dir: [1, 0] }]);
    const w = h.worm(id);
    expect(w.alive).toBe(false);
    expect(w.hp).toBe(0);
    expect(w.state).toBe('dead');
    const died = h.events('wormDied');
    expect(died).toHaveLength(1);
    expect(died[0]!.cause).toBe('water');
    expect(died[0]!.pos[1]).toBeLessThan(0);
    expect(died[0]!.pos[1]).toBeGreaterThan(-0.5);
    expect(h.sim.worm(id)!.body.isEnabled()).toBe(false);
    const pos = [...w.pos];
    h.run(60, [{ type: 'move', wormId: id, dir: [-1, 0] }]);
    expect(w.pos).toEqual(pos);
    expect(h.events('commandIgnored').at(-1)!.reason).toBe('worm is dead');
  });
});

describe('worm: knockback', () => {
  it('applyImpulse makes the worm ballistic, then it recovers when grounded and slow', () => {
    const id = flat();
    const w = h.worm(id);
    h.sim.worm(id)!.applyImpulse([6, 5, 0]);
    expect(w.state).toBe('knocked');
    let maxY = 0;
    let recoveredAt = -1;
    let i = 0;
    // Player input is ignored while knocked.
    h.run(
      240,
      [
        { type: 'move', wormId: id, dir: [-1, 0] },
        { type: 'jump', wormId: id },
      ],
      () => {
        i++;
        maxY = Math.max(maxY, w.pos[1]);
        if (recoveredAt < 0 && w.state !== 'knocked') recoveredAt = i;
      },
    );
    expect(maxY).toBeGreaterThan(STAND_Y + 1);
    expect(recoveredAt).toBeGreaterThan(30);
    expect(recoveredAt).toBeLessThan(150);
    expect(h.events('wormJumped')).toHaveLength(0);
    // Flew well along +x before regaining control and walking back (-x) afterwards.
    expect(w.grounded).toBe(true);
    expect(w.alive).toBe(true);
    expect(h.events('wormLanded').length).toBeGreaterThan(0);
  });

  it('knockback is stopped by walls', () => {
    h = new Harness().ground().box([3, 3, 0], [0.5, 3, 5]); // wall at x ∈ [2.5, 3.5]
    const id = h.spawn([0, 0.6, 0]);
    h.run(30);
    h.sim.worm(id)!.applyImpulse([15, 2, 0]);
    h.run(180);
    const w = h.worm(id);
    expect(w.pos[0]).toBeLessThan(2.5);
    expect(w.state).toBe('idle');
  });
});

describe('worm: steep ground', () => {
  it('does not stand on a 70° face: slides down it, cannot jump off it, slow slide does not hurt', () => {
    // 70° face rising along +x from x=0; a 1 m ledge sticks out of it at y=8 (face at y=8 is x≈2.91).
    const xFace = (y: number) => y / Math.tan((70 * Math.PI) / 180);
    h = new Harness().ground().ramp(70, 0, 14);
    h.box([xFace(8) - 0.5, 7.9, 0], [0.5, 0.1, 1]);
    const ledge = h.last!;
    const id = h.spawn([xFace(8) - 0.45, 8.6, 0]);
    h.run(40);
    const w = h.worm(id);
    expect(w.grounded).toBe(true);
    expect(w.pos[1]).toBeGreaterThan(8.5);

    h.sim.physics.removeCollider(ledge, true);
    h.sim.wakeWorms();
    let groundedOnFace = 0;
    h.run(20, [], () => {
      if (w.grounded && w.pos[1] > 1) groundedOnFace++;
    });
    // Drops off, hits the face and slides; never counts as standing on it.
    expect(w.pos[1]).toBeLessThan(8);
    expect(w.pos[1]).toBeGreaterThan(2);
    expect(w.state).toBe('fall');
    h.run(1, [{ type: 'jump', wormId: id, kind: 'backflip' }]); // no wall-jumps
    h.run(300, [], () => {
      if (w.grounded && w.pos[1] > 1) groundedOnFace++;
    });
    expect(groundedOnFace).toBe(0);
    expect(h.events('wormJumped')).toHaveLength(0);
    expect(w.grounded).toBe(true);
    expect(w.pos[1]).toBeLessThan(STAND_Y + 0.15); // (in the corner, partly on the ramp box's lower edge)
    // 8 m down, but braked by the face: counted drop is the speed-equivalent height, below the damage threshold.
    const landed = h.events('wormLanded').at(-1)!;
    expect(landed.drop).toBeLessThan(FALL_DAMAGE_MIN_DROP);
    expect(w.hp).toBe(WORM_MAX_HP);
  });

  it('stands still on a 40° slope (no creep) and goes to rest', () => {
    h = new Harness().ground().ramp(40, 2, 20);
    const id = h.spawn([8, 6.5, 0]);
    h.run(120);
    const w = h.worm(id);
    expect(w.grounded).toBe(true);
    expect(w.state).toBe('idle');
    const p = [...w.pos];
    h.run(300);
    expect(Math.hypot(w.pos[0] - p[0]!, w.pos[1] - p[1]!, w.pos[2] - p[2]!)).toBeLessThan(1e-3);
    expect(h.sim.worm(id)!.resting).toBe(true);
  });

  it('a worm wedged in a V-crevice of two 60° faces counts as standing and can jump out', () => {
    h = new Harness().ramp(60, 0, 6, 5, 1).ramp(60, 0, 6, 5, -1);
    const id = h.spawn([0.05, 3, 0]);
    h.run(90);
    const w = h.worm(id);
    expect(w.pos[1]).toBeLessThan(1.2);
    expect(w.grounded).toBe(true);
    expect(w.state).toBe('idle');

    // Walking into the crevice wall: the controller maxes out its iterations without progress ⇒ jammed
    // (skips the controller); the pose stays, re-sending the same intent does not unjam it, a jump does.
    const p = [...w.pos];
    h.run(30, [{ type: 'move', wormId: id, dir: [1, 0] }]);
    expect(h.sim.worm(id)!.jammed).toBe(true);
    h.run(30, [{ type: 'move', wormId: id, dir: [1, 0] }]);
    expect(h.sim.worm(id)!.jammed).toBe(true);
    expect(w.state).toBe('walk');
    expect(Math.hypot(w.pos[0] - p[0]!, w.pos[1] - p[1]!, w.pos[2] - p[2]!)).toBeLessThan(0.01);
    h.run(1, [{ type: 'jump', wormId: id, kind: 'backflip' }]);
    expect(h.sim.worm(id)!.jammed).toBe(false);
    expect(h.events('wormJumped')).toHaveLength(1);
  });

  it('a worm spawned in mid-air cannot jump before it has landed', () => {
    h = new Harness().ground();
    const id = h.spawn([0, 5, 0]);
    h.run(1, [{ type: 'jump', wormId: id, kind: 'forward' }]);
    h.run(90);
    expect(h.events('wormJumped')).toHaveLength(0);
    expect(h.worm(id).grounded).toBe(true);
  });
});

describe('worm: resting (CPU saver)', () => {
  it('rests when idle, wakes on commands and keeps behaving identically', () => {
    const id = flat();
    const worm = h.sim.worm(id)!;
    h.run(REST_AFTER_TICKS + 2);
    expect(worm.resting).toBe(true);
    h.run(1, [{ type: 'move', wormId: id, dir: [1, 0] }]);
    expect(worm.resting).toBe(false);
    h.run(59);
    expect(h.worm(id).pos[0]).toBeGreaterThan(WALK_SPEED * 0.98);
    h.run(REST_AFTER_TICKS + 2, [{ type: 'move', wormId: id, dir: [0, 0] }]);
    expect(worm.resting).toBe(true);
    h.run(1, [{ type: 'jump', wormId: id, kind: 'backflip' }]);
    expect(worm.resting).toBe(false);
    expect(h.events('wormJumped')).toHaveLength(1);
  });

  it('a resting worm falls at once when woken after its ground is removed, and on its own soon after', () => {
    h = new Harness().box([0, -8, 0], [20, 0.5, 20]); // floor far below
    h.sim.waterLevel = -100;
    h.box([0, -0.5, 0], [2, 0.5, 2]);
    const platformA = h.last!;
    h.box([10, -0.5, 0], [2, 0.5, 2]);
    const platformB = h.last!;
    const a = h.spawn([0, 0.6, 0]);
    const b = h.spawn([10, 0.6, 0]);
    h.run(40);
    expect(h.sim.worm(a)!.resting).toBe(true);
    expect(h.sim.worm(b)!.resting).toBe(true);

    h.sim.physics.removeCollider(platformA, true);
    h.sim.physics.removeCollider(platformB, true);
    h.sim.wakeWorms([0, 0, 0], 3); // only A is woken explicitly (e.g. by an explosion there)
    h.run(3);
    expect(h.worm(a).grounded).toBe(false);
    expect(h.worm(b).pos[1]).toBeCloseTo(STAND_Y, 1); // B still resting, re-checks within REST_RECHECK_TICKS
    h.run(REST_RECHECK_TICKS);
    expect(h.worm(b).grounded).toBe(false);
    h.run(120);
    expect(h.worm(a).pos[1]).toBeLessThan(-6);
    expect(h.worm(b).pos[1]).toBeLessThan(-6);
  });
});

describe('worm: worm-worm interaction', () => {
  it('worms walk through each other: no blocking, no carrying, no standing on heads', () => {
    h = new Harness().ground();
    const a = h.spawn([0, 0.6, 0]);
    const b = h.spawn([3, 0.6, 0]);
    const c = h.spawn([6, 3, 0]); // dropped right onto d
    const d = h.spawn([6, 0.6, 0]);
    h.run(40);
    const bPos = [...h.worm(b).pos];
    h.run(120, [{ type: 'move', wormId: a, dir: [1, 0] }]);
    expect(h.worm(a).pos[0]).toBeGreaterThan(5.5); // walked straight through b
    expect(h.worm(b).pos).toEqual(bPos); // and b was not pushed or dragged along
    expect(h.worm(b).state).toBe('idle');
    expect(h.worm(c).pos[1]).toBeCloseTo(STAND_Y, 1); // fell through d onto the ground
    expect(h.worm(d).pos[1]).toBeCloseTo(STAND_Y, 1);
    // Overlapping idle worms stay put (Rapier would otherwise treat each as the other's moving platform).
    const cPos = [...h.worm(c).pos];
    h.run(120);
    const cNow = h.worm(c).pos;
    expect(Math.hypot(cNow[0] - cPos[0]!, cNow[1] - cPos[1]!, cNow[2] - cPos[2]!)).toBeLessThan(1e-3);
  });
});

describe('sim determinism & perf', () => {
  /** A busy scenario: 16 worms, ramps, ledges, pits; seeded random command log. */
  function scenario(seed: number, cmdSeed: number, ticks: number, timing?: number[]) {
    h = new Harness(seed)
      .box([0, -0.5, 0], [20, 0.5, 20])
      .ramp(30, 5, 12, 4)
      .ramp(60, -10, 8, 3)
      .box([0, 0.125, 8], [3, 0.125, 3])
      .box([-8, 3, -8], [1.5, 3, 1.5])
      .box([0, -8, 0], [60, 0.5, 60]); // sea floor beyond the island edge
    const rng = new Rng(cmdSeed);
    const ids: number[] = [];
    for (let i = 0; i < 16; i++)
      ids.push(h.spawn([rng.range(-15, 15), rng.range(1, 8), rng.range(-15, 15)], i % 4));
    for (let t = 0; t < ticks; t++) {
      const cmds: Command[] = [];
      for (const id of ids) {
        const r = rng.next();
        if (r < 0.03) {
          const a = rng.range(-Math.PI, Math.PI);
          cmds.push({ type: 'move', wormId: id, dir: [Math.sin(a), Math.cos(a)] });
        } else if (r < 0.035) cmds.push({ type: 'jump', wormId: id });
        else if (r < 0.037) cmds.push({ type: 'move', wormId: id, dir: [0, 0] });
        else if (r < 0.038) h.sim.worm(id)!.applyImpulse([rng.range(-5, 5), 4, rng.range(-5, 5)]);
      }
      const t0 = performance.now();
      h.sim.step(cmds);
      timing?.push(performance.now() - t0);
    }
    const out = { hash: h.sim.hash(), snap: h.sim.snapshot() };
    h.dispose();
    return out;
  }

  it('same seed + command log ⇒ identical hash after 600 ticks', () => {
    const a = scenario(7, 99, 600);
    const b = scenario(7, 99, 600);
    expect(a.hash).toBe(b.hash);
    expect(a.snap).toEqual(b.snap);
    const c = scenario(7, 100, 600);
    expect(c.hash).not.toBe(a.hash);
    // Something actually happened.
    expect(a.snap.worms.some((w) => w.alive)).toBe(true);
  });

  it('hash is stable across snapshot calls and changes with state', () => {
    const id = flat();
    const h1 = h.sim.hash();
    expect(h.sim.hash()).toBe(h1);
    h.run(10, [{ type: 'move', wormId: id, dir: [1, 0] }]);
    expect(h.sim.hash()).not.toBe(h1);
  });

  it('16 worms: sim step well under the 3 ms/tick budget', () => {
    const timing: number[] = [];
    scenario(3, 5, 600, timing);
    const avg = timing.reduce((s, v) => s + v, 0) / timing.length;
    const sorted = [...timing].sort((x, y) => x - y);
    const p95 = sorted[Math.floor(sorted.length * 0.95)]!;
    console.log(`[perf] 16 worms: avg ${avg.toFixed(3)} ms/tick, p95 ${p95.toFixed(3)} ms`);
    expect(avg).toBeLessThan(3);
  });
});
