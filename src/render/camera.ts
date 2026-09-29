import type * as THREE from 'three';
import type { Vec3 } from '../core/math';

export type CameraMode = 'free' | 'overview';

export interface CameraRig {
  mode: CameraMode;
  setMode(mode: CameraMode): void;
  /** Place the camera explicitly (used by debug API / screenshots). */
  setPose(position: Vec3, target: Vec3): void;
  update(dt: number): void;
  dispose(): void;
}

/** M0 STUB – render-engineer replaces with free-fly + overview cameras in M1. */
export function createCameraRig(camera: THREE.PerspectiveCamera, _dom: HTMLElement): CameraRig {
  const rig: CameraRig = {
    mode: 'overview',
    setMode(mode) {
      rig.mode = mode;
    },
    setPose(p, t) {
      camera.position.set(p[0], p[1], p[2]);
      camera.lookAt(t[0], t[1], t[2]);
    },
    update: () => {},
    dispose: () => {},
  };
  return rig;
}
