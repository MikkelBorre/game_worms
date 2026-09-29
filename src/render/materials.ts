import * as THREE from 'three';

export interface TerrainMaterialOptions {
  /** Faceted normals via screen-space derivatives (low-poly look). Default false: marching-cubes
   * triangles are 0.5 m, so faceting reads as noise rather than chunky low-poly facets. */
  flatShading?: boolean;
}

/**
 * Toon ramp for the sun: 4 bands keyed on dot(N, L).
 * MeshToonMaterial samples the ramp at u = dot(N,L) * 0.5 + 0.5, so the left half is back-facing.
 * Bands (dot(N,L)): < 0 → 0 (ambient/hemisphere only, matches cast shadows), 0–0.25 → 0.59,
 * 0.25–0.5 → 0.84, > 0.5 → 1.
 */
const RAMP: readonly number[] = [0, 0, 0, 0, 0, 0, 0, 0, 150, 150, 215, 215, 255, 255, 255, 255];

let rampTexture: THREE.DataTexture | null = null;

export function getToonRamp(): THREE.DataTexture {
  if (rampTexture) return rampTexture;
  const data = new Uint8Array(RAMP.length * 4);
  RAMP.forEach((v, i) => {
    data[i * 4] = v;
    data[i * 4 + 1] = v;
    data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  });
  const tex = new THREE.DataTexture(data, RAMP.length, 1, THREE.RGBAFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  rampTexture = tex;
  return tex;
}

/** Stylized terrain material: vertex colours (linear rgb) + stepped toon lighting, fog and shadows. */
export function createTerrainMaterial(opts: TerrainMaterialOptions = {}): THREE.Material {
  const mat = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: getToonRamp() });
  // Not in MeshToonMaterial's typings, but WebGLPrograms honours material.flatShading for every material.
  (mat as unknown as { flatShading: boolean }).flatShading = opts.flatShading ?? false;
  return mat;
}
