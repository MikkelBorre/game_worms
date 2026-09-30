/**
 * Aim helper (render only): a short dotted ballistic preview of the first ~0.8 s of flight, shown while the
 * camera is in aim mode. No wind – it is a hint, not an aimbot. One InstancedMesh (1 draw call).
 */
import * as THREE from 'three';
import type { Vec3 } from '../core/math';
import { MUZZLE_DISTANCE, MUZZLE_HEIGHT } from '../sim/projectile';
import { BAZOOKA_MAX_SPEED, BAZOOKA_MIN_SPEED } from '../sim/weapons/bazooka';
import { GRENADE_MAX_SPEED, GRENADE_MIN_SPEED } from '../sim/weapons/grenade';
import { GRAVITY } from '../sim/world';

export const AIM_VIEW = {
  dots: 22,
  /** Seconds of flight previewed. */
  duration: 0.8,
  dotSize: 0.055,
  /** Dots shrink toward the end of the preview by this factor. */
  endScale: 0.45,
  /** Marching speed of the dots (fraction of the spacing per second). */
  march: 2.2,
  color: [1.6, 1.55, 1.3] as Vec3,
};

/** Launch speed (m/s) at power 0 and 1 for weapons with a ballistic preview. */
const LAUNCH_SPEED: Record<string, [number, number]> = {
  bazooka: [BAZOOKA_MIN_SPEED, BAZOOKA_MAX_SPEED],
  grenade: [GRENADE_MIN_SPEED, GRENADE_MAX_SPEED],
};

export class AimView {
  readonly mesh: THREE.InstancedMesh;
  private time = 0;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3();

  constructor(private readonly groundAt: ((x: number, z: number) => number) | null = null) {
    const geo = new THREE.IcosahedronGeometry(1, 0);
    const c = AIM_VIEW.color;
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(c[0], c[1], c[2]), fog: false });
    this.mesh = new THREE.InstancedMesh(geo, mat, AIM_VIEW.dots);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.visible = false;
    this.mesh.renderOrder = 3;
  }

  hide(): void {
    this.mesh.visible = false;
    this.mesh.count = 0;
  }

  /**
   * Show the preview from worm centre `origin` along unit `dir` at `power` (0..1) for `weapon`.
   * Weapons without a known launch speed hide the preview.
   */
  update(weapon: string, origin: Readonly<Vec3>, dir: Readonly<Vec3>, power: number, rawDt: number): void {
    const range = LAUNCH_SPEED[weapon];
    if (!range) return this.hide();
    this.time += Math.min(Math.max(rawDt, 0), 0.1);
    const speed = range[0] + (range[1] - range[0]) * Math.min(1, Math.max(0, power));
    const x0 = origin[0] + dir[0] * MUZZLE_DISTANCE;
    const y0 = origin[1] + MUZZLE_HEIGHT + dir[1] * MUZZLE_DISTANCE;
    const z0 = origin[2] + dir[2] * MUZZLE_DISTANCE;
    const vx = dir[0] * speed;
    const vy = dir[1] * speed;
    const vz = dir[2] * speed;
    const N = AIM_VIEW.dots;
    const step = AIM_VIEW.duration / N;
    const phase = (this.time * AIM_VIEW.march) % 1;
    let n = 0;
    for (let i = 0; i < N; i++) {
      const u = (i + phase) / N;
      const t = (i + phase) * step;
      const x = x0 + vx * t;
      const y = y0 + vy * t + 0.5 * GRAVITY * t * t;
      const z = z0 + vz * t;
      if (this.groundAt && y < this.groundAt(x, z)) break;
      const sc = AIM_VIEW.dotSize * (1 - (1 - AIM_VIEW.endScale) * u) * Math.min(1, (i + phase) * 0.8);
      this.m.compose(this.p.set(x, y, z), this.q, this.s.set(sc, sc, sc));
      this.mesh.setMatrixAt(n++, this.m);
    }
    this.mesh.count = n;
    this.mesh.visible = n > 0;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }
}
