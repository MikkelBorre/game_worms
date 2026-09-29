import { beforeAll, describe, expect, it } from 'vitest';
import { generateIsland } from '../../../src/terrain/generate';
import {
  CHUNK_COUNT,
  PAD3,
  Q_AIR,
  SX,
  VoxelField,
  chunkCoordOf,
  chunkIndex,
  quantize,
  sampleX,
  sampleY,
  sampleZ,
} from '../../../src/terrain/voxels';
import { CHUNK_SIZE, CHUNK_WORLD, WORLD_MIN, type ChunkCoord } from '../../../src/terrain/types';

/** Brute force: every chunk whose padded mesher input differs between two snapshots. */
function snapshot(f: VoxelField): Int8Array[] {
  const out: Int8Array[] = [];
  for (let ci = 0; ci < CHUNK_COUNT; ci++) out.push(f.extractPadded(chunkCoordOf(ci)));
  return out;
}
function changedChunks(a: Int8Array[], b: Int8Array[]): number[] {
  const out: number[] = [];
  for (let ci = 0; ci < CHUNK_COUNT; ci++) {
    const x = a[ci]!;
    const y = b[ci]!;
    for (let n = 0; n < PAD3; n++)
      if (x[n] !== y[n]) {
        out.push(ci);
        break;
      }
  }
  return out;
}
const ids = (cs: ChunkCoord[]) => cs.map((c) => chunkIndex(c.cx, c.cy, c.cz));

describe('quantize', () => {
  it('never returns 0 and preserves sign', () => {
    for (const d of [1e-9, -1e-9, 0, 0.01, -0.01, 100, -100, 0.5, -0.5]) {
      const q = quantize(d);
      expect(q).not.toBe(0);
      expect(Math.abs(q)).toBeLessThanOrEqual(127);
      if (d > 0) expect(q).toBeGreaterThan(0);
      else expect(q).toBeLessThan(0);
    }
  });
});

describe('VoxelField', () => {
  let field: VoxelField;
  beforeAll(() => {
    field = generateIsland(4321).field;
  });

  it('extractPadded matches per-sample reads (incl. clamped world edges)', () => {
    for (const c of [
      { cx: 0, cy: 0, cz: 0 },
      { cx: 4, cy: 1, cz: 5 },
      { cx: 9, cy: 2, cz: 9 },
    ]) {
      const p = field.extractPadded(c);
      const P = CHUNK_SIZE + 3;
      for (let z = 0; z < P; z += 3)
        for (let y = 0; y < P; y += 2)
          for (let x = 0; x < P; x++)
            expect(p[x + P * (y + P * z)]).toBe(
              field.get(c.cx * CHUNK_SIZE - 1 + x, c.cy * CHUNK_SIZE - 1 + y, c.cz * CHUNK_SIZE - 1 + z),
            );
    }
  });

  const surfacePoint = (x: number, z: number): [number, number, number] => {
    const i = Math.round((x - WORLD_MIN.x) / 0.5);
    const k = Math.round((z - WORLD_MIN.z) / 0.5);
    return [x, field.columnTop[i + k * SX]!, z];
  };

  const cases: [string, () => [number, number, number], number][] = [
    ['surface point inside a chunk', () => surfacePoint(4.3, -3.7), 3],
    ['on a chunk face (x border)', () => surfacePoint(WORLD_MIN.x + 5 * CHUNK_WORLD, 2.2), 3],
    [
      'on a chunk corner (x, z and y borders)',
      () => [WORLD_MIN.x + 5 * CHUNK_WORLD, WORLD_MIN.y + CHUNK_WORLD, WORLD_MIN.z + 5 * CHUNK_WORLD],
      3,
    ],
    [
      'just inside a border (padding only)',
      () => surfacePoint(WORLD_MIN.x + 4 * CHUNK_WORLD + 0.6, 10.1),
      1.2,
    ],
    ['at the world edge', () => [WORLD_MIN.x + 0.2, -6, 0], 3],
  ];

  for (const [name, at, r] of cases) {
    it(`carveSphere marks exactly the chunks whose mesher input changed: ${name}`, () => {
      const before = snapshot(field);
      const res = field.carveSphere(at(), r);
      const after = snapshot(field);
      const truth = changedChunks(before, after);
      expect(truth.length).toBeGreaterThan(0);
      expect(ids(res.dirty)).toEqual(truth);
    });
  }

  it('carve on a chunk corner dirties the 8 chunks around it plus padding neighbours only', () => {
    const f = generateIsland(4321).field;
    // Corner between chunks (4..5, 0..1, 4..5); sphere fully solid there so it changes samples on all sides.
    const c: [number, number, number] = [
      WORLD_MIN.x + 5 * CHUNK_WORLD,
      WORLD_MIN.y + CHUNK_WORLD,
      WORLD_MIN.z + 5 * CHUNK_WORLD,
    ];
    const res = f.carveSphere(c, 2);
    const got = res.dirty.map((d) => `${d.cx},${d.cy},${d.cz}`).sort();
    const want: string[] = [];
    for (const x of [4, 5]) for (const y of [0, 1]) for (const z of [4, 5]) want.push(`${x},${y},${z}`);
    expect(got).toEqual(want.sort());
  });

  it('carving in open air changes nothing', () => {
    const res = field.carveSphere([0, 39, 70], 2);
    expect(res.dirty).toEqual([]);
    expect(res.bounds).toBeNull();
  });

  it('carve removes solid, lowers the column top, and addSphere puts it back', () => {
    const f = generateIsland(4321).field;
    const i = SX / 2 + 10;
    const k = SX / 2 - 7;
    const x = sampleX(i);
    const z = sampleZ(k);
    const top = f.columnTop[i + k * SX]!;
    expect(f.densityAt(x, top - 1, z)).toBeGreaterThan(0);
    f.carveSphere([x, top, z], 3);
    expect(f.densityAt(x, top - 1, z)).toBeLessThan(0);
    expect(f.columnTop[i + k * SX]!).toBeLessThan(top - 2.5);
    f.addSphere([x, top + 1, z], 1.5);
    expect(f.densityAt(x, top + 1, z)).toBeGreaterThan(0);
    expect(f.columnTop[i + k * SX]!).toBeGreaterThan(top + 2);
  });

  it('uniform chunks hold no array; edits materialise and re-collapse them', () => {
    const f = new VoxelField();
    expect(f.chunks.every((c) => c === null)).toBe(true);
    expect(f.get(10, 10, 10)).toBe(Q_AIR);
    const c: [number, number, number] = [sampleX(40), sampleY(40), sampleZ(40)];
    f.addSphere(c, 2);
    expect(f.chunks.filter(Boolean).length).toBeGreaterThan(0);
    f.carveSphere(c, 10);
    // Everything carved back to air: chunks collapse to uniform air again.
    expect(f.chunks.every((a) => a === null)).toBe(true);
    expect(Array.from(f.uniform).every((u) => u === Q_AIR)).toBe(true);
  });
});
