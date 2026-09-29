import * as THREE from 'three';
import { SPLASH_COLORS } from './palette';

/** Splash tweakables. */
export const SPLASH = {
  maxDroplets: 128,
  dropletsPerSplash: 34,
  gravity: 14,
  ringPool: 4,
  ringLife: 0.9,
  ringStartRadius: 0.35,
  ringEndRadius: 2.4,
  /** Height above the water plane the ring floats at (waves are ~±0.25 m). */
  ringLift: 0.14,
};

interface Drop {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  maxLife: number;
  size: number;
  floor: number;
}

interface Ring {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  t: number;
}

/**
 * Cheap water splash: one InstancedMesh for all droplets (1 draw call) + a small pool of expanding rings.
 * Purely visual, deterministic per spawn position (no Math.random), zero allocations per frame.
 */
export class SplashFx {
  readonly group = new THREE.Group();
  private readonly drops: THREE.InstancedMesh;
  private readonly pool: Drop[] = [];
  private readonly rings: Ring[] = [];
  private readonly ringGeo: THREE.RingGeometry;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly pos = new THREE.Vector3();
  private readonly scl = new THREE.Vector3();
  private cursor = 0;
  private ringCursor = 0;
  private seed = 0x9e3779b9;

  constructor() {
    const geo = new THREE.IcosahedronGeometry(1, 0);
    // > 1 so droplets stay white after ACES tone mapping (same trick as the water foam).
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(SPLASH_COLORS.droplet).multiplyScalar(1.6) });
    this.drops = new THREE.InstancedMesh(geo, mat, SPLASH.maxDroplets);
    this.drops.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.drops.count = 0;
    this.drops.frustumCulled = false;
    this.group.add(this.drops);
    for (let i = 0; i < SPLASH.maxDroplets; i++) {
      this.pool.push({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, maxLife: 1, size: 0, floor: 0 });
    }
    this.ringGeo = new THREE.RingGeometry(0.82, 1, 32);
    this.ringGeo.rotateX(-Math.PI / 2);
    for (let i = 0; i < SPLASH.ringPool; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(SPLASH_COLORS.ring).multiplyScalar(1.5),
        transparent: true,
        opacity: 0,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(this.ringGeo, mat);
      mesh.visible = false;
      mesh.renderOrder = 2;
      this.rings.push({ mesh, mat, t: -1 });
      this.group.add(mesh);
    }
  }

  private rand(): number {
    let t = (this.seed = (this.seed + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Splash at the water surface (x, waterY, z). strength ~1 for a worm. */
  spawn(x: number, waterY: number, z: number, strength = 1): void {
    this.seed = (Math.round(x * 97) * 73856093) ^ (Math.round(z * 97) * 19349663);
    const n = Math.round(SPLASH.dropletsPerSplash * strength);
    for (let k = 0; k < n; k++) {
      const d = this.pool[this.cursor]!;
      this.cursor = (this.cursor + 1) % SPLASH.maxDroplets;
      const a = (k / n) * Math.PI * 2 + this.rand() * 0.5;
      const column = k < 6; // a few fast central drops form the splash column
      const hs = column ? 0.3 + this.rand() * 0.4 : 1.1 + this.rand() * 1.6;
      const vs = column ? 6.5 + this.rand() * 2 : 3 + this.rand() * 3.2;
      d.x = x + Math.cos(a) * 0.15;
      d.y = waterY + 0.05;
      d.z = z + Math.sin(a) * 0.15;
      d.vx = Math.cos(a) * hs * strength;
      d.vy = vs * Math.sqrt(strength);
      d.vz = Math.sin(a) * hs * strength;
      d.maxLife = 0.7 + this.rand() * 0.5;
      d.life = d.maxLife;
      d.size = (column ? 0.08 : 0.035) + this.rand() * 0.05;
      d.floor = waterY - 0.3;
    }
    const ring = this.rings[this.ringCursor]!;
    this.ringCursor = (this.ringCursor + 1) % SPLASH.ringPool;
    ring.t = 0;
    ring.mesh.position.set(x, waterY + SPLASH.ringLift, z);
    ring.mesh.scale.set(SPLASH.ringStartRadius, 1, SPLASH.ringStartRadius);
    ring.mesh.visible = true;
  }

  update(rawDt: number): void {
    const dt = Math.min(Math.max(rawDt, 0), 0.1);
    let n = 0;
    for (let i = 0; i < this.pool.length; i++) {
      const d = this.pool[i]!;
      if (d.life <= 0) continue;
      d.life -= dt;
      d.vy -= SPLASH.gravity * dt;
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      d.z += d.vz * dt;
      if (d.life <= 0 || d.y < d.floor) {
        d.life = 0;
        continue;
      }
      const s = d.size * Math.min(1, (d.life / d.maxLife) * 2.5);
      // Stretch droplets along their vertical speed a little.
      const stretch = 1 + Math.min(1.2, Math.abs(d.vy) * 0.12);
      this.m.compose(this.pos.set(d.x, d.y, d.z), this.q, this.scl.set(s, s * stretch, s));
      this.drops.setMatrixAt(n++, this.m);
    }
    if (n > 0 || this.drops.count > 0) this.drops.instanceMatrix.needsUpdate = true;
    this.drops.count = n;

    for (let r = 0; r < this.rings.length; r++) {
      const ring = this.rings[r]!;
      if (ring.t < 0) continue;
      ring.t += dt;
      const k = ring.t / SPLASH.ringLife;
      if (k >= 1) {
        ring.t = -1;
        ring.mesh.visible = false;
        continue;
      }
      const e = 1 - (1 - k) * (1 - k);
      const rad = SPLASH.ringStartRadius + (SPLASH.ringEndRadius - SPLASH.ringStartRadius) * e;
      ring.mesh.scale.set(rad, 1, rad);
      ring.mat.opacity = 0.85 * (1 - k);
    }
  }

  clear(): void {
    for (const d of this.pool) d.life = 0;
    this.drops.count = 0;
    for (const ring of this.rings) {
      ring.t = -1;
      ring.mesh.visible = false;
    }
  }

  dispose(): void {
    this.drops.geometry.dispose();
    (this.drops.material as THREE.Material).dispose();
    this.drops.dispose();
    this.ringGeo.dispose();
    for (const r of this.rings) r.mat.dispose();
  }
}
