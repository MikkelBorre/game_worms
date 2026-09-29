import * as THREE from 'three';
import type { HeightmapData } from '../terrain/types';
import { WATER_LEVEL } from '../terrain/types';
import { SUN_DIRECTION, WATER, SKY, LIGHT } from './palette';

export interface Water {
  object: THREE.Object3D;
  /** Terrain heightmap, used for shoreline foam / depth tint. Can be called again after a seed change. */
  setHeightmap(h: HeightmapData): void;
  update(timeSec: number, camera: THREE.Camera): void;
  dispose(): void;
}

/** Half extent (m) of the finely tessellated centre of the ocean grid. */
const INNER_HALF = 150;
/** Cells across the inner grid (2 m cells). */
const INNER_SEGMENTS = 150;
/** Half extent (m) of the whole ocean; well past fog end so its edge is never visible. */
const OUTER_HALF = 1600;
/** Geometrically growing cells per side between INNER_HALF and OUTER_HALF. */
const OUTER_SEGMENTS = 20;
/** Signed shore distance (m) used where no heightmap is loaded or for clamping. */
const FAR_DISTANCE = 60;

const waterVertex = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
#include <shadowmap_pars_vertex>

uniform float uTime;
uniform float uAmp;
uniform vec2 uWaveFade;
uniform sampler2D uTerrain;
uniform vec4 uHmRect; // minX, minZ, 1/size, hasHeightmap
uniform float uWaterLevel;

varying vec3 vWorldPos;
varying vec2 vTerrain; // x: water depth (m), y: signed horizontal distance to shore (m, + = water)

// Gentle swell: 4 directional sines. Returns height and d/dx, d/dz.
vec3 swell(vec2 p, float t) {
  vec3 r = vec3(0.0);
  // dir.x, dir.y, wavenumber, speed (rad/s); amplitude below
  const vec4 W0 = vec4(0.83, 0.56, 0.36, 1.10);
  const vec4 W1 = vec4(-0.45, 0.89, 0.52, 1.45);
  const vec4 W2 = vec4(0.20, -0.98, 0.78, 1.90);
  const vec4 W3 = vec4(-0.93, -0.36, 1.15, 2.40);
  const vec4 A = vec4(0.11, 0.075, 0.045, 0.028);
  float ph;
  ph = dot(W0.xy, p) * W0.z + t * W0.w; r += A.x * vec3(sin(ph), W0.z * W0.xy * cos(ph));
  ph = dot(W1.xy, p) * W1.z + t * W1.w; r += A.y * vec3(sin(ph), W1.z * W1.xy * cos(ph));
  ph = dot(W2.xy, p) * W2.z + t * W2.w; r += A.z * vec3(sin(ph), W2.z * W2.xy * cos(ph));
  ph = dot(W3.xy, p) * W3.z + t * W3.w; r += A.w * vec3(sin(ph), W3.z * W3.xy * cos(ph));
  return r;
}

void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec2 uv = (wp.xz - uHmRect.xy) * uHmRect.z;
  vec2 terr = texture2D(uTerrain, uv).rg;
  float depth = uWaterLevel - terr.r;
  // Calmer right at the beach, fading to a flat far ocean (fragment normals keep it lively).
  float amp = uAmp * (1.0 - smoothstep(uWaveFade.x, uWaveFade.y, length(wp.xz)));
  amp *= 0.45 + 0.55 * smoothstep(0.0, 3.0, depth);
  wp.y += swell(wp.xz, uTime).x * amp;
  vWorldPos = wp.xyz;
  vTerrain = vec2(depth, terr.g);
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  vec4 worldPosition = wp;
  #include <shadowmap_vertex>
  #include <fog_vertex>
}
`;

const waterFragment = /* glsl */ `
#include <common>
#include <packing>
#include <fog_pars_fragment>
#include <lights_pars_begin>
#include <shadowmap_pars_fragment>
#include <shadowmask_pars_fragment>

uniform float uTime;
uniform float uAmp;
uniform vec2 uWaveFade;
uniform sampler2D uTerrain;
uniform vec4 uHmRect;
uniform float uWaterLevel;
uniform vec3 uShallow;
uniform vec3 uMid;
uniform vec3 uDeep;
uniform vec3 uFoam;
uniform vec3 uSky;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec2 uDepths;   // midDepth, deepDepth
uniform vec3 uFoamParams; // width, stripe spacing, speed
uniform vec2 uShade;    // specular, fresnel

varying vec3 vWorldPos;
varying vec2 vTerrain;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
             mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}

// Same swell as the vertex shader (gradient only) plus two short ripples for sparkle.
vec2 slope(vec2 p, float t, float ampSwell, float ampRipple) {
  const vec4 W0 = vec4(0.83, 0.56, 0.36, 1.10);
  const vec4 W1 = vec4(-0.45, 0.89, 0.52, 1.45);
  const vec4 W2 = vec4(0.20, -0.98, 0.78, 1.90);
  const vec4 W3 = vec4(-0.93, -0.36, 1.15, 2.40);
  const vec4 A = vec4(0.11, 0.075, 0.045, 0.028);
  const vec4 R0 = vec4(0.60, -0.80, 2.4, 3.3);
  const vec4 R1 = vec4(-0.71, -0.70, 3.3, 4.1);
  vec2 g = vec2(0.0);
  g += A.x * W0.z * W0.xy * cos(dot(W0.xy, p) * W0.z + t * W0.w) * ampSwell;
  g += A.y * W1.z * W1.xy * cos(dot(W1.xy, p) * W1.z + t * W1.w) * ampSwell;
  g += A.z * W2.z * W2.xy * cos(dot(W2.xy, p) * W2.z + t * W2.w) * ampSwell;
  g += A.w * W3.z * W3.xy * cos(dot(W3.xy, p) * W3.z + t * W3.w) * ampSwell;
  g += 0.009 * R0.z * R0.xy * cos(dot(R0.xy, p) * R0.z + t * R0.w) * ampRipple;
  g += 0.006 * R1.z * R1.xy * cos(dot(R1.xy, p) * R1.z + t * R1.w) * ampRipple;
  return g;
}

void main() {
  float depth = vTerrain.x;
  float shoreDist = vTerrain.y;
  vec3 toCam = cameraPosition - vWorldPos;
  float viewDist = length(toCam);
  vec3 V = toCam / viewDist;

  // --- Normal -------------------------------------------------------------
  float nearFade = 1.0 - smoothstep(40.0, 260.0, viewDist); // tame aliasing far away
  float swellAmp = uAmp * (1.0 - smoothstep(uWaveFade.x, uWaveFade.y, length(vWorldPos.xz)));
  swellAmp = max(swellAmp, 0.5 * uAmp) * (0.45 + 0.55 * smoothstep(0.0, 3.0, depth));
  swellAmp *= mix(0.2, 1.0, nearFade);
  vec2 g = slope(vWorldPos.xz, uTime, swellAmp, uAmp * nearFade);
  vec3 N = normalize(vec3(-g.x, 1.0, -g.y));

  // --- Base colour by depth -------------------------------------------------
  float dShallow = max(depth, 0.0);
  vec3 col = mix(uShallow, uMid, smoothstep(0.0, uDepths.x, dShallow));
  col = mix(col, uDeep, smoothstep(uDepths.x * 0.8, uDepths.y, dShallow));
  // Light shallow tint also hugs the coast horizontally (reads on steep cliffs too).
  col = mix(col, uShallow, (1.0 - smoothstep(0.0, 8.0, shoreDist)) * 0.5);

  // --- Lighting: soft diffuse, fresnel sky, crisp cartoon sun glint ----------
  float shadow = getShadowMask();
  float ndl = dot(N, uSunDir);
  col *= (0.8 + 0.25 * clamp(ndl, 0.0, 1.0)) * mix(0.72, 1.0, shadow);
  // Fresnel from a flattened normal: full-strength normals make grazing angles streaky.
  vec3 Nf = normalize(mix(vec3(0.0, 1.0, 0.0), N, 0.35));
  float fres = pow(1.0 - clamp(dot(Nf, V), 0.0, 1.0), 5.0);
  col = mix(col, uSky, fres * uShade.y);
  // Broad sun path from the flattened normal (no streaks) + small crisp sparkles from the ripple normal
  // (ripples fade with distance, so sparkles only appear up close).
  float rsSoft = max(dot(reflect(-V, Nf), uSunDir), 0.0);
  float rsCrisp = max(dot(reflect(-V, N), uSunDir), 0.0);
  float glint = smoothstep(0.6, 0.66, pow(rsCrisp, 1400.0)) * 0.75 * (1.0 - smoothstep(25.0, 80.0, viewDist)) + pow(rsSoft, 24.0) * 0.22;
  col += uSunColor * glint * uShade.x * shadow;

  // --- Shoreline foam ------------------------------------------------------
  float n1 = vnoise(vWorldPos.xz * 0.35 + vec2(uTime * 0.11, -uTime * 0.07));
  float n2 = vnoise(vWorldPos.xz * 1.1 - vec2(uTime * 0.19, uTime * 0.15));
  float nz = n1 * 0.7 + n2 * 0.3 - 0.5;
  float width = uFoamParams.x;
  float sd = shoreDist + nz * 0.8;
  // Solid swash line (covers the water/terrain intersection, also on the land side).
  float line = 1.0 - smoothstep(0.55, 0.7, sd);
  // Stripes travelling towards the shore, getting thinner until they vanish at 'width'.
  float phase = sd / uFoamParams.y + uTime * uFoamParams.z;
  float thick = 0.5 * (1.0 - clamp(sd / width, 0.0, 1.0));
  float fp = fract(phase);
  float stripe = smoothstep(1.0 - thick, 1.0 - thick + 0.04, fp) * step(0.02, thick);
  // Foam over barely-submerged shoals.
  float shoal = 1.0 - smoothstep(0.1, 0.16, depth + nz * 0.15);
  float foam = max(max(line, stripe), shoal);
  // > 1 so it still reads as white after ACES tone mapping; darker in the terrain's shadow.
  vec3 foamCol = uFoam * (1.25 + 0.2 * clamp(ndl, 0.0, 1.0)) * mix(0.7, 1.0, shadow);
  col = mix(col, foamCol, foam);

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

/**
 * Stylized ocean: one mesh / one draw call. A 2 m grid over the island that grows geometrically to the
 * horizon, vertex swell, depth tint + shoreline foam from the terrain heightmap, cartoon sun glint and fog.
 */
export function createWater(): Water {
  const geo = buildOceanGeometry();
  // 1×1 placeholder: deep water everywhere until a heightmap arrives.
  let terrainTex = makeTerrainTexture(1, new Uint16Array([toHalf(-50), toHalf(FAR_DISTANCE)]));
  const uniforms = {
    ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
    ...THREE.UniformsUtils.clone(THREE.UniformsLib.lights),
    uTime: { value: 0 },
    uAmp: { value: WATER.waveAmplitude },
    uWaveFade: { value: new THREE.Vector2(WATER.waveFadeStart, WATER.waveFadeEnd) },
    uTerrain: { value: terrainTex as THREE.Texture },
    uHmRect: { value: new THREE.Vector4(-0.5, -0.5, 1, 0) },
    uWaterLevel: { value: WATER_LEVEL },
    uShallow: { value: new THREE.Color(WATER.shallow) },
    uMid: { value: new THREE.Color(WATER.mid) },
    uDeep: { value: new THREE.Color(WATER.deep) },
    uFoam: { value: new THREE.Color(WATER.foam) },
    uSky: { value: new THREE.Color(SKY.horizon) },
    uSunDir: { value: new THREE.Vector3(...SUN_DIRECTION).normalize() },
    uSunColor: { value: new THREE.Color(LIGHT.sunColor) },
    uDepths: { value: new THREE.Vector2(WATER.midDepth, WATER.deepDepth) },
    uFoamParams: { value: new THREE.Vector3(WATER.foamWidth, WATER.foamStripeSpacing, WATER.foamSpeed) },
    uShade: { value: new THREE.Vector2(WATER.specular, WATER.fresnel) },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: waterVertex,
    fragmentShader: waterFragment,
    fog: true,
    lights: true, // only used for the sun's shadow map (getShadowMask)
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'water';
  mesh.position.y = WATER_LEVEL;
  mesh.frustumCulled = false;
  mesh.receiveShadow = true;
  // Draw after the (default renderOrder 0) terrain so early-z rejects ocean pixels hidden by the island.
  mesh.renderOrder = 1;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();

  return {
    object: mesh,
    setHeightmap(h) {
      const res = h.resolution;
      const data = encodeTerrain(h);
      if (terrainTex.image.width === res) {
        (terrainTex.image.data as Uint16Array).set(data);
        terrainTex.needsUpdate = true;
      } else {
        terrainTex.dispose();
        terrainTex = makeTerrainTexture(res, data);
        uniforms.uTerrain.value = terrainTex;
      }
      // Map world xz to texel centres: sample 0 sits at minX, sample res-1 at minX + size.
      const step = h.size / (res - 1);
      uniforms.uHmRect.value.set(h.minX - step / 2, h.minZ - step / 2, 1 / (step * res), 1);
    },
    update(timeSec) {
      uniforms.uTime.value = timeSec;
    },
    dispose() {
      geo.dispose();
      mat.dispose();
      terrainTex.dispose();
    },
  };
}

function makeTerrainTexture(res: number, data: Uint16Array): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, res, res, THREE.RGFormat, THREE.HalfFloatType);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

const toHalf = (v: number) => THREE.DataUtils.toHalfFloat(v);

/**
 * Pack (terrain height, signed horizontal distance to the shoreline) per texel as half floats.
 * Distance is Euclidean to the nearest sub-texel zero crossing: seeds are placed where the bilinear
 * surface crosses water level, then nearest-seed positions are propagated with two 8-neighbour sweeps
 * (8SSEDT-style). This gives a smooth, constant-width foam band regardless of beach slope.
 */
function encodeTerrain(h: HeightmapData): Uint16Array {
  const n = h.resolution;
  const hs = h.heights;
  const cell = h.size / (n - 1);
  const wl = WATER_LEVEL;
  // Nearest crossing point (texel units) per texel; NaN = none yet.
  const sx = new Float32Array(n * n).fill(NaN);
  const sz = new Float32Array(n * n).fill(NaN);
  const d2 = new Float32Array(n * n).fill(Infinity);

  const seed = (i: number, x: number, z: number, px: number, pz: number) => {
    const dd = (px - x) * (px - x) + (pz - z) * (pz - z);
    if (dd < d2[i]!) {
      d2[i] = dd;
      sx[i] = px;
      sz[i] = pz;
    }
  };
  for (let z = 0; z < n; z++)
    for (let x = 0; x < n; x++) {
      const i = z * n + x;
      const hi = hs[i]!;
      const landI = hi > wl;
      if (x < n - 1) {
        const hj = hs[i + 1]!;
        if (hj > wl !== landI) {
          const t = (wl - hi) / (hj - hi);
          seed(i, x, z, x + t, z);
          seed(i + 1, x + 1, z, x + t, z);
        }
      }
      if (z < n - 1) {
        const hj = hs[i + n]!;
        if (hj > wl !== landI) {
          const t = (wl - hi) / (hj - hi);
          seed(i, x, z, x, z + t);
          seed(i + n, x, z + 1, x, z + t);
        }
      }
    }
  const relax = (i: number, x: number, z: number, j: number) => {
    const px = sx[j]!;
    if (Number.isNaN(px)) return;
    const pz = sz[j]!;
    const dd = (px - x) * (px - x) + (pz - z) * (pz - z);
    if (dd < d2[i]!) {
      d2[i] = dd;
      sx[i] = px;
      sz[i] = pz;
    }
  };
  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) {
      const i = z * n + x;
      if (x > 0) relax(i, x, z, i - 1);
      if (z > 0) {
        relax(i, x, z, i - n);
        if (x > 0) relax(i, x, z, i - n - 1);
        if (x < n - 1) relax(i, x, z, i - n + 1);
      }
    }
    for (let x = n - 2; x >= 0; x--) relax(z * n + x, x, z, z * n + x + 1);
  }
  for (let z = n - 1; z >= 0; z--) {
    for (let x = n - 1; x >= 0; x--) {
      const i = z * n + x;
      if (x < n - 1) relax(i, x, z, i + 1);
      if (z < n - 1) {
        relax(i, x, z, i + n);
        if (x < n - 1) relax(i, x, z, i + n + 1);
        if (x > 0) relax(i, x, z, i + n - 1);
      }
    }
    for (let x = 1; x < n; x++) relax(z * n + x, x, z, z * n + x - 1);
  }

  const out = new Uint16Array(n * n * 2);
  for (let i = 0; i < n * n; i++) {
    const hi = hs[i]!;
    const d = Math.min(Math.sqrt(d2[i]!) * cell, FAR_DISTANCE);
    out[i * 2] = toHalf(hi);
    out[i * 2 + 1] = toHalf(hi > wl ? -d : d);
  }
  return out;
}

/** Axis coordinates: uniform cells over ±INNER_HALF, then geometrically growing cells out to ±OUTER_HALF. */
function oceanAxis(): number[] {
  const cell = (INNER_HALF * 2) / INNER_SEGMENTS;
  // Solve cell * (r + r^2 + ... + r^k) = OUTER_HALF - INNER_HALF for the growth ratio r.
  const span = OUTER_HALF - INNER_HALF;
  let lo = 1.0001;
  let hi = 3;
  for (let it = 0; it < 60; it++) {
    const r = (lo + hi) / 2;
    const sum = (cell * (Math.pow(r, OUTER_SEGMENTS + 1) - r)) / (r - 1);
    if (sum > span) hi = r;
    else lo = r;
  }
  const r = (lo + hi) / 2;
  const outer: number[] = [];
  let x = INNER_HALF;
  let c = cell;
  for (let k = 0; k < OUTER_SEGMENTS; k++) {
    c *= r;
    x += c;
    outer.push(k === OUTER_SEGMENTS - 1 ? OUTER_HALF : x);
  }
  const axis: number[] = [];
  for (let k = outer.length - 1; k >= 0; k--) axis.push(-outer[k]!);
  for (let k = 0; k <= INNER_SEGMENTS; k++) axis.push(-INNER_HALF + k * cell);
  for (const v of outer) axis.push(v);
  return axis;
}

function buildOceanGeometry(): THREE.BufferGeometry {
  const axis = oceanAxis();
  const n = axis.length;
  const pos = new Float32Array(n * n * 3);
  for (let z = 0; z < n; z++)
    for (let x = 0; x < n; x++) {
      const i = (z * n + x) * 3;
      pos[i] = axis[x]!;
      pos[i + 1] = 0;
      pos[i + 2] = axis[z]!;
    }
  const idx = new Uint32Array((n - 1) * (n - 1) * 6);
  let k = 0;
  for (let z = 0; z < n - 1; z++)
    for (let x = 0; x < n - 1; x++) {
      const a = z * n + x;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      // Counter-clockwise seen from above (+y) so the front face points up.
      idx[k++] = a;
      idx[k++] = c;
      idx[k++] = b;
      idx[k++] = b;
      idx[k++] = c;
      idx[k++] = d;
    }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), OUTER_HALF * Math.SQRT2);
  return geo;
}
