/**
 * Marching cubes over one padded chunk. Pure function: runs inside the mesher worker, and directly in node
 * for tests and benchmarks. Never call it on the browser main thread.
 *
 * The case table is generated at module load by walking the cube faces: on each face the crossed edges are
 * paired so that solid corners are always separated (a rule that depends only on the face's four corner
 * signs, so the two cells sharing a face always agree - the mesh is watertight, also across chunks). The
 * segments chain into closed loops that are fan-triangulated. Winding is counter-clockwise seen from the air.
 */
import * as T from './types';
import { chunkId, type ChunkCoord, type ChunkMeshData, type ColliderBlock } from './types';
import * as V from './voxels';

// Module-local copies of hot constants (see voxels.ts).
const CHUNK_SIZE = T.CHUNK_SIZE;
const VOXEL_SIZE = T.VOXEL_SIZE;
const WATER_LEVEL = T.WATER_LEVEL;
const WORLD_MIN = { x: T.WORLD_MIN.x, y: T.WORLD_MIN.y, z: T.WORLD_MIN.z };
const PAD = V.PAD;
const PAD3 = V.PAD3;

// ---------------------------------------------------------------------------------------------------------------
// Case table
// ---------------------------------------------------------------------------------------------------------------

/** Corner c = x + 2y + 4z. */
const bit = (c: number, axis: number): number => (c >> axis) & 1;

interface Edge {
  a: number;
  b: number;
  axis: number;
}

const EDGES: Edge[] = [];
const EDGE_OF = new Int8Array(64).fill(-1);
for (let axis = 0; axis < 3; axis++)
  for (let a = 0; a < 8; a++) {
    if (bit(a, axis)) continue;
    const b = a | (1 << axis);
    EDGE_OF[a * 8 + b] = EDGE_OF[b * 8 + a] = EDGES.length;
    EDGES.push({ a, b, axis });
  }

/** Bitmask of the 6 cube faces each edge lies on (face index = axis * 2 + side). */
const EDGE_FACES = EDGES.map((e) => {
  let m = 0;
  for (let axis = 0; axis < 3; axis++) {
    if (axis === e.axis) continue;
    const side = bit(e.a, axis);
    m |= 1 << (axis * 2 + side);
  }
  return m;
});

/** A triangle whose three edges share a cube face would lie flat in that face (a membrane between cells). */
const flatTri = (a: number, b: number, c: number): boolean =>
  (EDGE_FACES[a]! & EDGE_FACES[b]! & EDGE_FACES[c]!) !== 0;

/**
 * Triangulate a polygon (edge ids, in loop order) without flat-in-face triangles. Triangles keep the loop's
 * vertex order, so winding is preserved. Returns null if impossible.
 */
function triangulate(poly: number[]): number[] | null {
  const n = poly.length;
  if (n < 3) return [];
  if (n === 3) return flatTri(poly[0]!, poly[1]!, poly[2]!) ? null : [poly[0]!, poly[1]!, poly[2]!];
  for (let k = n - 2; k >= 1; k--) {
    if (flatTri(poly[0]!, poly[k]!, poly[n - 1]!)) continue;
    const left = triangulate(poly.slice(0, k + 1));
    if (!left) continue;
    const right = triangulate(poly.slice(k));
    if (!right) continue;
    return [...left, poly[0]!, poly[k]!, poly[n - 1]!, ...right];
  }
  return null;
}

function buildCaseTable(): { offsets: Uint16Array; edges: Uint8Array } {
  const offsets = new Uint16Array(257);
  const all: number[] = [];
  for (let cs = 0; cs < 256; cs++) {
    offsets[cs] = all.length;
    const solid = (c: number) => (cs >> c) & 1;
    const next = new Int8Array(12).fill(-1);
    for (let axis = 0; axis < 3; axis++)
      for (let side = 0; side < 2; side++) {
        const u = (axis + 1) % 3;
        const v = (axis + 2) % 3;
        // (u,v) = (0,0),(1,0),(1,1),(0,1) is CCW about +axis; reverse for the -axis face.
        const quad = [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ].map(([pu, pv]) => (side << axis) | (pu! << u) | (pv! << v));
        if (side === 0) quad.reverse();
        for (let i = 0; i < 4; i++) {
          const qi = quad[i]!;
          const qj = quad[(i + 1) % 4]!;
          if (solid(qi) || !solid(qj)) continue;
          // air -> solid edge starts a segment; it ends at the next solid -> air edge.
          let k = (i + 1) % 4;
          while (solid(quad[(k + 1) % 4]!)) k = (k + 1) % 4;
          next[EDGE_OF[qi * 8 + qj]!] = EDGE_OF[quad[k]! * 8 + quad[(k + 1) % 4]!]!;
        }
      }
    const seen = new Uint8Array(12);
    for (let e = 0; e < 12; e++) {
      if (next[e]! < 0 || seen[e]) continue;
      const loop: number[] = [];
      let cur = e;
      while (!seen[cur]) {
        seen[cur] = 1;
        loop.push(cur);
        cur = next[cur]!;
        if (cur < 0) throw new Error(`marching cubes table: open loop in case ${cs}`);
      }
      let tris: number[] | null = null;
      // Rotate the loop start until a membrane-free triangulation exists (always the case for MC loops).
      for (let r = 0; r < loop.length && !tris; r++)
        tris = triangulate([...loop.slice(r), ...loop.slice(0, r)]);
      if (!tris) throw new Error(`marching cubes table: cannot triangulate case ${cs}`);
      all.push(...tris);
    }
  }
  offsets[256] = all.length;
  return { offsets, edges: Uint8Array.from(all) };
}

export const MC_TABLE = buildCaseTable();

// ---------------------------------------------------------------------------------------------------------------
// Palette (linear RGB). Tweak colours here.
// ---------------------------------------------------------------------------------------------------------------

const srgbToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const hex = (h: number): [number, number, number] => [
  srgbToLinear(((h >> 16) & 255) / 255),
  srgbToLinear(((h >> 8) & 255) / 255),
  srgbToLinear((h & 255) / 255),
];

export const PALETTE = {
  sand: hex(0xe8d28a),
  sandAlt: hex(0xf0dc9c),
  seabed: hex(0xb89e62),
  grass: hex(0x5dbb4a),
  grassAlt: hex(0x7ccc4f),
  grassDark: hex(0x4a9e3c),
  rock: hex(0x8a8580),
  rockAlt: hex(0x9d968c),
  dirt: hex(0x6b4a2b),
  /** Surfaces this far (m) below the column's top surface count as covered (cave floors, under overhangs). */
  coveredDepth: 1.2,
  /** Sand up to this height above water (m), jittered by noise. */
  beachTop: 1.4,
  /** Rock above this height (m). */
  rockLine: 28,
  /** Normal.y where rock starts / is full (0.74 ≈ 42°, 0.58 ≈ 55° slope). */
  rockSlope: [0.74, 0.58],
} as const;

/** Cheap deterministic lattice hash in [0,1). */
function hash3(i: number, j: number, k: number): number {
  let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(k, 1440662683)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Trilinear value noise in [0,1). */
function valueNoise(x: number, y: number, z: number): number {
  const i = Math.floor(x);
  const j = Math.floor(y);
  const k = Math.floor(z);
  let fx = x - i;
  let fy = y - j;
  let fz = z - k;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  fz = fz * fz * (3 - 2 * fz);
  const a = hash3(i, j, k) + (hash3(i + 1, j, k) - hash3(i, j, k)) * fx;
  const b = hash3(i, j + 1, k) + (hash3(i + 1, j + 1, k) - hash3(i, j + 1, k)) * fx;
  const c = hash3(i, j, k + 1) + (hash3(i + 1, j, k + 1) - hash3(i, j, k + 1)) * fx;
  const d = hash3(i, j + 1, k + 1) + (hash3(i + 1, j + 1, k + 1) - hash3(i, j + 1, k + 1)) * fx;
  const ab = a + (b - a) * fy;
  const cd = c + (d - c) * fy;
  return ab + (cd - ab) * fz;
}

const smooth = (e0: number, e1: number, x: number): number => {
  let t = (x - e0) / (e1 - e0);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
};

const tmp: [number, number, number] = [0, 0, 0];
const mix3 = (out: number[], c: readonly number[], t: number): void => {
  out[0]! += (c[0]! - out[0]!) * t;
  out[1]! += (c[1]! - out[1]!) * t;
  out[2]! += (c[2]! - out[2]!) * t;
};

/** Vertex colour from world position, unit normal and the column's top surface height. */
export function terrainColor(
  x: number,
  y: number,
  z: number,
  ny: number,
  columnTop: number,
  out: [number, number, number] = tmp,
): [number, number, number] {
  const P = PALETTE;
  const nFine = valueNoise(x * 0.45, y * 0.45, z * 0.45);
  const nBroad = valueNoise(x * 0.07 + 31.7, y * 0.07, z * 0.07 - 11.3);

  // Grass with broad patches of lighter/darker green and fine speckle.
  out[0] = P.grass[0];
  out[1] = P.grass[1];
  out[2] = P.grass[2];
  mix3(out, nBroad > 0.5 ? P.grassAlt : P.grassDark, Math.abs(nBroad - 0.5) * 1.2);
  const speck = 0.92 + nFine * 0.16;
  out[0] *= speck;
  out[1] *= speck;
  out[2] *= speck;

  // Beach band.
  const beachTop = WATER_LEVEL + P.beachTop + (nBroad - 0.5) * 1.2 + (nFine - 0.5) * 0.3;
  const wSand = smooth(beachTop + 0.5, beachTop - 0.1, y);
  if (wSand > 0) {
    const sand = nFine > 0.5 ? P.sandAlt : P.sand;
    mix3(out, sand, wSand);
    mix3(out, P.seabed, smooth(WATER_LEVEL - 0.3, WATER_LEVEL - 2.5, y));
  }

  // Rock on steep slopes and high up.
  const steep = smooth(P.rockSlope[0] + (nFine - 0.5) * 0.08, P.rockSlope[1], ny);
  const high = smooth(P.rockLine - 2, P.rockLine + 3, y + (nBroad - 0.5) * 6);
  const wRock = steep > high ? steep : high;
  if (wRock > 0) mix3(out, nFine > 0.55 ? P.rockAlt : P.rock, wRock);

  // Dirt under overhangs and on cave floors.
  // Only upward-facing surfaces count as "covered" floors; vertical faces under a cliff top stay rock.
  const covered = smooth(P.coveredDepth, P.coveredDepth + 1.5, columnTop - y) * smooth(0.2, 0.5, ny);
  const under = smooth(-0.05, -0.5, ny);
  const wDirt = covered > under ? covered : under;
  if (wDirt > 0) mix3(out, P.dirt, wDirt * (0.75 + nFine * 0.25));
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Mesher
// ---------------------------------------------------------------------------------------------------------------

const C1 = CHUNK_SIZE + 1;
const PAD2 = PAD * PAD;
const STRIDE = [1, PAD, PAD2];

/** Reusable scratch (one set per worker / process). */
const edgeCache = new Int32Array(C1 * C1 * C1 * 3);
let vbuf = new Float32Array(3 * 8192);
let nbuf = new Float32Array(3 * 8192);
let ibuf = new Uint32Array(3 * 16384);
/** Collider sub-block of each triangle. */
let tbuf = new Uint8Array(16384);

/** Collider sub-block edge in cells (power of two dividing CHUNK_SIZE). */
export const COLLIDER_BLOCK_CELLS = 8;
const BLOCK_SHIFT = Math.log2(COLLIDER_BLOCK_CELLS);
/** Sub-blocks per chunk axis. */
export const COLLIDER_BLOCKS_PER_AXIS = CHUNK_SIZE / COLLIDER_BLOCK_CELLS;
const NB = COLLIDER_BLOCKS_PER_AXIS;
const NB3 = NB * NB * NB;

function growF(a: Float32Array<ArrayBuffer>, need: number): Float32Array<ArrayBuffer> {
  if (need <= a.length) return a;
  const b = new Float32Array(Math.max(need, a.length * 2));
  b.set(a);
  return b;
}

export interface MeshInput {
  coord: ChunkCoord;
  /** PAD³ quantised density, see VoxelField.extractPadded. */
  density: Int8Array;
  /** PAD² column-top heights (metres) over the padded xz footprint, see VoxelField.extractColumnTops. */
  columnTops: Float32Array;
  /**
   * Drop triangles whose three vertices are all below this height (m), or null to keep everything.
   * The ocean shader is opaque, so deep sea floor is never visible and nothing collides with it usefully.
   */
  cullBelow?: number | null;
}

/** Default underwater cull height: a margin below the water surface for wave troughs. */
export const DEFAULT_CULL_BELOW = WATER_LEVEL - 1.5;

/** Mesh one chunk. Output is in world space; arrays are freshly allocated (safe to transfer). */
export function meshChunk(input: MeshInput): ChunkMeshData {
  const { coord, density: d, columnTops } = input;
  if (d.length !== PAD3) throw new Error(`meshChunk: expected ${PAD3} samples, got ${d.length}`);
  const id = chunkId(coord);
  const gx0 = coord.cx * CHUNK_SIZE;
  const gy0 = coord.cy * CHUNK_SIZE;
  const gz0 = coord.cz * CHUNK_SIZE;
  edgeCache.fill(-1);
  let nv = 0;
  let ni = 0;
  const { offsets, edges } = MC_TABLE;
  const cornerOff = new Int32Array(8);
  for (let c = 0; c < 8; c++) cornerOff[c] = bit(c, 0) + bit(c, 1) * PAD + bit(c, 2) * PAD2;

  for (let z = 0; z < CHUNK_SIZE; z++)
    for (let y = 0; y < CHUNK_SIZE; y++) {
      let p = 1 + (y + 1) * PAD + (z + 1) * PAD2;
      for (let x = 0; x < CHUNK_SIZE; x++, p++) {
        let cs = 0;
        for (let c = 0; c < 8; c++) if (d[p + cornerOff[c]!]! > 0) cs |= 1 << c;
        if (cs === 0 || cs === 255) continue;
        const e0 = offsets[cs]!;
        const e1 = offsets[cs + 1]!;
        if (ni + (e1 - e0) > ibuf.length) {
          const b = new Uint32Array(ibuf.length * 2);
          b.set(ibuf);
          ibuf = b;
          const tb = new Uint8Array(ibuf.length / 3 + 1);
          tb.set(tbuf);
          tbuf = tb;
        }
        const block = (x >> BLOCK_SHIFT) + NB * ((y >> BLOCK_SHIFT) + NB * (z >> BLOCK_SHIFT));
        for (let t = ni / 3, tEnd = (ni + e1 - e0) / 3; t < tEnd; t++) tbuf[t] = block;
        for (let t = e0; t < e1; t++) {
          const edge = EDGES[edges[t]!]!;
          const ax = x + bit(edge.a, 0);
          const ay = y + bit(edge.a, 1);
          const az = z + bit(edge.a, 2);
          const key = (ax + ay * C1 + az * C1 * C1) * 3 + edge.axis;
          let vi = edgeCache[key]!;
          if (vi < 0) {
            vi = nv++;
            edgeCache[key] = vi;
            if (nv * 3 > vbuf.length) {
              vbuf = growF(vbuf, nv * 3);
              nbuf = growF(nbuf, nv * 3);
            }
            const pa = 1 + ax + (ay + 1) * PAD + (az + 1) * PAD2;
            const pb = pa + STRIDE[edge.axis]!;
            const va = d[pa]!;
            const vb = d[pb]!;
            const tt = va / (va - vb);
            const o = vi * 3;
            vbuf[o] = WORLD_MIN.x + (gx0 + ax) * VOXEL_SIZE;
            vbuf[o + 1] = WORLD_MIN.y + (gy0 + ay) * VOXEL_SIZE;
            vbuf[o + 2] = WORLD_MIN.z + (gz0 + az) * VOXEL_SIZE;
            vbuf[o + edge.axis]! += tt * VOXEL_SIZE;
            // Outward normal = -gradient, interpolated between the two corners' central differences.
            const u = 1 - tt;
            let gx = (d[pa + 1]! - d[pa - 1]!) * u + (d[pb + 1]! - d[pb - 1]!) * tt;
            let gy = (d[pa + PAD]! - d[pa - PAD]!) * u + (d[pb + PAD]! - d[pb - PAD]!) * tt;
            let gz = (d[pa + PAD2]! - d[pa - PAD2]!) * u + (d[pb + PAD2]! - d[pb - PAD2]!) * tt;
            let len = Math.sqrt(gx * gx + gy * gy + gz * gz);
            if (!(len > 1e-6)) {
              // Degenerate gradient: fall back to the edge direction, pointing from solid to air.
              gx = gy = gz = 0;
              if (edge.axis === 0) gx = va > 0 ? -1 : 1;
              else if (edge.axis === 1) gy = va > 0 ? -1 : 1;
              else gz = va > 0 ? -1 : 1;
              len = 1;
            }
            nbuf[o] = -gx / len;
            nbuf[o + 1] = -gy / len;
            nbuf[o + 2] = -gz / len;
          }
          ibuf[ni++] = vi;
        }
      }
    }

  let positions: Float32Array;
  let normals: Float32Array;
  let indices: Uint32Array;
  const cull = input.cullBelow ?? null;
  if (cull !== null && ni > 0) {
    // Keep triangles with any vertex at/above the cull height, then compact the vertex arrays.
    const remap = new Int32Array(nv).fill(-1);
    let nk = 0;
    let nvKeep = 0;
    for (let t = 0; t < ni; t += 3) {
      const a = ibuf[t]!;
      const b = ibuf[t + 1]!;
      const c = ibuf[t + 2]!;
      if (vbuf[a * 3 + 1]! < cull && vbuf[b * 3 + 1]! < cull && vbuf[c * 3 + 1]! < cull) continue;
      tbuf[nk / 3] = tbuf[t / 3]!;
      for (const v of [a, b, c]) {
        let r = remap[v]!;
        if (r < 0) r = remap[v] = nvKeep++;
        ibuf[nk++] = r;
      }
    }
    positions = new Float32Array(nvKeep * 3);
    normals = new Float32Array(nvKeep * 3);
    for (let v = 0; v < nv; v++) {
      const r = remap[v]!;
      if (r < 0) continue;
      positions[r * 3] = vbuf[v * 3]!;
      positions[r * 3 + 1] = vbuf[v * 3 + 1]!;
      positions[r * 3 + 2] = vbuf[v * 3 + 2]!;
      normals[r * 3] = nbuf[v * 3]!;
      normals[r * 3 + 1] = nbuf[v * 3 + 1]!;
      normals[r * 3 + 2] = nbuf[v * 3 + 2]!;
    }
    indices = ibuf.slice(0, nk);
    nv = nvKeep;
    ni = nk;
  } else {
    positions = vbuf.slice(0, nv * 3);
    normals = nbuf.slice(0, nv * 3);
    indices = ibuf.slice(0, ni);
  }
  const colors = new Float32Array(nv * 3);
  const col: [number, number, number] = [0, 0, 0];
  for (let v = 0; v < nv; v++) {
    const o = v * 3;
    const x = positions[o]!;
    const y = positions[o + 1]!;
    const z = positions[o + 2]!;
    // Nearest padded column (padded index 0 = global sample gx0 - 1).
    const px = Math.round((x - WORLD_MIN.x) / VOXEL_SIZE) - gx0 + 1;
    const pz = Math.round((z - WORLD_MIN.z) / VOXEL_SIZE) - gz0 + 1;
    const top = columnTops[pz * PAD + px] ?? y;
    terrainColor(x, y, z, normals[o + 1]!, top, col);
    colors[o] = col[0];
    colors[o + 1] = col[1];
    colors[o + 2] = col[2];
  }
  const colliderBlocks = splitColliderBlocks(positions, indices, ni / 3);
  return {
    id,
    coord: { ...coord },
    positions,
    normals,
    colors,
    indices,
    triangleCount: ni / 3,
    colliderBlocks,
  };
}

/** Compact per-sub-block collision geometry from the final mesh (tbuf holds each triangle's block). */
function splitColliderBlocks(
  positions: Float32Array,
  indices: Uint32Array,
  triCount: number,
): ColliderBlock[] {
  const counts = new Uint32Array(NB3);
  for (let t = 0; t < triCount; t++) counts[tbuf[t]!]!++;
  const nv = positions.length / 3;
  const stamp = new Int32Array(nv).fill(-1);
  const remap = new Uint32Array(nv);
  const out: ColliderBlock[] = [];
  for (let b = 0; b < NB3; b++) {
    const n = counts[b]!;
    if (n === 0) continue;
    const idx = new Uint32Array(n * 3);
    const pos = new Float32Array(n * 9); // upper bound; trimmed below
    let bv = 0;
    let k = 0;
    for (let t = 0; t < triCount; t++) {
      if (tbuf[t] !== b) continue;
      for (let e = 0; e < 3; e++) {
        const v = indices[t * 3 + e]!;
        if (stamp[v] !== b) {
          stamp[v] = b;
          remap[v] = bv;
          pos[bv * 3] = positions[v * 3]!;
          pos[bv * 3 + 1] = positions[v * 3 + 1]!;
          pos[bv * 3 + 2] = positions[v * 3 + 2]!;
          bv++;
        }
        idx[k++] = remap[v]!;
      }
    }
    out.push({ index: b, positions: pos.slice(0, bv * 3), indices: idx });
  }
  return out;
}

/** Buffers to transfer when posting a mesh between threads. */
export function meshTransferables(m: ChunkMeshData): ArrayBuffer[] {
  const out: ArrayBuffer[] = [
    m.positions.buffer as ArrayBuffer,
    m.normals.buffer as ArrayBuffer,
    m.colors.buffer as ArrayBuffer,
  ];
  if (m.indices) out.push(m.indices.buffer as ArrayBuffer);
  for (const b of m.colliderBlocks ?? [])
    out.push(b.positions.buffer as ArrayBuffer, b.indices.buffer as ArrayBuffer);
  return out;
}
