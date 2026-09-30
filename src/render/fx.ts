/**
 * Explosion & projectile particle FX (render only – never touches sim state).
 *
 * Every particle kind is ONE InstancedMesh (1 draw call) backed by a fixed-size struct-of-arrays pool, so the
 * whole system costs a handful of draw calls at peak and allocates nothing per frame:
 *   fireball (unlit, hot gradient) · smoke (toon-lit puffs that grow then shrink – opaque, no sorting) ·
 *   debris (toon-lit chunks in terrain colours, bounce on the ground) · sparks (unlit, stretched along velocity)
 * plus a small pool of shockwave rings and one pooled PointLight flash.
 *
 * Randomness is a local mulberry32 seeded from the spawn position (no Math.random) → screenshots are stable.
 */
import * as THREE from 'three';
import type { Vec3 } from '../core/math';
import { getToonRamp } from './materials';

// ---------------------------------------------------------------------------
// Tweakables
// ---------------------------------------------------------------------------

export const FX = {
  /** Pool sizes (instances). */
  fireballCap: 96,
  smokeCap: 512,
  debrisCap: 320,
  sparkCap: 320,
  ringPool: 4,

  /** Per explosion at the reference radius (3 m); counts scale ~linearly with radius / 3. */
  refRadius: 3,
  fireballLobes: 10,
  smokePuffs: 18,
  debrisChunks: 42,
  sparks: 34,

  /** Fireball: life (s), lobe size (× radius). */
  fireballLife: 0.45,
  fireballSize: 0.5,
  /**
   * Fire gradient over life (linear rgb, NOT tone mapped → exactly these saturated cartoon colours; the
   * view-facing shading brightens the centre of each ball on top).
   */
  fireHot: [1.0, 0.86, 0.3] as Vec3,
  fireMid: [1.0, 0.42, 0.04] as Vec3,
  fireCool: [0.55, 0.1, 0.03] as Vec3,

  /** Smoke: life range (s), start delay (s), size (× radius), rise acceleration (m/s²), drag (1/s). */
  smokeLife: [1.1, 1.9] as [number, number],
  smokeDelay: [0.14, 0.3] as [number, number],
  smokeSize: [0.2, 0.36] as [number, number],
  smokeRise: 2.6,
  smokeDrag: 2.2,
  /** Smoke colours (sRGB), lit by a fake sky-from-above toon shade (no dependence on the sun direction). */
  smokeDark: 0x77706a,
  smokeLight: 0xc9c3bb,

  /** Debris: speed (m/s), size (m), gravity, bounciness, life (s). */
  debrisSpeed: [5, 12] as [number, number],
  debrisSize: [0.09, 0.26] as [number, number],
  debrisGravity: 22,
  debrisBounce: 0.35,
  debrisLife: [1.6, 2.8] as [number, number],

  /** Sparks. */
  sparkSpeed: [9, 22] as [number, number],
  sparkLife: [0.2, 0.55] as [number, number],
  sparkGravity: 14,
  sparkSize: 0.045,
  sparkHot: [1.0, 0.95, 0.6] as Vec3,
  sparkCool: [1.0, 0.5, 0.08] as Vec3,

  /** Ground shockwave ring: life (s), end radius (× radius). */
  ringLife: 0.45,
  ringEnd: 2.3,
  ringColor: 0xfff1c8,

  /** Point-light flash (set enabled=false to drop the per-fragment point light entirely). */
  light: true,
  lightColor: 0xffa040,
  /** Peak intensity per metre of blast radius (candela-ish, physically based lights). */
  lightIntensity: 260,
  lightDistance: 9,
  lightLife: 0.35,

  /** Rocket smoke trail: spacing (m), puff size (m), life (s). */
  trailSpacing: 0.32,
  trailSize: [0.13, 0.24] as [number, number],
  trailLife: [0.7, 1.15] as [number, number],
  trailColor: 0xf2eee8,
};

/**
 * Terrain palette for debris (sRGB hex). Mirrors the marching-cubes vertex colours in
 * src/terrain/marchingCubes.ts (kept local so render/ does not depend on mesher internals).
 */
export const DEBRIS_COLORS = {
  sand: [0xe8d28a, 0xf0dc9c, 0xd8bf78],
  grass: [0x5dbb4a, 0x7ccc4f, 0x4a9e3c],
  rock: [0x8a8580, 0x9d968c, 0x6f6a66],
  dirt: [0x6b4a2b, 0x7d5733, 0x5a3c22],
  /** Height (m) below which the surface is beach sand / above which it is rock. */
  sandLine: 2.6,
  rockLine: 28,
} as const;

// ---------------------------------------------------------------------------

type SizeCurve = 'pop' | 'puff' | 'solid' | 'shrink';

/**
 * Unlit instanced material with a cheap stylised shade (no lights, no tone mapping):
 * - 'glow': brighter toward the view direction → hot centre, darker rim (fireballs),
 * - 'puff': 3 toon bands lit from straight above (smoke – reads as soft cartoon puffs from any angle),
 * - 'flat': plain colour (sparks).
 */
function createFxMaterial(shade: 'glow' | 'puff' | 'flat'): THREE.MeshBasicMaterial {
  const mat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  mat.toneMapped = false;
  if (shade === 'flat') return mat;
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFxW;\nvarying vec3 vFxV;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vec3 fxN = normal;
#ifdef USE_INSTANCING
  fxN = mat3(instanceMatrix) * fxN;
#endif
vFxW = normalize(mat3(modelMatrix) * fxN);
vFxV = normalize(mat3(viewMatrix) * vFxW);`,
      );
    const body =
      shade === 'glow'
        ? `float fxF = clamp(normalize(vFxV).z, 0.0, 1.0);
diffuseColor.rgb *= 0.6 + 0.55 * fxF * fxF;`
        : `float fxU = normalize(vFxW).y;
diffuseColor.rgb *= fxU > 0.35 ? 1.06 : (fxU > -0.35 ? 0.88 : 0.7);`;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFxW;\nvarying vec3 vFxV;')
      .replace('#include <color_fragment>', `#include <color_fragment>\n${body}`);
  };
  mat.customProgramCacheKey = () => `fx-${shade}`;
  return mat;
}

interface PoolConfig {
  cap: number;
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  gravity: number;
  drag: number;
  curve: SizeCurve;
  /** Orient along velocity and stretch by speed. */
  stretch: number;
  /** Collide with groundAt(). */
  ground: boolean;
  bounce: number;
  /** Optional 3-stop colour gradient over life (multiplied with the particle colour). */
  gradient?: [Vec3, Vec3, Vec3];
}

const Z_AXIS = new THREE.Vector3(0, 0, 1);

/** Fixed-capacity particle pool rendered as one InstancedMesh. */
class ParticlePool {
  readonly mesh: THREE.InstancedMesh;
  private readonly cfg: PoolConfig;
  private readonly px: Float32Array;
  private readonly py: Float32Array;
  private readonly pz: Float32Array;
  private readonly vx: Float32Array;
  private readonly vy: Float32Array;
  private readonly vz: Float32Array;
  /** Age (s); negative = delayed start (hidden). */
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly size: Float32Array;
  private readonly rx: Float32Array;
  private readonly ry: Float32Array;
  private readonly rz: Float32Array;
  private readonly spin: Float32Array;
  private readonly cr: Float32Array;
  private readonly cg: Float32Array;
  private readonly cb: Float32Array;
  private cursor = 0;
  private live = 0;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly v = new THREE.Vector3();
  private readonly c = new THREE.Color();

  constructor(cfg: PoolConfig) {
    this.cfg = cfg;
    const n = cfg.cap;
    const f = () => new Float32Array(n);
    this.px = f();
    this.py = f();
    this.pz = f();
    this.vx = f();
    this.vy = f();
    this.vz = f();
    this.age = f();
    this.life = f();
    this.size = f();
    this.rx = f();
    this.ry = f();
    this.rz = f();
    this.spin = f();
    this.cr = f();
    this.cg = f();
    this.cb = f();
    this.mesh = new THREE.InstancedMesh(cfg.geometry, cfg.material, n);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  /** Live particle count after the last update. */
  get count(): number {
    return this.live;
  }

  spawn(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    size: number,
    life: number,
    color: THREE.Color,
    rot: number,
    spin: number,
    delay = 0,
  ): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.cfg.cap;
    this.px[i] = x;
    this.py[i] = y;
    this.pz[i] = z;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.vz[i] = vz;
    this.size[i] = size;
    this.life[i] = life;
    this.age[i] = -delay;
    this.rx[i] = rot;
    this.ry[i] = rot * 1.7;
    this.rz[i] = rot * 0.6;
    this.spin[i] = spin;
    this.cr[i] = color.r;
    this.cg[i] = color.g;
    this.cb[i] = color.b;
  }

  update(dt: number, groundAt: ((x: number, z: number) => number) | null): void {
    const cfg = this.cfg;
    const drag = cfg.drag > 0 ? Math.exp(-cfg.drag * dt) : 1;
    const grad = cfg.gradient;
    let n = 0;
    for (let i = 0; i < cfg.cap; i++) {
      const L = this.life[i]!;
      if (L <= 0) continue;
      const a = this.age[i]! + dt;
      this.age[i] = a;
      if (a < 0) continue; // delayed, not born yet
      if (a >= L) {
        this.life[i] = 0;
        continue;
      }
      // Integrate.
      let vx = this.vx[i]! * drag;
      let vy = (this.vy[i]! - cfg.gravity * dt) * drag;
      let vz = this.vz[i]! * drag;
      const x = this.px[i]! + vx * dt;
      let y = this.py[i]! + vy * dt;
      const z = this.pz[i]! + vz * dt;
      const sz0 = this.size[i]!;
      if (cfg.ground && groundAt) {
        const g = groundAt(x, z) + sz0 * 0.5;
        if (y < g) {
          y = g;
          if (vy < 0) vy = -vy * cfg.bounce;
          vx *= 0.55;
          vz *= 0.55;
          this.spin[i]! *= 0.6;
          if (Math.abs(vy) < 0.6) vy = 0;
        }
      }
      this.px[i] = x;
      this.py[i] = y;
      this.pz[i] = z;
      this.vx[i] = vx;
      this.vy[i] = vy;
      this.vz[i] = vz;

      const t = a / L;
      let s: number;
      switch (cfg.curve) {
        case 'pop': {
          // Quick overshooting pop, then collapse.
          const grow = t < 0.14 ? easeOutBack(t / 0.14) : 1;
          s = sz0 * grow * (1 - smooth(0.45, 1, t));
          break;
        }
        case 'puff':
          s = sz0 * (0.35 + 0.65 * easeOut(Math.min(1, t / 0.3))) * (1 - smooth(0.55, 1, t));
          break;
        case 'solid':
          s = sz0 * (1 - smooth(0.82, 1, t));
          break;
        case 'shrink':
        default:
          s = sz0 * (1 - t);
          break;
      }
      if (s <= 1e-4) continue;

      this.p.set(x, y, z);
      if (cfg.stretch > 0) {
        this.v.set(vx, vy, vz);
        const sp = this.v.length();
        if (sp > 1e-4) this.q.setFromUnitVectors(Z_AXIS, this.v.multiplyScalar(1 / sp));
        this.s.set(s, s, s * (1 + sp * cfg.stretch));
      } else {
        const r = this.spin[i]! * a;
        this.e.set(this.rx[i]! + r, this.ry[i]! + r * 0.7, this.rz[i]!);
        this.q.setFromEuler(this.e);
        this.s.set(s, s, s);
      }
      this.m.compose(this.p, this.q, this.s);
      this.mesh.setMatrixAt(n, this.m);

      let r = this.cr[i]!;
      let g = this.cg[i]!;
      let b = this.cb[i]!;
      if (grad) {
        const [c0, c1, c2] = grad;
        const u = t < 0.25 ? t / 0.25 : (t - 0.25) / 0.75;
        const A = t < 0.25 ? c0 : c1;
        const B = t < 0.25 ? c1 : c2;
        r *= A[0] + (B[0] - A[0]) * u;
        g *= A[1] + (B[1] - A[1]) * u;
        b *= A[2] + (B[2] - A[2]) * u;
      }
      this.mesh.setColorAt(n, this.c.setRGB(r, g, b));
      n++;
    }
    if (n > 0 || this.mesh.count > 0) {
      this.mesh.instanceMatrix.needsUpdate = true;
      if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    }
    this.mesh.count = n;
    this.mesh.visible = n > 0;
    this.live = n;
  }

  clear(): void {
    this.life.fill(0);
    this.mesh.count = 0;
    this.mesh.visible = false;
    this.live = 0;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }
}

interface Ring {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  t: number;
  radius: number;
}

export interface FxStats {
  /** Explosions spawned since the last clear(). */
  explosions: number;
  /** Live particles (all pools). */
  particles: number;
}

/**
 * All explosion / projectile particles. Call update(dt) once per rendered frame.
 * `groundAt(x, z)` (terrain surface height) lets debris bounce on the island.
 */
export class Fx {
  readonly group = new THREE.Group();
  readonly light: THREE.PointLight | null;
  private readonly fire: ParticlePool;
  private readonly smoke: ParticlePool;
  private readonly debris: ParticlePool;
  private readonly sparks: ParticlePool;
  private readonly rings: Ring[] = [];
  private readonly ringGeo: THREE.RingGeometry;
  private ringCursor = 0;
  private lightT = -1;
  private lightPeak = 0;
  private seed = 1;
  private explosions = 0;
  private readonly col = new THREE.Color();
  private readonly smokeDark = new THREE.Color(FX.smokeDark);
  private readonly smokeLight = new THREE.Color(FX.smokeLight);
  private readonly trailCol = new THREE.Color(FX.trailColor);
  private readonly white = new THREE.Color(1, 1, 1);
  private readonly debrisPalette: Record<'sand' | 'grass' | 'rock' | 'dirt', THREE.Color[]>;

  constructor(private readonly groundAt: ((x: number, z: number) => number) | null = null) {
    this.group.name = 'fx';
    const ramp = getToonRamp();

    const fireGeo = new THREE.IcosahedronGeometry(1, 1);
    const fireMat = createFxMaterial('glow');
    this.fire = new ParticlePool({
      cap: FX.fireballCap,
      geometry: fireGeo,
      material: fireMat,
      gravity: -3,
      drag: 3.5,
      curve: 'pop',
      stretch: 0,
      ground: false,
      bounce: 0,
      gradient: [FX.fireHot, FX.fireMid, FX.fireCool],
    });

    const smokeGeo = new THREE.IcosahedronGeometry(1, 1);
    const smokeMat = createFxMaterial('puff');
    this.smoke = new ParticlePool({
      cap: FX.smokeCap,
      geometry: smokeGeo,
      material: smokeMat,
      gravity: -FX.smokeRise,
      drag: FX.smokeDrag,
      curve: 'puff',
      stretch: 0,
      ground: false,
      bounce: 0,
    });

    const debrisGeo = new THREE.DodecahedronGeometry(1, 0);
    const debrisMat = new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: ramp });
    this.debris = new ParticlePool({
      cap: FX.debrisCap,
      geometry: debrisGeo,
      material: debrisMat,
      gravity: FX.debrisGravity,
      drag: 0.3,
      curve: 'solid',
      stretch: 0,
      ground: true,
      bounce: FX.debrisBounce,
    });

    const sparkGeo = new THREE.BoxGeometry(1, 1, 1);
    const sparkMat = createFxMaterial('flat');
    this.sparks = new ParticlePool({
      cap: FX.sparkCap,
      geometry: sparkGeo,
      material: sparkMat,
      gravity: FX.sparkGravity,
      drag: 1.2,
      curve: 'shrink',
      stretch: 0.09,
      ground: false,
      bounce: 0,
      gradient: [FX.sparkHot, FX.sparkCool, FX.sparkCool],
    });

    for (const pool of [this.smoke, this.debris, this.fire, this.sparks]) this.group.add(pool.mesh);

    this.ringGeo = new THREE.RingGeometry(0.78, 1, 40);
    this.ringGeo.rotateX(-Math.PI / 2);
    for (let i = 0; i < FX.ringPool; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(FX.ringColor).multiplyScalar(1.4),
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(this.ringGeo, mat);
      mesh.visible = false;
      mesh.renderOrder = 2;
      this.rings.push({ mesh, mat, t: -1, radius: 1 });
      this.group.add(mesh);
    }

    // One pooled point light, always in the scene (intensity 0 when idle) so materials never recompile.
    if (FX.light) {
      this.light = new THREE.PointLight(FX.lightColor, 0, FX.lightDistance * FX.refRadius, 2);
      this.light.castShadow = false;
      this.group.add(this.light);
    } else this.light = null;

    const cols = (hexes: readonly number[]) => hexes.map((h) => new THREE.Color(h));
    this.debrisPalette = {
      sand: cols(DEBRIS_COLORS.sand),
      grass: cols(DEBRIS_COLORS.grass),
      rock: cols(DEBRIS_COLORS.rock),
      dirt: cols(DEBRIS_COLORS.dirt),
    };
  }

  private rand(): number {
    let t = (this.seed = (this.seed + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  private range(r: readonly [number, number]): number {
    return r[0] + (r[1] - r[0]) * this.rand();
  }

  private reseed(x: number, y: number, z: number, salt: number): void {
    this.seed =
      (Math.round(x * 131) * 73856093) ^
      (Math.round(y * 131) * 19349663) ^
      (Math.round(z * 131) * 83492791) ^
      salt;
  }

  /** Random unit vector in the upper hemisphere biased by `up` (0 = uniform hemisphere, 1 = mostly up). */
  private dir(out: Vec3, up: number): Vec3 {
    const a = this.rand() * Math.PI * 2;
    const y = up + (1 - up) * this.rand();
    const h = Math.sqrt(Math.max(0, 1 - y * y));
    out[0] = Math.cos(a) * h;
    out[1] = y;
    out[2] = Math.sin(a) * h;
    return out;
  }

  private readonly d: Vec3 = [0, 0, 0];

  /** Full explosion at `pos` scaled by blast radius (m). */
  explosion(pos: Readonly<Vec3>, radius: number): void {
    const [x, y, z] = pos;
    const R = Math.max(0.5, radius);
    const k = R / FX.refRadius;
    const cnt = (base: number) => Math.max(3, Math.round(base * k));
    this.reseed(x, y, z, 0x5eed);
    this.explosions++;
    const d = this.d;

    // Fireball: one hot core + lobes pushed outward/up.
    this.fire.spawn(
      x,
      y + R * 0.15,
      z,
      0,
      1.5,
      0,
      R * FX.fireballSize * 1.25,
      FX.fireballLife,
      this.white,
      0,
      0,
    );
    const lobes = cnt(FX.fireballLobes);
    for (let i = 0; i < lobes; i++) {
      this.dir(d, 0.15);
      const sp = (2 + this.rand() * 4) * Math.sqrt(k);
      const off = R * (0.2 + this.rand() * 0.35);
      this.fire.spawn(
        x + d[0] * off,
        y + d[1] * off * 0.8 + R * 0.1,
        z + d[2] * off,
        d[0] * sp,
        d[1] * sp * 0.8 + 1,
        d[2] * sp,
        R * FX.fireballSize * (0.55 + this.rand() * 0.45),
        FX.fireballLife * (0.75 + this.rand() * 0.6),
        this.white,
        this.rand() * 6,
        0,
        this.rand() * 0.06,
      );
    }

    // Smoke: rises out of the fireball as it collapses.
    const puffs = cnt(FX.smokePuffs);
    for (let i = 0; i < puffs; i++) {
      this.dir(d, 0.1);
      const sp = (1.5 + this.rand() * 3.5) * Math.sqrt(k);
      const off = R * (0.15 + this.rand() * 0.45);
      this.col.copy(this.smokeDark).lerp(this.smokeLight, this.rand());
      this.smoke.spawn(
        x + d[0] * off,
        y + d[1] * off * 0.6 + R * 0.1,
        z + d[2] * off,
        d[0] * sp,
        d[1] * sp + 1.2,
        d[2] * sp,
        R * this.range(FX.smokeSize),
        this.range(FX.smokeLife),
        this.col,
        this.rand() * 6,
        (this.rand() - 0.5) * 0.8,
        this.range(FX.smokeDelay),
      );
    }

    // Debris in terrain colours: surface material by height plus soil from the crater.
    const surface = y < DEBRIS_COLORS.sandLine ? 'sand' : y > DEBRIS_COLORS.rockLine ? 'rock' : 'grass';
    const chunks = cnt(FX.debrisChunks);
    for (let i = 0; i < chunks; i++) {
      this.dir(d, 0.25);
      const sp = this.range(FX.debrisSpeed) * Math.sqrt(k);
      const roll = this.rand();
      const set =
        roll < 0.45
          ? this.debrisPalette[surface]
          : roll < 0.85
            ? this.debrisPalette.dirt
            : this.debrisPalette.rock;
      const c = set[Math.floor(this.rand() * set.length) % set.length]!;
      this.debris.spawn(
        x + d[0] * R * 0.3,
        y + R * 0.2,
        z + d[2] * R * 0.3,
        d[0] * sp,
        d[1] * sp * 1.1,
        d[2] * sp,
        this.range(FX.debrisSize) * (0.7 + 0.3 * k),
        this.range(FX.debrisLife),
        c,
        this.rand() * 6,
        (this.rand() - 0.5) * 18,
      );
    }

    // Sparks.
    const sparks = cnt(FX.sparks);
    for (let i = 0; i < sparks; i++) {
      this.dir(d, 0.05);
      const sp = this.range(FX.sparkSpeed) * Math.sqrt(k);
      this.sparks.spawn(
        x,
        y + R * 0.1,
        z,
        d[0] * sp,
        d[1] * sp,
        d[2] * sp,
        FX.sparkSize * (0.7 + this.rand() * 0.6),
        this.range(FX.sparkLife),
        this.white,
        0,
        0,
      );
    }

    // Shockwave ring at ground level.
    const ring = this.rings[this.ringCursor]!;
    this.ringCursor = (this.ringCursor + 1) % FX.ringPool;
    const gy = this.groundAt ? Math.max(this.groundAt(x, z), y - R) : y - R * 0.3;
    ring.t = 0;
    ring.radius = R;
    ring.mesh.position.set(x, gy + 0.12, z);
    ring.mesh.scale.setScalar(R * 0.3);
    ring.mesh.visible = true;

    if (this.light) {
      this.light.position.set(x, y + R * 0.6, z);
      this.light.distance = FX.lightDistance * R;
      this.lightPeak = FX.lightIntensity * R;
      this.lightT = 0;
    }
  }

  /** Small muzzle flash + puff (weapon fired). */
  muzzle(pos: Readonly<Vec3>, dir: Readonly<Vec3>): void {
    const [x, y, z] = pos;
    this.reseed(x, y, z, 0x3127);
    this.fire.spawn(x, y, z, dir[0] * 3, dir[1] * 3, dir[2] * 3, 0.28, 0.14, this.white, 0, 0);
    for (let i = 0; i < 5; i++) {
      const s = 1 + this.rand() * 2.5;
      this.col.copy(this.trailCol).lerp(this.smokeLight, this.rand() * 0.6);
      this.smoke.spawn(
        x - dir[0] * 0.2,
        y - dir[1] * 0.2,
        z - dir[2] * 0.2,
        -dir[0] * s + (this.rand() - 0.5) * 1.5,
        -dir[1] * s + this.rand() * 1.2,
        -dir[2] * s + (this.rand() - 0.5) * 1.5,
        0.14 + this.rand() * 0.12,
        0.5 + this.rand() * 0.4,
        this.col,
        this.rand() * 6,
        0.5,
      );
    }
  }

  /** One rocket-trail puff (+ a tiny flame blob) at the rocket's tail. */
  trailPuff(x: number, y: number, z: number, vx: number, vy: number, vz: number): void {
    this.reseed(x, y, z, 0x7a11);
    this.col.copy(this.trailCol).lerp(this.smokeLight, this.rand() * 0.35);
    this.smoke.spawn(
      x,
      y,
      z,
      vx * 0.08 + (this.rand() - 0.5) * 0.6,
      vy * 0.08 + (this.rand() - 0.2) * 0.5,
      vz * 0.08 + (this.rand() - 0.5) * 0.6,
      this.range(FX.trailSize),
      this.range(FX.trailLife),
      this.col,
      this.rand() * 6,
      (this.rand() - 0.5) * 1.5,
    );
    this.fire.spawn(x, y, z, vx * 0.1, vy * 0.1, vz * 0.1, 0.1 + this.rand() * 0.05, 0.1, this.white, 0, 0);
  }

  /** Fuse spark at (x, y, z) (grenade). `intensity` 0..1 scales count/speed. */
  fuseSpark(x: number, y: number, z: number, intensity = 0.5): void {
    this.reseed(x, y, z, 0xf05e);
    const n = intensity > 0.75 ? 2 : 1;
    for (let i = 0; i < n; i++) {
      this.dir(this.d, 0.4);
      const sp = 1.5 + this.rand() * 2.5 * (0.5 + intensity);
      this.sparks.spawn(
        x,
        y,
        z,
        this.d[0] * sp,
        this.d[1] * sp,
        this.d[2] * sp,
        0.025 + this.rand() * 0.015,
        0.12 + this.rand() * 0.18,
        this.white,
        0,
        0,
      );
    }
  }

  update(rawDt: number): void {
    const dt = Math.min(Math.max(rawDt, 0), 0.1);
    this.fire.update(dt, null);
    this.smoke.update(dt, null);
    this.debris.update(dt, this.groundAt);
    this.sparks.update(dt, null);
    for (let i = 0; i < this.rings.length; i++) {
      const ring = this.rings[i]!;
      if (ring.t < 0) continue;
      ring.t += dt;
      const k = ring.t / FX.ringLife;
      if (k >= 1) {
        ring.t = -1;
        ring.mesh.visible = false;
        continue;
      }
      const e = 1 - (1 - k) * (1 - k) * (1 - k);
      ring.mesh.scale.setScalar(ring.radius * (0.3 + (FX.ringEnd - 0.3) * e));
      ring.mat.opacity = 0.9 * (1 - k) * (1 - k);
    }
    if (this.light && this.lightT >= 0) {
      this.lightT += dt;
      const k = this.lightT / FX.lightLife;
      if (k >= 1) {
        this.lightT = -1;
        this.light.intensity = 0;
      } else this.light.intensity = this.lightPeak * (1 - k) * (1 - k);
    }
  }

  stats(): FxStats {
    return {
      explosions: this.explosions,
      particles: this.fire.count + this.smoke.count + this.debris.count + this.sparks.count,
    };
  }

  clear(): void {
    this.fire.clear();
    this.smoke.clear();
    this.debris.clear();
    this.sparks.clear();
    for (const r of this.rings) {
      r.t = -1;
      r.mesh.visible = false;
    }
    if (this.light) this.light.intensity = 0;
    this.lightT = -1;
    this.explosions = 0;
  }

  dispose(): void {
    this.fire.dispose();
    this.smoke.dispose();
    this.debris.dispose();
    this.sparks.dispose();
    this.ringGeo.dispose();
    for (const r of this.rings) r.mat.dispose();
    this.light?.dispose();
  }
}

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const easeOut = (t: number): number => 1 - (1 - t) * (1 - t);
const easeOutBack = (t: number): number => {
  const c = 1.9;
  const u = t - 1;
  return 1 + (c + 1) * u * u * u + c * u * u;
};
