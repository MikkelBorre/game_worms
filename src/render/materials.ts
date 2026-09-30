import * as THREE from 'three';
import { LIGHT } from './palette';

export interface TerrainMaterialOptions {
  /** Faceted normals via screen-space derivatives (low-poly look). Default false: marching-cubes
   * triangles are 0.5 m, so faceting reads as noise rather than chunky low-poly facets. */
  flatShading?: boolean;
}

/**
 * Toon ramp for the sun (per lighting preset, see palette.ts LIGHT.toonRamp).
 * MeshToonMaterial samples the ramp at u = dot(N,L) * 0.5 + 0.5, so the left half is back-facing and
 * stays 0 (hemisphere fill only, matching cast shadows).
 */
const RAMP: readonly number[] = LIGHT.toonRamp;

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
