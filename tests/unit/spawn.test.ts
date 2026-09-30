import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/core/math';
import {
  findSpawnPoints,
  findSpawnPointsDetailed,
  SPAWN_DROP,
  SPAWN_MIN_ABOVE_WATER,
  SPAWN_MIN_SPACING,
  spawnTeams,
} from '../../src/sim/spawn';
import { WORM_CENTER_TO_FEET } from '../../src/sim/worm';
import { WORLD_MIN } from '../../src/terrain/types';

/** Synthetic island: flat plateau at `top` inside radius r, empty column (no terrain) outside. */
const disc =
  (r: number, top = 5) =>
  (x: number, z: number) =>
    x * x + z * z <= r * r ? top : WORLD_MIN.y;

const LIFT = WORM_CENTER_TO_FEET + SPAWN_DROP;

function minPairDist(points: Vec3[]): number {
  let d = Infinity;
  for (let i = 0; i < points.length; i++)
    for (let j = i + 1; j < points.length; j++)
      d = Math.min(d, Math.hypot(points[i]![0] - points[j]![0], points[i]![2] - points[j]![2]));
  return d;
}

describe('findSpawnPoints', () => {
  it('places points on land, spaced, lifted above the surface, deterministically', () => {
    const heightAt = disc(55);
    const opts = { seed: 7, count: 16, heightAt, waterLevel: 0 };
    const a = findSpawnPointsDetailed(opts);
    expect(a.points).toHaveLength(16);
    expect(a.spacing).toBe(SPAWN_MIN_SPACING);
    expect(minPairDist(a.points)).toBeGreaterThanOrEqual(SPAWN_MIN_SPACING);
    for (const p of a.points) {
      expect(Math.hypot(p[0], p[2])).toBeLessThanOrEqual(55);
      expect(p[1]).toBeCloseTo(5 + LIFT, 9);
    }
    expect(findSpawnPoints(opts)).toEqual(a.points);
    expect(findSpawnPoints({ ...opts, seed: 8 })).not.toEqual(a.points);
  });

  it('never spawns in or right next to the water, nor where there is no terrain', () => {
    // Island that is mostly low beach (below water + 1.5) with a dry ring.
    const heightAt = (x: number, z: number) => {
      const r = Math.hypot(x, z);
      if (r > 50) return WORLD_MIN.y;
      return r > 30 ? 3 : 1; // inner part too low
    };
    const pts = findSpawnPoints({ seed: 1, count: 12, heightAt, waterLevel: 0, minSpacing: 8 });
    for (const p of pts) {
      const r = Math.hypot(p[0], p[2]);
      expect(r).toBeGreaterThan(31); // ≥ 1 m neighbour probe inside the dry ring
      expect(r).toBeLessThan(49);
      expect(p[1] - LIFT).toBeGreaterThanOrEqual(SPAWN_MIN_ABOVE_WATER);
    }
  });

  it('avoids steep ground', () => {
    // Half the island is a 45° ramp, the other half flat.
    const heightAt = (x: number, z: number) => (x * x + z * z > 55 * 55 ? WORLD_MIN.y : x > 0 ? 5 + x : 5);
    const pts = findSpawnPoints({ seed: 3, count: 8, heightAt, waterLevel: 0, minSpacing: 10 });
    expect(pts).toHaveLength(8);
    for (const p of pts) expect(p[0]).toBeLessThan(1);
  });

  it('relaxes the spacing on a small island instead of failing', () => {
    const r = findSpawnPointsDetailed({ seed: 2, count: 16, heightAt: disc(14), waterLevel: 0 });
    expect(r.points).toHaveLength(16);
    expect(r.spacing).toBeLessThan(SPAWN_MIN_SPACING);
    expect(r.spacing).toBeGreaterThan(1);
    expect(minPairDist(r.points)).toBeGreaterThanOrEqual(r.spacing);
  });

  it('keeps away from `avoid` points', () => {
    const avoid: Vec3[] = [
      [0, 5, 0],
      [20, 5, 20],
    ];
    const pts = findSpawnPoints({ seed: 4, count: 10, heightAt: disc(55), waterLevel: 0, avoid });
    for (const p of pts)
      for (const a of avoid) expect(Math.hypot(p[0] - a[0], p[2] - a[2])).toBeGreaterThanOrEqual(14);
  });

  it('throws when there is no dry land at all', () => {
    expect(() => findSpawnPoints({ seed: 1, count: 2, heightAt: () => -1, waterLevel: 0 })).toThrow(
      /dry land/,
    );
  });
});

describe('spawnTeams', () => {
  it('interleaves teams and spreads every team over the island', () => {
    const list = spawnTeams({ seed: 11, teams: 4, wormsPerTeam: 4, heightAt: disc(55), waterLevel: 0 });
    expect(list.map((s) => s.team)).toEqual([0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3]);
    expect(minPairDist(list.map((s) => s.pos))).toBeGreaterThanOrEqual(SPAWN_MIN_SPACING);
    for (let t = 0; t < 4; t++) {
      const own = list.filter((s) => s.team === t).map((s) => s.pos);
      // Farthest-from-own-team assignment: a team's worms are well apart, not clumped in one corner.
      expect(minPairDist(own)).toBeGreaterThan(20);
    }
    expect(spawnTeams({ seed: 11, teams: 4, wormsPerTeam: 4, heightAt: disc(55), waterLevel: 0 })).toEqual(
      list,
    );
  });

  it('handles 0 worms', () => {
    expect(spawnTeams({ seed: 1, teams: 2, wormsPerTeam: 0, heightAt: disc(55), waterLevel: 0 })).toEqual([]);
  });
});
