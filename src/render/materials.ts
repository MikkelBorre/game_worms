import * as THREE from 'three';

/** M0 STUB – render-engineer replaces with the stylized/toon terrain material in M1. */
export function createTerrainMaterial(): THREE.Material {
  return new THREE.MeshLambertMaterial({ vertexColors: true });
}
