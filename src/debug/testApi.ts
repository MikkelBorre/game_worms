import type { Command } from '../core/commands';
import type { Vec3 } from '../core/math';
import type { Game } from '../game';

export interface GameTestApi {
  readonly ready: boolean;
  state(): ReturnType<Game['state']>;
  spawnWorm(opts: { team: number; pos: Vec3 }): void;
  fire(weapon: string, dir: Vec3, power: number): void;
  /** Queue any serializable Command (move/jump/face/…) for the next tick. */
  command(cmd: Command): void;
  /** Deterministic sim state hash (desync checks). */
  hash(): number;
  /** Run exactly n sim ticks synchronously, then render one frame. */
  advance(ticks: number): number;
  /** Rebuild the world from a new seed. Resolves when ready. */
  setSeed(seed: number): Promise<void>;
  /** PNG data URL of the current frame. */
  screenshot(): string;
  /** Pause/resume real-time sim ticking (rendering continues). */
  pause(paused: boolean): void;
  camera(position: Vec3, target: Vec3): void;
  cameraMode(mode: 'free' | 'overview'): void;
  /** Render n frames (no sim ticks) so time-based shaders advance. */
  renderFrames(n: number, dtSec?: number): void;
}

declare global {
  interface Window {
    __game?: GameTestApi;
  }
}

/** Exposes window.__game. Only installed with ?debug=1. */
export function installTestApi(game: Game): GameTestApi {
  const api: GameTestApi = {
    get ready() {
      return game.ready;
    },
    state: () => game.state(),
    spawnWorm: ({ team, pos }) => game.spawnWorm(team, pos),
    fire: (weapon, dir, power) => game.command({ type: 'fire', weapon, dir, power }),
    command: (cmd) => game.command(cmd),
    hash: () => game.sim.hash(),
    advance: (ticks) => {
      game.loop.advance(ticks);
      return game.sim.tick;
    },
    setSeed: (seed) => game.load(seed),
    screenshot: () => game.ctx.renderer.domElement.toDataURL('image/png'),
    pause: (p) => {
      game.loop.paused = p;
    },
    camera: (position, target) => {
      game.cameraRig.setMode('free');
      game.cameraRig.setPose(position, target);
      game.ctx.render();
    },
    cameraMode: (mode) => game.cameraRig.setMode(mode),
    renderFrames: (n, dtSec = 1 / 60) => {
      for (let i = 0; i < n; i++) game.renderFrame(1, dtSec);
    },
  };
  window.__game = api;
  return api;
}
