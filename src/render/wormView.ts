import * as THREE from 'three';
import type { JumpKind } from '../core/commands';
import { TICK_DT } from '../core/loop';
import type { Vec3 } from '../core/math';
import type { WormState } from '../sim/world';
import {
  BACKFLIP_UP_SPEED,
  WALK_SPEED,
  WORM_CENTER_TO_FEET,
  WORM_GRAVITY,
  type DeathCause,
} from '../sim/worm';
import { WATER_LEVEL } from '../terrain/types';
import { teamColor } from './palette';
import { getToonRamp } from './materials';
import { SplashFx } from './wormFx';
import {
  BONE,
  LID_OPEN,
  boneRestLocal,
  createOutlineMaterial,
  createWormMaterial,
  createWormRig,
  getGravestoneGeometry,
} from './wormModel';

/** Facial expressions (lids, brows, mouth, eye size). */
export type WormExpression = 'happy' | 'neutral' | 'determined' | 'scared';

interface ExpressionPose {
  /** Lid angle offset from LID_OPEN (rad, + = more closed). */
  lid: number;
  /** Lid / brow slant (rad, + = inner corners down = angry). */
  lidSlant: number;
  browY: number;
  browSlant: number;
  /** Mouth scale.y: 1 = full smile, ~0.1 = grim line. */
  mouth: number;
  /** 0 = smile, 1 = frown (mouth bone rotated by π). */
  frown: number;
  eye: number;
  pupil: number;
}

/** Expression tweakables. */
export const WORM_EXPRESSIONS: Record<WormExpression, ExpressionPose> = {
  happy: { lid: -0.08, lidSlant: -0.1, browY: 0.014, browSlant: -0.14, mouth: 1, frown: 0, eye: 1, pupil: 1 },
  neutral: { lid: 0.18, lidSlant: 0, browY: 0, browSlant: 0, mouth: 0.5, frown: 0, eye: 1, pupil: 1 },
  determined: {
    lid: 0.72,
    lidSlant: 0.34,
    browY: -0.024,
    browSlant: 0.5,
    mouth: 0.12,
    frown: 0,
    eye: 1,
    pupil: 1.05,
  },
  scared: {
    lid: -0.4,
    lidSlant: -0.3,
    browY: 0.03,
    browSlant: -0.45,
    mouth: 0.8,
    frown: 1,
    eye: 1.12,
    pupil: 0.72,
  },
};

export interface WormSyncOptions {
  /** Worm currently aiming (aim camera): shows the determined face. */
  aimingId?: number | null;
}

/** HP at or below which an idle worm looks scared. */
const SCARED_HP = 25;
/** Lid angle (rad) for a fully closed eye. */
const LID_CLOSED = 1.75;

/** Render-side mirror of the sim worm events the view reacts to. */
export type WormViewEvent =
  | { type: 'jumped'; id: number; kind: JumpKind }
  | { type: 'landed'; id: number; drop: number }
  | { type: 'damaged'; id: number; amount: number }
  | { type: 'died'; id: number; cause: DeathCause; pos: Vec3 };

export interface WormViewOptions {
  /** Water surface height for drown splashes (default WATER_LEVEL). */
  waterLevel?: number;
  /** Cartoon outline hull (+1 draw call per worm). Default true. */
  outline?: boolean;
}

/** Animation tweakables. Rates are exponential damping rates (1/s). */
export const WORM_ANIM = {
  yawRate: 16,
  scaleRate: 16,
  leanRate: 10,
  /** Walk: body waves per metre walked, bend amplitude (rad), tail swing (rad), vertical pulse. */
  walkWavesPerM: 1.3,
  walkBend: 0.21,
  walkTail: 0.5,
  walkPulse: 0.06,
  walkLean: 0.12,
  idleBreath: 0.028,
  idleSway: 0.05,
  windupSquash: 0.76,
  /** Flail frequency (rad/s) / amplitude while falling or knocked. */
  flailFreq: 15,
  flailBend: 0.2,
  fallStretch: 1.1,
  /** Landing squash spring: stiffness, damping, impulse = base + perMetre·drop (clamped). */
  springK: 260,
  springC: 13,
  landImpulseBase: 2.2,
  landImpulsePerM: 0.9,
  landImpulseMax: 9,
  /** Knocked tumble speed (rad/s) = base + perMps·speed. */
  tumbleBase: 5,
  tumblePerMps: 0.8,
  blinkMin: 1.8,
  blinkMax: 5,
  blinkDuration: 0.13,
  /** Drown: sink speed (m/s) and time until hidden. */
  sinkSpeed: 2.4,
  sinkTime: 0.7,
  /** Gravestone drop height and gravity. */
  graveDrop: 1.8,
  graveGravity: 22,
  /** Active marker: height above worm centre, bob amplitude/frequency, spin speed. */
  markerHeight: 1.0,
  markerBob: 0.14,
  markerBobFreq: 5,
  markerSpin: 2.2,
  /** Marker fades out between (near + range) and near metres from the camera. */
  markerFadeNear: 2.9,
  markerFadeRange: 0.8,
  /** Seconds the determined (aiming) face lingers after leaving aim mode. */
  aimHold: 2.5,
} as const;

const TAU = Math.PI * 2;
const wrap = (a: number): number => {
  a %= TAU;
  if (a > Math.PI) a -= TAU;
  else if (a < -Math.PI) a += TAU;
  return a;
};
const damp = (rate: number, dt: number): number => 1 - Math.exp(-rate * dt);
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

const AIR_STATES = new Set(['jump', 'backflip', 'fall', 'knocked']);

class WormVisual {
  readonly root = new THREE.Group();
  readonly flip = new THREE.Group();
  readonly squash = new THREE.Group();
  readonly bones: THREE.Bone[];
  grave: THREE.Mesh | null = null;

  seen = 0;
  initialized = false;
  time: number;
  visYaw = 0;
  targetYaw = 0;
  pitch = 0;
  roll = 0;
  lean = 0;
  sy = 1;
  q = 0;
  qv = 0;
  walkPhase = 0;
  walkAmp = 0;
  flailAmp = 0;
  flailPhase = 0;
  blinkIn: number;
  blinkT = 0;
  squint = 0;
  lookX = 0;
  lookY = 0;
  sacX = 0;
  sacY = 0;
  sacIn = 1;
  headLook = 0;
  headLookTarget = 0;
  hurt = 0;
  prevState = '';
  landedEvent = false;
  flipping = false;
  tumbleDir = 1;
  dead = false;
  deathCause: DeathCause | null = null;
  deathPos: Vec3 | null = null;
  sinkT = -1;
  graveT = -1;
  /** Seconds the determined face lingers after aiming ends. */
  aimHold = 0;
  /** Current blended expression pose. */
  readonly ex: ExpressionPose = { ...WORM_EXPRESSIONS.happy };
  private rng: number;

  constructor(
    readonly id: number,
    readonly team: number,
    material: THREE.Material,
    outline: THREE.Material | null,
  ) {
    const rig = createWormRig(team, material, outline);
    this.bones = rig.bones;
    this.root.add(this.flip);
    this.flip.add(this.squash);
    this.squash.position.y = -WORM_CENTER_TO_FEET;
    this.squash.add(rig.mesh);
    if (rig.outline) this.squash.add(rig.outline);
    this.rng = (Math.imul(id + 1, 2654435761) ^ 0x5bd1e995) >>> 0;
    this.time = this.rand() * 10;
    this.blinkIn = 0.5 + this.rand() * 3;
  }

  rand(): number {
    this.rng = (Math.imul(this.rng, 1664525) + 1013904223) >>> 0;
    return this.rng / 4294967296;
  }

  kick(v: number): void {
    this.qv += v;
  }
}

/**
 * Procedural worms driven only by WormState + events (never mutates sim state).
 * Per worm: 1 skinned toon mesh + 1 outline hull (optional) sharing one skeleton, plus a shadow pass.
 */
export class WormView {
  readonly group = new THREE.Group();
  private readonly visuals = new Map<number, WormVisual>();
  /** Same visuals as an array: iterated per frame without allocating an iterator. */
  private readonly list: WormVisual[] = [];
  private readonly material = createWormMaterial();
  private readonly outlineMaterial: THREE.MeshBasicMaterial | null;
  private readonly graveMaterial = createWormMaterial();
  private readonly splash = new SplashFx();
  private readonly marker: THREE.Mesh;
  private readonly markerMat: THREE.MeshToonMaterial;
  private readonly waterLevel: number;
  private activeId: number | null = null;
  private markerTeam = -1;
  private frame = 0;
  private time = 0;
  /** Deaths reported before the worm was first synced. */
  private readonly pendingDeaths = new Map<number, { cause: DeathCause; pos: Vec3 }>();
  private readonly pose = { pos: [0, 0, 0] as Vec3, yaw: 0 };
  private readonly exprOverride = new Map<number, WormExpression>();
  private aimingId: number | null = null;
  private readonly browRestL = boneRestLocal(BONE.browL);
  private readonly browRestR = boneRestLocal(BONE.browR);

  constructor(opts: WormViewOptions = {}) {
    this.waterLevel = opts.waterLevel ?? WATER_LEVEL;
    this.outlineMaterial = opts.outline === false ? null : createOutlineMaterial();
    this.group.name = 'worms';
    this.group.add(this.splash.group);
    const markerGeo = new THREE.ConeGeometry(0.17, 0.36, 4, 1);
    markerGeo.rotateX(Math.PI); // point down
    this.markerMat = new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: getToonRamp() });
    this.markerMat.transparent = true;
    this.marker = new THREE.Mesh(markerGeo, this.markerMat);
    this.marker.visible = false;
    this.marker.renderOrder = 3;
    // Fade out when the camera is close (over-the-shoulder aim) so it never blocks the view.
    const camPos = new THREE.Vector3();
    this.marker.onBeforeRender = (_r, _s, cam) => {
      camPos.setFromMatrixPosition(cam.matrixWorld);
      const d = camPos.distanceTo(this.marker.position);
      this.markerMat.opacity = clamp((d - WORM_ANIM.markerFadeNear) / WORM_ANIM.markerFadeRange, 0, 1);
    };
    this.group.add(this.marker);
  }

  /**
   * Force a facial expression on a worm (null = automatic: happy idle, neutral walking, scared in the air or
   * at low HP, determined while aiming / winding up). Expressions blend smoothly.
   */
  setExpression(id: number, expression: WormExpression | null): void {
    if (expression) this.exprOverride.set(id, expression);
    else this.exprOverride.delete(id);
  }

  /** Mark the worm whose turn it is (bouncing arrow above it). */
  setActive(id: number | null): void {
    this.activeId = id;
  }

  /**
   * Render-interpolated pose of a worm from the last sync (centre position + smoothed visual yaw).
   * Returns a shared object (valid until the next call) or null. Handy as a camera target getter.
   */
  renderPose(id: number): { pos: Vec3; yaw: number } | null {
    const v = this.visuals.get(id);
    if (!v || !v.initialized) return null;
    const p = v.root.position;
    this.pose.pos[0] = p.x;
    this.pose.pos[1] = p.y;
    this.pose.pos[2] = p.z;
    this.pose.yaw = v.visYaw;
    return this.pose;
  }

  handleEvent(e: WormViewEvent): void {
    const v = this.visuals.get(e.id);
    switch (e.type) {
      case 'landed':
        if (!v) return;
        v.landedEvent = true;
        v.kick(
          clamp(WORM_ANIM.landImpulseBase + WORM_ANIM.landImpulsePerM * e.drop, 0, WORM_ANIM.landImpulseMax),
        );
        if (e.drop > 3) v.squint = 0.35;
        return;
      case 'jumped':
        if (!v) return;
        v.kick(-3.2); // stretch on take-off
        if (e.kind === 'backflip') v.flipping = true;
        return;
      case 'damaged':
        if (!v) return;
        v.hurt = 0.45;
        v.squint = 0.4;
        v.kick(2.5);
        return;
      case 'died':
        if (v) {
          v.deathCause = e.cause;
          v.deathPos = [e.pos[0], e.pos[1], e.pos[2]];
        } else this.pendingDeaths.set(e.id, { cause: e.cause, pos: [e.pos[0], e.pos[1], e.pos[2]] });
        return;
    }
  }

  sync(worms: readonly WormState[], alpha: number, dt = 1 / 60, opts?: WormSyncOptions): void {
    const d = Math.min(Math.max(dt, 0), 0.1);
    this.aimingId = opts?.aimingId ?? null;
    this.time += d;
    this.frame++;
    for (let i = 0; i < worms.length; i++) {
      const w = worms[i]!;
      let v = this.visuals.get(w.id);
      if (!v) {
        v = new WormVisual(w.id, w.team, this.material, this.outlineMaterial);
        this.visuals.set(w.id, v);
        this.list.push(v);
        this.group.add(v.root);
        const pd = this.pendingDeaths.get(w.id);
        if (pd) {
          v.deathCause = pd.cause;
          v.deathPos = pd.pos;
          this.pendingDeaths.delete(w.id);
        }
      }
      v.seen = this.frame;
      this.animate(v, w, alpha, d);
    }
    // Worms that vanished from the sim list (world reload without clear()).
    for (let i = this.list.length - 1; i >= 0; i--) {
      if (this.list[i]!.seen !== this.frame) this.remove(this.list[i]!);
    }
    this.splash.update(d);
    this.updateMarker(d);
  }

  private animate(v: WormVisual, w: WormState, alpha: number, dt: number): void {
    const A = WORM_ANIM;
    const b = v.bones;
    v.time += dt;

    // --- Transform: interpolated position + shortest-arc yaw, visually smoothed.
    const a = clamp(alpha, 0, 1);
    const px = w.prevPos[0] + (w.pos[0] - w.prevPos[0]) * a;
    const py = w.prevPos[1] + (w.pos[1] - w.prevPos[1]) * a;
    const pz = w.prevPos[2] + (w.pos[2] - w.prevPos[2]) * a;
    v.targetYaw = wrap(w.prevYaw + wrap(w.yaw - w.prevYaw) * a);
    if (!v.initialized) {
      v.visYaw = v.targetYaw;
      v.prevState = w.state;
      v.initialized = true;
    }
    const dyaw = wrap(v.targetYaw - v.visYaw);
    v.visYaw = wrap(v.visYaw + dyaw * damp(A.yawRate, dt));

    // --- Death: drown (sink + splash) or gravestone.
    if (!w.alive) {
      if (!v.dead) this.startDeath(v, w);
      this.updateDeath(v, dt);
      v.root.position.set(px, py + (v.sinkT >= 0 ? -A.sinkSpeed * v.sinkT - 3 * v.sinkT * v.sinkT : 0), pz);
      v.root.rotation.y = v.visYaw;
      if (v.sinkT >= 0) {
        v.flip.rotation.x += dt * 2.5;
        v.squash.scale.set(1, 1.15, 1);
      }
      return;
    }
    v.root.visible = true;
    v.root.position.set(px, py, pz);
    v.root.rotation.y = v.visYaw;

    // --- State transitions (event-free fallbacks so the view also works without handleEvent).
    const st = w.state;
    const wasAir = AIR_STATES.has(v.prevState);
    if (st !== v.prevState) {
      if ((st === 'idle' || st === 'walk') && wasAir && !v.landedEvent) v.kick(A.landImpulseBase);
      if (st === 'backflip') v.flipping = true;
      if (st === 'knocked') v.tumbleDir = v.rand() < 0.5 ? -1 : 1;
      v.prevState = st;
    }
    v.landedEvent = false;

    // Interpolated vertical speed (gravity is constant between ticks while airborne).
    const vy = w.grounded ? 0 : w.vel[1] - WORM_GRAVITY * TICK_DT * (1 - a);
    const hSpeed = Math.hypot(w.vel[0], w.vel[2]);

    // --- Targets per state.
    let targetSy = 1;
    let targetLean = 0;
    let walkTarget = 0;
    let flailTarget = 0;
    let lookYTarget = 0;
    switch (st) {
      case 'idle':
        break;
      case 'walk':
        walkTarget = clamp(hSpeed / WALK_SPEED, 0.4, 1.2);
        targetLean = A.walkLean;
        break;
      case 'windup':
        targetSy = A.windupSquash;
        targetLean = -0.12;
        lookYTarget = 0.25;
        break;
      case 'jump':
        targetSy = 1 + clamp(vy * 0.035, -0.08, 0.2);
        targetLean = 0.22;
        lookYTarget = vy > 0 ? 0.2 : -0.3;
        break;
      case 'backflip':
        targetSy = 1.04;
        lookYTarget = 0.3;
        break;
      case 'fall':
        targetSy = A.fallStretch;
        flailTarget = 1;
        lookYTarget = -0.45;
        break;
      case 'knocked':
        targetSy = 1.05;
        flailTarget = 1;
        break;
      default:
        break;
    }

    // --- Pitch/roll: backflip, tumble, or settle upright (via the nearest equivalent angle).
    if (v.flipping && st === 'backflip') {
      const p = clamp((BACKFLIP_UP_SPEED - vy) / (2 * BACKFLIP_UP_SPEED), 0, 1);
      const eased = p * p * (3 - 2 * p);
      v.pitch = -TAU * Math.min(1, eased * 1.08);
      v.roll += (0 - v.roll) * damp(10, dt);
    } else if (st === 'knocked' && !w.grounded) {
      v.flipping = false;
      const spin = A.tumbleBase + A.tumblePerMps * hSpeed;
      v.pitch -= spin * dt;
      v.roll += v.tumbleDir * spin * 0.35 * dt;
    } else {
      v.flipping = false;
      v.pitch = wrap(v.pitch);
      v.roll = wrap(v.roll);
      const settle = st === 'knocked' ? 6 : 14;
      v.pitch += (0 - v.pitch) * damp(settle, dt);
      v.roll += (0 - v.roll) * damp(settle, dt);
    }
    v.flip.rotation.set(v.pitch, 0, v.roll);

    // --- Squash & stretch: damped state target × landing spring.
    v.sy += (targetSy - v.sy) * damp(A.scaleRate, dt);
    // Semi-implicit spring, sub-stepped for stability with long frames.
    const steps = dt > 1 / 50 ? 3 : 1;
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      v.qv += (-A.springK * v.q - A.springC * v.qv) * h;
      v.q = clamp(v.q + v.qv * h, -0.35, 0.42);
    }
    v.walkAmp += (walkTarget - v.walkAmp) * damp(8, dt);
    v.flailAmp += (flailTarget - v.flailAmp) * damp(6, dt);
    v.walkPhase += hSpeed * dt * A.walkWavesPerM * TAU * (st === 'walk' ? 1 : 0.3);
    v.flailPhase += A.flailFreq * dt;
    const idleAmp = Math.max(0, 1 - v.walkAmp - v.flailAmp);
    const breath = 1 + A.idleBreath * Math.sin(v.time * 2.3) * idleAmp;
    const pulse = 1 + A.walkPulse * v.walkAmp * Math.sin(v.walkPhase * 2);
    const sy = v.sy * (1 - v.q) * breath * pulse;
    const sxz = 1 / Math.sqrt(Math.max(0.3, sy));
    v.squash.scale.set(sxz, sy, sxz);

    // --- Body bend: walking S-wave, flailing, idle sway, lean, hurt shake.
    v.lean += (targetLean - v.lean) * damp(A.leanRate, dt);
    const ph = v.walkPhase;
    const wb = A.walkBend * v.walkAmp;
    const fb = A.flailBend * v.flailAmp;
    const fp = v.flailPhase;
    const sway = A.idleSway * idleAmp;
    const hurtShake = v.hurt > 0 ? Math.sin(v.hurt * 60) * v.hurt * 0.5 : 0;
    v.hurt = Math.max(0, v.hurt - dt);
    b[BONE.base]!.rotation.set(
      v.lean * 0.6,
      0,
      wb * Math.sin(ph) + fb * Math.sin(fp) + sway * Math.sin(v.time * 0.9),
    );
    b[BONE.mid]!.rotation.set(
      v.lean * 0.3,
      0,
      wb * 0.9 * Math.sin(ph - 1.1) + fb * Math.sin(fp - 1.3) + sway * 0.6 * Math.sin(v.time * 1.1 + 1),
    );
    b[BONE.upper]!.rotation.set(
      v.lean * 0.2,
      0,
      wb * 0.8 * Math.sin(ph - 2.2) + fb * 0.8 * Math.sin(fp - 2.6),
    );
    // Head: counter-bend to stay roughly level, idle glances, hurt shake.
    v.headLook += (v.headLookTarget - v.headLook) * damp(4, dt);
    b[BONE.head]!.rotation.set(
      -v.lean * 0.4,
      v.headLook * idleAmp + hurtShake,
      -wb * 0.9 * Math.sin(ph - 1.6) - fb * 0.5 * Math.sin(fp - 2),
    );
    b[BONE.tail]!.rotation.set(
      -0.12 * v.flailAmp * Math.sin(fp * 0.7),
      A.walkTail * v.walkAmp * Math.sin(ph + Math.PI) +
        0.14 * idleAmp * Math.sin(v.time * 1.3) +
        fb * 1.5 * Math.sin(fp),
      0,
    );
    // Tail tip follows with a phase lag (whip) and lifts a little when idle.
    b[BONE.tailTip]!.rotation.set(
      -0.08 * idleAmp * (1 + Math.sin(v.time * 0.8)) - 0.15 * v.flailAmp * Math.sin(fp * 0.7 - 0.8),
      A.walkTail * 0.9 * v.walkAmp * Math.sin(ph + Math.PI - 1.0) +
        0.2 * idleAmp * Math.sin(v.time * 1.3 - 0.9) +
        fb * 1.8 * Math.sin(fp - 0.9),
      0,
    );

    // --- Eyes: blink, squint, pupils look toward the turn / saccades.
    v.blinkIn -= dt;
    if (v.blinkIn <= 0) {
      v.blinkT = A.blinkDuration;
      v.blinkIn = A.blinkMin + v.rand() * (A.blinkMax - A.blinkMin);
    }
    v.sacIn -= dt;
    if (v.sacIn <= 0) {
      v.sacIn = 0.6 + v.rand() * 2.2;
      v.sacX = (v.rand() - 0.5) * 0.7;
      v.sacY = (v.rand() - 0.5) * 0.35;
      if (v.rand() < 0.35) v.headLookTarget = (v.rand() - 0.5) * 0.8;
    }
    // Closure 0 = expression pose, 1 = shut (blink) – applied on top of the expression's lid angle.
    let close = 0;
    if (v.blinkT > 0) {
      v.blinkT -= dt;
      const k = 1 - Math.abs(v.blinkT / A.blinkDuration - 0.5) * 2; // 0 → 1 → 0
      close = clamp(k * 1.5, 0, 1);
    }
    if (v.squint > 0) {
      v.squint -= dt;
      close = Math.max(close, 0.55);
    }

    // --- Expression: override > aiming > state/HP, blended.
    const exprName = this.pickExpression(v, w, dt);
    const target = WORM_EXPRESSIONS[exprName];
    const ex = v.ex;
    const ek = damp(9, dt);
    ex.lid += (target.lid - ex.lid) * ek;
    ex.lidSlant += (target.lidSlant - ex.lidSlant) * ek;
    ex.browY += (target.browY - ex.browY) * ek;
    ex.browSlant += (target.browSlant - ex.browSlant) * ek;
    ex.mouth += (target.mouth - ex.mouth) * ek;
    ex.frown += (target.frown - ex.frown) * ek;
    ex.eye += (target.eye - ex.eye) * ek;
    ex.pupil += (target.pupil - ex.pupil) * ek;

    const eyeWide = ex.eye * (1 + 0.1 * v.flailAmp);
    b[BONE.eyeL]!.scale.setScalar(eyeWide);
    b[BONE.eyeR]!.scale.setScalar(eyeWide);
    const lidA = LID_OPEN + ex.lid;
    const lidX = lidA + (LID_CLOSED - lidA) * close;
    const slant = ex.lidSlant * (1 - close);
    b[BONE.lidL]!.rotation.set(lidX, 0, slant);
    b[BONE.lidR]!.rotation.set(lidX, 0, -slant);
    b[BONE.lidL]!.scale.setScalar(eyeWide);
    b[BONE.lidR]!.scale.setScalar(eyeWide);
    // Brows ride up with wide eyes and bob a little with the blink.
    const browY = ex.browY + (eyeWide - 1) * 0.1 - close * 0.01;
    b[BONE.browL]!.position.set(this.browRestL.x, this.browRestL.y + browY, this.browRestL.z);
    b[BONE.browR]!.position.set(this.browRestR.x, this.browRestR.y + browY, this.browRestR.z);
    b[BONE.browL]!.rotation.set(0, 0, ex.browSlant);
    b[BONE.browR]!.rotation.set(0, 0, -ex.browSlant);
    const mouth = b[BONE.mouth]!;
    mouth.rotation.set(0, 0, Math.PI * ex.frown);
    mouth.scale.set(1, Math.max(0.08, ex.mouth), 1);

    const turnLook = clamp(dyaw * 1.2, -0.6, 0.6);
    const lx = turnLook + v.sacX * idleAmp;
    const ly = lookYTarget + v.sacY * idleAmp;
    v.lookX += (lx - v.lookX) * damp(14, dt);
    v.lookY += (ly - v.lookY) * damp(14, dt);
    b[BONE.pupilL]!.rotation.set(-v.lookY, v.lookX, 0);
    b[BONE.pupilR]!.rotation.set(-v.lookY, v.lookX, 0);
    b[BONE.pupilL]!.scale.set(ex.pupil, ex.pupil, 1);
    b[BONE.pupilR]!.scale.set(ex.pupil, ex.pupil, 1);
  }

  private pickExpression(v: WormVisual, w: WormState, dt: number): WormExpression {
    const forced = this.exprOverride.get(v.id);
    if (forced) return forced;
    if (this.aimingId === v.id) v.aimHold = WORM_ANIM.aimHold;
    else v.aimHold = Math.max(0, v.aimHold - dt);
    if (v.aimHold > 0 || w.state === 'windup') return 'determined';
    if (w.state === 'fall' || w.state === 'knocked' || v.hurt > 0) return 'scared';
    if (w.hp <= SCARED_HP) return 'scared';
    if (w.state === 'walk') return 'neutral';
    return 'happy';
  }

  private startDeath(v: WormVisual, w: WormState): void {
    v.dead = true;
    const pos = v.deathPos ?? w.pos;
    const cause: DeathCause = v.deathCause ?? (pos[1] < this.waterLevel + 0.05 ? 'water' : 'fall');
    if (cause === 'water') {
      v.sinkT = 0;
      this.splash.spawn(pos[0], this.waterLevel, pos[2], 1);
    } else {
      v.root.visible = false;
      const grave = new THREE.Mesh(getGravestoneGeometry(), this.graveMaterial);
      grave.castShadow = true;
      grave.receiveShadow = true;
      grave.position.set(pos[0], pos[1] - WORM_CENTER_TO_FEET, pos[2]);
      grave.rotation.y = v.visYaw;
      grave.userData.baseY = grave.position.y;
      v.grave = grave;
      v.graveT = 0;
      this.group.add(grave);
    }
  }

  private updateDeath(v: WormVisual, dt: number): void {
    const A = WORM_ANIM;
    if (v.sinkT >= 0) {
      v.sinkT += dt;
      if (v.sinkT > A.sinkTime) v.root.visible = false;
    }
    if (v.grave && v.graveT >= 0) {
      v.graveT += dt;
      const t = v.graveT;
      const baseY = v.grave.userData.baseY as number;
      const tFall = Math.sqrt((2 * A.graveDrop) / A.graveGravity);
      if (t < tFall) {
        v.grave.position.y = baseY + A.graveDrop - 0.5 * A.graveGravity * t * t;
        v.grave.scale.set(0.9, 1.12, 0.9);
      } else {
        // Damped wobble after impact.
        const k = t - tFall;
        const s = 0.28 * Math.exp(-k * 7) * Math.cos(k * 26);
        v.grave.position.y = baseY;
        v.grave.scale.set(1 + s * 0.5, 1 - s, 1 + s * 0.5);
        if (k > 1) {
          v.grave.scale.set(1, 1, 1);
          v.graveT = -1;
        }
      }
    }
  }

  private updateMarker(dt: number): void {
    const A = WORM_ANIM;
    const v = this.activeId !== null ? this.visuals.get(this.activeId) : undefined;
    if (!v || v.dead || !v.initialized) {
      this.marker.visible = false;
      return;
    }
    if (v.team !== this.markerTeam) {
      this.markerTeam = v.team;
      this.markerMat.color.setHex(teamColor(v.team));
      this.markerMat.emissive.setHex(teamColor(v.team)).multiplyScalar(0.35);
    }
    const p = v.root.position;
    const bob = A.markerBob * Math.abs(Math.sin(this.time * A.markerBobFreq * 0.5));
    this.marker.visible = true;
    this.marker.position.set(p.x, p.y + A.markerHeight + bob, p.z);
    this.marker.rotation.y += A.markerSpin * dt;
  }

  private remove(v: WormVisual): void {
    this.group.remove(v.root);
    if (v.grave) this.group.remove(v.grave);
    for (const bone of v.bones) bone.removeFromParent();
    v.root.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) (o as THREE.SkinnedMesh).skeleton.dispose();
    });
    this.visuals.delete(v.id);
    const i = this.list.indexOf(v);
    if (i >= 0) this.list.splice(i, 1);
  }

  clear(): void {
    for (let i = this.list.length - 1; i >= 0; i--) this.remove(this.list[i]!);
    this.pendingDeaths.clear();
    this.exprOverride.clear();
    this.splash.clear();
    this.activeId = null;
    this.marker.visible = false;
  }

  dispose(): void {
    this.clear();
    this.material.dispose();
    this.outlineMaterial?.dispose();
    this.graveMaterial.dispose();
    this.markerMat.dispose();
    this.marker.geometry.dispose();
    this.splash.dispose();
  }
}
