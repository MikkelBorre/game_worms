import { CommandQueue, type Command } from './core/commands';
import { GameLoop } from './core/loop';
import type { Vec3 } from './core/math';
import { initPhysics } from './sim/physics';
import { SimWorld } from './sim/world';
import { createTerrain, type TerrainSystem } from './terrain';
import { createCameraRig, type CameraRig } from './render/camera';
import { createTerrainMaterial } from './render/materials';
import { createRenderContext, type RenderContext } from './render/scene';
import { createSky, type Sky } from './render/sky';
import { createTerrainView, type TerrainView } from './render/terrainView';
import { createWater, type Water } from './render/water';
import { WormView } from './render/wormView';

export interface GameOptions {
  seed: number;
  debug: boolean;
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
  private renderTime = 0;
  private unsubMesh: (() => void) | null = null;

  private constructor(canvas: HTMLCanvasElement, opts: GameOptions) {
    this.seed = opts.seed;
    this.ctx = createRenderContext(canvas);
    this.sky = createSky(this.ctx.scene);
    this.water = createWater();
    this.ctx.scene.add(this.water.object);
    this.terrainView = createTerrainView(createTerrainMaterial());
    this.ctx.scene.add(this.terrainView.group);
    this.ctx.scene.add(this.wormView.group);
    this.cameraRig = createCameraRig(this.ctx.camera, canvas);
    this.loop = new GameLoop({
      step: () => this.sim.step(this.queue.drain(this.sim.tick)),
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
    this.terrain?.dispose();
    this.sim?.dispose();
    this.terrainView.clear();
    this.wormView.clear();
    this.queue.clear();

    this.sim = new SimWorld({ seed });
    this.terrain = createTerrain({ seed, sim: this.sim });
    this.unsubMesh = this.terrain.onChunkMesh((m) => this.terrainView.apply(m));
    await this.terrain.generate();
    this.water.setHeightmap(this.terrain.heightmap(256));
    this.ready = true;
  }

  command(cmd: Command): void {
    this.queue.push(cmd, this.sim.tick);
  }

  spawnWorm(team: number, pos: Vec3): void {
    this.command({ type: 'spawnWorm', team, pos });
  }

  renderFrame(alpha: number, dt: number): void {
    this.renderTime += dt;
    this.cameraRig.update(dt);
    this.sky.update(this.ctx.camera);
    this.water.update(this.renderTime, this.ctx.camera);
    this.wormView.sync(this.sim.worms, alpha);
    this.ctx.render();
  }

  state() {
    const cam = this.ctx.camera.position;
    return {
      ready: this.ready,
      ...this.sim.snapshot(),
      camera: { mode: this.cameraRig.mode, pos: [cam.x, cam.y, cam.z] as Vec3 },
      terrain: { ...this.terrain.stats() },
      perf: { ...this.loop.perf.stats(), ...this.ctx.info() },
    };
  }
}
