import * as THREE from 'three';
import type { HeightmapData } from '../terrain/types';
import { WATER_LEVEL } from '../terrain/types';

export interface Water {
  object: THREE.Object3D;
  /** Terrain heightmap, used for shoreline foam / depth tint. */
  setHeightmap(h: HeightmapData): void;
  update(timeSec: number, camera: THREE.Camera): void;
  dispose(): void;
}

/** M0 STUB – render-engineer replaces with the animated water shader in M1. */
export function createWater(): Water {
  const geo = new THREE.PlaneGeometry(1200, 1200);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshLambertMaterial({ color: 0x1e7fbf, transparent: true, opacity: 0.85 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = WATER_LEVEL;
  return {
    object: mesh,
    setHeightmap: () => {},
    update: () => {},
    dispose: () => {
      geo.dispose();
      mat.dispose();
    },
  };
}
