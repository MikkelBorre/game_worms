import type { Command } from '../core/commands';
import { EventBus } from '../core/events';
import type { Vec3 } from '../core/math';
import { Rng } from '../core/rng';
import { TICK_DT } from '../core/loop';
import { WATER_LEVEL } from '../terrain/types';
import { RAPIER } from './physics';
import {
  createWormControllers,
  Worm,
  WORM_GRAVITY,
  type WormControllers,
  type WormEvents,
  type WormState,
} from './worm';

export type { WormAnimState, WormState } from './worm';

export const GRAVITY = WORM_GRAVITY;

export interface SimEvents extends WormEvents {
  wormSpawned: { id: number; team: number; pos: Vec3 };
  commandIgnored: { type: string; reason: string };
}

export interface SimOptions {
  seed: number;
}

/**
 * Headless, deterministic simulation. No three.js, no wall clock, no Math.random.
 * Worms are kinematic character controllers (see worm.ts).
 */
export class SimWorld {
  readonly physics: RAPIER.World;
  readonly events = new EventBus<SimEvents>();
  readonly rng: Rng;
  readonly seed: number;
  tick = 0;
  /** Worm y (centre) below this ⇒ instant death. Sudden death will raise it later. */
  waterLevel = WATER_LEVEL;
  /** Plain per-worm state read by render/UI. Same objects as `worm(id).s`. */
  readonly worms: WormState[] = [];
  private readonly wormById = new Map<number, Worm>();
  private readonly wormList: Worm[] = [];
  private readonly controllers: WormControllers;
  private nextId = 1;

  constructor(opts: SimOptions) {
    this.seed = opts.seed;
    this.rng = new Rng(opts.seed).fork(1);
    this.physics = new RAPIER.World({ x: 0, y: GRAVITY, z: 0 });
    this.physics.timestep = TICK_DT;
    this.controllers = createWormControllers(this.physics);
  }

  step(commands: readonly Command[]): void {
    for (const cmd of commands) this.apply(cmd);
    for (const w of this.worms) {
      w.prevPos[0] = w.pos[0];
      w.prevPos[1] = w.pos[1];
      w.prevPos[2] = w.pos[2];
      w.prevYaw = w.yaw;
    }
    for (const w of this.wormList) w.preStep(this.controllers);
    this.physics.step();
    for (const w of this.wormList) w.postStep(this.waterLevel);
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

  /** Controller-level access (knockback etc.). */
  worm(id: number): Worm | undefined {
    return this.wormById.get(id);
  }

  private apply(cmd: Command): void {
    switch (cmd.type) {
      case 'noop':
        return;
      case 'spawnWorm':
        this.spawnWorm(cmd.team, cmd.pos);
        return;
      case 'fire':
        this.events.emit('commandIgnored', { type: cmd.type, reason: 'weapons arrive in M3' });
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

  private spawnWorm(team: number, pos: Vec3): Worm {
    const id = this.nextId++;
    const worm = new Worm(
      this.physics,
      (type, payload) => this.events.emit(type, payload as SimEvents[typeof type]),
      id,
      team,
      pos,
    );
    this.wormById.set(id, worm);
    this.wormList.push(worm);
    this.worms.push(worm.s);
    this.events.emit('wormSpawned', { id, team, pos: [...pos] });
    return worm;
  }

  /** Plain serializable snapshot (for debug API, hashing and tests). */
  snapshot() {
    return {
      tick: this.tick,
      seed: this.seed,
      waterLevel: this.waterLevel,
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
    };
  }

  /**
   * Deterministic 32-bit state hash (FNV-1a over tick, rng state and per-worm quantized data:
   * positions in mm, yaw in mrad, hp, alive). For desync detection between peers/replays.
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
    return h >>> 0;
  }

  dispose(): void {
    this.events.clear();
    this.physics.free();
  }
}
