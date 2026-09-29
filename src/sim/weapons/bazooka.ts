/**
 * Bazooka: power-charged rocket, drifts with the wind, explodes on contact with terrain or a worm.
 * Ammo: infinite. usesPower, no timer, affectedByWind.
 */
import type { Weapon } from './registry';

// ---------------------------------------------------------------------------
// Balance constants – tweak here.
// ---------------------------------------------------------------------------

/** Launch speed (m/s) at power 0 and power 1 (linear in between). 40 m/s at 45° ≈ 160 m range without wind. */
export const BAZOOKA_MIN_SPEED = 8;
export const BAZOOKA_MAX_SPEED = 40;
/** Blast radius (m) – also the terrain crater radius. */
export const BAZOOKA_RADIUS = 3;
/** Damage at the centre (falls off linearly to 0 at the radius). */
export const BAZOOKA_DAMAGE = 50;
/** Rocket collider radius (m). */
export const BAZOOKA_PROJECTILE_RADIUS = 0.12;

// ---------------------------------------------------------------------------

export const bazooka: Weapon = {
  id: 'bazooka',
  name: 'Bazooka',
  icon: 'bazooka',
  ammo: -1,
  crateWeight: 0,
  usesPower: true,
  usesTimer: false,
  affectedByWind: true,

  fire(ctx) {
    const speed = BAZOOKA_MIN_SPEED + (BAZOOKA_MAX_SPEED - BAZOOKA_MIN_SPEED) * ctx.power;
    const [dx, dy, dz] = ctx.dir;
    ctx.spawnProjectile({
      pos: ctx.origin,
      vel: [dx * speed, dy * speed, dz * speed],
      radius: BAZOOKA_PROJECTILE_RADIUS,
    });
  },

  onImpact(ctx, p, hit) {
    ctx.explode(hit.pos, BAZOOKA_RADIUS, BAZOOKA_DAMAGE);
    ctx.removeProjectile(p, 'exploded');
  },
};
