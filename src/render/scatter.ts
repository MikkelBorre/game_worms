import * as THREE from 'three';
import type { Vec3 } from '../core/math';
import { Rng, hash32 } from '../core/rng';
import { PALETTE } from '../terrain/marchingCubes';
import type { HeightmapData } from '../terrain/types';
import { WATER_LEVEL } from '../terrain/types';
import { getToonRamp } from './materials';

/**
 * Instanced decoration on top of the terrain (visual only, never read by the sim):
 *  - grass tufts on flat grass, some carrying a small white/yellow flower (one InstancedMesh),
 *  - low-poly faceted rocks on slopes, beaches and high ground (one InstancedMesh, casts shadows),
 *  - low-poly palms near the beaches (casts shadows) and round bushes on grass (no shadow pass).
 * Draw calls: 4 in the main pass + 2 in the shadow pass (rocks, palms). Placement is seeded (reproducible screenshots).
 * Grass/flowers shrink to nothing with camera distance in the vertex shader, so far views cost no fill.
 */
export interface Scatter {
  object: THREE.Object3D;
  /**
   * (Re)place everything from a top-down heightmap. `avoid` discs (e.g. the village plateau) stay clear.
   * Safe to call again after a seed change.
   */
  setHeightmap(h: HeightmapData, seed: number, opts?: ScatterOptions): void;
  /** Hide every instance whose base lies inside the sphere (explosion craters). */
  removeInSphere(center: Vec3, radius: number): void;
  /** Wind animation time (seconds). Optional – static if never called. */
  update(timeSec: number): void;
  /** Instance counts per category (debug/perf). */
  counts(): { grass: number; flowers: number; rocks: number; palms: number; bushes: number };
  dispose(): void;
}

export interface ScatterOptions {
  avoid?: ReadonlyArray<{ x: number; z: number; radius: number }>;
}

/** Tweakables. Counts are upper bounds (placement stops when candidates run out). */
export const SCATTER = {
  grassCount: 7000,
  /** Fraction of tufts carrying a flower inside flower patches. */
  flowerChance: 0.35,
  rockCount: 480,
  palmCount: 34,
  bushCount: 110,
  /** Grass/flower fade: full size until `start` m from the camera, gone at `end` m. */
  grassFadeStart: 34,
  grassFadeEnd: 52,
  /** Grass grows between these heights above sea level (sand below, bare peaks above). */
  grassMinY: 2.3,
  grassMaxY: 25,
  /** Minimum surface normal.y (flatness) for grass, bushes and palms. */
  flatNy: 0.86,
  /** Normal.y range that counts as a slope for rocks. */
  slopeNy: [0.5, 0.84] as readonly [number, number],
  windStrength: 0.06,
};

const COLORS = {
  /** Blade tip multiplier (> 1 = lighter than the ground). */
  grassTip: new THREE.Color(1.25, 1.3, 0.8),
  flowerYellow: new THREE.Color(0xffd21f),
  flowerCentre: new THREE.Color(0xff9a1a),
  stem: new THREE.Color(0x4f9a36),
  rock: [0xb0a08a, 0xbdae96, 0xa39584, 0xc6b89e] as readonly number[],
  trunk: new THREE.Color(0x8c6a44),
  trunkDark: new THREE.Color(0x6e5234),
  frond: new THREE.Color(0x3e9636),
  frondTip: new THREE.Color(0x86c94a),
  bush: new THREE.Color(0x3f8f34),
  bushTop: new THREE.Color(0x6fbf45),
};

// ---------------------------------------------------------------------------------------------
// Geometry builders (model space, base at y = 0).

interface Builder {
  pos: number[];
  nor: number[];
  col: number[];
  /** Per-vertex tag: grass 0 = blade / 1 = flower; otherwise unused (0). */
  part: number[];
  /** Per-vertex wind weight (0 = rigid). */
  sway: number[];
}
const newBuilder = (): Builder => ({ pos: [], nor: [], col: [], part: [], sway: [] });

function tri(
  b: Builder,
  a: THREE.Vector3,
  c: THREE.Vector3,
  d: THREE.Vector3,
  colors: [THREE.Color, THREE.Color, THREE.Color],
  part: number,
  sway: [number, number, number],
  normal?: THREE.Vector3,
): void {
  const n =
    normal ?? new THREE.Vector3().subVectors(c, a).cross(new THREE.Vector3().subVectors(d, a)).normalize();
  const vs = [a, c, d];
  for (let i = 0; i < 3; i++) {
    const v = vs[i]!;
    b.pos.push(v.x, v.y, v.z);
    b.nor.push(n.x, n.y, n.z);
    const cc = colors[i]!;
    b.col.push(cc.r, cc.g, cc.b);
    b.part.push(part);
    b.sway.push(sway[i]!);
  }
}

function finish(b: Builder): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(b.nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(b.col, 3));
  g.setAttribute('aPart', new THREE.Float32BufferAttribute(b.part, 1));
  g.setAttribute('aSway', new THREE.Float32BufferAttribute(b.sway, 1));
  g.computeBoundingSphere();
  return g;
}

/** Tuft of 4 tapered blades (normals up so it shades like the ground) + an optional flower (part 1). */
function buildGrassGeometry(): THREE.BufferGeometry {
  const b = newBuilder();
  const up = new THREE.Vector3(0, 1, 0);
  const root = new THREE.Color(0.78, 0.82, 0.72);
  const white = new THREE.Color(1, 1, 1);
  const r = new Rng(77);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + r.range(-0.3, 0.3);
    const off = r.range(0.01, 0.06);
    const ox = Math.cos(a) * off;
    const oz = Math.sin(a) * off;
    const h = r.range(0.24, 0.4);
    const lean = r.range(0.07, 0.16);
    const w = r.range(0.045, 0.06);
    // Blade faces sideways relative to its lean direction.
    const px = -Math.sin(a) * w;
    const pz = Math.cos(a) * w;
    tri(
      b,
      new THREE.Vector3(ox - px, 0, oz - pz),
      new THREE.Vector3(ox + px, 0, oz + pz),
      new THREE.Vector3(ox + Math.cos(a) * lean, h, oz + Math.sin(a) * lean),
      [root, root, COLORS.grassTip],
      0,
      [0, 0, 1],
      up,
    );
  }
  // Flower: thin stem + 5-petal fan, tilted a little.
  const top = new THREE.Vector3(0.03, 0.3, 0.01);
  tri(
    b,
    new THREE.Vector3(0.01, 0, 0),
    new THREE.Vector3(0.03, 0, 0.01),
    top,
    [COLORS.stem, COLORS.stem, COLORS.stem],
    1,
    [0, 0, 1],
    up,
  );
  const tilt = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.35, 0, 0.2));
  const centre = top.clone().add(new THREE.Vector3(0, 0.01, 0));
  const petal = (k: number, rad: number) =>
    new THREE.Vector3(Math.cos(k) * rad, 0, Math.sin(k) * rad).applyQuaternion(tilt).add(centre);
  const nUp = up.clone().applyQuaternion(tilt);
  // Pentagon fan: orange centre, white (or tinted yellow) rim.
  for (let i = 0; i < 5; i++) {
    const k0 = (i / 5) * Math.PI * 2;
    const k1 = ((i + 1) / 5) * Math.PI * 2;
    tri(b, centre, petal(k1, 0.06), petal(k0, 0.06), [COLORS.flowerCentre, white, white], 1, [1, 1, 1], nUp);
  }
  return finish(b);
}

/** Jittered icosahedron with faceted normals (unit size, base around y = 0). */
function buildRockGeometry(): THREE.BufferGeometry {
  const ico = new THREE.IcosahedronGeometry(1, 0);
  const p = ico.getAttribute('position');
  const r = new Rng(4242);
  // Jitter shared vertices consistently (the geometry is non-indexed: key by rounded position).
  const jit = new Map<string, THREE.Vector3>();
  const v = new THREE.Vector3();
  const b = newBuilder();
  const verts: THREE.Vector3[] = [];
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const key = `${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)}`;
    let j = jit.get(key);
    if (!j) {
      j = v.clone().multiplyScalar(r.range(0.78, 1.12));
      j.y *= 0.72;
      jit.set(key, j);
    }
    verts.push(j);
  }
  const lit = new THREE.Color(1.08, 1.06, 1.02);
  const shade = new THREE.Color(0.88, 0.86, 0.86);
  for (let i = 0; i < verts.length; i += 3) {
    const a = verts[i]!;
    const c = verts[i + 1]!;
    const d = verts[i + 2]!;
    const n = new THREE.Vector3().subVectors(c, a).cross(new THREE.Vector3().subVectors(d, a)).normalize();
    const col = n.y > 0.3 ? lit : shade;
    tri(b, a, c, d, [col, col, col], 0, [0, 0, 0], n);
  }
  ico.dispose();
  return finish(b);
}

/** Low-poly palm: curved banded 5-sided trunk + drooping V-folded fronds (base at y = 0). */
function buildPalmGeometry(): THREE.BufferGeometry {
  const b = newBuilder();
  // --- Trunk: 5-sided, curved, banded.
  const H = 3.3;
  const rings = 6;
  const sides = 5;
  const trunkAt = (t: number) => new THREE.Vector3(0.45 * t * t, H * t, 0);
  const ring = (i: number) => {
    const t = i / (rings - 1);
    const c = trunkAt(t);
    const rad = 0.17 - 0.07 * t;
    const out: THREE.Vector3[] = [];
    for (let s = 0; s < sides; s++) {
      const a = (s / sides) * Math.PI * 2;
      out.push(new THREE.Vector3(c.x + Math.cos(a) * rad, c.y, c.z + Math.sin(a) * rad));
    }
    return out;
  };
  for (let i = 0; i < rings - 1; i++) {
    const r0 = ring(i);
    const r1 = ring(i + 1);
    const col = i % 2 === 0 ? COLORS.trunk : COLORS.trunkDark;
    const sw0 = (i / (rings - 1)) ** 2 * 0.3;
    const sw1 = ((i + 1) / (rings - 1)) ** 2 * 0.3;
    for (let s = 0; s < sides; s++) {
      const a = r0[s]!;
      const bb = r0[(s + 1) % sides]!;
      const c = r1[s]!;
      const d = r1[(s + 1) % sides]!;
      tri(b, a, c, bb, [col, col, col], 0, [sw0, sw1, sw0]);
      tri(b, bb, c, d, [col, col, col], 0, [sw0, sw1, sw1]);
    }
  }
  // --- Fronds: 7 drooping, V-folded leaves.
  const topC = trunkAt(1);
  const fronds = 7;
  const r = new Rng(9001);
  for (let f = 0; f < fronds; f++) {
    const yaw = (f / fronds) * Math.PI * 2 + r.range(-0.2, 0.2);
    const dir = new THREE.Vector3(Math.cos(yaw), 0, Math.sin(yaw));
    const side = new THREE.Vector3(-dir.z, 0, dir.x);
    const L = r.range(1.5, 1.9);
    const segs = 3;
    const spine: THREE.Vector3[] = [];
    for (let k = 0; k <= segs; k++) {
      const p = topC.clone();
      // Integrate an arc whose pitch goes from rising (+0.55 rad) to drooping.
      let x = 0;
      let y = 0;
      for (let q = 1; q <= k; q++) {
        const tt = (q - 0.5) / segs;
        const pp = 0.55 - 1.5 * tt;
        x += Math.cos(pp) * (L / segs);
        y += Math.sin(pp) * (L / segs);
      }
      spine.push(p.addScaledVector(dir, x).add(new THREE.Vector3(0, y, 0)));
    }
    const widths = [0.02, 0.28, 0.24, 0.02];
    for (let k = 0; k < segs; k++) {
      const a = spine[k]!;
      const c = spine[k + 1]!;
      const wa = widths[k]!;
      const wc = widths[k + 1]!;
      const aL = a
        .clone()
        .addScaledVector(side, wa)
        .add(new THREE.Vector3(0, -wa * 0.35, 0));
      const aR = a
        .clone()
        .addScaledVector(side, -wa)
        .add(new THREE.Vector3(0, -wa * 0.35, 0));
      const cL = c
        .clone()
        .addScaledVector(side, wc)
        .add(new THREE.Vector3(0, -wc * 0.35, 0));
      const cR = c
        .clone()
        .addScaledVector(side, -wc)
        .add(new THREE.Vector3(0, -wc * 0.35, 0));
      const ca = COLORS.frond.clone().lerp(COLORS.frondTip, k / segs);
      const cc = COLORS.frond.clone().lerp(COLORS.frondTip, (k + 1) / segs);
      const s0 = 0.3 + (k / segs) * 0.7;
      const s1 = 0.3 + ((k + 1) / segs) * 0.7;
      const nUp = new THREE.Vector3(0, 1, 0);
      tri(b, a, aL, c, [ca, ca, cc], 0, [s0, s0, s1], nUp);
      tri(b, aL, cL, c, [ca, cc, cc], 0, [s0, s1, s1], nUp);
      tri(b, a, c, aR, [ca, cc, ca], 0, [s0, s1, s0], nUp);
      tri(b, aR, c, cR, [ca, cc, cc], 0, [s0, s1, s1], nUp);
    }
  }
  return finish(b);
}

/** Round bush: faceted blobs, darker underneath (base at y = 0). */
function buildBushGeometry(): THREE.BufferGeometry {
  const b = newBuilder();
  const blobs: [number, number, number, number][] = [
    [0, 0.42, 0, 0.55],
    [0.42, 0.3, 0.12, 0.42],
    [-0.32, 0.28, 0.22, 0.42],
  ];
  const ico = new THREE.IcosahedronGeometry(1, 0);
  const ip = ico.getAttribute('position');
  const v = new THREE.Vector3();
  for (const [bx, by, bz, br] of blobs) {
    const verts: THREE.Vector3[] = [];
    for (let i = 0; i < ip.count; i++) {
      v.fromBufferAttribute(ip, i);
      verts.push(new THREE.Vector3(bx + v.x * br, by + v.y * br * 0.85, bz + v.z * br));
    }
    for (let i = 0; i < verts.length; i += 3) {
      const a = verts[i]!;
      const c = verts[i + 1]!;
      const d = verts[i + 2]!;
      const n = new THREE.Vector3().subVectors(c, a).cross(new THREE.Vector3().subVectors(d, a)).normalize();
      const col = COLORS.bush.clone().lerp(COLORS.bushTop, THREE.MathUtils.clamp(n.y * 0.8 + 0.2, 0, 1));
      tri(b, a, c, d, [col, col, col], 0, [0.12, 0.12, 0.12], n);
    }
  }
  ico.dispose();
  return finish(b);
}

// ---------------------------------------------------------------------------------------------
// Shader patches (shared between colour and depth materials).

interface Patch {
  fade: boolean;
  /** Instance flag attribute name and the rule: collapse vertices whose aPart doesn't match. */
  mode: 'grass' | 'none';
}

function patchVertex(
  shader: THREE.WebGLProgramParametersWithUniforms,
  p: Patch,
  uTime: { value: number },
): void {
  shader.uniforms.uTime = uTime;
  shader.uniforms.uFade = { value: new THREE.Vector2(SCATTER.grassFadeStart, SCATTER.grassFadeEnd) };
  shader.uniforms.uWind = { value: SCATTER.windStrength };
  let decl = `
uniform float uTime;
uniform vec2 uFade;
uniform float uWind;
attribute float aPart;
attribute float aSway;
`;
  if (p.mode !== 'none') decl += 'attribute float aKind;\n';
  let body = `
  vec3 wwInst = (modelMatrix * vec4(instanceMatrix[3].xyz, 1.0)).xyz;
`;
  if (p.fade) {
    body += `  transformed *= 1.0 - smoothstep(uFade.x, uFade.y, distance(cameraPosition, wwInst));\n`;
  }
  if (p.mode === 'grass') body += '  if (aPart > 0.5 && aKind < 0.5) transformed = vec3(0.0);\n';
  body += `
  float wwPh = uTime * 1.7 + wwInst.x * 0.23 + wwInst.z * 0.31;
  transformed.xz += aSway * uWind * vec2(sin(wwPh), cos(wwPh * 0.8 + 1.3)) * (1.0 + 0.4 * sin(uTime * 0.5));
`;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${decl}`)
    .replace('#include <begin_vertex>', `#include <begin_vertex>\n${body}`);
  if (p.mode === 'grass') {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <color_vertex>',
      `#include <color_vertex>
#ifdef USE_COLOR
  if (aPart > 0.5) vColor.rgb = color.rgb * (aKind > 1.5 ? vec3(${rgb(COLORS.flowerYellow)}) : vec3(1.0));
#endif`,
    );
  }
}

const rgb = (c: THREE.Color) => `${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)}`;

function makeMaterial(
  p: Patch,
  uTime: { value: number },
  opts: { doubleSide?: boolean; flat?: boolean },
): THREE.MeshToonMaterial {
  const mat = new THREE.MeshToonMaterial({
    vertexColors: true,
    gradientMap: getToonRamp(),
    side: opts.doubleSide ? THREE.DoubleSide : THREE.FrontSide,
  });
  mat.onBeforeCompile = (shader) => {
    patchVertex(shader, p, uTime);
    // Double-sided cards (blades, fronds) keep their authored normal on the back face too; three's
    // default flip would point it into the ground and render the back sides dark.
    if (opts.doubleSide) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <normal_fragment_begin>',
        '#include <normal_fragment_begin>\n  normal = normalize( vNormal );',
      );
    }
  };
  mat.customProgramCacheKey = () => `scatter-${p.mode}-${p.fade}-${opts.doubleSide ? 2 : 1}`;
  return mat;
}

function makeDepthMaterial(p: Patch, uTime: { value: number }): THREE.MeshDepthMaterial {
  const mat = new THREE.MeshDepthMaterial();
  mat.onBeforeCompile = (shader) => patchVertex(shader, p, uTime);
  mat.customProgramCacheKey = () => `scatter-depth-${p.mode}-${p.fade}`;
  return mat;
}

// ---------------------------------------------------------------------------------------------
// Heightmap sampling.

class HeightSampler {
  private readonly cell: number;
  constructor(private readonly h: HeightmapData) {
    this.cell = h.size / (h.resolution - 1);
  }

  height(x: number, z: number): number {
    const h = this.h;
    const n = h.resolution;
    const fx = THREE.MathUtils.clamp((x - h.minX) / this.cell, 0, n - 1.001);
    const fz = THREE.MathUtils.clamp((z - h.minZ) / this.cell, 0, n - 1.001);
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    const tx = fx - ix;
    const tz = fz - iz;
    const a = h.heights[iz * n + ix]!;
    const b = h.heights[iz * n + ix + 1]!;
    const c = h.heights[(iz + 1) * n + ix]!;
    const d = h.heights[(iz + 1) * n + ix + 1]!;
    return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
  }

  /** Surface normal from central differences over ~1 m. */
  normal(x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    const e = Math.max(0.5, this.cell);
    const dx = (this.height(x + e, z) - this.height(x - e, z)) / (2 * e);
    const dz = (this.height(x, z + e) - this.height(x, z - e)) / (2 * e);
    return out.set(-dx, 1, -dz).normalize();
  }

  /** Lowest surface within a ring of radius r (8 samples) – "is the sea close?". */
  ringMin(x: number, z: number, r: number): number {
    let m = Infinity;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      m = Math.min(m, this.height(x + Math.cos(a) * r, z + Math.sin(a) * r));
    }
    return m;
  }
}

/** Smooth 2D value noise in [0,1) from a seed (patchiness masks). */
function noise2(seed: number, x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const h = (i: number, j: number) =>
    hash32(seed ^ Math.imul(i, 73856093) ^ Math.imul(j, 19349663)) / 4294967296;
  const u = fx * fx * (3 - 2 * fx);
  const v = fz * fz * (3 - 2 * fz);
  const a = h(ix, iz) + (h(ix + 1, iz) - h(ix, iz)) * u;
  const b = h(ix, iz + 1) + (h(ix + 1, iz + 1) - h(ix, iz + 1)) * u;
  return a + (b - a) * v;
}

// ---------------------------------------------------------------------------------------------

interface Layer {
  mesh: THREE.InstancedMesh;
  /** Instance base positions (xyz) for removeInSphere. */
  bases: Float32Array;
  kinds: THREE.InstancedBufferAttribute | null;
  count: number;
}

function makeLayer(
  geo: THREE.BufferGeometry,
  mat: THREE.Material,
  capacity: number,
  withKind: boolean,
  name: string,
): Layer {
  const kinds = withKind ? new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1) : null;
  if (kinds) geo.setAttribute('aKind', kinds);
  const mesh = new THREE.InstancedMesh(geo, mat, capacity);
  mesh.name = name;
  mesh.count = 0;
  mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  mesh.frustumCulled = false; // instances span the island; bounds would always intersect anyway
  return { mesh, bases: new Float32Array(capacity * 3), kinds, count: 0 };
}

export function createScatter(): Scatter {
  const group = new THREE.Group();
  group.name = 'scatter';
  const uTime = { value: 0 };

  const grassPatch: Patch = { fade: true, mode: 'grass' };
  const plainPatch: Patch = { fade: false, mode: 'none' };

  const grass = makeLayer(
    buildGrassGeometry(),
    makeMaterial(grassPatch, uTime, { doubleSide: true }),
    SCATTER.grassCount,
    true,
    'scatter:grass',
  );
  grass.mesh.receiveShadow = true;

  const rocks = makeLayer(
    buildRockGeometry(),
    makeMaterial(plainPatch, uTime, {}),
    SCATTER.rockCount,
    false,
    'scatter:rocks',
  );
  rocks.mesh.castShadow = true;
  rocks.mesh.receiveShadow = true;
  rocks.mesh.customDepthMaterial = makeDepthMaterial(plainPatch, uTime);

  const palms = makeLayer(
    buildPalmGeometry(),
    makeMaterial(plainPatch, uTime, { doubleSide: true }),
    SCATTER.palmCount,
    false,
    'scatter:palms',
  );
  palms.mesh.castShadow = true;
  palms.mesh.receiveShadow = true;
  palms.mesh.customDepthMaterial = makeDepthMaterial(plainPatch, uTime);

  // Bushes hug the ground: no shadow pass (keeps the scatter at 6 draw calls), baked darker undersides.
  const bushes = makeLayer(
    buildBushGeometry(),
    makeMaterial(plainPatch, uTime, {}),
    SCATTER.bushCount,
    false,
    'scatter:bushes',
  );
  bushes.mesh.receiveShadow = true;

  const layers = [grass, rocks, palms, bushes];
  for (const l of layers) group.add(l.mesh);
  const tally = { grass: 0, flowers: 0, rocks: 0, palms: 0, bushes: 0 };

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const qa = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const col = new THREE.Color();

  const push = (l: Layer, kind: number, color: THREE.Color | null) => {
    const i = l.count++;
    l.mesh.setMatrixAt(i, m);
    if (color) l.mesh.setColorAt(i, color);
    if (l.kinds) l.kinds.setX(i, kind);
    l.bases[i * 3] = p.x;
    l.bases[i * 3 + 1] = p.y;
    l.bases[i * 3 + 2] = p.z;
  };

  const place = (h: HeightmapData, seed: number, opts: ScatterOptions) => {
    for (const l of layers) l.count = 0;
    tally.grass = tally.flowers = tally.rocks = tally.palms = tally.bushes = 0;
    const S = new HeightSampler(h);
    const avoid = opts.avoid ?? [];
    const blocked = (x: number, z: number, pad = 0) =>
      avoid.some((a) => (x - a.x) ** 2 + (z - a.z) ** 2 < (a.radius + pad) ** 2);
    const x0 = h.minX;
    const z0 = h.minZ;
    const size = h.size;
    const root = new Rng(hash32(seed ^ 0x5ca77e5));
    const beachTop = (x: number, z: number) =>
      WATER_LEVEL + 1.6 + (noise2(seed, x * 0.07, z * 0.07) - 0.5) * 1.2;

    // --- Grass + flowers: patchy density mask, flowers in their own meadows.
    {
      const r = root.fork(1);
      const grassBase = new THREE.Color().setRGB(...PALETTE.grass);
      const grassAlt = new THREE.Color().setRGB(...PALETTE.grassAlt);
      const grassDark = new THREE.Color().setRGB(...PALETTE.grassDark);
      for (let tries = 0; tries < SCATTER.grassCount * 12 && grass.count < SCATTER.grassCount; tries++) {
        const x = x0 + r.next() * size;
        const z = z0 + r.next() * size;
        const mask = noise2(seed + 11, x * 0.12, z * 0.12);
        if (r.next() > mask * 1.5 - 0.2) continue;
        const y = S.height(x, z);
        if (y < SCATTER.grassMinY || y > SCATTER.grassMaxY || y < beachTop(x, z) + 0.6) continue;
        S.normal(x, z, n);
        if (n.y < SCATTER.flatNy) continue;
        if (blocked(x, z, -2)) continue;
        const meadow = noise2(seed + 23, x * 0.09, z * 0.09);
        const flower = meadow > 0.62 && r.next() < SCATTER.flowerChance ? (r.next() < 0.55 ? 1 : 2) : 0;
        // Lean towards the terrain normal (60 %) with a random yaw.
        q.setFromUnitVectors(up, n.clone().lerp(up, 0.4).normalize());
        qa.setFromAxisAngle(up, r.next() * Math.PI * 2);
        q.multiply(qa);
        const sc = r.range(0.75, 1.35);
        p.set(x, y - 0.03, z);
        m.compose(p, q, s.set(sc, sc * r.range(0.8, 1.25), sc));
        const t = r.next();
        col.copy(grassBase).lerp(t < 0.5 ? grassAlt : grassDark, r.next() * 0.7);
        push(grass, flower, col);
        tally.grass++;
        if (flower) tally.flowers++;
      }
    }

    // --- Rocks: slopes, beaches, high ground, a few big boulders.
    {
      const r = root.fork(2);
      for (let tries = 0; tries < SCATTER.rockCount * 40 && rocks.count < SCATTER.rockCount; tries++) {
        const x = x0 + r.next() * size;
        const z = z0 + r.next() * size;
        const y = S.height(x, z);
        if (y < WATER_LEVEL - 0.4) continue;
        S.normal(x, z, n);
        const onSlope = n.y > SCATTER.slopeNy[0] && n.y < SCATTER.slopeNy[1] && y > 1;
        const onBeach = y < beachTop(x, z) && y > WATER_LEVEL - 0.3 && n.y > 0.8;
        const high = y > SCATTER.grassMaxY - 2 && n.y > 0.5;
        let size0: number;
        if (onSlope) size0 = r.next() < 0.08 ? r.range(1.0, 1.6) : r.range(0.25, 0.8);
        else if (onBeach) {
          if (r.next() > 0.35) continue;
          size0 = r.next() < 0.1 ? r.range(0.7, 1.2) : r.range(0.18, 0.5);
        } else if (high) size0 = r.range(0.3, 0.9);
        else if (n.y > 0.84 && r.next() < 0.015)
          size0 = r.range(0.2, 0.45); // stray pebble in the grass
        else continue;
        if (blocked(x, z, 1)) continue;
        qa.setFromEuler(new THREE.Euler(r.range(-0.3, 0.3), r.next() * Math.PI * 2, r.range(-0.3, 0.3)));
        q.setFromUnitVectors(up, n.clone().lerp(up, 0.5).normalize()).multiply(qa);
        p.set(x, y - size0 * 0.28, z);
        m.compose(
          p,
          q,
          s.set(size0 * r.range(0.8, 1.3), size0 * r.range(0.7, 1.1), size0 * r.range(0.8, 1.3)),
        );
        const c = COLORS.rock[r.int(0, COLORS.rock.length - 1)]!;
        col.setHex(c);
        // Sandy rocks a touch warmer.
        if (onBeach) col.lerp(new THREE.Color(0xc9b48a), 0.25);
        push(rocks, 0, col);
        tally.rocks++;
      }
    }

    // --- Palms near beaches, bushes on grass edges.
    {
      const r = root.fork(3);
      const palmSpots: THREE.Vector3[] = [];
      for (let tries = 0; tries < 20000 && tally.palms < SCATTER.palmCount; tries++) {
        const x = x0 + r.next() * size;
        const z = z0 + r.next() * size;
        const y = S.height(x, z);
        if (y < 1.0 || y > 5) continue;
        S.normal(x, z, n);
        if (n.y < SCATTER.flatNy) continue;
        if (S.ringMin(x, z, 7) > WATER_LEVEL + 0.2) continue; // the sea must be close
        if (blocked(x, z, 2)) continue;
        if (palmSpots.some((o) => (o.x - x) ** 2 + (o.z - z) ** 2 < 9)) continue;
        palmSpots.push(new THREE.Vector3(x, y, z));
        // Lean away from the island centre (towards the sea) a little.
        const out = Math.atan2(z, x);
        q.setFromEuler(new THREE.Euler(0, -out + r.range(-0.6, 0.6), 0));
        qa.setFromAxisAngle(new THREE.Vector3(0, 0, 1), -r.range(0.0, 0.18));
        q.multiply(qa);
        const sc = r.range(0.8, 1.25);
        p.set(x, y - 0.1, z);
        m.compose(p, q, s.setScalar(sc));
        push(palms, 0, col.setRGB(1, 1, 1));
        tally.palms++;
      }
      for (let tries = 0; tries < 30000 && tally.bushes < SCATTER.bushCount; tries++) {
        const x = x0 + r.next() * size;
        const z = z0 + r.next() * size;
        const y = S.height(x, z);
        if (y < 1.6 || y > 16) continue;
        S.normal(x, z, n);
        if (n.y < 0.8) continue;
        if (noise2(seed + 41, x * 0.08, z * 0.08) < 0.45) continue;
        if (blocked(x, z, 1)) continue;
        q.setFromAxisAngle(up, r.next() * Math.PI * 2);
        const sc = r.range(0.55, 1.05);
        p.set(x, y - 0.12, z);
        m.compose(p, q, s.set(sc, sc * r.range(0.8, 1.1), sc));
        col.setRGB(r.range(0.85, 1.1), r.range(0.9, 1.1), r.range(0.8, 1.0));
        push(bushes, 0, col);
        tally.bushes++;
      }
    }

    for (const l of layers) {
      l.mesh.count = l.count;
      l.mesh.instanceMatrix.needsUpdate = true;
      if (l.mesh.instanceColor) l.mesh.instanceColor.needsUpdate = true;
      if (l.kinds) l.kinds.needsUpdate = true;
    }
  };

  const zero = new THREE.Matrix4().makeScale(0, 0, 0);

  return {
    object: group,
    setHeightmap(h, seed, opts = {}) {
      place(h, seed, opts);
    },
    removeInSphere(center, radius) {
      const r2 = radius * radius;
      for (const l of layers) {
        let changed = false;
        for (let i = 0; i < l.count; i++) {
          const dx = l.bases[i * 3]! - center[0];
          const dy = l.bases[i * 3 + 1]! - center[1];
          const dz = l.bases[i * 3 + 2]! - center[2];
          if (dx * dx + dy * dy + dz * dz < r2) {
            l.mesh.setMatrixAt(i, zero);
            l.bases[i * 3 + 1] = -1e6; // never matches again
            changed = true;
          }
        }
        if (changed) l.mesh.instanceMatrix.needsUpdate = true;
      }
    },
    update(timeSec) {
      uTime.value = timeSec;
    },
    counts: () => ({ ...tally }),
    dispose() {
      for (const l of layers) {
        group.remove(l.mesh);
        l.mesh.geometry.dispose();
        (l.mesh.material as THREE.Material).dispose();
        l.mesh.customDepthMaterial?.dispose();
        l.mesh.dispose();
      }
    },
  };
}
