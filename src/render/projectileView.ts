/**
 * Projectile visuals (render only): procedural rocket / grenade meshes that follow ProjectileState with
 * prevPos→pos interpolation, plus their particle trails (via Fx) and a splash when they drop into the sea.
 *
 * Each projectile kind shares one merged vertex-coloured geometry + a scaled inverted-hull outline, so a live
 * rocket costs 3 draw calls (body, outline, flame) and a grenade 2. Visuals are pooled per kind.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Vec3 } from '../core/math';
import type { ProjectileState } from '../sim/projectile';
import { WATER_LEVEL } from '../terrain/types';
import type { Fx } from './fx';
import { FX } from './fx';
import { getToonRamp } from './materials';
import { SplashFx } from './wormFx';

export const PROJECTILE_LOOK = {
  rocket: {
    body: 0x6f7d3c,
    tip: 0xe0392b,
    band: 0xf2c230,
    fins: 0xd13a2c,
    nozzle: 0x3b3a38,
    /** Exhaust flame (sRGB, not tone mapped). */
    flame: 0xffc02a,
    /** Rotation smoothing toward the velocity direction (1/s). */
    turnRate: 18,
  },
  grenade: {
    body: 0x3e6b2c,
    bodyDark: 0x2c4f20,
    cap: 0x9c9c98,
    pin: 0xe0c040,
    /** Fuse sparks per second (ramps up in the last second). */
    sparkRate: 30,
    /** Visual radius (m); the collider is 0.15. */
    radius: 0.19,
  },
  outline: 0x2a1420,
  /** Splash strength for projectiles dropping into the sea (worm = 1). */
  splash: 0.7,
};

type Kind = 'rocket' | 'grenade' | 'ball';

interface Visual {
  kind: Kind;
  root: THREE.Group;
  flame: THREE.Mesh | null;
  id: number;
  seen: number;
  initialized: boolean;
  trailAcc: number;
  sparkAcc: number;
  lastX: number;
  lastY: number;
  lastZ: number;
  time: number;
}

const FWD = new THREE.Vector3(0, 0, 1);

function tint(geo: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const c = new THREE.Color(hex);
  const n = g.getAttribute('position').count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  g.deleteAttribute('uv');
  return g;
}

/** Rocket along +Z, centred on the collider. ~0.8 m long. */
function buildRocket(): THREE.BufferGeometry {
  const L = PROJECTILE_LOOK.rocket;
  const parts: THREE.BufferGeometry[] = [];
  const cyl = (r0: number, r1: number, len: number, z: number, hex: number, seg = 10) => {
    const g = new THREE.CylinderGeometry(r1, r0, len, seg);
    g.rotateX(Math.PI / 2); // +Y → +Z (r1 at the front)
    g.translate(0, 0, z);
    parts.push(tint(g, hex));
  };
  cyl(0.085, 0.085, 0.46, 0.0, L.body);
  cyl(0.087, 0.087, 0.05, 0.17, L.band);
  const nose = new THREE.ConeGeometry(0.085, 0.22, 10);
  nose.rotateX(Math.PI / 2);
  nose.translate(0, 0, 0.34);
  parts.push(tint(nose, L.tip));
  cyl(0.06, 0.075, 0.08, -0.27, L.nozzle);
  for (let i = 0; i < 4; i++) {
    const fin = new THREE.BoxGeometry(0.018, 0.13, 0.16);
    fin.translate(0, 0.11, -0.18);
    fin.rotateZ((i * Math.PI) / 2 + Math.PI / 4);
    parts.push(tint(fin, L.fins));
  }
  const g = mergeGeometries(parts, false)!;
  g.computeBoundingSphere();
  for (const p of parts) p.dispose();
  return g;
}

/** Pineapple grenade: faceted ball, grey cap, lever and a pin ring. Centred on the collider. */
function buildGrenade(): THREE.BufferGeometry {
  const G = PROJECTILE_LOOK.grenade;
  const parts: THREE.BufferGeometry[] = [];
  const ball = new THREE.IcosahedronGeometry(G.radius, 1);
  ball.scale(1, 1.08, 1);
  const b = tint(ball, G.body);
  // Darker alternating facets → pineapple segments.
  const col = b.getAttribute('color') as THREE.BufferAttribute;
  const dark = new THREE.Color(G.bodyDark);
  for (let f = 0; f < col.count / 3; f++) {
    if ((f * 7) % 3 !== 0) continue;
    for (let v = 0; v < 3; v++) col.setXYZ(f * 3 + v, dark.r, dark.g, dark.b);
  }
  b.computeVertexNormals();
  parts.push(b);
  const cap = new THREE.CylinderGeometry(0.055, 0.065, 0.07, 8);
  cap.translate(0, G.radius + 0.03, 0);
  parts.push(tint(cap, G.cap));
  const lever = new THREE.BoxGeometry(0.035, 0.02, 0.19);
  lever.rotateX(0.55);
  lever.translate(0, G.radius - 0.01, -0.07);
  parts.push(tint(lever, G.cap));
  const ring = new THREE.TorusGeometry(0.035, 0.009, 5, 12);
  ring.rotateY(Math.PI / 2);
  ring.translate(0.07, G.radius + 0.04, 0.02);
  parts.push(tint(ring, G.pin));
  const g = mergeGeometries(parts, false)!;
  g.computeBoundingSphere();
  for (const p of parts) p.dispose();
  return g;
}

export class ProjectileView {
  readonly group = new THREE.Group();
  private readonly splash = new SplashFx();
  private readonly visuals = new Map<number, Visual>();
  private readonly list: Visual[] = [];
  private readonly free: Record<Kind, Visual[]> = { rocket: [], grenade: [], ball: [] };
  private readonly mat: THREE.MeshToonMaterial;
  private readonly outlineMat: THREE.MeshBasicMaterial;
  private readonly flameMat: THREE.MeshBasicMaterial;
  private readonly geo: Record<Kind, THREE.BufferGeometry>;
  private readonly flameGeo: THREE.BufferGeometry;
  private frame = 0;
  private readonly v = new THREE.Vector3();
  private readonly q = new THREE.Quaternion();
  private readonly spinQ = new THREE.Quaternion();
  private readonly axis = new THREE.Vector3();
  private readonly tail = new THREE.Vector3();

  constructor(
    private readonly fx: Fx,
    private readonly waterLevel: () => number = () => WATER_LEVEL,
  ) {
    this.group.name = 'projectiles';
    this.group.add(this.splash.group);
    this.mat = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: getToonRamp() });
    this.outlineMat = new THREE.MeshBasicMaterial({ color: PROJECTILE_LOOK.outline, side: THREE.BackSide });
    this.flameMat = new THREE.MeshBasicMaterial({ color: PROJECTILE_LOOK.rocket.flame });
    this.flameMat.toneMapped = false;
    const ballGeo = tint(new THREE.IcosahedronGeometry(0.15, 1), 0x555555);
    this.geo = { rocket: buildRocket(), grenade: buildGrenade(), ball: ballGeo };
    this.flameGeo = new THREE.ConeGeometry(0.06, 0.3, 7);
    this.flameGeo.rotateX(-Math.PI / 2); // tip → −Z
    this.flameGeo.translate(0, 0, -0.44);
  }

  private create(kind: Kind): Visual {
    const pooled = this.free[kind].pop();
    if (pooled) {
      pooled.root.visible = true;
      return pooled;
    }
    const root = new THREE.Group();
    const body = new THREE.Mesh(this.geo[kind], this.mat);
    body.castShadow = true;
    const outline = new THREE.Mesh(this.geo[kind], this.outlineMat);
    if (kind === 'rocket') outline.scale.set(1.32, 1.32, 1.08);
    else outline.scale.setScalar(1.1);
    root.add(body, outline);
    let flame: THREE.Mesh | null = null;
    if (kind === 'rocket') {
      flame = new THREE.Mesh(this.flameGeo, this.flameMat);
      root.add(flame);
    }
    return {
      kind,
      root,
      flame,
      id: -1,
      seen: 0,
      initialized: false,
      trailAcc: 0,
      sparkAcc: 0,
      lastX: 0,
      lastY: 0,
      lastZ: 0,
      time: 0,
    };
  }

  /** Update visuals from the sim list. `alpha` = interpolation factor between the last two ticks. */
  sync(projectiles: readonly ProjectileState[], alpha: number, rawDt: number): void {
    const dt = Math.min(Math.max(rawDt, 0), 0.1);
    const a = Math.min(1, Math.max(0, alpha));
    this.frame++;
    for (let i = 0; i < projectiles.length; i++) {
      const p = projectiles[i]!;
      let v = this.visuals.get(p.id);
      if (!v) {
        const kind: Kind = p.weapon === 'bazooka' ? 'rocket' : p.weapon === 'grenade' ? 'grenade' : 'ball';
        v = this.create(kind);
        v.id = p.id;
        v.initialized = false;
        v.trailAcc = 0;
        v.sparkAcc = 0;
        v.time = 0;
        this.visuals.set(p.id, v);
        this.list.push(v);
        this.group.add(v.root);
      }
      v.seen = this.frame;
      this.animate(v, p, a, dt);
    }
    for (let i = this.list.length - 1; i >= 0; i--) {
      const v = this.list[i]!;
      if (v.seen !== this.frame) this.release(v, i);
    }
    this.splash.update(dt);
  }

  private animate(v: Visual, p: ProjectileState, a: number, dt: number): void {
    const x = p.prevPos[0] + (p.pos[0] - p.prevPos[0]) * a;
    const y = p.prevPos[1] + (p.pos[1] - p.prevPos[1]) * a;
    const z = p.prevPos[2] + (p.pos[2] - p.prevPos[2]) * a;
    const root = v.root;
    root.position.set(x, y, z);
    v.time += dt;
    this.v.set(p.vel[0], p.vel[1], p.vel[2]);
    const speed = this.v.length();

    if (v.kind === 'rocket') {
      if (speed > 1e-3) {
        this.q.setFromUnitVectors(FWD, this.v.multiplyScalar(1 / speed));
        if (!v.initialized) root.quaternion.copy(this.q);
        else root.quaternion.slerp(this.q, 1 - Math.exp(-PROJECTILE_LOOK.rocket.turnRate * dt));
      }
      // Barrel roll for life.
      if (v.flame) {
        const f = 0.8 + 0.35 * Math.sin(v.time * 61) + 0.2 * Math.sin(v.time * 97);
        v.flame.scale.set(1, 1, f);
      }
      // Smoke trail: one puff per FX.trailSpacing metres travelled (independent of frame rate).
      if (v.initialized) {
        const d = Math.hypot(x - v.lastX, y - v.lastY, z - v.lastZ);
        v.trailAcc += d;
        if (v.trailAcc > FX.trailSpacing) {
          this.tail.set(0, 0, -0.4).applyQuaternion(root.quaternion);
          let n = 0;
          while (v.trailAcc > FX.trailSpacing && n < 8) {
            v.trailAcc -= FX.trailSpacing;
            // Spread the puffs along the segment travelled this frame.
            const back = d > 1e-5 ? v.trailAcc / d : 0;
            this.fx.trailPuff(
              x + this.tail.x - (x - v.lastX) * back,
              y + this.tail.y - (y - v.lastY) * back,
              z + this.tail.z - (z - v.lastZ) * back,
              -p.vel[0],
              -p.vel[1],
              -p.vel[2],
            );
            n++;
          }
          if (v.trailAcc > FX.trailSpacing) v.trailAcc = 0;
        }
      }
    } else {
      // Rolling/tumbling: spin about (up × velocity) at speed / radius.
      if (!v.initialized) root.quaternion.identity();
      const hs = Math.hypot(p.vel[0], p.vel[2]);
      if (speed > 0.05 && dt > 0) {
        if (hs > 1e-3) this.axis.set(p.vel[2] / hs, 0, -p.vel[0] / hs);
        else this.axis.set(1, 0, 0);
        const r = v.kind === 'grenade' ? PROJECTILE_LOOK.grenade.radius : 0.15;
        this.spinQ.setFromAxisAngle(this.axis, Math.min(speed / r, 40) * dt);
        root.quaternion.premultiply(this.spinQ);
      }
      if (v.kind === 'grenade' && dt > 0) {
        // Fuse spark from the cap (rotates with the grenade); faster in the last second.
        const left = p.fuseTicks ?? 999;
        const urgent = left < 60 ? 1 : 0.4;
        v.sparkAcc += dt * PROJECTILE_LOOK.grenade.sparkRate * (urgent > 0.5 ? 2 : 1);
        if (v.sparkAcc >= 1) {
          this.tail.set(0, PROJECTILE_LOOK.grenade.radius + 0.07, 0).applyQuaternion(root.quaternion);
          while (v.sparkAcc >= 1) {
            v.sparkAcc -= 1;
            this.fx.fuseSpark(x + this.tail.x, y + this.tail.y, z + this.tail.z, urgent);
          }
        }
      }
    }
    v.lastX = x;
    v.lastY = y;
    v.lastZ = z;
    v.initialized = true;
  }

  /** Projectile removed by the sim: drop its visual; a sea landing splashes. */
  removed(id: number, reason: string, pos: Readonly<Vec3>): void {
    const i = this.list.findIndex((v) => v.id === id);
    if (i >= 0) this.release(this.list[i]!, i);
    if (reason === 'water') this.splash.spawn(pos[0], this.waterLevel(), pos[2], PROJECTILE_LOOK.splash);
  }

  private release(v: Visual, index: number): void {
    this.list.splice(index, 1);
    this.visuals.delete(v.id);
    this.group.remove(v.root);
    v.root.visible = false;
    v.id = -1;
    this.free[v.kind].push(v);
  }

  /** Live projectile visuals. */
  get count(): number {
    return this.list.length;
  }

  clear(): void {
    for (let i = this.list.length - 1; i >= 0; i--) this.release(this.list[i]!, i);
    this.splash.clear();
  }

  dispose(): void {
    this.clear();
    for (const k of Object.keys(this.geo) as Kind[]) this.geo[k].dispose();
    this.flameGeo.dispose();
    this.mat.dispose();
    this.outlineMat.dispose();
    this.flameMat.dispose();
    this.splash.dispose();
  }
}
