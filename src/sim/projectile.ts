/**
 * Projectiles: Rapier dynamic bodies (ball collider, CCD) owned by a weapon.
 *
 * Physical collisions: terrain/static geometry only. Worms are hit through a swept shape cast along the
 * predicted motion of the tick (see SimWorld), which lets the firing worm be ignored for a few ticks and gives
 * exact impact points for explode-on-contact weapons. Worm movement ignores projectiles (PROJECTILE_GROUP).
 */
import type { Vec3 } from '../core/math';
import { RAPIER } from './physics';
import type { Weapon } from './weapons/registry';
import { PROJECTILE_GROUP, WORM_GROUP } from './worm';

// ---------------------------------------------------------------------------
// Tuning – shared by all projectiles.
// ---------------------------------------------------------------------------

/** Ticks during which a projectile cannot hit the worm that fired it (0.2 s). */
export const OWNER_GRACE_TICKS = 12;
/** Projectiles are removed after this many ticks no matter what (30 s). */
export const PROJECTILE_MAX_AGE_TICKS = 1800;
/** Projectiles farther than this outside the voxel volume (XZ) are removed ("left the world"). */
export const PROJECTILE_BOUNDS_MARGIN = 60;
/** Muzzle: this far above the worm's capsule centre … */
export const MUZZLE_HEIGHT = 0.1;
/** … and this far along the aim direction (pulled back if terrain is closer). Capsule radius is 0.3. */
export const MUZZLE_DISTANCE = 0.7;
/** Ball used to probe for terrain between the worm and the muzzle (≥ the largest projectile radius). */
export const MUZZLE_PROBE_RADIUS = 0.15;

// ---------------------------------------------------------------------------

/** Physical collider groups: member of PROJECTILE_GROUP, collides with everything except worms and projectiles. */
export const PROJECTILE_COLLIDER_GROUPS =
  ((PROJECTILE_GROUP << 16) | (0xffff & ~(WORM_GROUP | PROJECTILE_GROUP))) >>> 0;
/** Impact sweep: terrain/static geometry and worms, never projectiles (incl. itself). */
export const PROJECTILE_SWEEP_GROUPS = ((PROJECTILE_GROUP << 16) | (0xffff & ~PROJECTILE_GROUP)) >>> 0;
/** Terrain-only queries (muzzle placement). */
export const TERRAIN_QUERY_GROUPS =
  ((PROJECTILE_GROUP << 16) | (0xffff & ~(WORM_GROUP | PROJECTILE_GROUP))) >>> 0;

/** Plain projectile state read by render/UI (same object as `Projectile.s`). */
export interface ProjectileState {
  id: number;
  /** Weapon id (registry). */
  weapon: string;
  /** Worm that fired it, or null. */
  ownerId: number | null;
  /** Ball centre (world). */
  pos: Vec3;
  /** Position at the previous tick, for render interpolation. */
  prevPos: Vec3;
  /** Linear velocity (m/s). */
  vel: Vec3;
  /** Collider radius (m). */
  radius: number;
  /** Ticks left on the fuse, or null for no fuse. 0 = expires this tick. */
  fuseTicks: number | null;
  /** Ticks since spawn. */
  age: number;
}

export interface ProjectileSpec {
  pos: Vec3;
  vel: Vec3;
  /** Ball radius (m). */
  radius: number;
  /** kg/m³-ish; only matters for wind force = mass × wind (acceleration stays = wind). Default 1. */
  density?: number;
  /** Bounciness 0..1. Default 0. */
  restitution?: number;
  /** Default 0.5. */
  friction?: number;
  linearDamping?: number;
  angularDamping?: number;
  /** Fuse in ticks, or null/undefined for none. */
  fuseTicks?: number | null;
  /** Default: the weapon's affectedByWind. */
  affectedByWind?: boolean;
  /** Worm that fired it (ignored by the impact sweep for OWNER_GRACE_TICKS). Default: the firing worm. */
  ownerId?: number | null;
}

export type ProjectileRemoveReason = 'exploded' | 'water' | 'bounds' | 'timeout' | 'removed';

/** Sim-internal projectile: plain state + Rapier handles. */
export class Projectile {
  removed = false;
  /** Free per-weapon scratch values (bounce counters, …). Must stay deterministic. */
  readonly data: Record<string, number> = {};
  readonly shape: RAPIER.Ball;

  constructor(
    readonly s: ProjectileState,
    readonly weapon: Weapon,
    readonly body: RAPIER.RigidBody,
    readonly collider: RAPIER.Collider,
    readonly affectedByWind: boolean,
    /** Collider of the owner worm (excluded from the sweep during OWNER_GRACE_TICKS). */
    readonly ownerCollider: RAPIER.Collider | null,
  ) {
    this.shape = new RAPIER.Ball(s.radius);
  }
}

export function createProjectileBody(
  world: RAPIER.World,
  spec: ProjectileSpec,
): { body: RAPIER.RigidBody; collider: RAPIER.Collider } {
  const [x, y, z] = spec.pos;
  const [vx, vy, vz] = spec.vel;
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(x, y, z)
      .setLinvel(vx, vy, vz)
      .setCcdEnabled(true)
      .setLinearDamping(spec.linearDamping ?? 0)
      .setAngularDamping(spec.angularDamping ?? 0),
  );
  const collider = world.createCollider(
    RAPIER.ColliderDesc.ball(spec.radius)
      .setDensity(spec.density ?? 1)
      .setRestitution(spec.restitution ?? 0)
      .setFriction(spec.friction ?? 0.5)
      .setCollisionGroups(PROJECTILE_COLLIDER_GROUPS),
    body,
  );
  return { body, collider };
}
