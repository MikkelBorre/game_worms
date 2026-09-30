/**
 * Deterministic spawn placement on the island (GDD: "Spawn spredt over hele øen").
 *
 * Pure functions: terrain is only seen through `heightAt`, so this works headless, in tests and in the
 * game alike. Only seeded RNG and IEEE-exact arithmetic (+ - * / sqrt) are used on the placement path, so
 * every peer computes the same spawns from the same seed and terrain.
 */
import type { Vec3 } from '../core/math';
import { Rng } from '../core/rng';
import { WORLD_MIN, WORLD_SIZE } from '../terrain/types';
import { WORM_CENTER_TO_FEET } from './worm';

// ---------------------------------------------------------------------------
// Balance constants – tweak here.
// ---------------------------------------------------------------------------

/** Default minimum distance (m, XZ) between spawn points. Relaxed automatically if the island is too small. */
export const SPAWN_MIN_SPACING = 14;
/** Default max ground slope (degrees) at a spawn point, measured against neighbours ±SPAWN_SLOPE_PROBE m away. */
export const SPAWN_MAX_SLOPE_DEG = 30;
/** Neighbour distance (m) for the slope estimate. */
export const SPAWN_SLOPE_PROBE = 1;
/** Spawn surface must be at least this far above the water level (m). */
export const SPAWN_MIN_ABOVE_WATER = 1.5;
/** Worms are dropped from this far above standing height so they settle onto the ground (m). */
export const SPAWN_DROP = 0.6;
/** Random candidate columns tried per spawn search. */
export const SPAWN_CANDIDATES = 4000;
/** Each relaxation step multiplies the spacing by this factor. */
export const SPAWN_RELAX = 0.8;
/** Keep spawns this far inside the voxel volume (m). */
const BOUNDS_MARGIN = 3;

// ---------------------------------------------------------------------------

export interface SpawnBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface SpawnOptions {
  /** Match/terrain seed; spawns use their own forked stream, so the sim RNG is untouched. */
  seed: number;
  count: number;
  /** Highest solid surface y at (x, z); ≤ WORLD_MIN.y where there is no terrain (TerrainSystem.heightAt). */
  heightAt: (x: number, z: number) => number;
  waterLevel: number;
  /** Minimum XZ distance between points (m). Default SPAWN_MIN_SPACING. */
  minSpacing?: number;
  /** Max slope (deg) at a spawn. Default SPAWN_MAX_SLOPE_DEG. */
  maxSlopeDeg?: number;
  /** XZ search area. Default: the whole voxel volume minus a small margin. */
  bounds?: SpawnBounds;
  /** Existing positions to keep `minSpacing` away from (e.g. worms already on the map, crates). */
  avoid?: Vec3[];
}

export interface SpawnResult {
  /** Worm centre positions (surface + WORM_CENTER_TO_FEET + SPAWN_DROP). */
  points: Vec3[];
  /**
   * Spacing actually guaranteed between points (and `avoid`): `minSpacing`, or less if it had to be relaxed.
   * 0 means even the relaxed search failed and some points are on steep ground or closer than 1 m.
   */
  spacing: number;
}

export interface TeamSpawn {
  team: number;
  pos: Vec3;
}

export const DEFAULT_SPAWN_BOUNDS: SpawnBounds = {
  minX: WORLD_MIN.x + BOUNDS_MARGIN,
  maxX: WORLD_MIN.x + WORLD_SIZE.x - BOUNDS_MARGIN,
  minZ: WORLD_MIN.z + BOUNDS_MARGIN,
  maxZ: WORLD_MIN.z + WORLD_SIZE.z - BOUNDS_MARGIN,
};

/** Salt for the spawn RNG stream (fork of the match seed). */
const SPAWN_RNG_SALT = 0x5b4a;

interface Candidate {
  x: number;
  z: number;
  /** Surface height. */
  h: number;
}

/**
 * Pick `count` spawn points on dry, walkable land, spread out over the island.
 *
 * Algorithm: SPAWN_CANDIDATES random columns in `bounds` → keep those whose surface is ≥ water + 1.5 m and
 * whose slope (steepest of the four one-sided differences at ±1 m) is ≤ maxSlopeDeg → dart-throw through
 * them in random order, accepting a candidate only if it is ≥ spacing from every accepted point and every
 * `avoid` point. If fewer than `count` fit, spacing is multiplied by SPAWN_RELAX and the pass repeated
 * (already accepted points are kept). As a last resort, steep dry land is allowed too.
 * Unlike farthest-point sampling this does not push everyone onto the beaches.
 */
export function findSpawnPointsDetailed(opts: SpawnOptions): SpawnResult {
  const count = Math.max(0, Math.floor(opts.count));
  const minSpacing = opts.minSpacing ?? SPAWN_MIN_SPACING;
  const maxSlopeDeg = opts.maxSlopeDeg ?? SPAWN_MAX_SLOPE_DEG;
  const b = opts.bounds ?? DEFAULT_SPAWN_BOUNDS;
  const avoid = opts.avoid ?? [];
  const minSurface = opts.waterLevel + SPAWN_MIN_ABOVE_WATER;
  const noTerrain = WORLD_MIN.y + 1e-3;
  // Rounded so a last-ulp difference in Math.tan between JS engines cannot change the result.
  const maxRise =
    (Math.round(Math.tan((Math.min(89, Math.max(0, maxSlopeDeg)) * Math.PI) / 180) * 1e6) / 1e6) *
    SPAWN_SLOPE_PROBE;

  const rng = new Rng(opts.seed).fork(SPAWN_RNG_SALT);
  const flat: Candidate[] = [];
  const steep: Candidate[] = [];
  const P = SPAWN_SLOPE_PROBE;
  for (let i = 0; i < SPAWN_CANDIDATES; i++) {
    const x = rng.range(b.minX, b.maxX);
    const z = rng.range(b.minZ, b.maxZ);
    const h = opts.heightAt(x, z);
    if (!(h >= minSurface) || h <= noTerrain) continue;
    let rise = 0;
    let dry = true;
    for (const [dx, dz] of NEIGHBOURS) {
      const hn = opts.heightAt(x + dx * P, z + dz * P);
      if (!(hn >= minSurface)) dry = false;
      const d = hn > h ? hn - h : h - hn;
      if (d > rise) rise = d;
    }
    // Neighbours in the water ⇒ right at the shoreline; only good enough as a last resort.
    (dry && rise <= maxRise ? flat : steep).push({ x, z, h });
  }

  const placed: Candidate[] = [];
  const taken = new Set<Candidate>();
  const fits = (c: Candidate, s2: number): boolean => {
    for (const p of placed) if (dist2(p.x, p.z, c.x, c.z) < s2) return false;
    for (const a of avoid) if (dist2(a[0], a[2], c.x, c.z) < s2) return false;
    return true;
  };
  const pass = (pool: Candidate[], spacing: number) => {
    const s2 = spacing * spacing;
    for (const c of pool) {
      if (placed.length >= count) return;
      if (taken.has(c) || !fits(c, s2)) continue;
      placed.push(c);
      taken.add(c);
    }
  };

  let spacing = minSpacing;
  for (;;) {
    pass(flat, spacing);
    if (placed.length >= count || spacing < 1) break;
    spacing *= SPAWN_RELAX;
  }
  if (placed.length < count) {
    // Tiny or very rugged island: allow steep dry land and the shoreline, spacing ≥ 1 m if possible.
    spacing = 0;
    pass(steep, 1);
    pass(flat, 0);
    pass(steep, 0);
  }
  if (placed.length < count)
    throw new Error(`findSpawnPoints: only ${placed.length}/${count} spawn points on dry land`);

  const lift = WORM_CENTER_TO_FEET + SPAWN_DROP;
  return { points: placed.map((c) => [c.x, c.h + lift, c.z] as Vec3), spacing };
}

/** See findSpawnPointsDetailed. Throws if the island has fewer dry candidate columns than `count`. */
export function findSpawnPoints(opts: SpawnOptions): Vec3[] {
  return findSpawnPointsDetailed(opts).points;
}

/**
 * Spawn points for `teams × wormsPerTeam` worms, returned interleaved (team 0, 1, …, teams-1, 0, 1, …) —
 * the order worms should be spawned in. Each team's worms are spread over the island: after the first
 * round, every team in turn takes the free point farthest from its own worms.
 */
export function spawnTeams(
  opts: Omit<SpawnOptions, 'count'> & { teams: number; wormsPerTeam: number },
): TeamSpawn[] {
  const teams = Math.max(0, Math.floor(opts.teams));
  const per = Math.max(0, Math.floor(opts.wormsPerTeam));
  const points = findSpawnPoints({ ...opts, count: teams * per });
  const free = points.map((_, i) => i);
  const own: Vec3[][] = Array.from({ length: teams }, () => []);
  const out: TeamSpawn[] = [];
  for (let round = 0; round < per; round++) {
    for (let team = 0; team < teams; team++) {
      let best = 0;
      if (round > 0) {
        let bestD = -1;
        for (let k = 0; k < free.length; k++) {
          const p = points[free[k]!]!;
          let d = Infinity;
          for (const q of own[team]!) d = Math.min(d, dist2(p[0], p[2], q[0], q[2]));
          if (d > bestD) {
            bestD = d;
            best = k;
          }
        }
      }
      // Round 0 takes points in (random) placement order.
      const pos = points[free[best]!]!;
      free.splice(best, 1);
      own[team]!.push(pos);
      out.push({ team, pos });
    }
  }
  return out;
}

const NEIGHBOURS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

function dist2(ax: number, az: number, bx: number, bz: number): number {
  const dx = ax - bx;
  const dz = az - bz;
  return dx * dx + dz * dz;
}
