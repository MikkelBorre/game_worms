export type Vec3 = [number, number, number];
/** Horizontal (XZ) vector: [x, z]. */
export type Vec2 = [number, number];

export const vec3 = (x = 0, y = 0, z = 0): Vec3 => [x, y, z];

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export const lerpVec3 = (a: Vec3, b: Vec3, t: number, out: Vec3 = [0, 0, 0]): Vec3 => {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
  return out;
};
