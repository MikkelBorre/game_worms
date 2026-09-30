/**
 * Grenade: power-charged throw, bounces off terrain (passes through worms), explodes when its fuse runs out.
 * Ammo: infinite. usesPower, usesTimer (1–5 s, default 3), NOT affected by wind (classic).
 */
import type { Weapon } from './registry';

// ---------------------------------------------------------------------------
// Balance constants – tweak here.
// ---------------------------------------------------------------------------

/** Throw speed (m/s) at power 0 and power 1 (linear in between). */
export const GRENADE_MIN_SPEED = 4;
export const GRENADE_MAX_SPEED = 22;
/** Fuse (seconds): range selectable with keys 1–5, default 3. */
export const GRENADE_FUSE_MIN_S = 1;
export const GRENADE_FUSE_MAX_S = 5;
export const GRENADE_FUSE_DEFAULT_S = 3;
/** Blast radius (m) – also the terrain crater radius. */
export const GRENADE_RADIUS = 3;
/** Damage at the centre (falls off linearly to 0 at the radius). */
export const GRENADE_DAMAGE = 50;
/** Physics of the bouncing ball. */
export const GRENADE_PROJECTILE_RADIUS = 0.15;
export const GRENADE_RESTITUTION = 0.4;
export const GRENADE_FRICTION = 0.8;
/** Rolling brake (1/s) so grenades come to rest on gentle slopes instead of rolling forever. */
export const GRENADE_ANGULAR_DAMPING = 5;

// ---------------------------------------------------------------------------

export const grenade: Weapon = {
  id: 'grenade',
  name: 'Grenade',
  icon: 'grenade',
  ammo: -1,
  crateWeight: 0,
  usesPower: true,
  usesTimer: true,
  timer: { min: GRENADE_FUSE_MIN_S, max: GRENADE_FUSE_MAX_S, default: GRENADE_FUSE_DEFAULT_S },
  affectedByWind: false,

  fire(ctx) {
    const speed = GRENADE_MIN_SPEED + (GRENADE_MAX_SPEED - GRENADE_MIN_SPEED) * ctx.power;
    const [dx, dy, dz] = ctx.dir;
    ctx.spawnProjectile({
      pos: ctx.origin,
      vel: [dx * speed, dy * speed, dz * speed],
      radius: GRENADE_PROJECTILE_RADIUS,
      restitution: GRENADE_RESTITUTION,
      friction: GRENADE_FRICTION,
      angularDamping: GRENADE_ANGULAR_DAMPING,
      fuseTicks: ctx.timerTicks,
    });
  },

  onTick(ctx, p) {
    if (p.s.fuseTicks !== 0) return;
    ctx.explode(p.s.pos, GRENADE_RADIUS, GRENADE_DAMAGE);
    ctx.removeProjectile(p, 'exploded');
  },
};
