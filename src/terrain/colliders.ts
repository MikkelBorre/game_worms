/**
 * Fixed Rapier trimesh colliders for the terrain, built on the main thread from worker mesh output.
 *
 * Each chunk's collision geometry comes split into sub-blocks (ChunkMeshData.colliderBlocks, produced by the
 * mesher). A rebuild compares every sub-block with what is currently in the physics world and only replaces the
 * sub-blocks whose triangles changed, so an explosion touches a handful of small trimeshes instead of whole
 * chunks. Meshes without colliderBlocks fall back to one collider for the whole chunk.
 */
import { RAPIER } from '../sim/physics';
import type { ChunkMeshData, ColliderBlock } from './types';

export const TERRAIN_FRICTION = 0.9;

interface Entry {
  collider: RAPIER.Collider;
  positions: Float32Array;
  indices: Uint32Array;
}

const WHOLE_CHUNK = -1;

function sameGeometry(e: Entry, b: ColliderBlock): boolean {
  if (e.indices.length !== b.indices.length || e.positions.length !== b.positions.length) return false;
  const ia = e.indices;
  const ib = b.indices;
  for (let i = 0; i < ia.length; i++) if (ia[i] !== ib[i]) return false;
  const pa = e.positions;
  const pb = b.positions;
  for (let i = 0; i < pa.length; i++) if (pa[i] !== pb[i]) return false;
  return true;
}

export class ChunkColliders {
  /** chunk id -> sub-block index -> collider. */
  private readonly chunks = new Map<string, Map<number, Entry>>();
  /** Colliders created / removed since construction (for stats and tests). */
  created = 0;
  removed = 0;

  /**
   * @param flags TriMeshFlags. FIX_INTERNAL_EDGES smooths contacts across triangle edges (better for the M2
   * character controller) at some build cost; see scripts/bench-terrain.ts.
   */
  constructor(
    private readonly world: RAPIER.World,
    private readonly flags: RAPIER.TriMeshFlags | 0 = RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES,
  ) {}

  /** Number of live colliders. */
  get size(): number {
    let n = 0;
    for (const m of this.chunks.values()) n += m.size;
    return n;
  }

  has(id: string): boolean {
    return (this.chunks.get(id)?.size ?? 0) > 0;
  }

  /** Colliders of one chunk. */
  get(id: string): RAPIER.Collider[] {
    return [...(this.chunks.get(id)?.values() ?? [])].map((e) => e.collider);
  }

  /** Create, replace or remove the colliders of a chunk so they match the mesh. Returns colliders rebuilt. */
  set(mesh: ChunkMeshData): number {
    const blocks: ColliderBlock[] =
      mesh.colliderBlocks ??
      (mesh.triangleCount > 0 && mesh.indices
        ? [{ index: WHOLE_CHUNK, positions: mesh.positions, indices: mesh.indices }]
        : []);
    let entries = this.chunks.get(mesh.id);
    if (!entries) {
      if (blocks.length === 0) return 0;
      entries = new Map();
      this.chunks.set(mesh.id, entries);
    }
    const keep = new Set<number>();
    let rebuilt = 0;
    for (const b of blocks) {
      if (b.indices.length === 0) continue;
      keep.add(b.index);
      const old = entries.get(b.index);
      if (old && sameGeometry(old, b)) continue;
      if (old) this.free(old);
      const desc = RAPIER.ColliderDesc.trimesh(b.positions, b.indices, this.flags || undefined).setFriction(
        TERRAIN_FRICTION,
      );
      entries.set(b.index, { collider: this.world.createCollider(desc), positions: b.positions, indices: b.indices });
      this.created++;
      rebuilt++;
    }
    for (const [idx, e] of entries)
      if (!keep.has(idx)) {
        this.free(e);
        entries.delete(idx);
      }
    if (entries.size === 0) this.chunks.delete(mesh.id);
    return rebuilt;
  }

  remove(id: string): void {
    const entries = this.chunks.get(id);
    if (!entries) return;
    for (const e of entries.values()) this.free(e);
    this.chunks.delete(id);
  }

  private free(e: Entry): void {
    this.removed++;
    try {
      this.world.removeCollider(e.collider, true);
    } catch {
      // World already freed (sim disposed before terrain) - nothing left to remove.
    }
  }

  dispose(): void {
    for (const id of [...this.chunks.keys()]) this.remove(id);
  }
}
