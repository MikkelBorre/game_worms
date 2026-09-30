import type { Command } from '../core/commands';
import { EventBus } from '../core/events';
import { clamp, type Vec2, type Vec3 } from '../core/math';
import { Rng } from '../core/rng';
import { TICK_DT, TICK_RATE } from '../core/loop';
import { WATER_LEVEL, WORLD_MIN, WORLD_SIZE } from '../terrain/types';
import {
  DEATH_EXPLOSION_DAMAGE,
  DEATH_EXPLOSION_RADIUS,
  explode,
  type ExplodeOptions,
  type ExplosionResult,
} from './explosion';
import { RAPIER } from './physics';
import {
  createProjectileBody,
  MUZZLE_DISTANCE,
  MUZZLE_HEIGHT,
  MUZZLE_PROBE_RADIUS,
  OWNER_GRACE_TICKS,
  Projectile,
  PROJECTILE_BOUNDS_MARGIN,
  PROJECTILE_MAX_AGE_TICKS,
  PROJECTILE_SWEEP_GROUPS,
  TERRAIN_QUERY_GROUPS,
  type ProjectileRemoveReason,
  type ProjectileSpec,
  type ProjectileState,
} from './projectile';
import {
  defaultAmmo,
  getWeapon,
  type FireContext,
  type ImpactInfo,
  type Weapon,
  type WeaponContext,
} from './weapons/registry';
import { TurnSystem, type TurnEvents, type TurnState } from './turn';
import { sanitizeWind, windFromSeed } from './wind';
import {
  createWormControllers,
  Worm,
  WORM_GRAVITY,
  type WormControllers,
  type WormEvents,
  type WormState,
} from './worm';

export type { WormAnimState, WormState } from './worm';
export type { ProjectileState } from './projectile';
export type { TurnPhase, TurnState } from './turn';
export type { ExplosionResult, ExplosionHit } from './explosion';

export const GRAVITY = WORM_GRAVITY;

export interface SimEvents extends WormEvents, TurnEvents {
  wormSpawned: { id: number; team: number; pos: Vec3 };
  commandIgnored: { type: string; reason: string };
  /** A `fire` command was accepted (before the weapon's fire() runs). */
  weaponFired: { wormId: number; weapon: string; origin: Vec3; dir: Vec3; power: number; timerTicks: number };
  projectileSpawned: { id: number; weapon: string; ownerId: number | null; pos: Vec3; vel: Vec3 };
  /** Projectile gone: exploded, fell into the water (splash), left the world or timed out. */
  projectileRemoved: { id: number; weapon: string; pos: Vec3; reason: ProjectileRemoveReason };
  /** Blast: render FX, camera shake, damage numbers. The terrain carve follows asynchronously. */
  explosion: ExplosionResult;
  windChanged: { wind: Vec2 };
  /** A TerrainEditor promise rejected (the sim keeps running; the crater may be missing). */
  terrainEditFailed: { error: string };
}

/**
 * Terrain edits the sim may request (implemented by the concrete TerrainSystem; the sim never imports it).
 * The returned promise must resolve once the terrain colliders reflect the edit.
 */
export interface TerrainEditor {
  carveSphere(center: Vec3, radius: number): Promise<void>;
}

export interface SimOptions {
  seed: number;
  /** Optional terrain for explosion craters; without it explosions do not carve. */
  terrain?: TerrainEditor | null;
  /** Initial wind [x, z] (m/s²); default windFromSeed(seed). */
  wind?: Vec2;
}

interface ScheduledExplosion {
  tick: number;
  pos: Vec3;
  radius: number;
  maxDamage: number;
  opts: ExplodeOptions;
}

const IDENTITY_ROT = { x: 0, y: 0, z: 0, w: 1 };
const BOUNDS = {
  minX: WORLD_MIN.x - PROJECTILE_BOUNDS_MARGIN,
  maxX: WORLD_MIN.x + WORLD_SIZE.x + PROJECTILE_BOUNDS_MARGIN,
  minZ: WORLD_MIN.z - PROJECTILE_BOUNDS_MARGIN,
  maxZ: WORLD_MIN.z + WORLD_SIZE.z + PROJECTILE_BOUNDS_MARGIN,
  minY: WORLD_MIN.y - 10,
};
/** A post-step contact closer than this counts as an impact (fallback when the predictive sweep missed). */
const CONTACT_IMPACT_DIST = 0.02;

/**
 * Headless, deterministic simulation. No three.js, no wall clock, no Math.random.
 * Worms are kinematic character controllers (see worm.ts); projectiles are dynamic bodies (projectile.ts).
 *
 * Terrain edits: explosions carve through the injected TerrainEditor. The density edit starts at once, the
 * collider rebuild finishes asynchronously (workers in the browser). While any edit is pending the sim must not
 * step – `canStep()` is false and `step()` throws – so worker timing can never change the outcome. Carves are
 * applied strictly one after another, so collider creation order is deterministic too.
 */
export class SimWorld {
  readonly physics: RAPIER.World;
  readonly events = new EventBus<SimEvents>();
  readonly rng: Rng;
  readonly seed: number;
  tick = 0;
  /** Worm y (centre) below this ⇒ instant death. Sudden death will raise it later. */
  waterLevel = WATER_LEVEL;
  /** Wind acceleration [x, z] (m/s²) on affectedByWind projectiles. Change it with the `setWind` command. */
  wind: Vec2;
  /** Plain per-worm state read by render/UI. Same objects as `worm(id).s`. */
  readonly worms: WormState[] = [];
  /** Plain live-projectile state read by render/UI (spawn order). Same objects as the internal Projectile.s. */
  readonly projectiles: ProjectileState[] = [];
  /**
   * Turn state read by render/UI (M4). Plain object, mutated in place every tick. `enabled` is false until a
   * `startMatch` command; until then worms, weapons and wind behave as in free play.
   */
  readonly turn: TurnState;
  private readonly turns: TurnSystem;
  private readonly wormById = new Map<number, Worm>();
  private readonly wormByCollider = new Map<number, Worm>();
  private readonly wormList: Worm[] = [];
  private readonly projectileList: Projectile[] = [];
  private readonly controllers: WormControllers;
  private readonly muzzleProbe: RAPIER.Ball;
  private nextId = 1;
  private nextProjectileId = 1;
  private scheduled: ScheduledExplosion[] = [];
  private readonly ammo = new Map<number, Record<string, number>>();
  private terrain: TerrainEditor | null;
  private pendingEdits = 0;
  private editChain: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(opts: SimOptions) {
    this.seed = opts.seed;
    this.rng = new Rng(opts.seed).fork(1);
    this.physics = new RAPIER.World({ x: 0, y: GRAVITY, z: 0 });
    this.physics.timestep = TICK_DT;
    this.controllers = createWormControllers(this.physics);
    this.muzzleProbe = new RAPIER.Ball(MUZZLE_PROBE_RADIUS);
    this.terrain = opts.terrain ?? null;
    this.wind = opts.wind ? sanitizeWind(opts.wind) : windFromSeed(opts.seed);
    this.turns = new TurnSystem(this);
    this.turn = this.turns.s;
  }

  /** Attach the terrain after construction (the TerrainSystem needs `sim.physics` to exist first). */
  setTerrainEditor(editor: TerrainEditor | null): void {
    this.terrain = editor;
  }

  // ---- terrain edit gate -------------------------------------------------------------------------------------

  /** Terrain edits requested but not yet reflected in the colliders. */
  get pendingTerrainEdits(): number {
    return this.pendingEdits;
  }

  /** False while a terrain edit is pending: the loop must not call step() until it resolves. */
  canStep(): boolean {
    return this.pendingEdits === 0;
  }

  /** Resolves once every queued terrain edit has been applied (immediately if none). */
  async whenTerrainIdle(): Promise<void> {
    while (this.pendingEdits > 0) await this.editChain;
  }

  /**
   * Queue a terrain carve (explosions). Starts immediately if nothing else is pending, otherwise after the
   * previous edit has been applied. No-op without a TerrainEditor.
   */
  carveTerrain(center: Vec3, radius: number): void {
    const editor = this.terrain;
    if (!editor || this.disposed || !(radius > 0)) return;
    const c: Vec3 = [center[0], center[1], center[2]];
    const start = (): Promise<void> => (this.disposed ? Promise.resolve() : editor.carveSphere(c, radius));
    let run: Promise<void>;
    if (this.pendingEdits === 0) {
      try {
        run = start();
      } catch (err) {
        run = Promise.reject(err);
      }
    } else run = this.editChain.then(start);
    this.pendingEdits++;
    this.editChain = run.then(
      () => {
        this.pendingEdits--;
      },
      (err: unknown) => {
        this.pendingEdits--;
        if (!this.disposed) this.events.emit('terrainEditFailed', { error: String(err) });
      },
    );
  }

  // ---- stepping ----------------------------------------------------------------------------------------------

  step(commands: readonly Command[]): void {
    if (this.pendingEdits > 0)
      throw new Error('SimWorld.step() while terrain edits are pending – gate the loop on canStep()');
    for (const cmd of commands) this.apply(cmd);
    for (const w of this.worms) {
      w.prevPos[0] = w.pos[0];
      w.prevPos[1] = w.pos[1];
      w.prevPos[2] = w.pos[2];
      w.prevYaw = w.yaw;
    }
    for (const p of this.projectiles) {
      p.prevPos[0] = p.pos[0];
      p.prevPos[1] = p.pos[1];
      p.prevPos[2] = p.pos[2];
    }
    this.runScheduledExplosions();
    this.preStepProjectiles();
    for (const w of this.wormList) w.preStep(this.controllers);
    this.physics.step();
    this.postStepProjectiles();
    for (const w of this.wormList) w.postStep(this.waterLevel);
    this.turns.update();
    this.tick++;
  }

  /**
   * Wake resting worms (all, or those whose centre is within `radius` of `center`) so they re-check their
   * footing this tick. Call after anything that changes the world under them, e.g. terrain carves.
   */
  wakeWorms(center?: Vec3, radius = Infinity): void {
    for (const w of this.wormList) {
      if (!w.resting) continue;
      if (center) {
        const p = w.s.pos;
        const dx = p[0] - center[0];
        const dy = p[1] - center[1];
        const dz = p[2] - center[2];
        if (dx * dx + dy * dy + dz * dz > radius * radius) continue;
      }
      w.wake();
    }
  }

  /** Explosions scheduled for later ticks (worm death blasts, delayed weapons). */
  get scheduledExplosions(): number {
    return this.scheduled.length;
  }

  /** Controller-level access (knockback etc.). */
  worm(id: number): Worm | undefined {
    return this.wormById.get(id);
  }

  /** Run `explode()` at the start of the tick `delayTicks` from now (≥ 1). Processed in scheduling order. */
  scheduleExplosion(
    delayTicks: number,
    pos: Vec3,
    radius: number,
    maxDamage: number,
    opts: ExplodeOptions = {},
  ): void {
    this.scheduled.push({
      tick: this.tick + Math.max(1, Math.floor(delayTicks)),
      pos: [pos[0], pos[1], pos[2]],
      radius,
      maxDamage,
      opts,
    });
  }

  /** Ammo left for a team (-1 = infinite, 0 = none, undefined = unknown weapon). */
  getAmmo(team: number, weapon: string): number | undefined {
    return this.teamAmmo(team)[weapon];
  }

  /** Crates / scenario setup. */
  setAmmo(team: number, weapon: string, amount: number): void {
    this.teamAmmo(team)[weapon] = Math.floor(amount);
  }

  private teamAmmo(team: number): Record<string, number> {
    let a = this.ammo.get(team);
    if (!a) this.ammo.set(team, (a = defaultAmmo()));
    return a;
  }

  // ---- commands ----------------------------------------------------------------------------------------------

  private apply(cmd: Command): void {
    switch (cmd.type) {
      case 'noop':
        return;
      case 'spawnWorm':
        this.spawnWorm(cmd.team, cmd.pos);
        return;
      case 'fire':
        if (this.fire(cmd)) this.turns.onFired();
        return;
      case 'startMatch': {
        const reason = this.turns.startMatch(cmd);
        if (reason) this.events.emit('commandIgnored', { type: cmd.type, reason });
        return;
      }
      case 'endTurn': {
        const reason = this.turns.endTurn();
        if (reason) this.events.emit('commandIgnored', { type: cmd.type, reason });
        return;
      }
      case 'setWind':
        this.wind = sanitizeWind(cmd.wind);
        this.events.emit('windChanged', { wind: [this.wind[0], this.wind[1]] });
        return;
      case 'move':
      case 'jump':
      case 'face': {
        const w = this.wormById.get(cmd.wormId);
        if (!w) {
          this.events.emit('commandIgnored', { type: cmd.type, reason: `no worm ${cmd.wormId}` });
          return;
        }
        if (!w.s.alive) {
          this.events.emit('commandIgnored', { type: cmd.type, reason: 'worm is dead' });
          return;
        }
        const blocked = this.turns.gate(cmd.type, cmd.wormId);
        if (blocked) {
          this.events.emit('commandIgnored', { type: cmd.type, reason: blocked });
          return;
        }
        if (cmd.type === 'move') w.setMove(cmd.dir);
        else if (cmd.type === 'jump') w.pressJump(cmd.kind);
        else w.face(cmd.yaw);
        return;
      }
      default: {
        const never: never = cmd;
        throw new Error(`unknown command ${JSON.stringify(never)}`);
      }
    }
  }

  /** Apply a `fire` command. Returns true if it was accepted (weapon fired, ammo taken). */
  private fire(cmd: Extract<Command, { type: 'fire' }>): boolean {
    const ignore = (reason: string) => {
      this.events.emit('commandIgnored', { type: 'fire', reason });
      return false;
    };
    const worm = this.wormById.get(cmd.wormId);
    if (!worm) return ignore(`no worm ${cmd.wormId}`);
    if (!worm.s.alive) return ignore('worm is dead');
    const blocked = this.turns.gate('fire', cmd.wormId);
    if (blocked) return ignore(blocked);
    const weapon = getWeapon(cmd.weapon);
    if (!weapon) return ignore(`unknown weapon ${cmd.weapon}`);
    const [ax, ay, az] = cmd.dir;
    const len = Math.hypot(ax, ay, az);
    if (!Number.isFinite(len) || len < 1e-6) return ignore('invalid aim direction');
    const dir: Vec3 = [ax / len, ay / len, az / len];
    const ammo = this.teamAmmo(worm.s.team);
    const left = ammo[weapon.id] ?? 0;
    if (left === 0) return ignore(`out of ammo: ${weapon.id}`);

    const power = weapon.usesPower ? clamp(Number.isFinite(cmd.power) ? cmd.power : 0, 0, 1) : 0;
    let timerTicks = 0;
    if (weapon.usesTimer) {
      const t = weapon.timer ?? { min: 1, max: 5, default: 3 };
      const sec =
        cmd.timer !== undefined && Number.isFinite(cmd.timer) ? clamp(cmd.timer, t.min, t.max) : t.default;
      timerTicks = Math.round(sec * TICK_RATE);
    }
    if (Math.hypot(dir[0], dir[2]) > 1e-3) worm.face(Math.atan2(dir[0], dir[2]));
    worm.wake();
    const origin = this.muzzle(worm.s.pos, dir);
    if (left > 0) ammo[weapon.id] = left - 1;
    this.events.emit('weaponFired', {
      wormId: worm.s.id,
      weapon: weapon.id,
      origin: [...origin],
      dir: [...dir],
      power,
      timerTicks,
    });
    const ctx: FireContext = Object.assign(this.weaponContext(weapon, worm.s.id), {
      worm: worm.s,
      origin,
      dir,
      power,
      timerTicks,
    });
    weapon.fire(ctx);
    return true;
  }

  /** Muzzle point in front of a worm, pulled back if terrain is in the way. */
  private muzzle(pos: Vec3, dir: Vec3): Vec3 {
    const base = { x: pos[0], y: pos[1] + MUZZLE_HEIGHT, z: pos[2] };
    const hit = this.physics.castShape(
      base,
      IDENTITY_ROT,
      { x: dir[0], y: dir[1], z: dir[2] },
      this.muzzleProbe,
      0,
      MUZZLE_DISTANCE,
      true,
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      TERRAIN_QUERY_GROUPS,
    );
    const d = hit ? Math.max(0, hit.time_of_impact - 0.02) : MUZZLE_DISTANCE;
    return [base.x + dir[0] * d, base.y + dir[1] * d, base.z + dir[2] * d];
  }

  // ---- weapons & projectiles ---------------------------------------------------------------------------------

  private weaponContext(weapon: Weapon, ownerId: number | null): WeaponContext {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const sim = this;
    return {
      sim,
      rng: sim.rng,
      get tick() {
        return sim.tick;
      },
      get wind() {
        return sim.wind;
      },
      weapon,
      emit: (type, payload) => sim.events.emit(type, payload),
      spawnProjectile: (spec) => sim.spawnProjectile(weapon, spec, ownerId),
      removeProjectile: (p, reason) => sim.removeProjectile(p, reason),
      explode: (pos, radius, maxDamage, opts) =>
        explode({ sim }, pos, radius, maxDamage, { weapon: weapon.id, sourceWormId: ownerId, ...opts }),
    };
  }

  private spawnProjectile(weapon: Weapon, spec: ProjectileSpec, defaultOwner: number | null): Projectile {
    const ownerId = spec.ownerId === undefined ? defaultOwner : spec.ownerId;
    const { body, collider } = createProjectileBody(this.physics, spec);
    const t = body.translation();
    const v = body.linvel();
    const s: ProjectileState = {
      id: this.nextProjectileId++,
      weapon: weapon.id,
      ownerId,
      pos: [t.x, t.y, t.z],
      prevPos: [t.x, t.y, t.z],
      vel: [v.x, v.y, v.z],
      radius: spec.radius,
      fuseTicks: spec.fuseTicks ?? null,
      age: 0,
    };
    const owner = ownerId === null ? undefined : this.wormById.get(ownerId);
    const p = new Projectile(
      s,
      weapon,
      body,
      collider,
      spec.affectedByWind ?? weapon.affectedByWind,
      owner ? owner.collider : null,
    );
    this.projectileList.push(p);
    this.projectiles.push(s);
    this.events.emit('projectileSpawned', {
      id: s.id,
      weapon: weapon.id,
      ownerId,
      pos: [...s.pos],
      vel: [...s.vel],
    });
    return p;
  }

  private removeProjectile(p: Projectile, reason: ProjectileRemoveReason): void {
    if (p.removed) return;
    p.removed = true;
    this.physics.removeRigidBody(p.body);
    const i = this.projectileList.indexOf(p);
    if (i >= 0) this.projectileList.splice(i, 1);
    const j = this.projectiles.indexOf(p.s);
    if (j >= 0) this.projectiles.splice(j, 1);
    this.events.emit('projectileRemoved', { id: p.s.id, weapon: p.s.weapon, pos: [...p.s.pos], reason });
  }

  private runScheduledExplosions(): void {
    if (this.scheduled.length === 0) return;
    const due: ScheduledExplosion[] = [];
    const later: ScheduledExplosion[] = [];
    for (const e of this.scheduled) (e.tick <= this.tick ? due : later).push(e);
    this.scheduled = later;
    for (const e of due) explode({ sim: this }, e.pos, e.radius, e.maxDamage, e.opts);
  }

  /** Weapon hooks, wind force and the predictive impact sweep, before the physics step. */
  private preStepProjectiles(): void {
    if (this.projectileList.length === 0) return;
    for (const p of [...this.projectileList]) {
      if (p.removed) continue;
      const w = p.weapon;
      const ctx = w.onTick || w.onImpact ? this.weaponContext(w, p.s.ownerId) : null;
      w.onTick?.(ctx!, p);
      if (p.removed) continue;
      if (p.affectedByWind) {
        p.body.resetForces(false);
        const [wx, wz] = this.wind;
        if (wx !== 0 || wz !== 0) {
          const m = p.body.mass();
          p.body.addForce({ x: wx * m, y: 0, z: wz * m }, true);
        }
      }
      if (w.onImpact) {
        const hit = this.sweep(p);
        if (hit) w.onImpact(ctx!, p, hit);
      }
    }
  }

  /**
   * Shape-cast the projectile along the motion Rapier is about to integrate this tick (semi-implicit Euler:
   * v' = v + (g + wind)·dt, Δx = v'·dt) against terrain and worms. Ignores the owner worm for OWNER_GRACE_TICKS.
   */
  private sweep(p: Projectile): ImpactInfo | null {
    const dt = TICK_DT;
    const t = p.body.translation();
    const v = p.body.linvel();
    const windy = p.affectedByWind;
    const vx = v.x + (windy ? this.wind[0] : 0) * dt;
    const vy = v.y + GRAVITY * dt;
    const vz = v.z + (windy ? this.wind[1] : 0) * dt;
    let len = Math.hypot(vx, vy, vz) * dt;
    let dir = { x: 0, y: -1, z: 0 };
    if (len > 1e-6) dir = { x: (vx * dt) / len, y: (vy * dt) / len, z: (vz * dt) / len };
    else len = 1e-3;
    const exclude = p.ownerCollider && p.s.age < OWNER_GRACE_TICKS ? p.ownerCollider : undefined;
    const hit = this.physics.castShape(
      t,
      IDENTITY_ROT,
      dir,
      p.shape,
      0,
      len,
      true,
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      PROJECTILE_SWEEP_GROUPS,
      exclude,
      p.body,
    );
    if (!hit) return null;
    const toi = hit.time_of_impact;
    const n = hit.normal1;
    return {
      pos: [t.x + dir.x * toi, t.y + dir.y * toi, t.z + dir.z * toi],
      normal: [n.x, n.y, n.z],
      wormId: this.wormByCollider.get(hit.collider.handle)?.s.id ?? null,
    };
  }

  /** Sync plain state, count down fuses, remove projectiles in the water / out of the world, contact fallback. */
  private postStepProjectiles(): void {
    if (this.projectileList.length === 0) return;
    for (const p of [...this.projectileList]) {
      if (p.removed) continue;
      const s = p.s;
      const t = p.body.translation();
      const v = p.body.linvel();
      s.pos[0] = t.x;
      s.pos[1] = t.y;
      s.pos[2] = t.z;
      s.vel[0] = v.x;
      s.vel[1] = v.y;
      s.vel[2] = v.z;
      s.age++;
      if (s.fuseTicks !== null && s.fuseTicks > 0) s.fuseTicks--;
      if (t.y < this.waterLevel) this.removeProjectile(p, 'water');
      else if (
        t.x < BOUNDS.minX ||
        t.x > BOUNDS.maxX ||
        t.z < BOUNDS.minZ ||
        t.z > BOUNDS.maxZ ||
        t.y < BOUNDS.minY
      )
        this.removeProjectile(p, 'bounds');
      else if (s.age >= PROJECTILE_MAX_AGE_TICKS) this.removeProjectile(p, 'timeout');
      else if (p.weapon.onImpact) {
        // Fallback: the predictive sweep missed (rounding, moving worm, …) but physics made contact.
        const normal = this.contactNormal(p);
        if (normal)
          p.weapon.onImpact(this.weaponContext(p.weapon, s.ownerId), p, {
            pos: [...s.pos],
            normal,
            wormId: null,
          });
      }
    }
  }

  /** World normal of a touching contact (pointing away from the surface), or null. */
  private contactNormal(p: Projectile): Vec3 | null {
    let out: Vec3 | null = null;
    this.physics.contactPairsWith(p.collider, (other) => {
      if (out) return;
      this.physics.contactPair(p.collider, other, (m, flipped) => {
        if (out || m.numContacts() === 0) return;
        let close = false;
        for (let i = 0; i < m.numContacts(); i++) if (m.contactDist(i) < CONTACT_IMPACT_DIST) close = true;
        if (!close) return;
        const n = m.normal();
        // The manifold normal points from collider1 to collider2.
        const k = flipped ? 1 : -1;
        out = [n.x * k, n.y * k, n.z * k];
      });
    });
    return out;
  }

  // ---- worms -------------------------------------------------------------------------------------------------

  private spawnWorm(team: number, pos: Vec3): Worm {
    const id = this.nextId++;
    const worm = new Worm(
      this.physics,
      (type, payload) => {
        this.events.emit(type, payload as SimEvents[typeof type]);
        if (type === 'wormDied') this.onWormDied(payload as WormEvents['wormDied']);
      },
      id,
      team,
      pos,
    );
    this.wormById.set(id, worm);
    this.wormByCollider.set(worm.collider.handle, worm);
    this.wormList.push(worm);
    this.worms.push(worm.s);
    this.events.emit('wormSpawned', { id, team, pos: [...pos] });
    return worm;
  }

  /** GDD: a worm reaching 0 HP explodes small (next tick) and becomes a gravestone. Drowned worms just sink. */
  private onWormDied(e: WormEvents['wormDied']): void {
    if (e.cause === 'water') return;
    this.scheduleExplosion(1, e.pos, DEATH_EXPLOSION_RADIUS, DEATH_EXPLOSION_DAMAGE, {
      kind: 'wormDeath',
      weapon: null,
      sourceWormId: e.id,
    });
  }

  // ---- snapshots ---------------------------------------------------------------------------------------------

  /** Plain serializable snapshot (for debug API, hashing and tests). */
  snapshot() {
    return {
      tick: this.tick,
      seed: this.seed,
      waterLevel: this.waterLevel,
      wind: [this.wind[0], this.wind[1]] as Vec2,
      pendingTerrainEdits: this.pendingEdits,
      turn: this.turns.snapshot(),
      worms: this.worms.map((w) => ({
        id: w.id,
        team: w.team,
        hp: w.hp,
        alive: w.alive,
        pos: [...w.pos] as Vec3,
        yaw: w.yaw,
        grounded: w.grounded,
        vel: [...w.vel] as Vec3,
        state: w.state,
      })),
      projectiles: this.projectiles.map((p) => ({
        id: p.id,
        weapon: p.weapon,
        ownerId: p.ownerId,
        pos: [...p.pos] as Vec3,
        vel: [...p.vel] as Vec3,
        fuseTicks: p.fuseTicks,
        age: p.age,
      })),
    };
  }

  /**
   * Deterministic 32-bit state hash (FNV-1a over tick, rng state, wind, per-worm quantized data: positions in mm,
   * yaw in mrad, hp, alive; per-projectile id, position in mm and fuse; turn state). For desync detection.
   */
  hash(): number {
    let h = 0x811c9dc5;
    const mix = (v: number) => {
      v |= 0;
      for (let i = 0; i < 4; i++) {
        h ^= (v >>> (i * 8)) & 0xff;
        h = Math.imul(h, 0x01000193);
      }
    };
    mix(this.tick);
    mix(this.rng.getState());
    mix(Math.round(this.waterLevel * 1000));
    mix(Math.round(this.wind[0] * 1000));
    mix(Math.round(this.wind[1] * 1000));
    for (const w of this.worms) {
      mix(w.id);
      mix(w.team);
      mix(w.alive ? 1 : 0);
      mix(Math.round(w.hp));
      mix(Math.round(w.pos[0] * 1000));
      mix(Math.round(w.pos[1] * 1000));
      mix(Math.round(w.pos[2] * 1000));
      mix(Math.round(w.yaw * 1000));
    }
    for (const p of this.projectiles) {
      mix(p.id);
      mix(Math.round(p.pos[0] * 1000));
      mix(Math.round(p.pos[1] * 1000));
      mix(Math.round(p.pos[2] * 1000));
      mix(p.fuseTicks ?? -1);
    }
    mix(this.scheduled.length);
    this.turns.hashInto(mix);
    return h >>> 0;
  }

  dispose(): void {
    this.disposed = true;
    this.events.clear();
    this.physics.free();
  }
}
