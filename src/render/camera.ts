import * as THREE from 'three';
import type { Vec3 } from '../core/math';
import { WATER_LEVEL } from '../terrain/types';

export type CameraMode = 'free' | 'overview' | 'follow' | 'aim';

/** What the follow/aim cameras track: worm centre (render-interpolated) + facing yaw (worm convention). */
export interface CameraTarget {
  pos: Vec3;
  yaw: number;
}

export interface CameraRigOptions {
  /**
   * Distance along the unit direction `dir` from `origin` to the first terrain hit within maxDist, or null.
   * Used for camera collision and the aim point. Arrays passed in are reused scratch – do not keep them.
   */
  raycast?: (origin: Vec3, dir: Vec3, maxDist: number) => number | null;
  /** Current water level (default WATER_LEVEL). The camera stays above it unless the target is below. */
  waterLevel?: () => number;
}

export interface CameraRig {
  mode: CameraMode;
  /** Switch mode with a damped transition. */
  setMode(mode: CameraMode): void;
  /** Place the camera explicitly (used by debug API / screenshots). Immediate, no damping. */
  setPose(position: Vec3, target: Vec3): void;
  /** The worm to follow/aim from, or null. The getter is called once per update. */
  setTarget(get: (() => CameraTarget | null) | null): void;
  /**
   * Hard cut behind the target (turn change / spawn): yaw = target yaw, default pitch, no damping.
   * Switches free/overview to 'follow'; keeps 'aim'. No-op without a target.
   */
  snapToTarget(): void;
  /** Camera yaw in the worm convention: forward = [sin(h), 0, cos(h)] (look direction on XZ). */
  heading(): number;
  /** Unit world vector from the target worm toward the crosshair (screen centre). */
  aimDirection(out?: Vec3): Vec3;
  update(dt: number): void;
  dispose(): void;
}

/** Tweakables. */
export const CAMERA = {
  /** Overview orbit: centre, horizontal radius, height above centre, angular speed (rad/s). */
  orbitCenter: [0, 6, 0] as Vec3,
  orbitRadius: 132,
  orbitHeight: 78,
  orbitSpeed: 0.045,
  /** Exponential damping rates (1/s) for position / rotation when blending into overview. */
  blendPos: 2.2,
  blendRot: 3.0,
  /** Free-fly speeds (m/s) and velocity damping (1/s). */
  flySpeed: 22,
  flyFastMul: 3.5,
  flyDamping: 9,
  /** Radians per pixel of mouse movement. */
  lookSensitivity: 0.0022,
  maxPitch: Math.PI / 2 - 0.01,

  /** Follow: orbit distance, look-at height above worm centre, default pitch (rad, + = looking down). */
  followDistance: 6.2,
  followLookHeight: 0.75,
  followPitch: 0.3,
  followMinPitch: -0.3,
  followMaxPitch: 1.25,
  /** Aim (over the shoulder): distance behind, offset to the right, pivot height above worm centre. */
  aimDistance: 2.8,
  aimRight: 0.75,
  aimHeight: 1.0,
  aimPitch: 0.08,
  aimMinPitch: -1.25,
  aimMaxPitch: 1.3,
  /** Aim ray length when nothing is hit, and the muzzle height above the worm centre. */
  aimRange: 80,
  aimMuzzleHeight: 0.25,
  /** Pivot smoothing (1/s): horizontal / vertical (vertical softer so hops don't bounce the view). */
  pivotRateXZ: 14,
  pivotRateY: 7,
  /** Steady-state position / rotation damping (1/s) in follow/aim, and during mode transitions. */
  steadyPos: 22,
  steadyRot: 24,
  transitionPos: 3,
  transitionRot: 4,
  /** Seconds for a transition to ramp from transition rates to steady rates. */
  transitionTime: 0.9,
  /** Collision: gap kept in front of terrain hits, min distance, re-extend rate (1/s). */
  collisionMargin: 0.35,
  collisionMinDist: 0.9,
  collisionRelax: 3,
  /** Minimum camera height above the water level (unless the target is under water). */
  waterClearance: 0.3,
};

const MOVE_KEYS = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'KeyE',
  'KeyQ',
  'KeyC',
  'Space',
  'ShiftLeft',
  'ShiftRight',
]);

const clamp = THREE.MathUtils.clamp;
const damp = (rate: number, dt: number): number => 1 - Math.exp(-rate * dt);

/**
 * Camera rig: debug free-fly, slow overview orbit, third-person follow and over-the-shoulder aim.
 * Mode changes are damped; only setPose() and snapToTarget() cut. Pure render-side: never touches sim state.
 *
 * Input: Tab toggles overview ↔ previous mode, right mouse held = aim (with a target), mouse (pointer lock
 * or drag) looks/orbits, WASD/Space/E/C/Q fly only in 'free' mode.
 */
export function createCameraRig(
  camera: THREE.PerspectiveCamera,
  dom: HTMLElement,
  opts: CameraRigOptions = {},
): CameraRig {
  const keys = new Set<string>();
  const velocity = new THREE.Vector3();
  const euler = new THREE.Euler(0, 0, 0, 'YXZ');
  const center = new THREE.Vector3(...CAMERA.orbitCenter);
  const up = new THREE.Vector3(0, 1, 0);
  // Scratch objects – no allocations per frame.
  const wish = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  const right = new THREE.Vector3();
  const tmpM = new THREE.Matrix4();
  const tmpQ = new THREE.Quaternion();
  const pivot = new THREE.Vector3();
  const look = new THREE.Vector3();
  const desired = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const rayO: Vec3 = [0, 0, 0];
  const rayD: Vec3 = [0, 0, 0];

  // Free-fly angles (three.js convention).
  let yaw = 0;
  let pitch = 0;
  // Follow/aim angles: heading in the worm convention, pitch + = looking down.
  let orbitYaw = 0;
  let orbitPitch = CAMERA.followPitch;
  let orbitAngle = Math.PI / 2;
  let snap = true; // first overview update places the camera directly
  let dragging = false;
  let rmbHeld = false;
  let lastNonOverview: CameraMode = 'free';
  let targetGet: (() => CameraTarget | null) | null = null;
  let pivotValid = false;
  let collDist = -1;
  let blend = 1; // 0 right after a mode change → 1 steady
  let lastHeading = 0;

  const waterLevel = () => (opts.waterLevel ? opts.waterLevel() : WATER_LEVEL);

  const syncAnglesFromCamera = () => {
    camera.getWorldDirection(fwd);
    yaw = Math.atan2(-fwd.x, -fwd.z);
    pitch = Math.asin(clamp(fwd.y, -1, 1));
  };
  const applyAngles = () => {
    euler.set(pitch, yaw, 0, 'YXZ');
    camera.quaternion.setFromEuler(euler);
  };
  const isTargetMode = (m: CameraMode) => m === 'follow' || m === 'aim';
  const pitchLimits = (m: CameraMode): [number, number] =>
    m === 'aim' ? [CAMERA.aimMinPitch, CAMERA.aimMaxPitch] : [CAMERA.followMinPitch, CAMERA.followMaxPitch];

  /**
   * Orbit yaw that keeps the current viewing direction onto the target (smooth entry into follow/aim).
   * Pitch resets to the mode default: coming from the high overview would otherwise look straight down.
   */
  const orbitFromCamera = (t: CameraTarget | null, mode: CameraMode) => {
    if (t) {
      dir.set(t.pos[0] - camera.position.x, 0, t.pos[2] - camera.position.z);
      if (dir.lengthSq() > 1e-6) orbitYaw = Math.atan2(dir.x, dir.z);
    } else {
      camera.getWorldDirection(fwd);
      if (Math.abs(fwd.x) + Math.abs(fwd.z) > 1e-4) orbitYaw = Math.atan2(fwd.x, fwd.z);
    }
    orbitPitch = mode === 'aim' ? CAMERA.aimPitch : CAMERA.followPitch;
  };

  const rig: CameraRig = {
    mode: 'overview',
    setMode(mode) {
      if (mode === rig.mode) return;
      const prev = rig.mode;
      rig.mode = mode;
      velocity.set(0, 0, 0);
      if (mode !== 'free') keys.clear();
      if (mode !== 'overview') lastNonOverview = mode === 'aim' ? 'follow' : mode;
      if (mode === 'free') {
        syncAnglesFromCamera();
        applyAngles();
      } else if (mode === 'overview') {
        // Continue the orbit from where the camera currently is → shortest, smooth blend.
        orbitAngle = Math.atan2(camera.position.z - center.z, camera.position.x - center.x);
        releaseLock();
      } else {
        const t = targetGet ? targetGet() : null;
        // follow ↔ aim share yaw; pitch keeps the player's offset from the mode default.
        // Entering from free/overview keeps the current viewing direction (yaw) → smooth swoop in.
        if (!isTargetMode(prev)) {
          orbitFromCamera(t, mode);
          pivotValid = false;
          collDist = -1;
        } else if (mode === 'aim') orbitPitch += CAMERA.aimPitch - CAMERA.followPitch;
        else orbitPitch += CAMERA.followPitch - CAMERA.aimPitch;
        const [lo, hi] = pitchLimits(mode);
        orbitPitch = clamp(orbitPitch, lo, hi);
      }
      blend = 0;
    },
    setPose(p, t) {
      camera.position.set(p[0], p[1], p[2]);
      camera.lookAt(t[0], t[1], t[2]);
      camera.updateMatrixWorld();
      syncAnglesFromCamera();
      pitch = clamp(pitch, -CAMERA.maxPitch, CAMERA.maxPitch);
      applyAngles();
      camera.updateMatrixWorld();
      velocity.set(0, 0, 0);
      snap = false;
      blend = 1;
    },
    setTarget(get) {
      targetGet = get;
      pivotValid = false;
      collDist = -1;
      if (!get && rig.mode === 'aim') rig.setMode('follow');
    },
    snapToTarget() {
      const t = targetGet ? targetGet() : null;
      if (!t) return;
      if (!isTargetMode(rig.mode)) {
        rig.mode = 'follow';
        lastNonOverview = 'follow';
        keys.clear();
        velocity.set(0, 0, 0);
      }
      orbitYaw = t.yaw;
      orbitPitch = rig.mode === 'aim' ? CAMERA.aimPitch : CAMERA.followPitch;
      pivotValid = false;
      collDist = -1;
      blend = 1;
      updateTargetMode(0, t, true);
      camera.updateMatrixWorld();
    },
    heading() {
      if (isTargetMode(rig.mode)) return (lastHeading = orbitYaw);
      camera.getWorldDirection(fwd);
      if (Math.abs(fwd.x) + Math.abs(fwd.z) > 1e-4) lastHeading = Math.atan2(fwd.x, fwd.z);
      return lastHeading;
    },
    aimDirection(out = [0, 0, 0]) {
      camera.getWorldDirection(fwd);
      const t = targetGet ? targetGet() : null;
      if (!t || rig.mode !== 'aim') {
        // Not aiming: the orbit look direction.
        const cp = Math.cos(orbitPitch);
        out[0] = Math.sin(orbitYaw) * cp;
        out[1] = -Math.sin(orbitPitch);
        out[2] = Math.cos(orbitYaw) * cp;
        return out;
      }
      // Converge on what the crosshair (screen centre) looks at.
      rayO[0] = camera.position.x;
      rayO[1] = camera.position.y;
      rayO[2] = camera.position.z;
      rayD[0] = fwd.x;
      rayD[1] = fwd.y;
      rayD[2] = fwd.z;
      const hit = opts.raycast ? opts.raycast(rayO, rayD, CAMERA.aimRange) : null;
      const d = hit ?? CAMERA.aimRange;
      let x = camera.position.x + fwd.x * d - t.pos[0];
      let y = camera.position.y + fwd.y * d - (t.pos[1] + CAMERA.aimMuzzleHeight);
      let z = camera.position.z + fwd.z * d - t.pos[2];
      let len = Math.hypot(x, y, z);
      // Crosshair point too close / behind the worm: fall back to the camera direction.
      if (len < 0.5 || x * fwd.x + y * fwd.y + z * fwd.z <= 0) {
        x = fwd.x;
        y = fwd.y;
        z = fwd.z;
        len = 1;
      }
      out[0] = x / len;
      out[1] = y / len;
      out[2] = z / len;
      return out;
    },
    update(rawDt) {
      const dt = Math.min(Math.max(rawDt, 0), 0.1);
      blend = Math.min(1, blend + dt / CAMERA.transitionTime);
      if (rig.mode === 'overview') updateOverview(dt);
      else if (rig.mode === 'free') updateFree(dt);
      else {
        const t = targetGet ? targetGet() : null;
        if (t) updateTargetMode(dt, t, false);
      }
      camera.updateMatrixWorld();
    },
    dispose() {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      dom.removeEventListener('click', onClick);
      dom.removeEventListener('mousedown', onMouseDown);
      dom.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('mousemove', onMouseMove);
      releaseLock();
    },
  };

  function updateOverview(dt: number): void {
    orbitAngle += CAMERA.orbitSpeed * dt;
    wish.set(
      center.x + Math.cos(orbitAngle) * CAMERA.orbitRadius,
      center.y + CAMERA.orbitHeight,
      center.z + Math.sin(orbitAngle) * CAMERA.orbitRadius,
    );
    tmpM.lookAt(wish, center, up);
    tmpQ.setFromRotationMatrix(tmpM);
    if (snap) {
      camera.position.copy(wish);
      camera.quaternion.copy(tmpQ);
      snap = false;
      return;
    }
    camera.position.lerp(wish, damp(CAMERA.blendPos, dt));
    camera.quaternion.slerp(tmpQ, damp(CAMERA.blendRot, dt));
  }

  function updateFree(dt: number): void {
    wish.set(0, 0, 0);
    if (keys.size > 0) {
      fwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
      right.set(1, 0, 0).applyQuaternion(camera.quaternion);
      if (keys.has('KeyW')) wish.add(fwd);
      if (keys.has('KeyS')) wish.sub(fwd);
      if (keys.has('KeyD')) wish.add(right);
      if (keys.has('KeyA')) wish.sub(right);
      if (keys.has('Space') || keys.has('KeyE')) wish.y += 1;
      if (keys.has('KeyC') || keys.has('KeyQ')) wish.y -= 1;
      if (wish.lengthSq() > 0) {
        const fast = keys.has('ShiftLeft') || keys.has('ShiftRight');
        wish.normalize().multiplyScalar(CAMERA.flySpeed * (fast ? CAMERA.flyFastMul : 1));
      }
    }
    velocity.lerp(wish, damp(CAMERA.flyDamping, dt));
    if (wish.lengthSq() === 0 && velocity.lengthSq() < 1e-4) velocity.set(0, 0, 0);
    camera.position.addScaledVector(velocity, dt);
    applyAngles();
  }

  /** Follow / aim. `cut` places the camera exactly (no damping). */
  function updateTargetMode(dt: number, t: CameraTarget, cut: boolean): void {
    const aim = rig.mode === 'aim';
    const [px, py, pz] = t.pos;
    // Smoothed pivot (worm centre); aim tracks tighter.
    if (!pivotValid || cut) {
      pivot.set(px, py, pz);
      pivotValid = true;
    } else {
      const kxz = damp(aim ? CAMERA.pivotRateXZ * 2 : CAMERA.pivotRateXZ, dt);
      const ky = damp(aim ? CAMERA.pivotRateY * 2 : CAMERA.pivotRateY, dt);
      pivot.x += (px - pivot.x) * kxz;
      pivot.y += (py - pivot.y) * ky;
      pivot.z += (pz - pivot.z) * kxz;
    }

    const cp = Math.cos(orbitPitch);
    dir.set(Math.sin(orbitYaw) * cp, -Math.sin(orbitPitch), Math.cos(orbitYaw) * cp); // look direction
    right.set(-Math.cos(orbitYaw), 0, Math.sin(orbitYaw)); // forward × up
    const dist = aim ? CAMERA.aimDistance : CAMERA.followDistance;
    // Point the camera orbits around / looks from: above the worm (+ shoulder offset when aiming).
    look.copy(pivot);
    look.y += aim ? CAMERA.aimHeight : CAMERA.followLookHeight;

    // Collision: cast from the worm-side point toward the desired camera position.
    let allowed = dist;
    let shoulder = CAMERA.aimRight;
    if (opts.raycast) {
      rayO[0] = look.x;
      rayO[1] = look.y;
      rayO[2] = look.z;
      if (aim) {
        // Shoulder offset first (short ray sideways), then backwards.
        rayD[0] = right.x;
        rayD[1] = 0;
        rayD[2] = right.z;
        const side = opts.raycast(rayO, rayD, CAMERA.aimRight + CAMERA.collisionMargin);
        if (side !== null) shoulder = Math.max(0, side - CAMERA.collisionMargin);
        rayO[0] += right.x * shoulder;
        rayO[2] += right.z * shoulder;
      }
      rayD[0] = -dir.x;
      rayD[1] = -dir.y;
      rayD[2] = -dir.z;
      const hit = opts.raycast(rayO, rayD, dist + CAMERA.collisionMargin);
      if (hit !== null) allowed = Math.max(CAMERA.collisionMinDist, hit - CAMERA.collisionMargin);
    }
    if (collDist < 0 || cut || allowed < collDist)
      collDist = allowed; // pull in instantly
    else collDist += (allowed - collDist) * damp(CAMERA.collisionRelax, dt); // ease back out

    if (aim) look.addScaledVector(right, shoulder);
    desired.copy(look).addScaledVector(dir, -collDist);
    const minY = waterLevel() + CAMERA.waterClearance;
    if (py >= waterLevel() && desired.y < minY) desired.y = minY;

    // Orientation: aim looks along yaw/pitch (crosshair = screen centre); follow looks at the pivot.
    if (aim) wish.copy(desired).add(dir);
    else wish.copy(look);

    if (cut) {
      camera.position.copy(desired);
      tmpM.lookAt(camera.position, wish, up);
      camera.quaternion.setFromRotationMatrix(tmpM);
      return;
    }
    const b = blend * blend;
    const kPos = damp(CAMERA.transitionPos + (CAMERA.steadyPos - CAMERA.transitionPos) * b, dt);
    const kRot = damp(CAMERA.transitionRot + (CAMERA.steadyRot - CAMERA.transitionRot) * b, dt);
    camera.position.lerp(desired, kPos);
    if (aim) {
      // Keep the aim direction parallel to yaw/pitch (not converging on a point that moves with the camera).
      tmpM.lookAt(desired, wish, up);
    } else {
      tmpM.lookAt(camera.position, wish, up);
    }
    tmpQ.setFromRotationMatrix(tmpM);
    camera.quaternion.slerp(tmpQ, kRot);
  }

  // --- Input -----------------------------------------------------------------
  const isTyping = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (isTyping(e)) return;
    if (e.code === 'Tab') {
      e.preventDefault();
      if (e.repeat) return;
      if (rig.mode !== 'overview') rig.setMode('overview');
      else rig.setMode(isTargetMode(lastNonOverview) && !targetGet ? 'free' : lastNonOverview);
      return;
    }
    if (rig.mode === 'free' && MOVE_KEYS.has(e.code)) {
      keys.add(e.code);
      if (e.code === 'Space') e.preventDefault();
    }
  };
  const onKeyUp = (e: KeyboardEvent) => {
    keys.delete(e.code);
  };
  const onBlur = () => {
    keys.clear();
    dragging = false;
    if (rmbHeld) {
      rmbHeld = false;
      if (rig.mode === 'aim') rig.setMode('follow');
    }
  };
  const isLocked = () => document.pointerLockElement === dom;
  const releaseLock = () => {
    try {
      if (isLocked()) document.exitPointerLock();
    } catch {
      /* ignore */
    }
  };
  const onClick = () => {
    if (rig.mode === 'overview') {
      rig.setMode(isTargetMode(lastNonOverview) && !targetGet ? 'free' : lastNonOverview);
    }
    if (isLocked()) return;
    try {
      const r = dom.requestPointerLock() as unknown;
      if (r instanceof Promise) r.catch(() => {});
    } catch {
      /* pointer lock unavailable (headless, iframe) – drag-to-look still works */
    }
  };
  const onMouseDown = (e: MouseEvent) => {
    if (e.button === 0 || e.button === 2) dragging = true;
    if (e.button === 2 && targetGet) {
      rmbHeld = true;
      rig.setMode('aim');
    }
  };
  const onMouseUp = (e: MouseEvent) => {
    dragging = false;
    if (e.button === 2 && rmbHeld) {
      rmbHeld = false;
      if (rig.mode === 'aim') rig.setMode('follow');
    }
  };
  const onContextMenu = (e: MouseEvent) => e.preventDefault();
  const onMouseMove = (e: MouseEvent) => {
    if (rig.mode === 'overview') return;
    if (!isLocked() && !dragging) return;
    if (rig.mode === 'free') {
      yaw -= e.movementX * CAMERA.lookSensitivity;
      pitch -= e.movementY * CAMERA.lookSensitivity;
      pitch = clamp(pitch, -CAMERA.maxPitch, CAMERA.maxPitch);
      return;
    }
    // follow / aim: mouse right turns right (heading decreases), mouse up looks up.
    orbitYaw -= e.movementX * CAMERA.lookSensitivity;
    if (orbitYaw > Math.PI) orbitYaw -= Math.PI * 2;
    else if (orbitYaw < -Math.PI) orbitYaw += Math.PI * 2;
    const [lo, hi] = pitchLimits(rig.mode);
    orbitPitch = clamp(orbitPitch + e.movementY * CAMERA.lookSensitivity, lo, hi);
  };

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  dom.addEventListener('click', onClick);
  dom.addEventListener('mousedown', onMouseDown);
  dom.addEventListener('contextmenu', onContextMenu);
  window.addEventListener('mouseup', onMouseUp);
  window.addEventListener('mousemove', onMouseMove);

  return rig;
}
