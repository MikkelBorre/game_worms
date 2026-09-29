import { describe, expect, it } from 'vitest';
import { Rng, hash32 } from '../../src/core/rng';

describe('Rng', () => {
  it('is deterministic for the same seed', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    for (let i = 0; i < 1000; i++) expect(a.next()).toBe(b.next());
  });

  it('differs between seeds', () => {
    expect(new Rng(1).next()).not.toBe(new Rng(2).next());
  });

  it('stays in range', () => {
    const r = new Rng(7);
    for (let i = 0; i < 10_000; i++) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      const n = r.int(-3, 3);
      expect(n).toBeGreaterThanOrEqual(-3);
      expect(n).toBeLessThanOrEqual(3);
    }
  });

  it('forks independent but reproducible streams', () => {
    const a = new Rng(99).fork(5);
    const b = new Rng(99).fork(5);
    const c = new Rng(99).fork(6);
    expect(a.next()).toBe(b.next());
    expect(new Rng(99).fork(5).next()).not.toBe(c.next());
  });

  it('restores state', () => {
    const r = new Rng(3);
    r.next();
    const s = r.getState();
    const x = r.next();
    r.setState(s);
    expect(r.next()).toBe(x);
  });

  it('hash32 is stable', () => {
    expect(hash32(0)).toBe(hash32(0));
    expect(hash32(1)).not.toBe(hash32(2));
  });
});
