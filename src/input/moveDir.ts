import type { Vec2 } from '../core/math';

export interface MoveKeys {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
}

/** Angle quantisation for move commands (1/512 turn ≈ 0.7°) so mouse-look doesn't spam commands. */
const ANGLE_STEPS = 512;

/**
 * Convert held WASD keys + camera heading into a world-space XZ walk direction.
 * Heading uses the worm yaw convention: forward = [sin(h), cos(h)], right = [-cos(h), sin(h)].
 * Returns [0, 0] when no (or cancelling) keys are held; otherwise a unit vector with a quantised angle.
 */
export function moveDirFromKeys(keys: MoveKeys, heading: number): Vec2 {
  const f = (keys.forward ? 1 : 0) - (keys.back ? 1 : 0);
  const r = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
  if (f === 0 && r === 0) return [0, 0];
  const sin = Math.sin(heading);
  const cos = Math.cos(heading);
  const x = f * sin - r * cos;
  const z = f * cos + r * sin;
  const step = (Math.PI * 2) / ANGLE_STEPS;
  const angle = Math.round(Math.atan2(x, z) / step) * step;
  return [round6(Math.sin(angle)), round6(Math.cos(angle))];
}

const round6 = (v: number): number => Math.round(v * 1e6) / 1e6 + 0;

export const sameDir = (a: Vec2, b: Vec2): boolean => a[0] === b[0] && a[1] === b[1];
