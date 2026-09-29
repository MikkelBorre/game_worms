import type { Vec2, Vec3 } from './math';

/**
 * Every player/bot/network action is a serializable Command.
 * The sim consumes commands only via CommandQueue, stamped with the tick they apply on.
 */
export type Command =
  | { type: 'noop' }
  | { type: 'spawnWorm'; team: number; pos: Vec3 }
  | { type: 'fire'; weapon: string; dir: Vec3; power: number }
  /**
   * Held walk intent for a worm, already resolved to a world-space XZ direction [x, z]
   * (the input layer applies camera yaw; the sim knows nothing about cameras).
   * Applied every tick until replaced; send [0, 0] to stop. Length is clamped to 1 (analog OK).
   */
  | { type: 'move'; wormId: number; dir: Vec2 }
  /**
   * Jump press. Without `kind` the sim does double-tap detection: a second press within
   * BACKFLIP_WINDOW_TICKS makes a backflip, otherwise a forward jump fires when the window expires.
   * With an explicit `kind` the jump fires immediately (bots, replays, alternative bindings).
   */
  | { type: 'jump'; wormId: number; kind?: JumpKind }
  /** Set facing yaw (radians). yaw 0 faces +Z; forward = [sin(yaw), 0, cos(yaw)]. */
  | { type: 'face'; wormId: number; yaw: number };

export type JumpKind = 'forward' | 'backflip';

export interface TimedCommand {
  tick: number;
  cmd: Command;
}

export class CommandQueue {
  private pending: TimedCommand[] = [];
  /** Full log of applied commands, enough to replay a match from its seed. */
  readonly log: TimedCommand[] = [];

  push(cmd: Command, tick: number): void {
    this.pending.push({ tick, cmd });
  }

  /** Remove and return commands due at or before `tick`, in insertion order. */
  drain(tick: number): Command[] {
    const due: Command[] = [];
    const rest: TimedCommand[] = [];
    for (const tc of this.pending) {
      if (tc.tick <= tick) {
        due.push(tc.cmd);
        this.log.push({ tick, cmd: tc.cmd });
      } else rest.push(tc);
    }
    this.pending = rest;
    return due;
  }

  clear(): void {
    this.pending = [];
    this.log.length = 0;
  }
}
