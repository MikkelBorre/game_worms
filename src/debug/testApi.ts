import type { Command } from '../core/commands';
import type { Vec2, Vec3 } from '../core/math';
import type { Game } from '../game';
import type { CameraMode } from '../render/camera';

export interface GameTestApi {
  readonly ready: boolean;
  state(): ReturnType<Game['state']>;
  spawnWorm(opts: { team: number; pos: Vec3 }): void;
  /** Spread teams over the island (seeded) – queued like spawnWorm. */
  spawnTeams(teams: number, wormsPerTeam: number): void;
  /**
   * Fire `weapon` from the active worm (game.activeWormId) along `dir` with `power` 0..1; `timer` = fuse seconds
   * for timer weapons. Queued for the next tick. Throws if there is no active worm.
   */
  fire(weapon: string, dir: Vec3, power: number, timer?: number): void;
  /** Queue a `setWind` command: wind acceleration [x, z] (m/s²). */
  setWind(wind: Vec2): void;
  /** Queue any serializable Command (move/jump/face/…) for the next tick. */
  command(cmd: Command): void;
  /** Deterministic sim state hash (desync checks). */
  hash(): number;
  /**
   * Run up to n sim ticks synchronously, then render one frame. Returns the sim tick. Ticks are skipped while a
   * terrain carve is pending (explosions), so after a blast fewer than n may run – use advanceAsync then.
   */
  advance(ticks: number): number;
  /** Run exactly n sim ticks, awaiting pending terrain edits (explosion craters) between ticks. */
  advanceAsync(ticks: number): Promise<number>;
  /** Rebuild the world from a new seed. Resolves when ready. */
  setSeed(seed: number): Promise<void>;
  /** PNG data URL of the current frame. */
  screenshot(): string;
  /** Pause/resume real-time sim ticking (rendering continues). */
  pause(paused: boolean): void;
  camera(position: Vec3, target: Vec3): void;
  cameraMode(mode: CameraMode): void;
  /** Top terrain surface y at (x, z). */
  heightAt(x: number, z: number): number;
  /** Make a worm the locally controlled one (follow camera + keyboard). */
  selectWorm(id: number | null): void;
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
    spawnTeams: (teams, wormsPerTeam) => game.spawnTeams(teams, wormsPerTeam),
    fire: (weapon, dir, power, timer) => {
      const wormId = game.activeWormId;
      if (wormId === null) throw new Error('fire: no active worm');
      game.command({ type: 'fire', wormId, weapon, dir, power, ...(timer === undefined ? {} : { timer }) });
    },
    setWind: (wind) => game.command({ type: 'setWind', wind }),
    command: (cmd) => game.command(cmd),
    hash: () => game.sim.hash(),
    advance: (ticks) => {
      game.loop.advance(ticks);
      return game.sim.tick;
    },
    advanceAsync: async (ticks) => {
      for (let i = 0; i < ticks; i++) {
        await game.sim.whenTerrainIdle();
        game.loop.advance(1);
      }
      await game.sim.whenTerrainIdle();
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
    selectWorm: (id) => game.setActiveWorm(id),
    heightAt: (x, z) => game.terrain.heightAt(x, z),
    renderFrames: (n, dtSec = 1 / 60) => {
      for (let i = 0; i < n; i++) game.renderFrame(1, dtSec);
    },
  };
  window.__game = api;
  return api;
}
