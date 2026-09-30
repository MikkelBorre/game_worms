import { CommandQueue, type Command } from './core/commands';
import { GameLoop } from './core/loop';
import { lerpVec3, type Vec3 } from './core/math';
import { Controls } from './input/controls';
import { FireInput } from './input/fire';
import { initPhysics, RAPIER } from './sim/physics';
import { spawnTeams } from './sim/spawn';
import { SimWorld, type ExplosionResult } from './sim/world';
import { TERRAIN_QUERY_GROUPS } from './sim/projectile';
import { createTerrain, type TerrainSystem } from './terrain';
import { AimView } from './render/aimView';
import { createCameraRig, type CameraRig } from './render/camera';
import { Fx } from './render/fx';
import { createTerrainMaterial } from './render/materials';
import { ProjectileView } from './render/projectileView';
import { createRenderContext, type RenderContext } from './render/scene';
import { ScreenShake } from './render/shake';
import { createSky, type Sky } from './render/sky';
import { createTerrainView, type TerrainView } from './render/terrainView';
import { createWater, type Water } from './render/water';
import { WormView, type WormViewEvent } from './render/wormView';

/** Projectile camera / hit-stop tweakables. */
export const GAME_FX = {
  /** Seconds the camera holds on a blast (or splash) before returning to the active worm. */
  holdAfterImpact: 1.0,
  /** Hold after a projectile left the world / timed out. */
  holdAfterOther: 0.4,
  /** Focus blend (s) from the worm to its projectile, and back to the worm after the hold. */
  blendToProjectile: 0.25,
  blendToWorm: 0.9,
  /** Hit-stop: frames frozen when an explosion deals at least `hitStopDamage` to some worm (or kills). */
  hitStopFrames: 3,
  hitStopDamage: 25,
  /** Recent explosions kept for state()/tests. */
  explosionLog: 16,
};

type CamTrack = 'worm' | 'projectile' | 'hold';

export interface GameOptions {
  seed: number;
  debug: boolean;
  /** Teams / worms per team spawned on load (0 teams = empty island, used by tests). */
  teams: number;
  wormsPerTeam: number;
}

/** Wires sim, terrain, render and loop together. Owns nothing game-rule related. */
export class Game {
  ready = false;
  seed: number;
  sim!: SimWorld;
  terrain!: TerrainSystem;
  readonly queue = new CommandQueue();
  readonly loop: GameLoop;
  readonly ctx: RenderContext;
  readonly sky: Sky;
  readonly water: Water;
  readonly terrainView: TerrainView;
  readonly wormView = new WormView();
  readonly cameraRig: CameraRig;
  readonly controls: Controls;
  readonly fireInput: FireInput;
  readonly fx: Fx;
  readonly projectileView: ProjectileView;
  readonly aimView: AimView;
  readonly shake = new ScreenShake();
  /**
   * Hit-stop freezes sim ticks + animation for a few frames on big hits. Off in debug mode by default so
   * advance()-driven tests keep exact tick counts (the sim never waits on wall time there).
   */
  hitStopEnabled: boolean;
  /** Recent explosions (newest last), for state() / tests. */
  readonly explosions: { tick: number; pos: Vec3; radius: number; kind: string; hits: number }[] = [];
  /** Worm controlled by the local player (turn system replaces this in M4). */
  activeWormId: number | null = null;
  private renderTime = 0;
  private lastAlpha = 1;
  private readonly target: { pos: Vec3; yaw: number } = { pos: [0, 0, 0], yaw: 0 };
  // Camera focus (projectile camera): one stable getter on the rig, blended here so switching between worm,
  // projectile and blast point never resets the rig's pivot damping.
  private camTrack: CamTrack = 'worm';
  private camProjectileId = -1;
  private readonly camHoldPos: Vec3 = [0, 0, 0];
  private camHoldLeft = 0;
  private camBlend = 1;
  private camBlendDur = 0;
  private readonly camFrom: Vec3 = [0, 0, 0];
  private readonly focus: { pos: Vec3; yaw: number } = { pos: [0, 0, 0], yaw: 0 };
  private focusValid = false;
  private hitStop = 0;
  private readonly aimDir: Vec3 = [0, 0, 0];
  private unsubMesh: (() => void) | null = null;
  private unsubSim: (() => void)[] = [];

  private readonly opts: GameOptions;

  private constructor(canvas: HTMLCanvasElement, opts: GameOptions) {
    this.opts = opts;
    this.seed = opts.seed;
    this.ctx = createRenderContext(canvas);
    this.sky = createSky(this.ctx.scene);
    this.water = createWater();
    this.ctx.scene.add(this.water.object);
    this.terrainView = createTerrainView(createTerrainMaterial());
    this.ctx.scene.add(this.terrainView.group);
    this.ctx.scene.add(this.wormView.group);
    const groundAt = (x: number, z: number) => (this.terrain ? this.terrain.heightAt(x, z) : 0);
    this.fx = new Fx(groundAt);
    this.ctx.scene.add(this.fx.group);
    this.projectileView = new ProjectileView(this.fx, () => (this.sim ? this.sim.waterLevel : 0));
    this.ctx.scene.add(this.projectileView.group);
    this.aimView = new AimView(groundAt);
    this.ctx.scene.add(this.aimView.mesh);
    this.hitStopEnabled = !opts.debug;
    this.cameraRig = createCameraRig(this.ctx.camera, canvas, {
      raycast: (o, d, max) => this.raycast(o, d, max),
    });
    this.controls = new Controls({
      activeWormId: () => this.activeWormId,
      heading: () => this.cameraHeading(),
      wormInputEnabled: () => this.cameraRig.mode === 'follow' || this.cameraRig.mode === 'aim',
      send: (cmd) => this.command(cmd),
      nextWorm: () => this.selectNextWorm(),
    });
    this.fireInput = new FireInput(
      {
        activeWormId: () => this.activeWormId,
        aiming: () => this.cameraRig.mode === 'aim',
        wormInputEnabled: () => this.cameraRig.mode === 'follow' || this.cameraRig.mode === 'aim',
        canFire: () => this.canFire(),
        aimDirection: (out) => this.cameraRig.aimDirection(out),
        send: (cmd) => this.command(cmd),
      },
      canvas,
      document.getElementById('ui'),
    );
    this.loop = new GameLoop({
      // No ticks while a world is (re)loading: every world starts at tick 0 regardless of load time.
      // Nor while an explosion crater is still being rebuilt (workers): the sim waits, so worker timing can
      // never change the outcome (determinism).
      step: () => {
        if (this.hitStop > 0) return; // hit-stop: time stands still for a few frames
        if (this.ready && this.sim.canStep()) this.sim.step(this.queue.drain(this.sim.tick));
      },
      render: (alpha, dt) => this.renderFrame(alpha, dt),
    });
  }

  static async create(canvas: HTMLCanvasElement, opts: GameOptions): Promise<Game> {
    await initPhysics();
    const game = new Game(canvas, opts);
    await game.load(opts.seed);
    game.loop.start();
    return game;
  }

  /** (Re)build the world from a seed. */
  async load(seed: number): Promise<void> {
    this.ready = false;
    this.seed = seed;
    this.unsubMesh?.();
    for (const u of this.unsubSim) u();
    this.unsubSim = [];
    this.setActiveWorm(null);
    this.terrain?.dispose();
    this.sim?.dispose();
    this.terrainView.clear();
    this.wormView.clear();
    this.projectileView?.clear();
    this.fx?.clear();
    this.shake.reset();
    this.explosions.length = 0;
    this.hitStop = 0;
    this.camTrack = 'worm';
    this.camBlend = 1;
    this.queue.clear();

    this.sim = new SimWorld({ seed });
    this.wireSimEvents();
    this.terrain = createTerrain({ seed, sim: this.sim });
    this.unsubMesh = this.terrain.onChunkMesh((m) => this.terrainView.apply(m));
    const terrain = this.terrain;
    this.sim.setTerrainEditor({ carveSphere: (c, r) => terrain.carveSphere(c, r) });
    await this.terrain.generate();
    this.water.setHeightmap(this.terrain.heightmap(256));
    if (this.opts.teams > 0) this.spawnTeams(this.opts.teams, this.opts.wormsPerTeam);
    this.ready = true;
  }

  command(cmd: Command): void {
    this.queue.push(cmd, this.sim.tick);
  }

  /** Selected weapon id (read by the HUD weapon card; Q cycles it for now). */
  get selectedWeapon(): string {
    return this.fireInput.weapon;
  }
  set selectedWeapon(id: string) {
    this.fireInput.selectWeapon(id);
  }
  /** Grenade fuse in seconds (keys 1–5). */
  get grenadeTimer(): number {
    return this.fireInput.timer;
  }
  set grenadeTimer(s: number) {
    this.fireInput.timer = Math.max(1, Math.min(5, Math.round(s)));
  }
  /** Fire charge 0..1 while the fire button is held, else null (HUD power bar). */
  get firePower(): number | null {
    return this.fireInput.charging ? this.fireInput.power : null;
  }

  /** The local player may fire: an alive active worm with no projectile of its own still in flight. */
  canFire(): boolean {
    const id = this.activeWormId;
    if (id === null || !this.ready) return false;
    const w = this.sim.worms.find((x) => x.id === id);
    if (!w || !w.alive) return false;
    for (const p of this.sim.projectiles) if (p.ownerId === id) return false;
    return true;
  }

  spawnWorm(team: number, pos: Vec3): void {
    this.command({ type: 'spawnWorm', team, pos });
  }

  /** Spread teams over dry land (seeded) and queue one spawn command per worm. */
  spawnTeams(teams: number, wormsPerTeam: number): void {
    const spawns = spawnTeams({
      seed: this.seed,
      teams,
      wormsPerTeam,
      heightAt: (x, z) => this.terrain.heightAt(x, z),
      waterLevel: this.sim.waterLevel,
    });
    for (const s of spawns) this.spawnWorm(s.team, s.pos);
  }

  /** Make a worm the locally controlled one; the follow camera tracks it. */
  setActiveWorm(id: number | null): void {
    this.activeWormId = id;
    this.wormView.setActive(id);
    this.cameraRig.setTarget(id === null ? null : () => this.cameraFocus());
    // Hard cut behind the new worm – unless the projectile camera is busy (it returns to the worm by itself).
    const targetMode = this.cameraRig.mode === 'follow' || this.cameraRig.mode === 'aim';
    if (id !== null && this.camTrack === 'worm' && targetMode) {
      this.camBlend = 1;
      this.cameraRig.snapToTarget();
    }
  }

  selectNextWorm(): void {
    const alive = this.sim.worms.filter((w) => w.alive);
    if (alive.length === 0) return this.setActiveWorm(null);
    const i = alive.findIndex((w) => w.id === this.activeWormId);
    this.setActiveWorm(alive[(i + 1) % alive.length]!.id);
  }

  /** Camera focus getter handed to the rig: the tracked thing, blended after a track switch. */
  private cameraFocus(): { pos: Vec3; yaw: number } | null {
    const raw = this.trackTarget();
    if (!raw) return null;
    const out = this.focus;
    if (this.camBlend < 1 && this.focusValid) {
      const t = this.camBlend;
      const e = t * t * (3 - 2 * t);
      lerpVec3(this.camFrom, raw.pos, e, out.pos);
    } else {
      out.pos[0] = raw.pos[0];
      out.pos[1] = raw.pos[1];
      out.pos[2] = raw.pos[2];
    }
    out.yaw = raw.yaw;
    this.focusValid = true;
    return out;
  }

  private trackTarget(): { pos: Vec3; yaw: number } | null {
    if (this.camTrack === 'projectile') {
      const p = this.sim.projectiles.find((x) => x.id === this.camProjectileId);
      if (p) {
        lerpVec3(p.prevPos, p.pos, this.lastAlpha, this.target.pos);
        if (Math.abs(p.vel[0]) + Math.abs(p.vel[2]) > 1e-3) this.target.yaw = Math.atan2(p.vel[0], p.vel[2]);
        this.camHoldPos[0] = this.target.pos[0];
        this.camHoldPos[1] = this.target.pos[1];
        this.camHoldPos[2] = this.target.pos[2];
        return this.target;
      }
      // Removed without us hearing about it: hold where it was last seen.
      this.setCamTrack('hold', 0);
      this.camHoldLeft = GAME_FX.holdAfterOther;
    }
    if (this.camTrack === 'hold') {
      this.target.pos[0] = this.camHoldPos[0];
      this.target.pos[1] = this.camHoldPos[1];
      this.target.pos[2] = this.camHoldPos[2];
      return this.target;
    }
    return this.activeTarget();
  }

  private setCamTrack(track: CamTrack, blend: number): void {
    if (this.focusValid) {
      this.camFrom[0] = this.focus.pos[0];
      this.camFrom[1] = this.focus.pos[1];
      this.camFrom[2] = this.focus.pos[2];
    }
    this.camTrack = track;
    this.camBlendDur = blend;
    this.camBlend = blend > 0 && this.focusValid ? 0 : 1;
  }

  /** Per frame: advance the focus blend and the post-impact hold. */
  private updateCameraTrack(dt: number): void {
    if (this.camBlend < 1) this.camBlend = Math.min(1, this.camBlend + dt / Math.max(1e-3, this.camBlendDur));
    if (this.camTrack === 'hold') {
      this.camHoldLeft -= dt;
      if (this.camHoldLeft <= 0) this.setCamTrack('worm', GAME_FX.blendToWorm);
    }
  }

  private onProjectileSpawned(id: number, ownerId: number | null): void {
    if (ownerId === null || ownerId !== this.activeWormId) return;
    const mode = this.cameraRig.mode;
    if (mode !== 'follow' && mode !== 'aim') return; // overview / free-fly: leave the camera alone
    if (this.camTrack === 'projectile') return; // already following one (cluster bombs etc.)
    this.camProjectileId = id;
    this.setCamTrack('projectile', GAME_FX.blendToProjectile);
    if (mode === 'aim') this.cameraRig.setMode('follow');
  }

  private onProjectileRemoved(id: number, reason: string, pos: Vec3): void {
    this.projectileView.removed(id, reason, pos);
    if (this.camTrack !== 'projectile' || id !== this.camProjectileId) return;
    this.camHoldPos[0] = pos[0];
    this.camHoldPos[1] = pos[1];
    this.camHoldPos[2] = pos[2];
    this.setCamTrack('hold', 0.15);
    this.camHoldLeft =
      reason === 'exploded' || reason === 'water' ? GAME_FX.holdAfterImpact : GAME_FX.holdAfterOther;
  }

  private onExplosion(e: ExplosionResult): void {
    this.fx.explosion(e.pos, e.radius);
    this.shake.addExplosion(e.pos, e.radius, this.ctx.camera.position);
    let big = false;
    for (const h of e.hits) if (h.killed || h.damage >= GAME_FX.hitStopDamage) big = true;
    if (big && this.hitStopEnabled) this.hitStop = Math.max(this.hitStop, GAME_FX.hitStopFrames);
    this.explosions.push({
      tick: e.tick,
      pos: [e.pos[0], e.pos[1], e.pos[2]],
      radius: e.radius,
      kind: e.kind,
      hits: e.hits.length,
    });
    if (this.explosions.length > GAME_FX.explosionLog) this.explosions.shift();
  }

  private activeTarget(): { pos: Vec3; yaw: number } | null {
    const w = this.sim.worms.find((x) => x.id === this.activeWormId);
    if (!w) return null;
    lerpVec3(w.prevPos, w.pos, this.lastAlpha, this.target.pos);
    this.target.yaw = w.yaw;
    return this.target;
  }

  private wireSimEvents(): void {
    const ev = this.sim.events;
    const view = this.wormView;
    const send = (e: WormViewEvent) => view.handleEvent(e);
    this.unsubSim.push(
      ev.on('wormSpawned', ({ id }) => {
        if (this.activeWormId !== null) return;
        this.setActiveWorm(id);
        // Normal play starts behind the first worm; debug/tests keep the camera where it is.
        if (!this.opts.debug) {
          this.cameraRig.setMode('follow');
          this.cameraRig.snapToTarget();
        }
      }),
      ev.on('wormJumped', ({ id, kind }) => send({ type: 'jumped', id, kind })),
      ev.on('wormLanded', ({ id, drop }) => send({ type: 'landed', id, drop })),
      ev.on('wormDamaged', ({ id, amount }) => send({ type: 'damaged', id, amount })),
      ev.on('weaponFired', ({ origin, dir }) => this.fx.muzzle(origin, dir)),
      ev.on('projectileSpawned', ({ id, ownerId }) => this.onProjectileSpawned(id, ownerId)),
      ev.on('projectileRemoved', ({ id, reason, pos }) => this.onProjectileRemoved(id, reason, pos)),
      ev.on('explosion', (e) => this.onExplosion(e)),
      ev.on('wormDied', ({ id, cause, pos }) => {
        send({ type: 'died', id, cause, pos });
        if (id === this.activeWormId) this.selectNextWorm();
      }),
    );
  }

  /** Distance along a unit direction to the first terrain hit (worms and projectiles ignored), or null. */
  private raycast(origin: Vec3, dir: Vec3, maxDist: number): number | null {
    const ray = new RAPIER.Ray(
      { x: origin[0], y: origin[1], z: origin[2] },
      { x: dir[0], y: dir[1], z: dir[2] },
    );
    const hit = this.sim.physics.castRay(
      ray,
      maxDist,
      true,
      RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC | RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC,
      TERRAIN_QUERY_GROUPS,
    );
    return hit ? hit.timeOfImpact : null;
  }

  private cameraHeading(): number {
    return this.cameraRig.heading();
  }

  renderFrame(alpha: number, dt: number): void {
    // Hit-stop: sim ticks are skipped (see loop step) and animation freezes on the last interpolated pose.
    const frozen = this.hitStop > 0;
    if (frozen && dt > 0) this.hitStop--;
    const a = frozen ? this.lastAlpha : alpha;
    const adt = frozen ? 0 : dt;
    this.renderTime += adt;
    this.lastAlpha = a;
    const camera = this.ctx.camera;
    // Remove last frame's shake before the rig damps from the camera pose.
    this.shake.restore(camera);
    this.fireInput.update(dt);
    this.controls.update();
    this.updateCameraTrack(dt);
    this.cameraRig.update(dt);
    this.shake.apply(camera, dt);
    this.sky.update(camera, this.renderTime);
    this.water.update(this.renderTime, camera);
    this.wormView.sync(this.sim.worms, a, adt);
    this.projectileView.sync(this.sim.projectiles, a, adt);
    this.updateAimView(dt);
    this.fx.update(adt);
    this.ctx.render();
  }

  private updateAimView(dt: number): void {
    const t = this.cameraRig.mode === 'aim' && this.canFire() ? this.activeTarget() : null;
    if (!t) return this.aimView.hide();
    const power = this.fireInput.charging ? this.fireInput.power : 0.5;
    this.aimView.update(this.fireInput.weapon, t.pos, this.cameraRig.aimDirection(this.aimDir), power, dt);
  }

  state() {
    const cam = this.ctx.camera.position;
    return {
      ready: this.ready,
      ...this.sim.snapshot(),
      activeWormId: this.activeWormId,
      camera: { mode: this.cameraRig.mode, pos: [cam.x, cam.y, cam.z] as Vec3, track: this.camTrack },
      explosions: this.explosions.map((e) => ({ ...e, pos: [...e.pos] as Vec3 })),
      fx: { ...this.fx.stats(), projectiles: this.projectileView.count, shake: this.shake.trauma },
      weapon: { selected: this.fireInput.weapon, timer: this.fireInput.timer, power: this.firePower },
      terrain: { ...this.terrain.stats() },
      perf: { ...this.loop.perf.stats(), ...this.ctx.info() },
    };
  }
}
