import type { Vec3 } from './math';

/**
 * Every player/bot/network action is a serializable Command.
 * The sim consumes commands only via CommandQueue, stamped with the tick they apply on.
 */
export type Command =
  | { type: 'noop' }
  | { type: 'spawnWorm'; team: number; pos: Vec3 }
  | { type: 'fire'; weapon: string; dir: Vec3; power: number };

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
