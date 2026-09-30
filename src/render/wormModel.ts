import * as THREE from 'three';
import { getToonRamp } from './materials';
import { GRAVE_COLORS, WORM_COLORS, teamColor } from './palette';

/**
 * Procedural worm (v2) + gravestone geometry. No external assets.
 *
 * Model space: feet (ground contact) at y = 0, front faces +Z, ~1.08 m tall incl. helmet, long S-shaped
 * body whose thick tail trails ~0.8 m behind. The whole worm (body, eyes, lids, brows, mouth, army helmet
 * with goggles and team strap) is ONE skinned BufferGeometry with vertex colours, so a worm costs one draw
 * call (+ one for the outline hull, + one shadow pass). Geometry is cached per team (strap colour is baked
 * into the vertex colours). Facial expressions are driven by bones (lids, brows, mouth) – see wormView.ts.
 */

/** Bone indices into WormRig.bones. Indices 0–9 are unchanged from v1. */
export const BONE = {
  root: 0,
  base: 1,
  tail: 2,
  mid: 3,
  upper: 4,
  head: 5,
  eyeL: 6,
  eyeR: 7,
  pupilL: 8,
  pupilR: 9,
  tailTip: 10,
  /** Upper eyelids: rotation.x closes (+) / opens (−) around the eye centre, rotation.z slants. */
  lidL: 11,
  lidR: 12,
  /** Brows: position offset raises/lowers, rotation.z slants. */
  browL: 13,
  browR: 14,
  /** Mouth: scale.y 1 = smile, ~0 = grim line; rotation.z = π turns it into a frown. */
  mouth: 15,
} as const;
const BONE_COUNT = 16;

/** Shape tweakables (metres, model space). */
export const WORM_MODEL = {
  /** Body spine control points [y, z], tail tip → top of head. A lying S: tail on the ground → upright. */
  spine: [
    [0.085, -0.8],
    [0.095, -0.68],
    [0.11, -0.54],
    [0.14, -0.39],
    [0.19, -0.23],
    [0.29, -0.09],
    [0.44, -0.005],
    [0.58, 0.025],
    [0.72, 0.02],
    [0.86, 0.0],
    [0.985, -0.01],
  ] as ReadonlyArray<readonly [number, number]>,
  /** Tube radius at each spine control point (first/last are the rounded tips). */
  radii: [0, 0.085, 0.105, 0.14, 0.18, 0.222, 0.248, 0.245, 0.24, 0.232, 0] as readonly number[],
  radialSegments: 14,
  ringsPerSegment: 5,
  /** Arc-length period (m) and colour strength of the ring creases on the lower body and tail. */
  segmentPeriod: 0.105,
  segmentStrength: 0.75,
  /** Radial depth (fraction of the radius) of the ring creases – they show in the silhouette. */
  segmentCrease: 0.06,
  /** Segment creases stop below this height (keeps the face clean). */
  segmentMaxY: 0.47,
  eyeRadius: 0.116,
  eyeX: 0.094,
  eyeY: 0.695,
  /** How far the eye centre sits behind the body's front surface (smaller = more bulging). */
  eyeInset: 0.062,
  pupilRadius: 0.05,
  /** Upper lid shell radius relative to the eye radius. */
  lidScale: 1.1,
  browLength: 0.078,
  browThickness: 0.018,
  /** Brow height above the eye centre and forward offset from the eye centre. */
  browRise: 0.12,
  browForward: 0.074,
  helmetY: 0.865,
  helmetZ: -0.012,
  helmetRadius: 0.272,
  helmetSquash: 0.8,
  /** Tilt back (radians) so the brim rises at the front and the eyes stay visible. */
  helmetTilt: -0.15,
  /** Team strap (goggle band) height range on the helmet dome, in helmet-local y. */
  strapY: [0.028, 0.098] as readonly [number, number],
  /** Half-width (radians of azimuth) of the team stripe running over the top of the helmet. */
  stripeHalfWidth: 0.2,
  goggleX: 0.084,
  goggleRadius: 0.05,
  mouthY: 0.575,
  /** Cartoon outline thickness (m) of the inverted hull. 0 disables the outline mesh. */
  outlineWidth: 0.016,
};

/** Rest lid angle (rotation.x, rad) for a neutral open eye; the expression code offsets from here. */
export const LID_OPEN = -0.85;

// ---------------------------------------------------------------------------------------------

class GeoBuilder {
  pos: number[] = [];
  nor: number[] = [];
  col: number[] = [];
  si: number[] = [];
  sw: number[] = [];
  idx: number[] = [];

  get count(): number {
    return this.pos.length / 3;
  }

  vertex(p: THREE.Vector3, n: THREE.Vector3, c: THREE.Color, b0 = 0, b1 = 0, w1 = 0): void {
    this.pos.push(p.x, p.y, p.z);
    this.nor.push(n.x, n.y, n.z);
    this.col.push(c.r, c.g, c.b);
    this.si.push(b0, b1, 0, 0);
    this.sw.push(1 - w1, w1, 0, 0);
  }

  /** Append a (rigid) three.js geometry transformed by `m`, coloured `c`, skinned to one or two bones. */
  addRigid(geo: THREE.BufferGeometry, m: THREE.Matrix4, c: THREE.Color, b0 = 0, b1 = 0, w1 = 0): void {
    const base = this.count;
    const p = geo.getAttribute('position');
    const n = geo.getAttribute('normal');
    const nm = new THREE.Matrix3().getNormalMatrix(m);
    const vp = new THREE.Vector3();
    const vn = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      vp.fromBufferAttribute(p, i).applyMatrix4(m);
      vn.fromBufferAttribute(n, i).applyMatrix3(nm).normalize();
      this.vertex(vp, vn, c, b0, b1, w1);
    }
    const index = geo.getIndex();
    if (index) for (let i = 0; i < index.count; i++) this.idx.push(base + index.getX(i));
    else for (let i = 0; i < p.count; i++) this.idx.push(base + i);
    geo.dispose();
  }

  build(skinned: boolean): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    if (skinned) {
      g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(this.si, 4));
      g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(this.sw, 4));
    }
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Tube radius at spine parameter u (rounded tail tip and dome-shaped head top). */
function radiusAt(u: number): number {
  const r = WORM_MODEL.radii;
  const n = r.length - 1;
  const uc = Math.min(n, Math.max(0, u));
  const k = Math.min(n - 1, Math.floor(uc));
  const f = uc - k;
  if (k === 0) return r[1]! * Math.sqrt(Math.max(0, 1 - (1 - f) * (1 - f)));
  if (k === n - 1) return r[n - 1]! * Math.sqrt(Math.max(0, 1 - f * f));
  return r[k]! + (r[k + 1]! - r[k]!) * smoothstep(0, 1, f);
}

// Spine curve shared by the body mesh and the face placement.
const spineCurve = new THREE.CatmullRomCurve3(
  WORM_MODEL.spine.map(([y, z]) => new THREE.Vector3(0, y, z)),
  false,
  'centripetal',
);

/** Front (+Z) surface z of the upper body at height y. */
function frontZAt(y: number): number {
  const n = WORM_MODEL.spine.length - 1;
  const p = new THREE.Vector3();
  let best = 0.5;
  let bestD = Infinity;
  for (let i = 0; i <= 400; i++) {
    const t = 0.5 + (i / 400) * 0.5;
    spineCurve.getPoint(t, p);
    const d = Math.abs(p.y - y);
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  spineCurve.getPoint(best, p);
  return p.z + radiusAt(best * n);
}

const EYE_Z = frontZAt(WORM_MODEL.eyeY) - WORM_MODEL.eyeInset;
const MOUTH_Z = frontZAt(WORM_MODEL.mouthY);
const BROW_Y = WORM_MODEL.eyeY + WORM_MODEL.browRise;
const BROW_Z = EYE_Z + WORM_MODEL.browForward;

/** Bone rest positions in model space and parents. */
const BONE_REST: ReadonlyArray<{ pos: readonly [number, number, number]; parent: number }> = [
  { pos: [0, 0, 0], parent: -1 }, // root
  { pos: [0, 0.3, -0.06], parent: BONE.root }, // base
  { pos: [0, 0.16, -0.34], parent: BONE.base }, // tail
  { pos: [0, 0.47, 0.01], parent: BONE.base }, // mid
  { pos: [0, 0.61, 0.025], parent: BONE.mid }, // upper
  { pos: [0, 0.76, 0.01], parent: BONE.upper }, // head
  { pos: [WORM_MODEL.eyeX, WORM_MODEL.eyeY, EYE_Z], parent: BONE.head }, // eyeL (+X = worm's left)
  { pos: [-WORM_MODEL.eyeX, WORM_MODEL.eyeY, EYE_Z], parent: BONE.head }, // eyeR
  { pos: [WORM_MODEL.eyeX, WORM_MODEL.eyeY, EYE_Z], parent: BONE.eyeL }, // pupilL
  { pos: [-WORM_MODEL.eyeX, WORM_MODEL.eyeY, EYE_Z], parent: BONE.eyeR }, // pupilR
  { pos: [0, 0.1, -0.64], parent: BONE.tail }, // tailTip
  { pos: [WORM_MODEL.eyeX, WORM_MODEL.eyeY, EYE_Z], parent: BONE.head }, // lidL
  { pos: [-WORM_MODEL.eyeX, WORM_MODEL.eyeY, EYE_Z], parent: BONE.head }, // lidR
  { pos: [WORM_MODEL.eyeX + 0.006, BROW_Y, BROW_Z], parent: BONE.head }, // browL
  { pos: [-WORM_MODEL.eyeX - 0.006, BROW_Y, BROW_Z], parent: BONE.head }, // browR
  { pos: [0, WORM_MODEL.mouthY, MOUTH_Z], parent: BONE.upper }, // mouth
];

/** Skin weight anchors along the spine parameter u ∈ [0, spine.length - 1]. */
const SPINE_ANCHORS: ReadonlyArray<readonly [bone: number, u: number]> = [
  [BONE.tailTip, 0.8],
  [BONE.tail, 2.8],
  [BONE.base, 4.8],
  [BONE.mid, 6.2],
  [BONE.upper, 7.2],
  [BONE.head, 8.3],
];

/** Two-bone skin weights along the spine: [bone0, bone1, weight of bone1]. */
function spineWeights(u: number): [number, number, number] {
  const a = SPINE_ANCHORS;
  const first = a[0]!;
  if (u <= first[1]) return [first[0], first[0], 0];
  for (let i = 0; i < a.length - 1; i++) {
    const lo = a[i]!;
    const hi = a[i + 1]!;
    if (u <= hi[1]) return [lo[0], hi[0], smoothstep(lo[1], hi[1], u)];
  }
  const last = a[a.length - 1]![0];
  return [last, last, 0];
}

function addBody(b: GeoBuilder): void {
  const M = WORM_MODEL;
  const curve = spineCurve;
  const nSeg = M.spine.length - 1;
  const rings = nSeg * M.ringsPerSegment + 1;
  const radial = M.radialSegments;
  const skin = new THREE.Color(WORM_COLORS.skin);
  const belly = new THREE.Color(WORM_COLORS.belly);
  const segment = new THREE.Color(WORM_COLORS.segment);

  const P = new THREE.Vector3();
  const T = new THREE.Vector3();
  const Bv = new THREE.Vector3();
  const X = new THREE.Vector3(1, 0, 0);
  const R = new THREE.Vector3();
  const N = new THREE.Vector3();
  const V = new THREE.Vector3();
  const pa = new THREE.Vector3();
  const pb = new THREE.Vector3();
  const c = new THREE.Color();
  const base = b.count;

  // Arc length from the tail tip, for the segment creases.
  let arc = 0;
  const prev = curve.getPoint(0);
  for (let i = 0; i < rings; i++) {
    const t = i / (rings - 1);
    curve.getPoint(t, P);
    arc += P.distanceTo(prev);
    prev.copy(P);
    curve.getTangent(Math.min(0.999, Math.max(0.001, t)), T).normalize();
    const u = t * nSeg;
    // dr/ds for analytic normals (caps → normal tends to ±T).
    const e = 1e-3;
    const t0 = Math.max(0, t - e);
    const t1 = Math.min(1, t + e);
    curve.getPoint(t0, pa);
    curve.getPoint(t1, pb);
    const ds = Math.max(1e-6, pa.distanceTo(pb));
    let slope = (radiusAt(t1 * nSeg) - radiusAt(t0 * nSeg)) / ds;
    slope = Math.max(-40, Math.min(40, slope));
    Bv.set(0, T.z, -T.y); // T × X, perpendicular to T in the YZ plane
    const [b0, b1, w1] = spineWeights(u);
    // Ring creases on the lower body and tail (not on the rounded tail cap).
    const band = 0.5 + 0.5 * Math.cos((arc / M.segmentPeriod) * Math.PI * 2);
    const lower = (1 - smoothstep(M.segmentMaxY - 0.08, M.segmentMaxY, P.y)) * smoothstep(0.6, 1.2, u);
    const bandW = Math.pow(band, 5) * lower;
    const r = radiusAt(u) * (1 - M.segmentCrease * bandW);
    for (let j = 0; j <= radial; j++) {
      const th = (j / radial) * Math.PI * 2;
      R.copy(X).multiplyScalar(Math.cos(th)).addScaledVector(Bv, Math.sin(th));
      V.copy(P).addScaledVector(R, r);
      N.copy(R).addScaledVector(T, -slope).normalize();
      // Lighter belly: the front of the upright part and the underside of the tail.
      const front = smoothstep(0.1, 0.85, R.z) * smoothstep(0.3, 0.8, Math.abs(T.y));
      const under = smoothstep(0.2, 0.8, -R.y) * (1 - smoothstep(0.4, 0.8, Math.abs(T.y)));
      c.copy(skin)
        .lerp(belly, Math.max(front, under) * 0.6)
        .lerp(segment, bandW * M.segmentStrength);
      b.vertex(V, N, c, b0, b1, w1);
    }
  }

  // Pick the winding whose face normal agrees with the analytic normal.
  const stride = radial + 1;
  const mid = Math.floor(rings / 2) * stride;
  const vA = new THREE.Vector3().fromArray(b.pos, (base + mid) * 3);
  const vB = new THREE.Vector3().fromArray(b.pos, (base + mid + stride) * 3);
  const vD = new THREE.Vector3().fromArray(b.pos, (base + mid + 1) * 3);
  const nA = new THREE.Vector3().fromArray(b.nor, (base + mid) * 3);
  const face = new THREE.Vector3().subVectors(vB, vA).cross(new THREE.Vector3().subVectors(vD, vA));
  const flip = face.dot(nA) < 0;
  for (let i = 0; i < rings - 1; i++) {
    for (let j = 0; j < radial; j++) {
      const a = base + i * stride + j;
      const bb = a + stride;
      const cc = bb + 1;
      const d = a + 1;
      if (flip) b.idx.push(a, d, bb, bb, d, cc);
      else b.idx.push(a, bb, d, bb, cc, d);
    }
  }
}

function addFace(b: GeoBuilder): void {
  const M = WORM_MODEL;
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const white = new THREE.Color(WORM_COLORS.eyeWhite);
  const black = new THREE.Color(WORM_COLORS.pupil);
  const skin = new THREE.Color(WORM_COLORS.skin);
  const brow = new THREE.Color(WORM_COLORS.brow);
  for (const side of [1, -1]) {
    const eyeBone = side > 0 ? BONE.eyeL : BONE.eyeR;
    const pupilBone = side > 0 ? BONE.pupilL : BONE.pupilR;
    const lidBone = side > 0 ? BONE.lidL : BONE.lidR;
    const browBone = side > 0 ? BONE.browL : BONE.browR;
    const ex = side * M.eyeX;
    // Eye white: nearly round so the (rotating) lid shell hugs it.
    m.compose(p.set(ex, M.eyeY, EYE_Z), q.identity(), s.set(1, 1.07, 0.96));
    b.addRigid(new THREE.SphereGeometry(M.eyeRadius, 16, 12), m, white, eyeBone);
    // Pupil: flattened sphere on the eye's front, looking a touch inward (cute).
    const dir = new THREE.Vector3(-side * 0.12, 0.02, 1).normalize();
    q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
    p.set(ex, M.eyeY, EYE_Z).addScaledVector(dir, M.eyeRadius * 0.93 - M.pupilRadius * 0.25);
    m.compose(p, q, s.set(1, 1.15, 0.5));
    b.addRigid(new THREE.SphereGeometry(M.pupilRadius, 12, 8), m, black, pupilBone);
    // Specular highlight.
    const hp = p.clone().add(new THREE.Vector3(side * 0.012 + 0.012, 0.022, 0.024));
    m.compose(hp, q.identity(), s.set(1, 1, 0.6));
    b.addRigid(new THREE.SphereGeometry(0.015, 6, 4), m, white, pupilBone);
    // Upper lid: skin-coloured top-hemisphere shell around the eye, pivoting on the eye centre.
    // Bind pose covers the top half; the view rotates it back to LID_OPEN (or down to blink).
    m.compose(p.set(ex, M.eyeY, EYE_Z), q.identity(), s.setScalar(1));
    b.addRigid(
      new THREE.SphereGeometry(M.eyeRadius * M.lidScale, 16, 5, 0, Math.PI * 2, 0, Math.PI / 2),
      m,
      skin,
      lidBone,
    );
    // Brow: small dark capsule lying along X above the eye, wrapped a little around the head.
    m.compose(
      p.set(ex + side * 0.006, BROW_Y, BROW_Z),
      q.setFromEuler(new THREE.Euler(0, side * 0.3, Math.PI / 2, 'YXZ')),
      s.set(1, 1, 0.75),
    );
    b.addRigid(new THREE.CapsuleGeometry(M.browThickness, M.browLength, 3, 8), m, brow, browBone);
  }
  // Mouth: half torus (smile) on the body front, on its own bone for expressions.
  const mouth = new THREE.Color(WORM_COLORS.mouth);
  q.setFromEuler(new THREE.Euler(-0.3, 0, Math.PI));
  m.compose(p.set(0, M.mouthY, MOUTH_Z - 0.008), q, s.set(1, 0.8, 1));
  b.addRigid(new THREE.TorusGeometry(0.05, 0.012, 5, 12, Math.PI), m, mouth, BONE.mouth);
}

function addHelmet(b: GeoBuilder, team: number): void {
  const M = WORM_MODEL;
  const r = M.helmetRadius;
  const sq = M.helmetSquash;
  const shell = new THREE.Color(WORM_COLORS.helmet);
  const dark = new THREE.Color(WORM_COLORS.helmetDark);
  const strap = new THREE.Color(teamColor(team)).multiplyScalar(WORM_COLORS.teamStrapShade);
  const rim = new THREE.Color(WORM_COLORS.goggleRim);
  const lens = new THREE.Color(WORM_COLORS.goggleLens);
  const m = new THREE.Matrix4();
  const place = new THREE.Matrix4()
    .makeTranslation(0, M.helmetY, M.helmetZ)
    .multiply(new THREE.Matrix4().makeRotationX(M.helmetTilt));
  const squash = new THREE.Matrix4().makeScale(1, sq, 1);
  // Dome.
  m.copy(place).multiply(squash);
  b.addRigid(new THREE.SphereGeometry(r, 20, 8, 0, Math.PI * 2, 0, Math.PI / 2), m, shell, BONE.head);
  // Team stripe over the top, front to back (reads from above and at distance).
  for (const phi of [Math.PI / 2, (Math.PI * 3) / 2]) {
    b.addRigid(
      new THREE.SphereGeometry(
        r * 1.012,
        3,
        8,
        phi - M.stripeHalfWidth,
        M.stripeHalfWidth * 2,
        0,
        Math.PI / 2 - 0.12,
      ),
      m,
      strap,
      BONE.head,
    );
  }
  // Brim: flared ring.
  m.copy(place).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
  b.addRigid(new THREE.TorusGeometry(r * 1.02, 0.034, 6, 28), m, dark, BONE.head);
  // Team strap (goggle band): open cone frustum hugging the squashed dome.
  const [y0, y1] = M.strapY;
  const ringR = (y: number) => r * Math.sqrt(Math.max(0, 1 - (y / (sq * r)) ** 2));
  m.copy(place).multiply(new THREE.Matrix4().makeTranslation(0, (y0 + y1) / 2, 0));
  b.addRigid(
    new THREE.CylinderGeometry(ringR(y1) * 1.035, ringR(y0) * 1.035, y1 - y0, 24, 1, true),
    m,
    strap,
    BONE.head,
  );
  // Goggles sitting on the strap at the front: rim torus + glassy lens, facing along the dome normal.
  const gy = (y0 + y1) / 2 + 0.004;
  const rho = ringR(gy);
  for (const side of [1, -1]) {
    const gx = side * M.goggleX;
    const gz = Math.sqrt(Math.max(0, rho * rho - gx * gx));
    const n = new THREE.Vector3(gx, gy / (sq * sq), gz).normalize();
    const pos = new THREE.Vector3(gx, gy, gz).addScaledVector(n, 0.02);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    m.copy(place).multiply(new THREE.Matrix4().compose(pos, q, new THREE.Vector3(1, 1, 1)));
    b.addRigid(new THREE.TorusGeometry(M.goggleRadius, 0.017, 6, 14), m, rim, BONE.head);
    m.copy(place).multiply(new THREE.Matrix4().compose(pos, q, new THREE.Vector3(1, 1, 0.42)));
    b.addRigid(new THREE.SphereGeometry(M.goggleRadius, 12, 6), m, lens, BONE.head);
  }
}

const wormGeoCache = new Map<number, THREE.BufferGeometry>();

/** Skinned worm geometry for a team (cached; do not dispose – shared by all worms of the team). */
export function getWormGeometry(team: number): THREE.BufferGeometry {
  const key = teamColor(team);
  let g = wormGeoCache.get(key);
  if (!g) {
    const b = new GeoBuilder();
    addBody(b);
    addFace(b);
    addHelmet(b, team);
    g = b.build(true);
    wormGeoCache.set(key, g);
  }
  return g;
}

/** Shared toon material (vertex colours, same ramp as the terrain). Works for skinned and static meshes. */
export function createWormMaterial(): THREE.MeshToonMaterial {
  return new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: getToonRamp() });
}

/** Inverted-hull outline: back faces pushed out along the (skinned) normal. */
export function createOutlineMaterial(width = WORM_MODEL.outlineWidth): THREE.MeshBasicMaterial {
  const mat = new THREE.MeshBasicMaterial({ color: WORM_COLORS.outline, side: THREE.BackSide });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uOutline = { value: width };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uOutline;')
      .replace(
        '#include <skinning_vertex>',
        `#include <skinning_vertex>
#ifdef USE_SKINNING
  transformed += normalize(objectNormal) * uOutline;
#else
  transformed += normalize(normal) * uOutline;
#endif`,
      );
  };
  mat.customProgramCacheKey = () => `worm-outline-${width}`;
  return mat;
}

export interface WormRig {
  mesh: THREE.SkinnedMesh;
  outline: THREE.SkinnedMesh | null;
  bones: THREE.Bone[];
}

const BOUNDS = new THREE.Sphere(new THREE.Vector3(0, 0.5, -0.2), 1.0);

/** One worm instance: own skeleton, shared geometry/material. */
export function createWormRig(
  team: number,
  material: THREE.Material,
  outlineMaterial: THREE.Material | null,
): WormRig {
  const geo = getWormGeometry(team);
  const bones: THREE.Bone[] = [];
  for (let i = 0; i < BONE_COUNT; i++) {
    const bone = new THREE.Bone();
    const r = BONE_REST[i]!;
    if (r.parent < 0) bone.position.set(r.pos[0], r.pos[1], r.pos[2]);
    else {
      const pp = BONE_REST[r.parent]!.pos;
      bone.position.set(r.pos[0] - pp[0], r.pos[1] - pp[1], r.pos[2] - pp[2]);
      bones[r.parent]!.add(bone);
    }
    bones.push(bone);
  }
  const mesh = new THREE.SkinnedMesh(geo, material);
  mesh.add(bones[0]!);
  mesh.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);
  mesh.bind(skeleton);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.boundingSphere = BOUNDS.clone();
  let outline: THREE.SkinnedMesh | null = null;
  if (outlineMaterial) {
    outline = new THREE.SkinnedMesh(geo, outlineMaterial);
    outline.bind(skeleton, mesh.bindMatrix);
    outline.castShadow = false;
    outline.boundingSphere = BOUNDS.clone();
  }
  // Bones are bound at the rest pose; open the lids so a freshly created rig does not look sleepy.
  bones[BONE.lidL]!.rotation.x = LID_OPEN;
  bones[BONE.lidR]!.rotation.x = LID_OPEN;
  return { mesh, outline, bones };
}

/** Rest (bind) local position of a bone – the view offsets brows etc. from here. */
export function boneRestLocal(index: number): THREE.Vector3 {
  const r = BONE_REST[index]!;
  if (r.parent < 0) return new THREE.Vector3(r.pos[0], r.pos[1], r.pos[2]);
  const pp = BONE_REST[r.parent]!.pos;
  return new THREE.Vector3(r.pos[0] - pp[0], r.pos[1] - pp[1], r.pos[2] - pp[2]);
}

// ---------------------------------------------------------------------------------------------

let graveGeo: THREE.BufferGeometry | null = null;

/** Small cartoon gravestone (feet at y = 0, front +Z). Cached, shared. */
export function getGravestoneGeometry(): THREE.BufferGeometry {
  if (graveGeo) return graveGeo;
  const b = new GeoBuilder();
  const m = new THREE.Matrix4();
  const stone = new THREE.Color(GRAVE_COLORS.stone);
  const dark = new THREE.Color(GRAVE_COLORS.stoneDark);
  const engr = new THREE.Color(GRAVE_COLORS.engraving);
  const dirt = new THREE.Color(GRAVE_COLORS.dirt);
  m.makeScale(1, 0.32, 0.85);
  b.addRigid(new THREE.SphereGeometry(0.36, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), m, dirt);
  m.makeTranslation(0, 0.07, 0);
  b.addRigid(new THREE.BoxGeometry(0.52, 0.1, 0.24), m, dark);
  m.makeTranslation(0, 0.32, 0);
  b.addRigid(new THREE.BoxGeometry(0.4, 0.42, 0.12), m, stone);
  m.makeTranslation(0, 0.53, 0).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
  b.addRigid(new THREE.CylinderGeometry(0.2, 0.2, 0.12, 16, 1, false, Math.PI / 2, Math.PI), m, stone);
  m.makeTranslation(0, 0.42, 0.065);
  b.addRigid(new THREE.BoxGeometry(0.05, 0.26, 0.02), m, engr);
  m.makeTranslation(0, 0.47, 0.065);
  b.addRigid(new THREE.BoxGeometry(0.17, 0.05, 0.02), m, engr);
  graveGeo = b.build(false);
  return graveGeo;
}
