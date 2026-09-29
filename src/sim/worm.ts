import type { JumpKind } from '../core/commands';
import { TICK_DT } from '../core/loop';
import type { Vec2, Vec3 } from '../core/math';
import { RAPIER } from './physics';

// ---------------------------------------------------------------------------
// Balance constants – tweak here. Distances in metres, speeds in m/s, time in ticks (60 Hz).
// ---------------------------------------------------------------------------

/** Capsule shape (matches the placeholder render capsule: radius 0.3, cylinder length 0.5). */
export const WORM_RADIUS = 0.3;
export const WORM_HALF_HEIGHT = 0.25;
/** Distance from worm centre (pos) to its feet when standing, excluding the controller gap. */
export const WORM_CENTER_TO_FEET = WORM_RADIUS + WORM_HALF_HEIGHT;
export const WORM_MAX_HP = 100;

/** Gravity applied to worms (m/s²). */
export const WORM_GRAVITY = -9.81;
/** Max downward speed. */
export const TERMINAL_FALL_SPEED = 40;

/** Ground walk speed. */
export const WALK_SPEED = 3;
/** Horizontal steering acceleration while airborne (reduced air control). */
export const AIR_ACCEL = 4;

/** Forward jump: horizontal speed along facing + vertical speed. Apex ≈ 1.27 m, length ≈ 2.5 m on flat. */
export const JUMP_FORWARD_SPEED = 2.5;
export const JUMP_UP_SPEED = 5;
/** Backflip: horizontal speed opposite facing + vertical speed. Apex ≈ 2.5 m, ≈ 1.7 m backwards on flat. */
export const BACKFLIP_BACK_SPEED = 1.2;
export const BACKFLIP_UP_SPEED = 7;
/**
 * Double-tap window for backflip (18 ticks = 0.3 s). This is also the wind-up delay of a plain
 * forward jump, because the sim has to wait to know it was not a double tap.
 */
export const BACKFLIP_WINDOW_TICKS = 18;
/** Ticks after leaving the ground during which a jump is still allowed. */
export const COYOTE_TICKS = 6;

/** Falls from higher than this (peak height since leaving ground → landing) hurt. */
export const FALL_DAMAGE_MIN_DROP = 6;
export const FALL_DAMAGE_PER_M = 5;
export const FALL_DAMAGE_MAX = 50;

/** Slopes up to this angle are walkable. */
export const MAX_SLOPE_CLIMB_DEG = 45;
/** Slopes steeper than this make the worm slide down. */
export const MIN_SLOPE_SLIDE_DEG = 50;
export const AUTOSTEP_MAX_HEIGHT = 0.3;
export const AUTOSTEP_MIN_WIDTH = 0.2;
export const SNAP_TO_GROUND_DIST = 0.2;
/** Skin gap the character controller keeps to its surroundings. */
export const CONTROLLER_OFFSET = 0.01;

/** Horizontal deceleration of a knocked worm sliding on the ground (m/s²). */
export const KNOCK_GROUND_FRICTION = 12;
/** A knocked worm that is grounded and slower than this regains control. */
export const KNOCK_RECOVER_SPEED = 0.5;

// ---------------------------------------------------------------------------

/**
 * High-level worm state, meant for render/animation.
 * - windup: jump pressed, waiting for a possible second press (backflip) – crouch/squash
 * - fall: airborne without having jumped (walked off a ledge, spawn drop)
 * - knocked: ballistic after an impulse (explosion/bat); no player control until grounded and slow
 */
export type WormAnimState = 'idle' | 'walk' | 'windup' | 'jump' | 'backflip' | 'fall' | 'knocked' | 'dead';

export type DeathCause = 'water' | 'fall';

export interface WormState {
  id: number;
  team: number;
  hp: number;
  alive: boolean;
  /** Capsule centre (world). Feet are WORM_CENTER_TO_FEET below. */
  pos: Vec3;
  /** Position at the previous tick, for render interpolation. */
  prevPos: Vec3;
  /** Facing yaw (radians). 0 faces +Z; forward = [sin(yaw), 0, cos(yaw)] (three.js rotation.y). */
  yaw: number;
  /** Yaw at the previous tick, for render interpolation. */
  prevYaw: number;
  grounded: boolean;
  /** Velocity (m/s) the controller is integrating. */
  vel: Vec3;
  state: WormAnimState;
}

export interface WormEvents {
  wormJumped: { id: number; kind: JumpKind };
  wormLanded: { id: number; drop: number; damage: number };
  wormDamaged: { id: number; amount: number; hp: number; cause: DeathCause };
  wormDied: { id: number; cause: DeathCause; pos: Vec3 };
}

export type WormEmit = <K extends keyof WormEvents>(type: K, payload: WormEvents[K]) => void;

/** The two controller configurations worms share (one Rapier controller each, per world). */
export interface WormControllers {
  /** Walking: autostep + snap-to-ground. */
  ground: RAPIER.KinematicCharacterController;
  /** Airborne/ballistic: no snapping, no autostep (so jumps are not pulled back to the ground). */
  air: RAPIER.KinematicCharacterController;
}

export function createWormControllers(world: RAPIER.World): WormControllers {
  const setup = (c: RAPIER.KinematicCharacterController) => {
    c.setUp({ x: 0, y: 1, z: 0 });
    c.setSlideEnabled(true);
    c.setMaxSlopeClimbAngle((MAX_SLOPE_CLIMB_DEG * Math.PI) / 180);
    c.setMinSlopeSlideAngle((MIN_SLOPE_SLIDE_DEG * Math.PI) / 180);
    c.setApplyImpulsesToDynamicBodies(false);
    return c;
  };
  const ground = setup(world.createCharacterController(CONTROLLER_OFFSET));
  ground.enableAutostep(AUTOSTEP_MAX_HEIGHT, AUTOSTEP_MIN_WIDTH, false);
  ground.enableSnapToGround(SNAP_TO_GROUND_DIST);
  const air = setup(world.createCharacterController(CONTROLLER_OFFSET));
  air.disableAutostep();
  air.disableSnapToGround();
  return { ground, air };
}

export function fallDamage(drop: number): number {
  if (drop <= FALL_DAMAGE_MIN_DROP) return 0;
  return Math.min(FALL_DAMAGE_MAX, Math.round((drop - FALL_DAMAGE_MIN_DROP) * FALL_DAMAGE_PER_M));
}

const EPS = 1e-6;
/** Per-tick movement (m) below which a standing worm is held perfectly still. */
const IDLE_DEADZONE = 1e-4;

/**
 * A worm driven by Rapier's KinematicCharacterController (kinematicPositionBased body + capsule).
 *
 * The worm integrates its own velocity (gravity, walking, jumps, knockback) at TICK_DT and asks the
 * controller how far it may actually move. Knockback does NOT switch to a dynamic body: `applyImpulse`
 * adds to the velocity and puts the worm in the ballistic `knocked` state, which the same controller
 * integrates. That keeps a single body type, needs no body swapping, and is fully deterministic.
 */
export class Worm {
  readonly s: WormState;
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;

  /** Held walk intent (world XZ, length ≤ 1). */
  private moveDir: Vec2 = [0, 0];
  /** > 0 while waiting for a possible second jump press. */
  private jumpPendingTicks = 0;
  private ticksSinceGrounded = 0;
  private jumpedSinceGrounded = false;
  private knocked = false;
  /** Highest y since the worm last stood on ground. */
  private peakY: number;
  /** Spawn drops never hurt: fall damage starts after the first touchdown. */
  private hasLanded = false;

  constructor(
    private readonly world: RAPIER.World,
    private readonly emit: WormEmit,
    id: number,
    team: number,
    pos: Vec3,
  ) {
    this.body = world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(pos[0], pos[1], pos[2]),
    );
    this.collider = world.createCollider(
      RAPIER.ColliderDesc.capsule(WORM_HALF_HEIGHT, WORM_RADIUS),
      this.body,
    );
    this.peakY = pos[1];
    this.s = {
      id,
      team,
      hp: WORM_MAX_HP,
      alive: true,
      pos: [...pos],
      prevPos: [...pos],
      yaw: 0,
      prevYaw: 0,
      grounded: false,
      vel: [0, 0, 0],
      state: 'fall',
    };
  }

  // ---- command handlers ----------------------------------------------------

  setMove(dir: Vec2): void {
    let [x, z] = dir;
    if (!Number.isFinite(x) || !Number.isFinite(z)) x = z = 0;
    const len = Math.hypot(x, z);
    if (len < 1e-3) {
      x = z = 0;
    } else if (len > 1) {
      x /= len;
      z /= len;
    }
    this.moveDir = [x, z];
  }

  face(yaw: number): void {
    if (!this.s.alive || !Number.isFinite(yaw)) return;
    this.s.yaw = wrapAngle(yaw);
  }

  /** Jump press. See the `jump` Command for double-tap semantics. */
  pressJump(kind?: JumpKind): void {
    if (!this.s.alive || this.knocked) return;
    if (kind) {
      this.jumpPendingTicks = 0;
      this.tryJump(kind);
    } else if (this.jumpPendingTicks > 0) {
      this.jumpPendingTicks = 0;
      this.tryJump('backflip');
    } else if (this.canJump()) {
      this.jumpPendingTicks = BACKFLIP_WINDOW_TICKS;
    }
  }

  /**
   * Knockback hook (M3 explosions, baseball bat, …). Adds `dv` (m/s, i.e. impulse for unit mass) to the
   * velocity and makes the worm ballistic until it is grounded and slower than KNOCK_RECOVER_SPEED.
   */
  applyImpulse(dv: Vec3): void {
    if (!this.s.alive) return;
    const v = this.s.vel;
    v[0] += dv[0];
    v[1] += dv[1];
    v[2] += dv[2];
    this.knocked = true;
    this.jumpPendingTicks = 0;
    if (v[1] > 0) this.s.grounded = false;
    this.s.state = 'knocked';
  }

  // ---- simulation ------------------------------------------------------------

  /** Integrate one tick and queue the kinematic move. Call before `world.step()`. */
  preStep(ctl: WormControllers): void {
    const s = this.s;
    if (!s.alive) return;
    const dt = TICK_DT;
    const v = s.vel;

    if (this.jumpPendingTicks > 0 && --this.jumpPendingTicks === 0) this.tryJump('forward');

    const [mx, mz] = this.moveDir;
    const moving = mx !== 0 || mz !== 0;
    if (this.knocked) {
      if (s.grounded) {
        const sp = Math.hypot(v[0], v[2]);
        const k = sp > EPS ? Math.max(0, sp - KNOCK_GROUND_FRICTION * dt) / sp : 0;
        v[0] *= k;
        v[2] *= k;
      }
    } else if (s.grounded) {
      if (this.jumpPendingTicks > 0) {
        v[0] = v[2] = 0; // crouch during wind-up
      } else {
        v[0] = mx * WALK_SPEED;
        v[2] = mz * WALK_SPEED;
        if (moving) s.yaw = Math.atan2(mx, mz);
      }
    } else if (moving) {
      // Reduced air control: steer toward the walk velocity with limited acceleration.
      let dx = mx * WALK_SPEED - v[0];
      let dz = mz * WALK_SPEED - v[2];
      const d = Math.hypot(dx, dz);
      const maxD = AIR_ACCEL * dt;
      if (d > maxD) {
        dx *= maxD / d;
        dz *= maxD / d;
      }
      v[0] += dx;
      v[2] += dz;
    }

    v[1] = Math.max(v[1] + WORM_GRAVITY * dt, -TERMINAL_FALL_SPEED);

    const onGround = s.grounded && v[1] <= 0;
    const c = onGround ? ctl.ground : ctl.air;
    const desired = { x: v[0] * dt, y: v[1] * dt, z: v[2] * dt };
    c.computeColliderMovement(this.collider, desired);
    const m = c.computedMovement();
    const grounded = c.computedGrounded() && v[1] <= 0;
    if (onGround && desired.x === 0 && desired.z === 0) {
      // Standing still: drop the controller's sub-mm skin corrections so idle worms don't creep.
      if (Math.abs(m.x) < IDLE_DEADZONE) m.x = 0;
      if (Math.abs(m.z) < IDLE_DEADZONE) m.z = 0;
      // (No y dead-zone: the controller needs its skin push-out, or the next walk tick sticks.)
    }

    if (!onGround && c.numComputedCollisions() > 0) {
      // Blocked while airborne: keep only the velocity that was actually realised (wall slide, ceiling).
      if (Math.abs(m.x) < Math.abs(desired.x) - EPS) v[0] = m.x / dt;
      if (Math.abs(m.y) < Math.abs(desired.y) - EPS) v[1] = m.y / dt;
      if (Math.abs(m.z) < Math.abs(desired.z) - EPS) v[2] = m.z / dt;
    } else if (this.knocked && c.numComputedCollisions() > 0) {
      if (Math.abs(m.x) < Math.abs(desired.x) - EPS) v[0] = m.x / dt;
      if (Math.abs(m.z) < Math.abs(desired.z) - EPS) v[2] = m.z / dt;
    }

    const t = this.body.translation();
    const ny = t.y + m.y;
    // Kinematic position-based: after world.step() the body is exactly here.
    this.body.setNextKinematicTranslation({ x: t.x + m.x, y: ny, z: t.z + m.z });
    s.pos[0] = t.x + m.x;
    s.pos[1] = ny;
    s.pos[2] = t.z + m.z;

    const wasGrounded = s.grounded;
    s.grounded = grounded;
    if (grounded) {
      v[1] = 0;
      this.ticksSinceGrounded = 0;
      this.jumpedSinceGrounded = false;
      if (!wasGrounded) this.land(this.peakY - ny);
      this.peakY = ny;
    } else {
      this.ticksSinceGrounded++;
      if (ny > this.peakY) this.peakY = ny;
    }

    if (!s.alive) return; // fatal landing
    if (this.knocked) {
      if (grounded && Math.hypot(v[0], v[2]) < KNOCK_RECOVER_SPEED) {
        this.knocked = false;
        v[0] = v[2] = 0;
      } else {
        s.state = 'knocked';
        return;
      }
    }
    if (this.jumpPendingTicks > 0) s.state = 'windup';
    else if (grounded) s.state = moving ? 'walk' : 'idle';
    else if (s.state !== 'jump' && s.state !== 'backflip') s.state = 'fall';
  }

  /** Call after `world.step()`: water death (worm centre below the water level). */
  postStep(waterLevel: number): void {
    if (this.s.alive && this.s.pos[1] < waterLevel) this.die('water');
  }

  private canJump(): boolean {
    return (
      this.s.alive &&
      !this.knocked &&
      !this.jumpedSinceGrounded &&
      (this.s.grounded || this.ticksSinceGrounded <= COYOTE_TICKS)
    );
  }

  private tryJump(kind: JumpKind): void {
    if (!this.canJump()) return;
    const s = this.s;
    const fx = Math.sin(s.yaw);
    const fz = Math.cos(s.yaw);
    if (kind === 'forward') {
      s.vel[0] = fx * JUMP_FORWARD_SPEED;
      s.vel[1] = JUMP_UP_SPEED;
      s.vel[2] = fz * JUMP_FORWARD_SPEED;
    } else {
      s.vel[0] = -fx * BACKFLIP_BACK_SPEED;
      s.vel[1] = BACKFLIP_UP_SPEED;
      s.vel[2] = -fz * BACKFLIP_BACK_SPEED;
    }
    s.grounded = false;
    s.state = kind === 'forward' ? 'jump' : 'backflip';
    this.jumpedSinceGrounded = true;
    this.emit('wormJumped', { id: s.id, kind });
  }

  private land(drop: number): void {
    const s = this.s;
    const damage = this.hasLanded ? fallDamage(drop) : 0;
    this.hasLanded = true;
    this.emit('wormLanded', { id: s.id, drop, damage });
    if (damage > 0) this.damage(damage, 'fall');
  }

  /** Reduce HP. Reaching 0 kills the worm immediately (M3 may defer this to turn resolve). */
  damage(amount: number, cause: DeathCause): void {
    const s = this.s;
    if (!s.alive || amount <= 0) return;
    s.hp = Math.max(0, s.hp - amount);
    this.emit('wormDamaged', { id: s.id, amount, hp: s.hp, cause });
    if (s.hp === 0) this.die(cause);
  }

  private die(cause: DeathCause): void {
    const s = this.s;
    if (!s.alive) return;
    s.alive = false;
    s.hp = 0;
    s.state = 'dead';
    s.grounded = false;
    s.vel[0] = s.vel[1] = s.vel[2] = 0;
    this.moveDir = [0, 0];
    this.jumpPendingTicks = 0;
    this.knocked = false;
    this.body.setEnabled(false);
    this.emit('wormDied', { id: s.id, cause, pos: [...s.pos] });
  }

  dispose(): void {
    this.world.removeRigidBody(this.body);
  }
}

function wrapAngle(a: number): number {
  const TAU = Math.PI * 2;
  a = a % TAU;
  if (a > Math.PI) a -= TAU;
  else if (a < -Math.PI) a += TAU;
  return a;
}
