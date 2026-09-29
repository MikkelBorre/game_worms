/**
 * Seeded island generation into a VoxelField.
 *
 * Determinism: all noise permutations come from core/rng (mulberry32) streams forked from the seed, and the
 * maths uses only + - * /, sqrt, floor and round (no sin/cos/exp/pow), which are exactly specified by IEEE-754,
 * so the same seed gives a bit-identical field on every JS engine.
 *
 * Shape: a warped radial distance gives "metres inland" from an irregular coastline; a coast profile (sand
 * beach or cliff) is combined with fBm hills, ridged noise, a few dome peaks, optional terraces and a flat
 * plateau (future village). The heightfield becomes an approximate signed distance (h - y) / |∇(h - y)|,
 * then 3D noise adds overhangs on steep ground and occasional tube caves under the hills.
 */
import { createNoise2D, createNoise3D, type NoiseFunction2D, type NoiseFunction3D } from 'simplex-noise';
import { Rng } from '../core/rng';
import * as T from './types';
import * as V from './voxels';
import { VoxelField, chunkIndex, quantize, sampleY } from './voxels';

// Module-local copies of hot constants (see voxels.ts).
const CHUNK_SIZE = T.CHUNK_SIZE;
const CHUNKS_X = T.CHUNKS_X;
const CHUNKS_Y = T.CHUNKS_Y;
const CHUNKS_Z = T.CHUNKS_Z;
const VOXEL_SIZE = T.VOXEL_SIZE;
const WORLD_MIN = { x: T.WORLD_MIN.x, y: T.WORLD_MIN.y, z: T.WORLD_MIN.z };
const DENSITY_MAX = V.DENSITY_MAX;
const Q_AIR = V.Q_AIR;
const Q_SOLID = V.Q_SOLID;
const SX = V.SX;
const SZ = V.SZ;

/** Tweakable island parameters (metres unless noted). */
export interface IslandParams {
  /** Mean coastline radius. */
  coastRadius: number;
  /** Coastline in/out variation along the shore. */
  coastJitter: number;
  /** Domain-warp amplitude that makes bays and headlands. */
  coastWarp: number;
  /** Width of the sand beach (from the waterline to the beach top). */
  beachWidth: number;
  /** Height of the beach top above water. */
  beachHeight: number;
  /** Horizontal width of the underwater shelf from the waterline down to seaFloor. */
  shelfWidth: number;
  seaFloor: number;
  /** Fraction-ish of the coast that is cliffs instead of beaches (0..1). */
  cliffAmount: number;
  cliffHeight: [number, number];
  /** Rolling hills amplitude and frequency (1/m). */
  hillHeight: number;
  hillFreq: number;
  /** Ridged-noise ridges amplitude and frequency. */
  ridgeHeight: number;
  ridgeFreq: number;
  peakCount: [number, number];
  peakHeight: [number, number];
  peakRadius: [number, number];
  /** Terrain above this is compressed softly towards maxHeight. */
  softCap: number;
  maxHeight: number;
  /** Terrace step height and how much of the island is terraced (0..1). */
  terraceStep: number;
  terraceAmount: number;
  /** Flat plateau for the village. */
  plateauRadius: number;
  plateauBlend: number;
  plateauHeight: [number, number];
  plateauDistance: [number, number];
  /** Cave tube frequency (1/m), tube radius (noise units) and how much of the island has caves (0..1). */
  caveFreq: number;
  caveRadius: number;
  caveAmount: number;
  /** Cave floors never go below this height; caves stay at least caveRoof below the surface. */
  caveMinY: number;
  caveRoof: number;
  /** Overhang noise amplitude on steep ground, and its frequency. */
  overhangAmp: number;
  overhangFreq: number;
}

export const DEFAULT_ISLAND: IslandParams = {
  coastRadius: 58,
  coastJitter: 7,
  coastWarp: 9,
  beachWidth: 9,
  beachHeight: 1.6,
  shelfWidth: 16,
  seaFloor: -6,
  cliffAmount: 0.35,
  cliffHeight: [5, 9],
  hillHeight: 9,
  hillFreq: 0.022,
  ridgeHeight: 7,
  ridgeFreq: 0.016,
  peakCount: [2, 3],
  peakHeight: [16, 26],
  peakRadius: [22, 32],
  softCap: 28,
  maxHeight: 37,
  terraceStep: 4,
  terraceAmount: 0.35,
  plateauRadius: 11,
  plateauBlend: 8,
  plateauHeight: [6, 9],
  plateauDistance: [18, 30],
  caveFreq: 0.035,
  caveRadius: 0.16,
  caveAmount: 0.55,
  caveMinY: 1.5,
  caveRoof: 1.5,
  overhangAmp: 1.5,
  overhangFreq: 0.12,
};

export interface IslandInfo {
  seed: number;
  /** Centre and height of the flat village plateau. */
  village: { x: number; z: number; y: number; radius: number };
  peaks: { x: number; z: number; height: number; radius: number }[];
}

const smooth = (e0: number, e1: number, x: number): number => {
  let t = (x - e0) / (e1 - e0);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

function fbm2(n: NoiseFunction2D, x: number, z: number, octaves: number): number {
  let s = 0;
  let a = 1;
  let f = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    s += a * n(x * f, z * f);
    norm += a;
    a *= 0.5;
    f *= 2.03;
  }
  return s / norm;
}

/** Ridged multifractal in [0,1]. */
function ridged2(n: NoiseFunction2D, x: number, z: number, octaves: number): number {
  let s = 0;
  let a = 1;
  let f = 1;
  let norm = 0;
  let prev = 1;
  for (let o = 0; o < octaves; o++) {
    let r = 1 - Math.abs(n(x * f, z * f));
    r *= r;
    s += a * r * prev;
    prev = r;
    norm += a;
    a *= 0.5;
    f *= 2.1;
  }
  return s / norm;
}

interface Noises {
  warpA: NoiseFunction2D;
  warpB: NoiseFunction2D;
  coast: NoiseFunction2D;
  cliff: NoiseFunction2D;
  hills: NoiseFunction2D;
  ridge: NoiseFunction2D;
  terrace: NoiseFunction2D;
  detail: NoiseFunction2D;
  caveMask: NoiseFunction2D;
  caveA: NoiseFunction3D;
  caveB: NoiseFunction3D;
  overhang: NoiseFunction3D;
}

function makeNoises(seed: number): Noises {
  const root = new Rng(seed);
  const n2 = (salt: number) => {
    const r = root.fork(salt);
    return createNoise2D(() => r.next());
  };
  const n3 = (salt: number) => {
    const r = root.fork(salt);
    return createNoise3D(() => r.next());
  };
  return {
    warpA: n2(101),
    warpB: n2(102),
    coast: n2(103),
    cliff: n2(104),
    hills: n2(105),
    ridge: n2(106),
    terrace: n2(107),
    detail: n2(108),
    caveMask: n2(109),
    caveA: n3(201),
    caveB: n3(202),
    overhang: n3(203),
  };
}

/** Pick the plateau site and peaks from the seed. */
function layout(seed: number, P: IslandParams): IslandInfo {
  const r = new Rng(seed).fork(300);
  // Rejection-sample points in a disc (avoids trig for engine-independent determinism).
  const inDisc = (rMin: number, rMax: number): [number, number] => {
    for (;;) {
      const x = r.range(-rMax, rMax);
      const z = r.range(-rMax, rMax);
      const d2 = x * x + z * z;
      if (d2 <= rMax * rMax && d2 >= rMin * rMin) return [x, z];
    }
  };
  const [vx, vz] = inDisc(P.plateauDistance[0], P.plateauDistance[1]);
  const village = { x: vx, z: vz, y: r.range(P.plateauHeight[0], P.plateauHeight[1]), radius: P.plateauRadius };
  const peaks: IslandInfo['peaks'] = [];
  const count = r.int(P.peakCount[0], P.peakCount[1]);
  let guard = 0;
  while (peaks.length < count && guard++ < 200) {
    const [x, z] = inDisc(0, 34);
    const dv = Math.sqrt((x - vx) * (x - vx) + (z - vz) * (z - vz));
    if (dv < P.plateauRadius + P.plateauBlend + 12) continue;
    if (peaks.some((p) => (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z) < 20 * 20)) continue;
    peaks.push({
      x,
      z,
      height: r.range(P.peakHeight[0], P.peakHeight[1]),
      radius: r.range(P.peakRadius[0], P.peakRadius[1]),
    });
  }
  return { seed, village, peaks };
}

/** Surface height (m) of the island at (x, z), before caves/overhangs. Also returns cave/overhang masks. */
function surface(
  x: number,
  z: number,
  N: Noises,
  P: IslandParams,
  info: IslandInfo,
): { h: number; caveMask: number } {
  // Warped radial distance -> metres inland from the coastline.
  const wx = x + P.coastWarp * fbm2(N.warpA, x * 0.012, z * 0.012, 2);
  const wz = z + P.coastWarp * fbm2(N.warpB, x * 0.012 + 17.3, z * 0.012 - 9.1, 2);
  const dist = Math.sqrt(wx * wx + wz * wz);
  const inv = dist > 1e-6 ? 1 / dist : 0;
  const dx = wx * inv;
  const dz = wz * inv;
  const coastR = P.coastRadius + P.coastJitter * fbm2(N.coast, dx * 1.4 + 3.1, dz * 1.4 - 7.7, 3);
  const inland = coastR - dist;

  // Coast profiles.
  const cliffMask = smooth(0.55 - P.cliffAmount, 0.8 - P.cliffAmount, N.cliff(dx * 1.2 + 11, dz * 1.2 - 4));
  const cliffH = lerp(P.cliffHeight[0], P.cliffHeight[1], 0.5 + 0.5 * N.cliff(x * 0.03, z * 0.03));
  let beach: number;
  let cliff: number;
  if (inland < 0) {
    beach = P.seaFloor * smooth(0, P.shelfWidth, -inland);
    cliff = P.seaFloor * smooth(0, P.shelfWidth * 0.4, -inland);
  } else {
    beach = P.beachHeight * smooth(0, P.beachWidth, inland);
    cliff = cliffH * smooth(0, 3, inland);
  }

  // Inland relief.
  const hills = P.hillHeight * (0.5 + 0.5 * fbm2(N.hills, x * P.hillFreq, z * P.hillFreq, 5));
  const ridge = ridged2(N.ridge, x * P.ridgeFreq + 5.2, z * P.ridgeFreq - 1.3, 4);
  let peaks = 0;
  for (const p of info.peaks) {
    const ex = x - p.x;
    const ez = z - p.z;
    // Slightly noisy radius so peaks are not perfect domes.
    const rr = p.radius * (1 + 0.25 * N.detail(x * 0.05 + p.x, z * 0.05 + p.z));
    const t2 = (ex * ex + ez * ez) / (rr * rr);
    if (t2 < 1) {
      const k = 1 - t2;
      peaks += p.height * k * k;
    }
  }
  let land = hills + P.ridgeHeight * ridge + peaks * (0.7 + 0.45 * ridge);

  // Terraces -> inland cliffs in some regions.
  const tMask = smooth(0.55 - P.terraceAmount, 0.85 - P.terraceAmount, N.terrace(x * 0.014, z * 0.014));
  if (tMask > 0) {
    const s = land / P.terraceStep;
    const k = Math.floor(s);
    const stepped = (k + smooth(0.35, 0.65, s - k)) * P.terraceStep;
    land = lerp(land, stepped, tMask);
  }

  const inlandMask = smooth(P.beachWidth * 0.5, P.beachWidth + 24, inland);
  let h = beach + inlandMask * land;
  // Cliff coasts: a steep wall up to a shelf that fades back into the normal relief further inland,
  // so the cliff sectors never leave a step towards the beach sectors in the island interior.
  if (cliffMask > 0) {
    const shelf = inland < 0 ? cliff : Math.max(h, cliff * (1 - smooth(10, 26, inland)));
    h = lerp(h, shelf, cliffMask);
  }

  // Soft cap.
  if (h > P.softCap) {
    const room = P.maxHeight - P.softCap;
    const e = h - P.softCap;
    h = P.softCap + e / (1 + e / room);
  }

  // Village plateau.
  const vx = x - info.village.x;
  const vz = z - info.village.z;
  const vd = Math.sqrt(vx * vx + vz * vz);
  const pw = smooth(P.plateauRadius + P.plateauBlend, P.plateauRadius, vd);
  if (pw > 0) h = lerp(h, info.village.y + 0.25 * N.detail(x * 0.1, z * 0.1), pw);

  // Small sea-floor variation (keeps the shoreline itself untouched).
  if (h < -0.5) h += 0.6 * N.detail(x * 0.06 + 40, z * 0.06) * smooth(-0.5, -2, h);

  // Safety: the island never reaches the edge of the voxel volume.
  const edge = 80 - Math.max(Math.abs(x), Math.abs(z));
  if (edge < 12) h = Math.min(h, P.seaFloor + (edge / 12) * (-1 - P.seaFloor));

  const caveMask =
    smooth(0.6 - P.caveAmount, 0.85 - P.caveAmount, N.caveMask(x * 0.02 - 8, z * 0.02 + 3)) * smooth(7, 11, h) * (1 - pw);
  return { h, caveMask };
}

export interface GenerateResult {
  field: VoxelField;
  info: IslandInfo;
  /** Wall-clock breakdown (ms); informational only, never feeds back into the field. */
  timings: { heightfieldMs: number; fillMs: number; columnsMs: number };
}

/** Build the full density field for a seed. Pure and deterministic. */
export function generateIsland(seed: number, params: Partial<IslandParams> = {}): GenerateResult {
  const P: IslandParams = { ...DEFAULT_ISLAND, ...params };
  const N = makeNoises(seed);
  const info = layout(seed, P);
  const field = new VoxelField();
  const t0 = performance.now();

  // Heightfield with a 1-sample border (for gradients).
  const HW = SX + 2;
  const HD = SZ + 2;
  const H = new Float32Array(HW * HD);
  const CAVE = new Float32Array(SX * SZ);
  for (let k = -1; k <= SZ; k++)
    for (let i = -1; i <= SX; i++) {
      const s = surface(WORLD_MIN.x + i * VOXEL_SIZE, WORLD_MIN.z + k * VOXEL_SIZE, N, P, info);
      H[i + 1 + (k + 1) * HW] = s.h;
      if (i >= 0 && k >= 0 && i < SX && k < SZ) CAVE[i + k * SX] = s.caveMask;
    }

  const t1 = performance.now();
  const CS = CHUNK_SIZE;
  const buf = new Int8Array(CS * CS * CS);
  const cf = P.caveFreq;
  const cfy = cf * 1.6; // flatter, more walkable tunnels
  const caveToMetres = 1 / (2.2 * cf);
  const of = P.overhangFreq;
  // Per chunk-column scratch.
  const colH = new Float32Array(CS * CS);
  const colInv = new Float32Array(CS * CS);
  const colAmp = new Float32Array(CS * CS);
  const colCave = new Float32Array(CS * CS);
  // 3D noise is evaluated on a coarse lattice (every LAT samples) and trilinearly interpolated.
  const LAT = 2;
  const LN = CS / LAT + 1;
  const latA = new Float32Array(LN * LN * LN);
  const latB = new Float32Array(LN * LN * LN);
  const latO = new Float32Array(LN * LN * LN);
  const fillLattice = (
    out: Float32Array,
    n: NoiseFunction3D,
    cx: number,
    cy: number,
    cz: number,
    fx: number,
    fy: number,
  ) => {
    let o = 0;
    for (let z = 0; z < LN; z++) {
      const wz = (WORLD_MIN.z + (cz * CS + z * LAT) * VOXEL_SIZE) * fx;
      for (let y = 0; y < LN; y++) {
        const wy = sampleY(cy * CS + y * LAT) * fy;
        for (let x = 0; x < LN; x++) out[o++] = n((WORLD_MIN.x + (cx * CS + x * LAT) * VOXEL_SIZE) * fx, wy, wz);
      }
    }
  };
  // Trilinear lookup at chunk-local sample (lx, ly, lz); LAT = 2 so weights are 0 or 0.5.
  const lat = (arr: Float32Array, lx: number, ly: number, lz: number): number => {
    const gx = lx >> 1;
    const gy = ly >> 1;
    const gz = lz >> 1;
    const b = gx + LN * (gy + LN * gz);
    const tx = (lx & 1) * 0.5;
    const ty = (ly & 1) * 0.5;
    const tz = (lz & 1) * 0.5;
    const c00 = arr[b]! + (arr[b + 1]! - arr[b]!) * tx;
    const c10 = arr[b + LN]! + (arr[b + LN + 1]! - arr[b + LN]!) * tx;
    const b2 = b + LN * LN;
    const c01 = arr[b2]! + (arr[b2 + 1]! - arr[b2]!) * tx;
    const c11 = arr[b2 + LN]! + (arr[b2 + LN + 1]! - arr[b2 + LN]!) * tx;
    const c0 = c00 + (c10 - c00) * ty;
    const c1 = c01 + (c11 - c01) * ty;
    return c0 + (c1 - c0) * tz;
  };

  for (let cz = 0; cz < CHUNKS_Z; cz++)
    for (let cx = 0; cx < CHUNKS_X; cx++) {
      // Column data shared by the chunks of this chunk-column, plus the y extents that need 3D noise.
      let overLo = Infinity;
      let overHi = -Infinity;
      let caveLo = Infinity;
      let caveHi = -Infinity;
      for (let lz = 0; lz < CS; lz++)
        for (let lx = 0; lx < CS; lx++) {
          const i = cx * CS + lx;
          const k = cz * CS + lz;
          const hi = i + 1 + (k + 1) * HW;
          const h = H[hi]!;
          const gx = (H[hi + 1]! - H[hi - 1]!) / (2 * VOXEL_SIZE);
          const gz = (H[hi + HW]! - H[hi - HW]!) / (2 * VOXEL_SIZE);
          const g2 = gx * gx + gz * gz;
          const c = lx + lz * CS;
          const inv = 1 / Math.sqrt(1 + g2);
          const amp = P.overhangAmp * smooth(1.2, 2.6, Math.sqrt(g2));
          colH[c] = h;
          colInv[c] = inv;
          colAmp[c] = amp;
          colCave[c] = P.caveRadius * CAVE[i + k * SX]!;
          if (amp > 0) {
            const reach = (DENSITY_MAX + amp + 0.25) / inv;
            if (h - reach < overLo) overLo = h - reach;
            if (h + reach > overHi) overHi = h + reach;
          }
          if (colCave[c]! > 0) {
            if (P.caveMinY - 3 < caveLo) caveLo = P.caveMinY - 3;
            if (h - P.caveRoof + 1 > caveHi) caveHi = h - P.caveRoof + 1;
          }
        }
      for (let cy = 0; cy < CHUNKS_Y; cy++) {
        const y0 = sampleY(cy * CS);
        const y1 = sampleY(cy * CS + CS - 1);
        const needOver = overHi >= y0 && overLo <= y1;
        const needCave = caveHi >= y0 && caveLo <= y1;
        if (needOver) fillLattice(latO, N.overhang, cx, cy, cz, of, of);
        if (needCave) {
          fillLattice(latA, N.caveA, cx, cy, cz, cf, cfy);
          fillLattice(latB, N.caveB, cx, cy, cz, cf, cfy);
        }
        for (let lz = 0; lz < CS; lz++)
          for (let lx = 0; lx < CS; lx++) {
            const c = lx + lz * CS;
            const h = colH[c]!;
            const invNorm = colInv[c]!;
            const amp = needOver ? colAmp[c]! : 0;
            const caveR = needCave ? colCave[c]! : 0;
            const band = DENSITY_MAX + amp + 0.25;
            for (let ly = 0; ly < CS; ly++) {
              const y = y0 + ly * VOXEL_SIZE;
              let d = (h - y) * invNorm;
              const o = lx + (ly << 5) + (lz << 10);
              const inCaveZone = caveR > 0 && y > P.caveMinY - 3 && y < h - P.caveRoof + 1;
              if (!inCaveZone) {
                if (d > band) {
                  buf[o] = Q_SOLID;
                  continue;
                }
                if (d < -band) {
                  buf[o] = Q_AIR;
                  continue;
                }
              }
              if (amp > 0 && d < band && d > -band) d += amp * lat(latO, lx, ly, lz);
              if (inCaveZone) {
                const a = lat(latA, lx, ly, lz);
                const b = lat(latB, lx, ly, lz);
                let cv = (Math.sqrt(a * a + b * b) - caveR) * caveToMetres;
                const floor = P.caveMinY - y;
                const roof = y - (h - P.caveRoof);
                if (floor > cv) cv = floor;
                if (roof > cv) cv = roof;
                if (cv < d) d = cv;
              }
              buf[o] = quantize(d);
            }
          }
        field.setChunk(chunkIndex(cx, cy, cz), buf.slice());
      }
    }
  const t2 = performance.now();
  field.updateColumns(0, SX - 1, 0, SZ - 1);
  const t3 = performance.now();
  return { field, info, timings: { heightfieldMs: t1 - t0, fillMs: t2 - t1, columnsMs: t3 - t2 } };
}
