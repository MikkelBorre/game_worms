/**
 * Explosions (GDD "Skade"): linear damage falloff, knockback ∝ damage (away from the centre + up), terrain carve,
 * worm wake-up. Every weapon reuses `explode()`; never reimplement damage in a weapon module.
 */
import type { Vec3 } from '../core/math';
import type { SimWorld } from './world';
import { WORM_RADIUS } from './worm';

// ---------------------------------------------------------------------------
// Balance constants – tweak here.
// ---------------------------------------------------------------------------

/**
 * Damage uses the distance from the explosion to the worm's capsule centre minus this slack (clamped at 0), so a
 * direct hit on the body deals (almost) full damage instead of ~80 %.
 */
export const DAMAGE_DISTANCE_SLACK = WORM_RADIUS;
/** Knockback speed (m/s) per point of damage: 50 dmg ⇒ 10 m/s. */
export const KNOCKBACK_PER_DAMAGE = 0.2;
/**
 * Upward bias of the knockback direction: dir = normalize(away_xz + (max(away_y, 0) + bias)·up). 0.6 ⇒ a worm
 * level with the blast flies off at ~31° up; worms are never pushed down into the ground.
 */
export const KNOCKBACK_UP_BIAS = 0.6;
/** Resting worms this far beyond the blast radius are woken too (crater rim). */
export const WAKE_MARGIN = 1.5;
/** A worm that reaches 0 HP (except by drowning) explodes one tick later (GDD: radius 2 m). */
export const DEATH_EXPLOSION_RADIUS = 2;
export const DEATH_EXPLOSION_DAMAGE = 20;

// ---------------------------------------------------------------------------

export type ExplosionKind = 'weapon' | 'wormDeath';

export interface ExplodeOptions {
  /** Default 'weapon'. */
  kind?: ExplosionKind;
  /** Weapon id that caused it (null for worm deaths / scripted). */
  weapon?: string | null;
  /** Worm that fired the weapon, or the worm that died (wormDeath). */
  sourceWormId?: number | null;
  /** Carve a terrain sphere of `radius` (default true). */
  carve?: boolean;
}

export interface ExplosionHit {
  id: number;
  /** HP removed (integer ≥ 1). */
  damage: number;
  /** Velocity change applied (m/s); [0,0,0] if the worm died. */
  knockback: Vec3;
  killed: boolean;
}

export interface ExplosionResult {
  tick: number;
  pos: Vec3;
  radius: number;
  maxDamage: number;
  kind: ExplosionKind;
  weapon: string | null;
  sourceWormId: number | null;
  /** Damaged worms in id order. */
  hits: ExplosionHit[];
}

/** Anything that carries the sim (every WeaponContext does). */
export interface ExplosionContext {
  readonly sim: SimWorld;
}

/** Linear falloff: maxDamage at distance ≤ slack, 0 at radius + slack. Rounded to whole HP. */
export function explosionDamage(centerDistance: number, radius: number, maxDamage: number): number {
  if (!(radius > 0) || !(maxDamage > 0)) return 0;
  const d = Math.max(0, centerDistance - DAMAGE_DISTANCE_SLACK);
  if (d >= radius) return 0;
  return Math.round(maxDamage * (1 - d / radius));
}

/** Knockback velocity change for a worm at offset `away` (= worm − centre) taking `damage`. */
export function knockback(away: Vec3, damage: number): Vec3 {
  let [x, y, z] = away;
  const len = Math.hypot(x, y, z);
  if (len > 1e-6) {
    x /= len;
    y /= len;
    z /= len;
  } else {
    x = z = 0;
    y = 1;
  }
  y = Math.max(y, 0) + KNOCKBACK_UP_BIAS;
  const n = Math.hypot(x, y, z);
  const speed = damage * KNOCKBACK_PER_DAMAGE;
  return [(x / n) * speed, (y / n) * speed, (z / n) * speed];
}

/**
 * Explode at `pos`: damage + knockback every living worm in range, carve a terrain sphere of `radius`, wake
 * resting worms nearby and emit `explosion`. Worms killed here explode again (small) on the next tick.
 * Deterministic: worms are processed in id order; the carve is queued on the sim (see SimWorld.canStep()).
 */
export function explode(
  ctx: ExplosionContext,
  pos: Vec3,
  radius: number,
  maxDamage: number,
  opts: ExplodeOptions = {},
): ExplosionResult {
  const sim = ctx.sim;
  const center: Vec3 = [pos[0], pos[1], pos[2]];
  const hits: ExplosionHit[] = [];
  for (const s of sim.worms) {
    if (!s.alive) continue;
    const away: Vec3 = [s.pos[0] - center[0], s.pos[1] - center[1], s.pos[2] - center[2]];
    const damage = explosionDamage(Math.hypot(away[0], away[1], away[2]), radius, maxDamage);
    if (damage <= 0) continue;
    const worm = sim.worm(s.id)!;
    worm.damage(damage, 'explosion');
    let kb: Vec3 = [0, 0, 0];
    if (s.alive) {
      kb = knockback(away, damage);
      worm.applyImpulse(kb);
    }
    hits.push({ id: s.id, damage, knockback: kb, killed: !s.alive });
  }
  if (opts.carve !== false) sim.carveTerrain(center, radius);
  sim.wakeWorms(center, radius + WAKE_MARGIN);
  const result: ExplosionResult = {
    tick: sim.tick,
    pos: center,
    radius,
    maxDamage,
    kind: opts.kind ?? 'weapon',
    weapon: opts.weapon ?? null,
    sourceWormId: opts.sourceWormId ?? null,
    hits,
  };
  sim.events.emit('explosion', result);
  return result;
}
