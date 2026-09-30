import { CommandQueue, type Command } from './core/commands';
import { GameLoop } from './core/loop';
import { lerpVec3, type Vec3 } from './core/math';
import { Controls } from './input/controls';
import { initPhysics, RAPIER } from './sim/physics';
import { spawnTeams } from './sim/spawn';
import { SimWorld } from './sim/world';
import { createTerrain, type TerrainSystem } from './terrain';
import { createCameraRig, type CameraRig } from './render/camera';
import { createTerrainMaterial } from './render/materials';
import { createRenderContext, type RenderContext } from './render/scene';
import { createSky, type Sky } from './render/sky';
import { createTerrainView, type TerrainView } from './render/terrainView';
import { createWater, type Water } from './render/water';
import { WormView, type WormViewEvent } from './render/wormView';

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
  /** Worm controlled by the local player (turn system replaces this in M4). */
  activeWormId: number | null = null;
  private renderTime = 0;
  private lastAlpha = 1;
  private readonly target: { pos: Vec3; yaw: number } = { pos: [0, 0, 0], yaw: 0 };
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
    this.loop = new GameLoop({
      // No ticks while a world is (re)loading: every world starts at tick 0 regardless of load time.
      step: () => {
        if (this.ready) this.sim.step(this.queue.drain(this.sim.tick));
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
    this.queue.clear();

    this.sim = new SimWorld({ seed });
    this.wireSimEvents();
    this.terrain = createTerrain({ seed, sim: this.sim });
    this.unsubMesh = this.terrain.onChunkMesh((m) => this.terrainView.apply(m));
    await this.terrain.generate();
    this.water.setHeightmap(this.terrain.heightmap(256));
    if (this.opts.teams > 0) this.spawnTeams(this.opts.teams, this.opts.wormsPerTeam);
    this.ready = true;
  }

  command(cmd: Command): void {
    this.queue.push(cmd, this.sim.tick);
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
    // Only living, existing worms can be controlled.
    if (id !== null && !this.sim.worms.some((w) => w.id === id && w.alive)) return;
    this.activeWormId = id;
    this.wormView.setActive(id);
    this.cameraRig.setTarget(id === null ? null : () => this.activeTarget());
    if (id !== null && (this.cameraRig.mode === 'follow' || this.cameraRig.mode === 'aim')) {
      this.cameraRig.snapToTarget();
    }
  }

  selectNextWorm(): void {
    const alive = this.sim.worms.filter((w) => w.alive);
    if (alive.length === 0) return this.setActiveWorm(null);
    const i = alive.findIndex((w) => w.id === this.activeWormId);
    this.setActiveWorm(alive[(i + 1) % alive.length]!.id);
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
      ev.on('wormDied', ({ id, cause, pos }) => {
        send({ type: 'died', id, cause, pos });
        if (id === this.activeWormId) this.selectNextWorm();
      }),
    );
  }

  /** Distance along a unit direction to the first terrain hit (worms ignored), or null. */
  private raycast(origin: Vec3, dir: Vec3, maxDist: number): number | null {
    const ray = new RAPIER.Ray(
      { x: origin[0], y: origin[1], z: origin[2] },
      { x: dir[0], y: dir[1], z: dir[2] },
    );
    const hit = this.sim.physics.castRay(ray, maxDist, true, RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC);
    return hit ? hit.timeOfImpact : null;
  }

  private cameraHeading(): number {
    return this.cameraRig.heading();
  }

  renderFrame(alpha: number, dt: number): void {
    this.renderTime += dt;
    this.lastAlpha = alpha;
    this.controls.update();
    this.cameraRig.update(dt);
    this.sky.update(this.ctx.camera, this.renderTime);
    this.water.update(this.renderTime, this.ctx.camera);
    this.wormView.sync(this.sim.worms, alpha, dt);
    this.ctx.render();
  }

  state() {
    const cam = this.ctx.camera.position;
    return {
      ready: this.ready,
      ...this.sim.snapshot(),
      activeWormId: this.activeWormId,
      camera: { mode: this.cameraRig.mode, pos: [cam.x, cam.y, cam.z] as Vec3 },
      terrain: { ...this.terrain.stats() },
      perf: { ...this.loop.perf.stats(), ...this.ctx.info() },
    };
  }
}
