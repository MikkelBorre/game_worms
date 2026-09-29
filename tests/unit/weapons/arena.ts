import type { Vec2, Vec3 } from '../../../src/core/math';
import { WORM_CENTER_TO_FEET } from '../../../src/sim/worm';
import { Harness } from '../simHarness';

/** Flat ground top (m) of the weapon arenas: well above the water level (0). */
export const ARENA_TOP = 5;

/** Headless arena: flat static ground at ARENA_TOP (±half m), given wind, worms settled on the ground. */
export function arena(opts: { wind?: Vec2; half?: number; worms?: [number, number][]; seed?: number } = {}) {
  const h = new Harness(opts.seed ?? 7);
  h.ground(ARENA_TOP, opts.half ?? 60);
  h.run(1, [{ type: 'setWind', wind: opts.wind ?? [0, 0] }]);
  const ids = (opts.worms ?? []).map(([x, z], i) => h.spawn(standing(x, z), i));
  h.run(60);
  return { h, ids };
}

export const standing = (x: number, z: number): Vec3 => [x, ARENA_TOP + WORM_CENTER_TO_FEET + 0.05, z];

export const norm = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
};

/** Unit direction at `elevDeg` above the horizon, heading along XZ vector (x, z). */
export function aim(x: number, z: number, elevDeg: number): Vec3 {
  const e = (elevDeg * Math.PI) / 180;
  const l = Math.hypot(x, z);
  return [(x / l) * Math.cos(e), Math.sin(e), (z / l) * Math.cos(e)];
}

/** Step until `pred` is true (max n ticks). Returns ticks run. */
export function runUntil(h: Harness, pred: () => boolean, n = 1200): number {
  for (let i = 0; i < n; i++) {
    if (pred()) return i;
    h.sim.step([]);
  }
  return n;
}
