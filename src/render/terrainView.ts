import * as THREE from 'three';
import type { ChunkMeshData } from '../terrain/types';

export interface TerrainView {
  group: THREE.Group;
  /** Add or replace the mesh for a chunk. */
  apply(mesh: ChunkMeshData): void;
  clear(): void;
  dispose(): void;
}

/**
 * Render adapter for terrain chunk meshes (world-space positions, per-vertex normals and linear colours).
 * One THREE.Mesh per non-empty chunk, all sharing the given material. Replacing a chunk disposes its old
 * geometry; an empty mesh (triangleCount 0) removes the chunk.
 */
export function createTerrainView(material: THREE.Material): TerrainView {
  const group = new THREE.Group();
  group.name = 'terrain';
  const meshes = new Map<string, THREE.Mesh>();

  const remove = (id: string) => {
    const old = meshes.get(id);
    if (!old) return;
    old.geometry.dispose();
    group.remove(old);
    meshes.delete(id);
  };

  const clear = () => {
    for (const id of [...meshes.keys()]) remove(id);
  };

  return {
    group,
    apply(data) {
      remove(data.id);
      if (data.triangleCount === 0) return;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(data.colors, 3));
      if (data.indices) geo.setIndex(new THREE.BufferAttribute(data.indices, 1));
      // Bounds for frustum culling (positions are already in world space).
      geo.computeBoundingBox();
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, material);
      mesh.name = `chunk:${data.id}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      meshes.set(data.id, mesh);
      group.add(mesh);
    },
    clear,
    dispose: clear,
  };
}
