/**
 * Wind: a constant XZ acceleration (m/s²) on affectedByWind projectiles. Seeded per match now, per turn in M4.
 */
import type { Vec2 } from '../core/math';
import { Rng } from '../core/rng';

// ---------------------------------------------------------------------------
// Balance constants – tweak here.
// ---------------------------------------------------------------------------

/** Strongest seeded wind (m/s²). A full-power bazooka (≈3 s flight) drifts ≈ ½·5·3² ≈ 22 m at max wind. */
export const WIND_MAX = 5;
/** `setWind` commands are clamped per axis to ±this (m/s²). */
export const WIND_COMMAND_LIMIT = 30;

// ---------------------------------------------------------------------------

const WIND_SALT = 0x77696e64; // 'wind'

/**
 * Deterministic wind for a seed (and optional round, for M4): uniform over the disc of radius WIND_MAX.
 * Rejection sampling instead of sin/cos so every JS engine gets bit-identical values.
 */
export function windFromSeed(seed: number, round = 0): Vec2 {
  const rng = new Rng(seed).fork(WIND_SALT ^ Math.imul(round, 0x9e3779b1));
  for (let i = 0; i < 64; i++) {
    const x = rng.range(-1, 1);
    const z = rng.range(-1, 1);
    if (x * x + z * z <= 1) return [quantize(x * WIND_MAX), quantize(z * WIND_MAX)];
  }
  return [0, 0];
}

/** Clamp a commanded wind; non-finite components become 0. */
export function sanitizeWind(w: Vec2): Vec2 {
  const c = (v: number) =>
    Number.isFinite(v) ? Math.max(-WIND_COMMAND_LIMIT, Math.min(WIND_COMMAND_LIMIT, v)) : 0;
  return [c(w[0]), c(w[1])];
}

/** mm/s² resolution keeps displays and hashes tidy. */
const quantize = (v: number) => Math.round(v * 1000) / 1000;
