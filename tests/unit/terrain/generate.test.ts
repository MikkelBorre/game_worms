import { describe, expect, it } from 'vitest';
import { generateIsland } from '../../../src/terrain/generate';
import { buildHeightmap } from '../../../src/terrain/heightmap';
import { SX, SY, SZ, sampleX, sampleZ } from '../../../src/terrain/voxels';
import { WATER_LEVEL, WORLD_MIN, WORLD_SIZE } from '../../../src/terrain/types';

describe('island generation', () => {
  const a = generateIsland(1234);

  it('is deterministic: same seed => bit-identical field', () => {
    const b = generateIsland(1234);
    expect(b.field.hash()).toBe(a.field.hash());
    expect(b.info).toEqual(a.info);
    expect(Array.from(b.field.columnTop)).toEqual(Array.from(a.field.columnTop));
  });

  it('different seeds give different islands', () => {
    const c = generateIsland(1235);
    expect(c.field.hash()).not.toBe(a.field.hash());
  });

  it('is surrounded by ocean with the coast well inside the volume', () => {
    const top = a.field.columnTop;
    let maxBorder = -Infinity;
    let maxRadius = 0;
    for (let k = 0; k < SZ; k++)
      for (let i = 0; i < SX; i++) {
        const h = top[i + k * SX]!;
        const edge = Math.min(i, k, SX - 1 - i, SZ - 1 - k);
        if (edge < 8) maxBorder = Math.max(maxBorder, h);
        if (h > WATER_LEVEL) maxRadius = Math.max(maxRadius, Math.hypot(sampleX(i), sampleZ(k)));
      }
    expect(maxBorder).toBeLessThan(WATER_LEVEL - 1);
    expect(maxRadius).toBeGreaterThan(50);
    expect(maxRadius).toBeLessThan(76);
  });

  it('has hills, a dry centre, beaches and a sea floor', () => {
    const top = a.field.columnTop;
    let max = -Infinity;
    let min = Infinity;
    let beach = 0;
    let land = 0;
    for (let n = 0; n < top.length; n++) {
      const h = top[n]!;
      max = Math.max(max, h);
      min = Math.min(min, h);
      if (h > WATER_LEVEL) land++;
      if (h > WATER_LEVEL && h < WATER_LEVEL + 1.5) beach++;
    }
    expect(max).toBeGreaterThan(20);
    expect(max).toBeLessThan(WORLD_MIN.y + WORLD_SIZE.y - 1);
    expect(min).toBeGreaterThan(WORLD_MIN.y);
    expect(min).toBeLessThan(-4);
    expect(beach / land).toBeGreaterThan(0.05);
    const centre = top[SX / 2 + (SZ / 2) * SX]!;
    expect(centre).toBeGreaterThan(WATER_LEVEL + 2);
    const v = a.info.village;
    expect(Math.hypot(v.x, v.z)).toBeLessThan(35);
  });

  it('has occasional caves/overhangs (air below the top surface), not everywhere', () => {
    const f = a.field;
    let columnsWithGap = 0;
    let land = 0;
    for (let k = 0; k < SZ; k += 2)
      for (let i = 0; i < SX; i += 2) {
        const top = f.columnTop[i + k * SX]!;
        if (top <= WATER_LEVEL + 1) continue;
        land++;
        const jTop = Math.floor((top - WORLD_MIN.y) / 0.5) - 3;
        for (let j = jTop; j > 0 && j < SY; j--) {
          const y = WORLD_MIN.y + j * 0.5;
          if (y < WATER_LEVEL + 1) break;
          if (f.get(i, j, k) < 0) {
            columnsWithGap++;
            break;
          }
        }
      }
    expect(columnsWithGap).toBeGreaterThan(0);
    expect(columnsWithGap / land).toBeLessThan(0.15);
  });

  it('heightmap follows the contract layout', () => {
    const hm = buildHeightmap(a.field, 64);
    expect(hm.resolution).toBe(64);
    expect(hm.minX).toBe(WORLD_MIN.x);
    expect(hm.minZ).toBe(WORLD_MIN.z);
    expect(hm.size).toBe(WORLD_SIZE.x);
    expect(hm.heights.length).toBe(64 * 64);
    expect(hm.heights.every(Number.isFinite)).toBe(true);
    // Corners are ocean, the middle is land.
    expect(hm.heights[0]!).toBeLessThan(WATER_LEVEL);
    expect(hm.heights[63 * 64 + 63]!).toBeLessThan(WATER_LEVEL);
    expect(hm.heights[32 * 64 + 32]!).toBeGreaterThan(WATER_LEVEL);
  });
});
