import { describe, expect, it } from 'vitest';
import { DEFAULT_SEED, parseSeed } from '../../src/core/seed';

describe('parseSeed', () => {
  it('accepts integers including 0 and negatives', () => {
    expect(parseSeed('0')).toBe(0);
    expect(parseSeed('42')).toBe(42);
    expect(parseSeed('-5')).toBe(-5);
    expect(parseSeed(' 7 ')).toBe(7);
  });

  it('falls back to the default for missing or invalid input', () => {
    for (const raw of [null, '', 'abc', '1e3', '1.5', '99999999999999999999']) {
      expect(parseSeed(raw)).toBe(DEFAULT_SEED);
    }
  });
});
