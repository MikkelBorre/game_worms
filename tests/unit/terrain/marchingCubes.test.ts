import { beforeAll, describe, expect, it } from 'vitest';
import { generateIsland } from '../../../src/terrain/generate';
import { MC_TABLE, meshChunk } from '../../../src/terrain/marchingCubes';
import {
  CHUNK_COUNT,
  PAD,
  VoxelField,
  chunkCoordOf,
  sampleX,
  sampleY,
  sampleZ,
} from '../../../src/terrain/voxels';
import { CHUNK_WORLD, WORLD_MIN, type ChunkCoord, type ChunkMeshData } from '../../../src/terrain/types';
import { Rng } from '../../../src/core/rng';

const mesh = (f: VoxelField, c: ChunkCoord, cullBelow: number | null = null) =>
  meshChunk({ coord: c, density: f.extractPadded(c), columnTops: f.extractColumnTops(c), cullBelow });

function checkFinite(m: ChunkMeshData) {
  const nv = m.positions.length / 3;
  expect(m.normals.length).toBe(nv * 3);
  expect(m.colors.length).toBe(nv * 3);
  expect(m.indices!.length).toBe(m.triangleCount * 3);
  const problems: string[] = [];
  for (let i = 0; i < m.positions.length; i++)
    if (!Number.isFinite(m.positions[i]!)) problems.push(`position[${i}]=${m.positions[i]}`);
  for (let i = 0; i < m.colors.length; i++) {
    const v = m.colors[i]!;
    if (!(v >= 0 && v <= 1)) problems.push(`color[${i}]=${v}`);
  }
  for (let i = 0; i < nv; i++) {
    const x = m.normals[i * 3]!;
    const y = m.normals[i * 3 + 1]!;
    const z = m.normals[i * 3 + 2]!;
    const len = Math.hypot(x, y, z);
    if (!(Math.abs(len - 1) < 1e-4)) problems.push(`normal[${i}] length ${len}`);
  }
  for (let i = 0; i < m.indices!.length; i++)
    if (m.indices![i]! >= nv) problems.push(`index[${i}] out of range`);
  expect(problems.slice(0, 5)).toEqual([]);
}

/** Merge chunk meshes by exact vertex position and count directed edges. */
function edgeStats(meshes: ChunkMeshData[]) {
  const key = (m: ChunkMeshData, i: number) =>
    `${m.positions[i * 3]},${m.positions[i * 3 + 1]},${m.positions[i * 3 + 2]}`;
  const directed = new Map<string, number>();
  for (const m of meshes)
    for (let t = 0; t < m.triangleCount; t++) {
      const v = [0, 1, 2].map((k) => key(m, m.indices![t * 3 + k]!));
      for (let e = 0; e < 3; e++) {
        const k = `${v[e]}|${v[(e + 1) % 3]}`;
        directed.set(k, (directed.get(k) ?? 0) + 1);
      }
    }
  let boundary = 0;
  let duplicated = 0;
  const boundaryEdges: string[] = [];
  for (const [k, n] of directed) {
    if (n > 1) duplicated++;
    const [a, b] = k.split('|');
    if (!directed.has(`${b}|${a}`)) {
      boundary++;
      boundaryEdges.push(k);
    }
  }
  return { boundary, duplicated, boundaryEdges };
}

describe('marching cubes table', () => {
  it('empty for all-air and all-solid, every case has whole triangles', () => {
    expect(MC_TABLE.offsets[1]! - MC_TABLE.offsets[0]!).toBe(0);
    expect(MC_TABLE.offsets[256]! - MC_TABLE.offsets[255]!).toBe(0);
    for (let c = 1; c < 255; c++) {
      const n = MC_TABLE.offsets[c + 1]! - MC_TABLE.offsets[c]!;
      expect(n % 3).toBe(0);
      expect(n).toBeGreaterThan(0);
    }
  });
});

describe('meshChunk', () => {
  it('a sphere spanning 8 chunks is closed, consistently wound and seam-free', () => {
    const f = new VoxelField();
    // Centre exactly on a chunk corner.
    const c: [number, number, number] = [
      WORLD_MIN.x + 5 * CHUNK_WORLD,
      WORLD_MIN.y + CHUNK_WORLD,
      WORLD_MIN.z + 5 * CHUNK_WORLD,
    ];
    const res = f.addSphere(c, 4.3);
    const meshes = res.dirty.map((d) => mesh(f, d)).filter((m) => m.triangleCount > 0);
    expect(meshes.length).toBe(8);
    for (const m of meshes) checkFinite(m);
    const s = edgeStats(meshes);
    expect(s.boundary).toBe(0);
    expect(s.duplicated).toBe(0);
    // Outward normals point away from the centre, and triangle winding agrees with them.
    for (const m of meshes) {
      for (let t = 0; t < m.triangleCount; t++) {
        const [a, b, cc] = [0, 1, 2].map((k) => m.indices![t * 3 + k]!) as [number, number, number];
        const p = (i: number) => [m.positions[i * 3]!, m.positions[i * 3 + 1]!, m.positions[i * 3 + 2]!];
        const [pa, pb, pc] = [p(a), p(b), p(cc)] as [number[], number[], number[]];
        const u = [pb[0]! - pa[0]!, pb[1]! - pa[1]!, pb[2]! - pa[2]!];
        const v = [pc[0]! - pa[0]!, pc[1]! - pa[1]!, pc[2]! - pa[2]!];
        const n = [
          u[1]! * v[2]! - u[2]! * v[1]!,
          u[2]! * v[0]! - u[0]! * v[2]!,
          u[0]! * v[1]! - u[1]! * v[0]!,
        ];
        const out = [pa[0]! - c[0], pa[1]! - c[1], pa[2]! - c[2]];
        expect(n[0]! * out[0]! + n[1]! * out[1]! + n[2]! * out[2]!).toBeGreaterThan(0);
        const vn = [m.normals[a * 3]!, m.normals[a * 3 + 1]!, m.normals[a * 3 + 2]!];
        expect(vn[0]! * out[0]! + vn[1]! * out[1]! + vn[2]! * out[2]!).toBeGreaterThan(0);
      }
    }
  });

  it('random noise fields: finite output, unit normals, closed except on chunk faces', () => {
    const rng = new Rng(99);
    const f = new VoxelField();
    // Random blobs of added and carved spheres around one chunk.
    for (let n = 0; n < 60; n++) {
      const p: [number, number, number] = [
        sampleX(64) + rng.range(-2, 18),
        sampleY(32) + rng.range(-2, 18),
        sampleZ(64) + rng.range(-2, 18),
      ];
      if (rng.next() < 0.6) f.addSphere(p, rng.range(0.3, 3));
      else f.carveSphere(p, rng.range(0.3, 2));
    }
    const c = { cx: 2, cy: 1, cz: 2 };
    const m = mesh(f, c);
    expect(m.triangleCount).toBeGreaterThan(100);
    checkFinite(m);
    const s = edgeStats([m]);
    expect(s.duplicated).toBe(0);
    // Every open edge lies on the chunk's boundary faces.
    const lo = [sampleX(64), sampleY(32), sampleZ(64)];
    const hi = [lo[0]! + CHUNK_WORLD, lo[1]! + CHUNK_WORLD, lo[2]! + CHUNK_WORLD];
    for (const e of s.boundaryEdges) {
      const pts = e.split('|').map((v) => v.split(',').map(Number));
      const onFace = [0, 1, 2].some(
        (ax) => pts.every((q) => q[ax] === lo[ax]) || pts.every((q) => q[ax] === hi[ax]),
      );
      expect(onFace).toBe(true);
    }
  });

  describe('real island', () => {
    let f: VoxelField;
    let meshes: ChunkMeshData[];
    beforeAll(() => {
      f = generateIsland(1234).field;
      meshes = [];
      for (let ci = 0; ci < CHUNK_COUNT; ci++) {
        const c = chunkCoordOf(ci);
        if (f.isTriviallyEmpty(c)) continue;
        meshes.push(mesh(f, c));
      }
    });

    it('no NaN, unit normals, indices in range', () => {
      expect(meshes.reduce((s, m) => s + m.triangleCount, 0)).toBeGreaterThan(50_000);
      for (const m of meshes) checkFinite(m);
    });

    it('whole-island mesh is watertight: open edges only on the outer world boundary', () => {
      const s = edgeStats(meshes);
      expect(s.duplicated).toBe(0);
      const lo = [WORLD_MIN.x, WORLD_MIN.y, WORLD_MIN.z];
      const hi = [sampleX(319), sampleY(95), sampleZ(319)];
      const inner = s.boundaryEdges.filter((e) => {
        const pts = e.split('|').map((v) => v.split(',').map(Number));
        return ![0, 1, 2].some(
          (ax) => pts.every((q) => q[ax]! <= lo[ax]!) || pts.every((q) => q[ax]! >= hi[ax]!),
        );
      });
      expect(inner).toEqual([]);
    });

    it('vertices on a shared chunk face are identical from both sides', () => {
      const byId = new Map(meshes.map((m) => [m.id, m]));
      let compared = 0;
      for (const m of meshes) {
        const n = byId.get(`${m.coord.cx + 1},${m.coord.cy},${m.coord.cz}`);
        if (!n) continue;
        const X = WORLD_MIN.x + (m.coord.cx + 1) * CHUNK_WORLD;
        const onFace = (mm: ChunkMeshData) => {
          const out = new Set<string>();
          for (let i = 0; i < mm.positions.length; i += 3)
            if (mm.positions[i] === X)
              out.add(
                `${mm.positions[i]},${mm.positions[i + 1]},${mm.positions[i + 2]}|${mm.normals[i]},${mm.normals[i + 1]},${mm.normals[i + 2]}`,
              );
          return out;
        };
        const a = onFace(m);
        const b = onFace(n);
        expect([...a].sort()).toEqual([...b].sort());
        compared += a.size;
      }
      expect(compared).toBeGreaterThan(500);
    });

    it('underwater culling drops deep sea floor only', () => {
      let full = 0;
      let culled = 0;
      for (const m of meshes) full += m.triangleCount;
      for (let ci = 0; ci < CHUNK_COUNT; ci++) {
        const c = chunkCoordOf(ci);
        if (f.isTriviallyEmpty(c)) continue;
        const m = mesh(f, c, -1.5);
        checkFinite(m);
        culled += m.triangleCount;
        let below = 0;
        for (let t = 0; t < m.triangleCount; t++) {
          const ys = [0, 1, 2].map((k) => m.positions[m.indices![t * 3 + k]! * 3 + 1]!);
          if (Math.max(...ys) < -1.5) below++;
        }
        expect(below).toBe(0);
      }
      expect(culled).toBeLessThan(full * 0.8);
      expect(culled).toBeGreaterThan(full * 0.2);
    });
  });

  it('rejects wrongly sized input', () => {
    expect(() =>
      meshChunk({
        coord: { cx: 0, cy: 0, cz: 0 },
        density: new Int8Array(10),
        columnTops: new Float32Array(PAD * PAD),
      }),
    ).toThrow();
  });
});
