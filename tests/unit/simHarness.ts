import type { Command } from '../../src/core/commands';
import type { Vec3 } from '../../src/core/math';
import { RAPIER } from '../../src/sim/physics';
import type { SimEvents } from '../../src/sim/world';
import { SimWorld } from '../../src/sim/world';

/** Headless sim + synthetic static colliders for rule tests. Call initPhysics() first. */
export class Harness {
  readonly sim: SimWorld;
  readonly log: { tick: number; type: keyof SimEvents; payload: unknown }[] = [];

  constructor(seed = 1) {
    this.sim = new SimWorld({ seed });
    const types: (keyof SimEvents)[] = [
      'wormSpawned',
      'wormJumped',
      'wormLanded',
      'wormDamaged',
      'wormDied',
      'commandIgnored',
    ];
    for (const type of types)
      this.sim.events.on(type, (payload) => this.log.push({ tick: this.sim.tick, type, payload }));
  }

  /** Axis-aligned static box. */
  box(center: Vec3, half: Vec3): this {
    this.sim.physics.createCollider(
      RAPIER.ColliderDesc.cuboid(half[0], half[1], half[2]).setTranslation(...center),
    );
    return this;
  }

  /** Flat ground whose top surface is at y = top. */
  ground(top = 0, half = 50): this {
    return this.box([0, top - 0.5, 0], [half, 0.5, half]);
  }

  /**
   * Ramp rising along +x at `deg` degrees; its top surface passes through (x0, 0) and it spans z ∈ [-w, w].
   */
  ramp(deg: number, x0: number, length: number, w = 5): this {
    const a = (deg * Math.PI) / 180;
    const hy = 0.5;
    const cx = x0 + (length / 2) * Math.cos(a) + hy * Math.sin(a);
    const cy = (length / 2) * Math.sin(a) - hy * Math.cos(a);
    this.sim.physics.createCollider(
      RAPIER.ColliderDesc.cuboid(length / 2, hy, w)
        .setTranslation(cx, cy, 0)
        .setRotation({ x: 0, y: 0, z: Math.sin(a / 2), w: Math.cos(a / 2) }),
    );
    return this;
  }

  spawn(pos: Vec3, team = 0): number {
    this.sim.step([{ type: 'spawnWorm', team, pos }]);
    return this.sim.worms[this.sim.worms.length - 1]!.id;
  }

  /** Step n ticks; `cmds` are applied on the first of them. Calls `each` after every tick. */
  run(n: number, cmds: Command[] = [], each?: () => void): this {
    for (let i = 0; i < n; i++) {
      this.sim.step(i === 0 ? cmds : []);
      each?.();
    }
    return this;
  }

  worm(id: number) {
    const w = this.sim.worms.find((x) => x.id === id);
    if (!w) throw new Error(`no worm ${id}`);
    return w;
  }

  events<K extends keyof SimEvents>(type: K): SimEvents[K][] {
    return this.log.filter((e) => e.type === type).map((e) => e.payload as SimEvents[K]);
  }

  private disposed = false;

  /** Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.sim.dispose();
  }
}
