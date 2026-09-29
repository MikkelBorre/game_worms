import { beforeAll, describe, expect, it } from 'vitest';
import { CommandQueue } from '../../src/core/commands';
import { initPhysics, RAPIER } from '../../src/sim/physics';
import { SimWorld } from '../../src/sim/world';

beforeAll(async () => {
  await initPhysics();
});

function run(seed: number, ticks: number) {
  const sim = new SimWorld({ seed });
  sim.physics.createCollider(RAPIER.ColliderDesc.cuboid(50, 0.5, 50).setTranslation(0, -0.5, 0));
  const q = new CommandQueue();
  q.push({ type: 'spawnWorm', team: 0, pos: [0, 10, 0] }, 0);
  q.push({ type: 'spawnWorm', team: 1, pos: [3, 5, 1] }, 30);
  for (let i = 0; i < ticks; i++) sim.step(q.drain(sim.tick));
  const snap = sim.snapshot();
  sim.dispose();
  return snap;
}

describe('SimWorld (headless)', () => {
  it('spawns worms via commands and lets them fall onto ground', () => {
    const s = run(1, 300);
    expect(s.tick).toBe(300);
    expect(s.worms).toHaveLength(2);
    for (const w of s.worms) {
      expect(w.pos[1]).toBeGreaterThan(0);
      expect(w.pos[1]).toBeLessThan(1.5);
    }
  });

  it('is deterministic: same seed + commands => identical state', () => {
    expect(run(5, 240)).toEqual(run(5, 240));
  });
});
