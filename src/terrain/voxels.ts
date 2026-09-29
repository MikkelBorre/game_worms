/**
 * Chunked voxel density field.
 *
 * Samples live on a regular grid (spacing VOXEL_SIZE) starting at WORLD_MIN. Chunk (cx,cy,cz) owns the
 * CHUNK_SIZE³ samples [c*32, c*32+32) per axis; its mesh covers the CHUNK_SIZE³ cells whose min corner is
 * an owned sample, so meshing needs samples [c*32-1, c*32+33] (one sample of padding beyond the 33 corner
 * samples, for gradient normals). Out-of-range sample indices are clamped to the grid edge.
 *
 * Storage: density in metres (≈ signed distance, > 0 = solid) quantised to Int8 at DENSITY_SCALE steps per
 * metre, clamped to ±127 and never 0 (sign is always well defined, which keeps MC vertices off corners).
 * Chunks whose samples are all identical (fully air / fully solid far from the surface) keep no array.
 *
 * No three.js in here.
 */
import * as T from './types';
import type { ChunkCoord } from './types';

// Module-local copies: hot loops must not go through (possibly getter-based) import bindings.
const CHUNK_SIZE = T.CHUNK_SIZE;
const CHUNKS_X = T.CHUNKS_X;
const CHUNKS_Y = T.CHUNKS_Y;
const CHUNKS_Z = T.CHUNKS_Z;
const VOXEL_SIZE = T.VOXEL_SIZE;
const WORLD_MIN = { x: T.WORLD_MIN.x, y: T.WORLD_MIN.y, z: T.WORLD_MIN.z };

/** Quantisation steps per metre of density. */
export const DENSITY_SCALE = 32;
/** Largest representable |density| in metres. */
export const DENSITY_MAX = 127 / DENSITY_SCALE;
export const Q_AIR = -127;
export const Q_SOLID = 127;

/** Samples per axis for the whole world. */
export const SX = CHUNKS_X * CHUNK_SIZE;
export const SY = CHUNKS_Y * CHUNK_SIZE;
export const SZ = CHUNKS_Z * CHUNK_SIZE;

/** Padded chunk edge in samples: 1 + 33 + 1. */
export const PAD = CHUNK_SIZE + 3;
export const PAD3 = PAD * PAD * PAD;
const CS = CHUNK_SIZE;
const CS3 = CS * CS * CS;
export const CHUNK_COUNT = CHUNKS_X * CHUNKS_Y * CHUNKS_Z;

/** How far (m) outside a sphere an edit still rewrites density (keeps gradients sane near the new surface). */
export const EDIT_BAND = 1.5;

/** Quantise a density in metres. Never returns 0. */
export function quantize(d: number): number {
  const q = Math.round(d * DENSITY_SCALE);
  if (d > 0) return q > 127 ? 127 : q < 1 ? 1 : q;
  return q < -127 ? -127 : q > -1 ? -1 : q;
}

export const chunkIndex = (cx: number, cy: number, cz: number): number =>
  cx + CHUNKS_X * (cy + CHUNKS_Y * cz);

export function chunkCoordOf(index: number): ChunkCoord {
  const cx = index % CHUNKS_X;
  const r = (index - cx) / CHUNKS_X;
  const cy = r % CHUNKS_Y;
  const cz = (r - cy) / CHUNKS_Y;
  return { cx, cy, cz };
}

/** World position of global sample index along an axis. */
export const sampleX = (i: number): number => WORLD_MIN.x + i * VOXEL_SIZE;
export const sampleY = (j: number): number => WORLD_MIN.y + j * VOXEL_SIZE;
export const sampleZ = (k: number): number => WORLD_MIN.z + k * VOXEL_SIZE;

const clampI = (v: number, hi: number): number => (v < 0 ? 0 : v > hi ? hi : v);

export interface EditResult {
  /** Chunks whose padded mesher input changed (sorted by chunk index). */
  dirty: ChunkCoord[];
  /** Inclusive changed-sample bounds, or null if nothing changed. */
  bounds: { i0: number; i1: number; j0: number; j1: number; k0: number; k1: number } | null;
}

export class VoxelField {
  /** Per-chunk samples (x fastest, then y, then z) or null when uniform. */
  readonly chunks: (Int8Array | null)[] = new Array<Int8Array | null>(CHUNK_COUNT).fill(null);
  /** Value of every sample of a uniform chunk (only meaningful when chunks[i] is null). */
  readonly uniform = new Int8Array(CHUNK_COUNT).fill(Q_AIR);
  /** Highest solid surface y per sample column (x + z * SX), metres. */
  readonly columnTop = new Float32Array(SX * SZ).fill(WORLD_MIN.y);

  /** Store a fully-filled chunk array; collapses it to a uniform value if possible. */
  setChunk(index: number, data: Int8Array): void {
    const v = data[0]!;
    let same = true;
    for (let i = 1; i < CS3; i++)
      if (data[i] !== v) {
        same = false;
        break;
      }
    if (same) {
      this.chunks[index] = null;
      this.uniform[index] = v;
    } else this.chunks[index] = data;
  }

  /** Raw quantised sample at global indices (clamped to the grid). */
  get(i: number, j: number, k: number): number {
    i = clampI(i, SX - 1);
    j = clampI(j, SY - 1);
    k = clampI(k, SZ - 1);
    const cx = i >> 5;
    const cy = j >> 5;
    const cz = k >> 5;
    const ci = chunkIndex(cx, cy, cz);
    const a = this.chunks[ci];
    if (!a) return this.uniform[ci]!;
    return a[(i & 31) + ((j & 31) << 5) + ((k & 31) << 10)]!;
  }

  /** Density in metres at global sample indices. */
  density(i: number, j: number, k: number): number {
    return this.get(i, j, k) / DENSITY_SCALE;
  }

  /** Trilinear density (metres) at a world position. Outside the volume the edge value is used. */
  densityAt(x: number, y: number, z: number): number {
    const fx = (x - WORLD_MIN.x) / VOXEL_SIZE;
    const fy = (y - WORLD_MIN.y) / VOXEL_SIZE;
    const fz = (z - WORLD_MIN.z) / VOXEL_SIZE;
    const i = Math.floor(fx);
    const j = Math.floor(fy);
    const k = Math.floor(fz);
    const tx = fx - i;
    const ty = fy - j;
    const tz = fz - k;
    const g = (a: number, b: number, c: number) => this.get(a, b, c);
    const c00 = g(i, j, k) * (1 - tx) + g(i + 1, j, k) * tx;
    const c10 = g(i, j + 1, k) * (1 - tx) + g(i + 1, j + 1, k) * tx;
    const c01 = g(i, j, k + 1) * (1 - tx) + g(i + 1, j, k + 1) * tx;
    const c11 = g(i, j + 1, k + 1) * (1 - tx) + g(i + 1, j + 1, k + 1) * tx;
    const c0 = c00 * (1 - ty) + c10 * ty;
    const c1 = c01 * (1 - ty) + c11 * ty;
    return (c0 * (1 - tz) + c1 * tz) / DENSITY_SCALE;
  }

  /** Materialise a uniform chunk into an array so it can be edited. */
  private writable(ci: number): Int8Array {
    let a = this.chunks[ci];
    if (!a) {
      a = new Int8Array(CS3).fill(this.uniform[ci]!);
      this.chunks[ci] = a;
    }
    return a;
  }

  /**
   * True when the padded mesher input of chunk c is guaranteed to have one sign everywhere, judged from
   * uniform chunks only (cheap; may return false for chunks that turn out empty).
   */
  isTriviallyEmpty(c: ChunkCoord): boolean {
    let sign = 0;
    for (let dz = -1; dz <= 1; dz++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const x = c.cx + dx;
          const y = c.cy + dy;
          const z = c.cz + dz;
          if (x < 0 || y < 0 || z < 0 || x >= CHUNKS_X || y >= CHUNKS_Y || z >= CHUNKS_Z) continue;
          const ci = chunkIndex(x, y, z);
          if (this.chunks[ci]) return false;
          const s = this.uniform[ci]! > 0 ? 1 : -1;
          if (sign === 0) sign = s;
          else if (s !== sign) return false;
        }
    return true;
  }

  /**
   * Copy the padded (PAD³) mesher input for chunk c into out. Layout: x fastest, then y, then z;
   * padded index p corresponds to global sample c*32 - 1 + p.
   */
  extractPadded(c: ChunkCoord, out: Int8Array = new Int8Array(PAD3)): Int8Array {
    const bx = c.cx * CS - 1;
    const by = c.cy * CS - 1;
    const bz = c.cz * CS - 1;
    for (let pz = 0; pz < PAD; pz++) {
      const k = clampI(bz + pz, SZ - 1);
      const cz = k >> 5;
      const lz = (k & 31) << 10;
      for (let py = 0; py < PAD; py++) {
        const j = clampI(by + py, SY - 1);
        const cy = j >> 5;
        const lyz = lz + ((j & 31) << 5);
        const rowOut = (pz * PAD + py) * PAD;
        // Walk the x row in runs that stay inside one source chunk.
        let px = 0;
        while (px < PAD) {
          const iRaw = bx + px;
          if (iRaw < 0 || iRaw >= SX) {
            out[rowOut + px] = this.get(iRaw, j, k);
            px++;
            continue;
          }
          const lx0 = iRaw & 31;
          let run = CS - lx0;
          if (run > PAD - px) run = PAD - px;
          if (run > SX - iRaw) run = SX - iRaw;
          const ci = chunkIndex(iRaw >> 5, cy, cz);
          const a = this.chunks[ci];
          const o = rowOut + px;
          if (a) {
            const src = lyz + lx0;
            for (let n = 0; n < run; n++) out[o + n] = a[src + n]!;
          } else {
            const u = this.uniform[ci]!;
            for (let n = 0; n < run; n++) out[o + n] = u;
          }
          px += run;
        }
      }
    }
    return out;
  }

  /** Copy column-top heights over the padded xz footprint of chunk c (PAD², x fastest). */
  extractColumnTops(c: ChunkCoord, out: Float32Array = new Float32Array(PAD * PAD)): Float32Array {
    const bx = c.cx * CS - 1;
    const bz = c.cz * CS - 1;
    for (let pz = 0; pz < PAD; pz++) {
      const k = clampI(bz + pz, SZ - 1);
      for (let px = 0; px < PAD; px++) out[pz * PAD + px] = this.columnTop[clampI(bx + px, SX - 1) + k * SX]!;
    }
    return out;
  }

  /** Remove terrain inside a sphere. */
  carveSphere(center: readonly [number, number, number], radius: number): EditResult {
    return this.editSphere(center, radius, false);
  }

  /** Add terrain inside a sphere. */
  addSphere(center: readonly [number, number, number], radius: number): EditResult {
    return this.editSphere(center, radius, true);
  }

  private editSphere(center: readonly [number, number, number], radius: number, add: boolean): EditResult {
    const [cxw, cyw, czw] = center;
    const reach = radius + EDIT_BAND;
    const i0 = Math.max(0, Math.ceil((cxw - reach - WORLD_MIN.x) / VOXEL_SIZE));
    const i1 = Math.min(SX - 1, Math.floor((cxw + reach - WORLD_MIN.x) / VOXEL_SIZE));
    const j0 = Math.max(0, Math.ceil((cyw - reach - WORLD_MIN.y) / VOXEL_SIZE));
    const j1 = Math.min(SY - 1, Math.floor((cyw + reach - WORLD_MIN.y) / VOXEL_SIZE));
    const k0 = Math.max(0, Math.ceil((czw - reach - WORLD_MIN.z) / VOXEL_SIZE));
    const k1 = Math.min(SZ - 1, Math.floor((czw + reach - WORLD_MIN.z) / VOXEL_SIZE));
    let mi0 = Infinity;
    let mi1 = -Infinity;
    let mj0 = Infinity;
    let mj1 = -Infinity;
    let mk0 = Infinity;
    let mk1 = -Infinity;
    const reach2 = reach * reach;
    const mark = new Uint8Array(CHUNK_COUNT);
    for (let k = k0; k <= k1; k++) {
      const dz = sampleZ(k) - czw;
      const cz = k >> 5;
      for (let j = j0; j <= j1; j++) {
        const dy = sampleY(j) - cyw;
        const dyz2 = dy * dy + dz * dz;
        if (dyz2 > reach2) continue;
        const cy = j >> 5;
        for (let i = i0; i <= i1; i++) {
          const dx = sampleX(i) - cxw;
          const d2 = dx * dx + dyz2;
          if (d2 > reach2) continue;
          const s = Math.sqrt(d2) - radius; // sphere SDF, > 0 outside
          const ci = chunkIndex(i >> 5, cy, cz);
          const arr = this.chunks[ci];
          const li = (i & 31) + ((j & 31) << 5) + ((k & 31) << 10);
          const old = arr ? arr[li]! : this.uniform[ci]!;
          let nv: number;
          if (add) {
            const q = quantize(-s);
            nv = q > old ? q : old;
          } else {
            const q = quantize(s);
            nv = q < old ? q : old;
          }
          if (nv === old) continue;
          this.writable(ci)[li] = nv;
          // Mark every chunk whose padded input reads this sample.
          const xlo = readerLo(i);
          const xhi = readerHi(i, CHUNKS_X);
          const ylo = readerLo(j);
          const yhi = readerHi(j, CHUNKS_Y);
          const zlo = readerLo(k);
          const zhi = readerHi(k, CHUNKS_Z);
          for (let rz = zlo; rz <= zhi; rz++)
            for (let ry = ylo; ry <= yhi; ry++)
              for (let rx = xlo; rx <= xhi; rx++) mark[chunkIndex(rx, ry, rz)] = 1;
          if (i < mi0) mi0 = i;
          if (i > mi1) mi1 = i;
          if (j < mj0) mj0 = j;
          if (j > mj1) mj1 = j;
          if (k < mk0) mk0 = k;
          if (k > mk1) mk1 = k;
        }
      }
    }
    if (mi0 === Infinity) return { dirty: [], bounds: null };
    const bounds = { i0: mi0, i1: mi1, j0: mj0, j1: mj1, k0: mk0, k1: mk1 };
    // Collapse chunks that became uniform (e.g. a fully carved chunk).
    for (let cz = mk0 >> 5; cz <= mk1 >> 5; cz++)
      for (let cy = mj0 >> 5; cy <= mj1 >> 5; cy++)
        for (let cx = mi0 >> 5; cx <= mi1 >> 5; cx++) {
          const ci = chunkIndex(cx, cy, cz);
          const a = this.chunks[ci];
          if (a) this.setChunk(ci, a);
        }
    this.updateColumns(mi0, mi1, mk0, mk1);
    const dirty: ChunkCoord[] = [];
    for (let ci = 0; ci < CHUNK_COUNT; ci++) if (mark[ci]) dirty.push(chunkCoordOf(ci));
    return { dirty, bounds };
  }

  /** Recompute columnTop for columns i0..i1 × k0..k1 (inclusive). */
  updateColumns(i0: number, i1: number, k0: number, k1: number): void {
    for (let k = k0; k <= k1; k++)
      for (let i = i0; i <= i1; i++) this.columnTop[i + k * SX] = this.scanColumn(i, k);
  }

  /** Highest solid surface y (metres) of a sample column, WORLD_MIN.y if the column is all air. */
  scanColumn(i: number, k: number): number {
    const cx = i >> 5;
    const cz = k >> 5;
    const lxz = (i & 31) + ((k & 31) << 10);
    let above = Q_AIR;
    for (let j = SY - 1; j >= 0;) {
      const ci = chunkIndex(cx, j >> 5, cz);
      const a = this.chunks[ci];
      if (!a) {
        const u = this.uniform[ci]!;
        const jBase = j & ~31;
        if (u > 0) {
          // The top sample of this uniform solid chunk is the first solid one.
          if (j === SY - 1) return sampleY(j);
          return sampleY(j) + (VOXEL_SIZE * u) / (u - above);
        }
        above = u;
        j = jBase - 1;
        continue;
      }
      const v = a[lxz + ((j & 31) << 5)]!;
      if (v > 0) {
        if (j === SY - 1) return sampleY(j);
        return sampleY(j) + (VOXEL_SIZE * v) / (v - above);
      }
      above = v;
      j--;
    }
    return WORLD_MIN.y;
  }

  /** Deep copy (e.g. for what-if simulations or benchmarks). */
  clone(): VoxelField {
    const f = new VoxelField();
    for (let ci = 0; ci < CHUNK_COUNT; ci++) {
      const a = this.chunks[ci];
      f.chunks[ci] = a ? a.slice() : null;
    }
    f.uniform.set(this.uniform);
    f.columnTop.set(this.columnTop);
    return f;
  }

  /** Bytes held by density arrays. */
  bytes(): number {
    let n = 0;
    for (const a of this.chunks) if (a) n += a.byteLength;
    return n + this.uniform.byteLength + this.columnTop.byteLength;
  }

  /** FNV-1a hash over the full field (uniform chunks hashed as their value). For determinism checks. */
  hash(): number {
    let h = 0x811c9dc5;
    for (let ci = 0; ci < CHUNK_COUNT; ci++) {
      const a = this.chunks[ci];
      if (!a) {
        h = Math.imul(h ^ 0xff, 0x01000193);
        h = Math.imul(h ^ (this.uniform[ci]! & 0xff), 0x01000193);
        continue;
      }
      for (let i = 0; i < CS3; i++) h = Math.imul(h ^ (a[i]! & 0xff), 0x01000193);
    }
    return h >>> 0;
  }
}

/**
 * First/last chunk (along one axis) whose padded mesher input reads global sample index s.
 * Chunk c reads samples [c*32-1, c*32+33] (clamped). A sample at the last grid index also stands in for the
 * clamped indices beyond it, which only the last chunk reads, so the formula still holds.
 */
const readerLo = (s: number): number => Math.max(0, Math.ceil((s - (CS + 1)) / CS));
const readerHi = (s: number, n: number): number => Math.min(n - 1, Math.floor((s + 1) / CS));
