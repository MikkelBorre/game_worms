/**
 * Terrain benchmark (node, single-threaded).
 *
 *   npm run bench:terrain [-- --seed 1234 --runs 20]
 *
 * In the browser the marching cubes run in a worker pool, so the explosion MAIN-THREAD cost is
 * density edit + padded input extraction + collider rebuild (+ BufferGeometry creation/upload, not measurable
 * here). The re-mesh time is reported separately (it is what the workers spend).
 */
import { initPhysics, RAPIER } from '../src/sim/physics';
import { ChunkColliders } from '../src/terrain/colliders';
import { generateIsland } from '../src/terrain/generate';
import { surfaceHeightAt } from '../src/terrain/heightmap';
import { DEFAULT_CULL_BELOW, meshChunk } from '../src/terrain/marchingCubes';
import { CHUNK_COUNT, chunkCoordOf, chunkIndex, type VoxelField } from '../src/terrain/voxels';
import { CHUNK_WORLD, WORLD_MIN, type ChunkMeshData } from '../src/terrain/types';
import { Rng } from '../src/core/rng';

const arg = (name: string, def: number): number => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : def;
};
const seed = arg('seed', 1234);
const runs = arg('runs', 20);
const now = () => performance.now();
const f1 = (v: number) => v.toFixed(1);
const f2 = (v: number) => v.toFixed(2);
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
};
const mb = (b: number) => `${(b / 1048576).toFixed(1)} MB`;

const meshOf = (field: VoxelField, ci: number, cullBelow: number | null): ChunkMeshData => {
  const c = chunkCoordOf(ci);
  return meshChunk({
    coord: c,
    density: field.extractPadded(c),
    columnTops: field.extractColumnTops(c),
    cullBelow,
  });
};

async function main() {
  await initPhysics();
  console.log(`WormWorld terrain bench - seed ${seed}, node ${process.version}\n`);

  // Warm up the JIT once so numbers reflect steady state (the browser gets similar warm-up from the first chunks).
  {
    const w = generateIsland(seed + 1);
    for (let ci = 0; ci < CHUNK_COUNT; ci += 7)
      if (!w.field.isTriviallyEmpty(chunkCoordOf(ci))) meshOf(w.field, ci, DEFAULT_CULL_BELOW);
    for (let n = 0; n < 5; n++) {
      const res = w.field.carveSphere([n * 7 - 14, surfaceHeightAt(w.field, n * 7 - 14, 3), 3], 3);
      for (const c of res.dirty)
        meshChunk({ coord: c, density: w.field.extractPadded(c), columnTops: w.field.extractColumnTops(c) });
    }
  }

  // --- Generation ---------------------------------------------------------------------------------------------
  let t = now();
  const { field, timings, info } = generateIsland(seed);
  const genMs = now() - t;
  let nonUniform = 0;
  for (const a of field.chunks) if (a) nonUniform++;
  console.log(
    `generate            ${f1(genMs)} ms  (heightfield ${f1(timings.heightfieldMs)}, 3D fill ${f1(timings.fillMs)}, column cache ${f1(timings.columnsMs)})`,
  );
  console.log(
    `density storage     ${mb(field.bytes())}  (${nonUniform}/${CHUNK_COUNT} chunks non-uniform, Int8 quantised)`,
  );
  console.log(
    `village plateau     (${f1(info.village.x)}, ${f1(info.village.z)}) y=${f1(info.village.y)}; peaks ${info.peaks.length}`,
  );

  // --- Full island mesh --------------------------------------------------------------------------------------
  for (const [label, cull] of [
    ['full mesh (culled)', DEFAULT_CULL_BELOW],
    ['full mesh (no cull)', null],
  ] as const) {
    t = now();
    let tris = 0;
    let verts = 0;
    let meshed = 0;
    let nonEmpty = 0;
    let maxChunk = 0;
    let bytes = 0;
    for (let ci = 0; ci < CHUNK_COUNT; ci++) {
      if (field.isTriviallyEmpty(chunkCoordOf(ci))) continue;
      const t0 = now();
      const m = meshOf(field, ci, cull);
      maxChunk = Math.max(maxChunk, now() - t0);
      meshed++;
      tris += m.triangleCount;
      verts += m.positions.length / 3;
      bytes += m.positions.byteLength * 3 + (m.indices?.byteLength ?? 0);
      if (m.triangleCount) nonEmpty++;
    }
    const ms = now() - t;
    console.log(
      `${label.padEnd(20)}${f1(ms)} ms single-threaded, ${meshed} chunks meshed (avg ${f2(ms / meshed)} ms, max ${f2(maxChunk)} ms), ` +
        `${nonEmpty} non-empty, ${tris} tris, ${verts} verts, ${mb(bytes)} mesh buffers`,
    );
  }

  // --- Full collider build -----------------------------------------------------------------------------------
  const meshes = new Map<number, ChunkMeshData>();
  for (let ci = 0; ci < CHUNK_COUNT; ci++)
    if (!field.isTriviallyEmpty(chunkCoordOf(ci))) meshes.set(ci, meshOf(field, ci, DEFAULT_CULL_BELOW));
  for (const [label, flags] of [
    ['FIX_INTERNAL_EDGES', RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES],
    ['no flags', 0],
  ] as const) {
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    const cols = new ChunkColliders(world, flags);
    t = now();
    for (const m of meshes.values()) cols.set(m);
    console.log(
      `colliders (${label})`.padEnd(32) +
        `${f1(now() - t)} ms, ${cols.size} sub-block trimeshes in ${meshes.size} chunks`,
    );
    cols.dispose();
    world.free();
  }

  // --- Explosions ----------------------------------------------------------------------------------------------
  // Each trial carves into a fresh clone of the generated field and restores the touched colliders afterwards,
  // so repeated trials of the same explosion measure the same work.
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  const cols = new ChunkColliders(world);
  for (const m of meshes.values()) cols.set(m);

  interface Sample {
    dirty: number;
    edit: number;
    extract: number;
    mesh: number;
    meshMax: number;
    collider: number;
    blocks: number;
    main: number;
  }
  const trial = (center: [number, number, number], radius: number): Sample => {
    const f = field.clone();
    let t0 = now();
    const res = f.carveSphere(center, radius);
    const edit = now() - t0;
    t0 = now();
    const inputs = res.dirty.map((c) => ({
      coord: c,
      density: f.extractPadded(c),
      columnTops: f.extractColumnTops(c),
      cullBelow: DEFAULT_CULL_BELOW,
    }));
    const extract = now() - t0;
    let mesh = 0;
    let meshMax = 0;
    const out: ChunkMeshData[] = [];
    for (const inp of inputs) {
      const t1 = now();
      out.push(meshChunk(inp));
      const d = now() - t1;
      mesh += d;
      meshMax = Math.max(meshMax, d);
    }
    t0 = now();
    let blocks = 0;
    for (const m of out) blocks += cols.set(m);
    const collider = now() - t0;
    // Restore (untimed).
    for (const m of out) {
      const orig = meshes.get(chunkIndex(m.coord.cx, m.coord.cy, m.coord.cz));
      if (orig) cols.set(orig);
      else cols.remove(m.id);
    }
    return {
      dirty: res.dirty.length,
      edit,
      extract,
      mesh,
      meshMax,
      collider,
      blocks,
      main: edit + extract + collider,
    };
  };
  const repeat = (center: [number, number, number], radius: number, n: number): Sample[] => {
    const out: Sample[] = [];
    for (let i = 0; i < n; i++) out.push(trial(center, radius));
    return out;
  };
  const med = (xs: Sample[], k: keyof Sample) =>
    pct(
      xs.map((x) => x[k]),
      0.5,
    );
  const max = (xs: Sample[], k: keyof Sample) => Math.max(...xs.map((x) => x[k]));
  const report = (label: string, xs: Sample[]) => {
    const m = med(xs, 'main');
    console.log(
      `${label}  [median of ${xs.length}]\n` +
        `    dirty chunks ${xs[0]!.dirty}, collider sub-blocks rebuilt ${xs[0]!.blocks}\n` +
        `    density edit ${f2(med(xs, 'edit'))} ms + input extract ${f2(med(xs, 'extract'))} ms + collider rebuild ${f2(med(xs, 'collider'))} ms` +
        `  => MAIN THREAD ${f2(m)} ms (max ${f2(max(xs, 'main'))}) ${m < 16 ? 'OK < 16 ms' : 'OVER 16 ms BUDGET'}\n` +
        `    re-mesh in workers: ${f2(med(xs, 'mesh'))} ms total / ${f2(med(xs, 'meshMax'))} ms slowest chunk` +
        `  (everything inline on one thread: ${f2(m + med(xs, 'mesh'))} ms)`,
    );
  };

  // 1) Surface point inside a chunk.
  const sx = 21.3;
  const sz = -13.7;
  const sy = surfaceHeightAt(field, sx, sz);
  report(`explosion r=3 at surface (${sx}, ${f1(sy)}, ${sz})`, repeat([sx, sy, sz], 3, runs));

  // 2) On a chunk corner: pick the xz chunk corner whose surface is closest to a y chunk boundary.
  let best: [number, number, number] = [0, 0, 0];
  let bestErr = Infinity;
  for (let cx = 1; cx < 10; cx++)
    for (let cz = 1; cz < 10; cz++) {
      const x = WORLD_MIN.x + cx * CHUNK_WORLD;
      const z = WORLD_MIN.z + cz * CHUNK_WORLD;
      const h = surfaceHeightAt(field, x, z);
      for (const yb of [WORLD_MIN.y + CHUNK_WORLD, WORLD_MIN.y + 2 * CHUNK_WORLD]) {
        const err = Math.abs(h - yb);
        if (err < bestErr) {
          bestErr = err;
          best = [x, yb, z];
        }
      }
    }
  report(
    `explosion r=3 on a chunk corner (${best.join(', ')}), surface y ${f1(surfaceHeightAt(field, best[0], best[2]))}`,
    repeat(best, 3, runs),
  );

  // 3) Random surface explosions for a distribution.
  const rng = new Rng(seed ^ 0xb00b);
  const xs: Sample[] = [];
  for (let n = 0; n < runs; n++) {
    let x = 0;
    let z = 0;
    let h = -10;
    while (h < 1) {
      x = rng.range(-50, 50);
      z = rng.range(-50, 50);
      h = surfaceHeightAt(field, x, z);
    }
    xs.push(trial([x, h, z], 3));
  }
  console.log(
    `${runs} random surface explosions r=3: MAIN THREAD median ${f2(med(xs, 'main'))} ms, p95 ${f2(
      pct(
        xs.map((x) => x.main),
        0.95,
      ),
    )} ms, ` +
      `max ${f2(max(xs, 'main'))} ms; re-mesh total median ${f2(med(xs, 'mesh'))} ms; dirty chunks median ${med(xs, 'dirty')}, max ${max(xs, 'dirty')}`,
  );
  cols.dispose();
  world.free();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
