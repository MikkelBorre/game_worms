import * as THREE from 'three';

export interface Sky {
  sun: THREE.DirectionalLight;
  /** Keep the shadow frustum / sky dome centred on the camera. */
  update(camera: THREE.Camera): void;
}

/** M0 STUB – render-engineer replaces with sky, fog and lighting in M1. */
export function createSky(scene: THREE.Scene): Sky {
  scene.background = new THREE.Color(0x87c5eb);
  scene.fog = new THREE.Fog(0x87c5eb, 150, 400);
  scene.add(new THREE.HemisphereLight(0xdff3ff, 0x4a5a3a, 1.2));
  const sun = new THREE.DirectionalLight(0xffffff, 2);
  sun.position.set(60, 100, 40);
  scene.add(sun);
  return { sun, update: () => {} };
}
