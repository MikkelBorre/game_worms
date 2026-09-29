import * as THREE from 'three';
import type { Vec3 } from '../core/math';

export type CameraMode = 'free' | 'overview';

export interface CameraRig {
  mode: CameraMode;
  setMode(mode: CameraMode): void;
  /** Place the camera explicitly (used by debug API / screenshots). Immediate, no damping. */
  setPose(position: Vec3, target: Vec3): void;
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

/**
 * Debug free-fly camera + slow overview orbit. Tab toggles, transitions into the overview are damped;
 * entering free mode keeps the current pose. Pure render-side: never touches sim state.
 */
export function createCameraRig(camera: THREE.PerspectiveCamera, dom: HTMLElement): CameraRig {
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

  let yaw = 0;
  let pitch = 0;
  let orbitAngle = Math.PI / 2;
  let snap = true; // first overview update places the camera directly
  let dragging = false;

  const syncAnglesFromCamera = () => {
    camera.getWorldDirection(fwd);
    yaw = Math.atan2(-fwd.x, -fwd.z);
    pitch = Math.asin(THREE.MathUtils.clamp(fwd.y, -1, 1));
  };
  const applyAngles = () => {
    euler.set(pitch, yaw, 0, 'YXZ');
    camera.quaternion.setFromEuler(euler);
  };

  const rig: CameraRig = {
    mode: 'overview',
    setMode(mode) {
      if (mode === rig.mode) return;
      rig.mode = mode;
      velocity.set(0, 0, 0);
      if (mode === 'free') {
        syncAnglesFromCamera();
        applyAngles();
      } else {
        // Continue the orbit from where the camera currently is → shortest, smooth blend.
        orbitAngle = Math.atan2(camera.position.z - center.z, camera.position.x - center.x);
        releaseLock();
      }
    },
    setPose(p, t) {
      camera.position.set(p[0], p[1], p[2]);
      camera.lookAt(t[0], t[1], t[2]);
      camera.updateMatrixWorld();
      syncAnglesFromCamera();
      pitch = THREE.MathUtils.clamp(pitch, -CAMERA.maxPitch, CAMERA.maxPitch);
      applyAngles();
      camera.updateMatrixWorld();
      velocity.set(0, 0, 0);
      snap = false;
    },
    update(rawDt) {
      const dt = Math.min(Math.max(rawDt, 0), 0.1);
      if (rig.mode === 'overview') updateOverview(dt);
      else updateFree(dt);
      camera.updateMatrixWorld();
    },
    dispose() {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      dom.removeEventListener('click', onClick);
      dom.removeEventListener('mousedown', onMouseDown);
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
    camera.position.lerp(wish, 1 - Math.exp(-CAMERA.blendPos * dt));
    camera.quaternion.slerp(tmpQ, 1 - Math.exp(-CAMERA.blendRot * dt));
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
    velocity.lerp(wish, 1 - Math.exp(-CAMERA.flyDamping * dt));
    if (wish.lengthSq() === 0 && velocity.lengthSq() < 1e-4) velocity.set(0, 0, 0);
    camera.position.addScaledVector(velocity, dt);
    applyAngles();
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
      if (!e.repeat) rig.setMode(rig.mode === 'free' ? 'overview' : 'free');
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
    if (rig.mode === 'overview') rig.setMode('free');
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
  };
  const onMouseUp = () => {
    dragging = false;
  };
  const onMouseMove = (e: MouseEvent) => {
    if (rig.mode !== 'free') return;
    if (!isLocked() && !dragging) return;
    yaw -= e.movementX * CAMERA.lookSensitivity;
    pitch -= e.movementY * CAMERA.lookSensitivity;
    pitch = THREE.MathUtils.clamp(pitch, -CAMERA.maxPitch, CAMERA.maxPitch);
  };

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  dom.addEventListener('click', onClick);
  dom.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mouseup', onMouseUp);
  window.addEventListener('mousemove', onMouseMove);

  return rig;
}
