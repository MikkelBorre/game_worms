import type { Command } from '../core/commands';
import { EventBus } from '../core/events';
import type { Vec3 } from '../core/math';
import { Rng } from '../core/rng';
import { TICK_DT } from '../core/loop';
import { RAPIER } from './physics';

export const GRAVITY = -9.81;

export interface WormState {
  id: number;
  team: number;
  hp: number;
  alive: boolean;
  pos: Vec3;
  /** Position at the previous tick, for render interpolation. */
  prevPos: Vec3;
}

export interface SimEvents {
  wormSpawned: { id: number; team: number; pos: Vec3 };
  commandIgnored: { type: string; reason: string };
}

export interface SimOptions {
  seed: number;
}

/**
 * Headless, deterministic simulation. No three.js, no wall clock, no Math.random.
 * M0 placeholder worms are dynamic capsules; M2 replaces them with a character controller.
 */
export class SimWorld {
  readonly physics: RAPIER.World;
  readonly events = new EventBus<SimEvents>();
  readonly rng: Rng;
  readonly seed: number;
  tick = 0;
  readonly worms: WormState[] = [];
  private readonly wormBodies = new Map<number, RAPIER.RigidBody>();
  private nextId = 1;

  constructor(opts: SimOptions) {
    this.seed = opts.seed;
    this.rng = new Rng(opts.seed).fork(1);
    this.physics = new RAPIER.World({ x: 0, y: GRAVITY, z: 0 });
    this.physics.timestep = TICK_DT;
  }

  step(commands: readonly Command[]): void {
    for (const cmd of commands) this.apply(cmd);
    for (const w of this.worms) {
      w.prevPos[0] = w.pos[0];
      w.prevPos[1] = w.pos[1];
      w.prevPos[2] = w.pos[2];
    }
    this.physics.step();
    for (const w of this.worms) {
      const body = this.wormBodies.get(w.id);
      if (!body) continue;
      const t = body.translation();
      w.pos[0] = t.x;
      w.pos[1] = t.y;
      w.pos[2] = t.z;
    }
    this.tick++;
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
    }
  }

  private spawnWorm(team: number, pos: Vec3): void {
    const id = this.nextId++;
    const body = this.physics.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(pos[0], pos[1], pos[2])
        .lockRotations()
        .setCcdEnabled(true),
    );
    this.physics.createCollider(RAPIER.ColliderDesc.capsule(0.25, 0.3).setFriction(0.9), body);
    this.wormBodies.set(id, body);
    this.worms.push({ id, team, hp: 100, alive: true, pos: [...pos], prevPos: [...pos] });
    this.events.emit('wormSpawned', { id, team, pos: [...pos] });
  }

  /** Plain serializable snapshot (for debug API, hashing and tests). */
  snapshot() {
    return {
      tick: this.tick,
      seed: this.seed,
      worms: this.worms.map((w) => ({
        id: w.id,
        team: w.team,
        hp: w.hp,
        alive: w.alive,
        pos: [...w.pos] as Vec3,
      })),
    };
  }

  dispose(): void {
    this.events.clear();
    this.physics.free();
  }
}
