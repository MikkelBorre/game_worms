/**
 * Trauma-based screen shake (render only).
 *
 * Explosions add trauma ∝ blast radius, falling off with distance to the camera; trauma decays linearly and the
 * visible shake is trauma² (small bumps stay subtle, big hits kick hard). The offset is applied to the camera
 * AFTER the camera rig has updated and removed again BEFORE the next rig update, so the rig's damping never
 * sees (or smooths) the shake. Deterministic smooth noise from summed sines – no Math.random.
 */
import * as THREE from 'three';
import type { Vec3 } from '../core/math';

export const SHAKE = {
  /** Trauma added per metre of blast radius at point-blank range (bazooka R=3 ⇒ 0.78). */
  perRadius: 0.26,
  /** Distance (m) beyond the blast radius at which the added trauma has halved. */
  falloffDist: 9,
  /** Trauma lost per second. */
  decay: 1.35,
  /** Peak translation (m) and rotation (rad) at trauma 1. */
  maxOffset: 0.32,
  maxPitchYaw: 0.022,
  maxRoll: 0.04,
  /** Noise frequency (Hz-ish). */
  frequency: 19,
};

export class ScreenShake {
  /** 0..1 */
  trauma = 0;
  private time = 0;
  private applied = false;
  private readonly offset = new THREE.Vector3();
  private readonly dq = new THREE.Quaternion();
  private readonly dqInv = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  /** Camera pose right after apply() – restore() only undoes the shake if nobody moved the camera since. */
  private readonly shakenPos = new THREE.Vector3();
  private readonly shakenQuat = new THREE.Quaternion();

  add(amount: number): void {
    this.trauma = Math.min(1, this.trauma + Math.max(0, amount));
  }

  /** Trauma for an explosion of `radius` at `pos` seen from `camPos`. */
  addExplosion(pos: Readonly<Vec3>, radius: number, camPos: THREE.Vector3): void {
    const d = Math.hypot(pos[0] - camPos.x, pos[1] - camPos.y, pos[2] - camPos.z);
    const beyond = Math.max(0, d - radius);
    this.add((SHAKE.perRadius * radius) / (1 + beyond / SHAKE.falloffDist));
  }

  /** Undo last frame's offset (call before the camera rig updates). */
  restore(camera: THREE.Camera): void {
    if (!this.applied) return;
    this.applied = false;
    if (!camera.position.equals(this.shakenPos) || !camera.quaternion.equals(this.shakenQuat)) return;
    camera.position.sub(this.offset);
    camera.quaternion.multiply(this.dqInv);
  }

  /** Advance time/decay and offset the camera (call after the rig updated, before rendering). */
  apply(camera: THREE.Camera, rawDt: number): void {
    const dt = Math.min(Math.max(rawDt, 0), 0.1);
    this.time += dt;
    this.trauma = Math.max(0, this.trauma - SHAKE.decay * dt);
    if (this.trauma <= 0) return;
    const s = this.trauma * this.trauma;
    const t = this.time * SHAKE.frequency;
    const n1 = noise(t, 0);
    const n2 = noise(t, 1.7);
    const n3 = noise(t, 3.1);
    const n4 = noise(t, 4.9);
    const n5 = noise(t, 6.3);
    // Translation in camera space (right/up only – moving along the view axis reads as zoom, not shake).
    this.offset.set(n1 * SHAKE.maxOffset * s, n2 * SHAKE.maxOffset * s, 0).applyQuaternion(camera.quaternion);
    this.e.set(n3 * SHAKE.maxPitchYaw * s, n4 * SHAKE.maxPitchYaw * s, n5 * SHAKE.maxRoll * s, 'YXZ');
    this.dq.setFromEuler(this.e);
    this.dqInv.copy(this.dq).invert();
    camera.position.add(this.offset);
    camera.quaternion.multiply(this.dq);
    camera.updateMatrixWorld();
    this.shakenPos.copy(camera.position);
    this.shakenQuat.copy(camera.quaternion);
    this.applied = true;
  }

  reset(): void {
    this.trauma = 0;
  }
}

/** Smooth pseudo-noise in [-1, 1] from incommensurate sines. */
function noise(t: number, seed: number): number {
  return (
    Math.sin(t * 1.0 + seed * 12.9898) * 0.5 +
    Math.sin(t * 2.31 + seed * 78.233) * 0.3 +
    Math.sin(t * 4.77 + seed * 37.719) * 0.2
  );
}
