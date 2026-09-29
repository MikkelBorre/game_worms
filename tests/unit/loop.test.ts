import { describe, expect, it } from 'vitest';
import { GameLoop, TICK_DT } from '../../src/core/loop';

describe('GameLoop', () => {
  const make = () => {
    let now = 0;
    let steps = 0;
    const alphas: number[] = [];
    const loop = new GameLoop({ step: () => steps++, render: (a) => alphas.push(a) }, () => now);
    return {
      loop,
      setNow: (t: number) => (now = t),
      steps: () => steps,
      alphas,
    };
  };

  it('runs 60 ticks per simulated second regardless of frame rate', () => {
    for (const fps of [30, 60, 144]) {
      const h = make();
      const frameMs = 1000 / fps;
      for (let i = 1; i <= fps; i++) {
        h.setNow(i * frameMs);
        h.loop.frame(i * frameMs);
      }
      expect(Math.abs(h.steps() - 60)).toBeLessThanOrEqual(1);
    }
  });

  it('interpolation alpha stays in [0,1)', () => {
    const h = make();
    for (let i = 1; i < 100; i++) h.loop.frame(i * 7.3);
    for (const a of h.alphas) {
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(1);
    }
  });

  it('caps catch-up steps after a long stall', () => {
    const h = make();
    h.loop.frame(0);
    h.loop.frame(5000);
    expect(h.steps()).toBeLessThanOrEqual(5);
  });

  it('advance() runs exact ticks and does not tick while paused', () => {
    const h = make();
    h.loop.paused = true;
    h.loop.frame(1000);
    expect(h.steps()).toBe(0);
    h.loop.advance(37);
    expect(h.steps()).toBe(37);
    expect(TICK_DT).toBeCloseTo(1 / 60);
  });
});
