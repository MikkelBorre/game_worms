/**
 * Weapon framework (GDD "Våben"): every weapon is a small module implementing `Weapon`, registered below.
 *
 * Weapons never touch input or rendering. They act through the context they are handed:
 * - `fire(ctx)` runs once when a `fire` Command is applied (spawn projectiles, instant effects, …),
 * - `onTick(ctx, p)` runs every tick for each of the weapon's live projectiles, before physics,
 * - `onImpact(ctx, p, hit)` runs when a projectile is about to touch terrain or a worm (explode-on-contact).
 *   Weapons without `onImpact` just bounce (physics) and are never swept against worms.
 * Only `ctx.rng` may be used for randomness. See `.claude/skills/add-weapon/SKILL.md`.
 */
import type { Vec2, Vec3 } from '../../core/math';
import type { Rng } from '../../core/rng';
import type { ExplodeOptions, ExplosionResult } from '../explosion';
import type { Projectile, ProjectileRemoveReason, ProjectileSpec } from '../projectile';
import type { SimEvents, SimWorld } from '../world';
import type { WormState } from '../worm';
import { bazooka } from './bazooka';
import { grenade } from './grenade';

export interface WeaponContext {
  /** Whole sim: physics, worms, waterLevel, … Prefer the helpers below where one exists. */
  readonly sim: SimWorld;
  /** Seeded RNG of the sim. The only randomness a weapon may use. */
  readonly rng: Rng;
  /** Current tick. */
  readonly tick: number;
  /** Wind acceleration [x, z] (m/s²). */
  readonly wind: Readonly<Vec2>;
  /** The weapon this context belongs to. */
  readonly weapon: Weapon;
  emit<K extends keyof SimEvents>(type: K, payload: SimEvents[K]): void;
  /** Spawn a projectile of this weapon (Rapier dynamic body with CCD). */
  spawnProjectile(spec: ProjectileSpec): Projectile;
  /** Remove a projectile (idempotent). Emits `projectileRemoved`. */
  removeProjectile(p: Projectile, reason: ProjectileRemoveReason): void;
  /** `explosion.ts` explode() with this weapon's id filled in. */
  explode(pos: Vec3, radius: number, maxDamage: number, opts?: ExplodeOptions): ExplosionResult;
}

export interface FireContext extends WeaponContext {
  /** Firing worm (alive). Already turned to face `dir`. */
  readonly worm: WormState;
  /** Muzzle point: in front of the worm along `dir`, pulled back if terrain is closer. */
  readonly origin: Vec3;
  /** Unit aim direction. */
  readonly dir: Vec3;
  /** 0..1 (0 for weapons without usesPower). */
  readonly power: number;
  /** Fuse in ticks for usesTimer weapons (clamped to the weapon's `timer` range), else 0. */
  readonly timerTicks: number;
}

export interface ImpactInfo {
  /** Projectile centre at the moment of contact. */
  pos: Vec3;
  /** Surface normal of what was hit (world space). */
  normal: Vec3;
  /** Worm hit, or null for terrain/static geometry. */
  wormId: number | null;
}

export interface Weapon {
  id: string;
  name: string;
  /** Icon id for the HUD (`src/ui/icons/<icon>.svg`). */
  icon: string;
  /** Default ammo per team at match start; -1 = infinite. */
  ammo: number;
  /** Relative weight in supply crates (0 = never in crates). */
  crateWeight: number;
  usesPower: boolean;
  usesTimer: boolean;
  /** Fuse range/default in seconds (usesTimer weapons). */
  timer?: { min: number; max: number; default: number };
  affectedByWind: boolean;
  fire(ctx: FireContext): void;
  onTick?(ctx: WeaponContext, p: Projectile): void;
  onImpact?(ctx: WeaponContext, p: Projectile, hit: ImpactInfo): void;
}

/** All weapons, in HUD/menu order. */
export const WEAPONS: readonly Weapon[] = [bazooka, grenade];

const byId = new Map<string, Weapon>(WEAPONS.map((w) => [w.id, w]));

export function getWeapon(id: string): Weapon | undefined {
  return byId.get(id);
}

export function weaponIds(): string[] {
  return WEAPONS.map((w) => w.id);
}

/** Default ammo table for a new team (-1 = infinite). */
export function defaultAmmo(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const w of WEAPONS) out[w.id] = w.ammo;
  return out;
}
