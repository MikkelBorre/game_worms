import * as THREE from 'three';
import type { ChunkMeshData } from '../terrain/types';

export interface TerrainView {
  group: THREE.Group;
  /** Add or replace the mesh for a chunk. */
  apply(mesh: ChunkMeshData): void;
  clear(): void;
  dispose(): void;
}

/** M0 STUB – terrain-engineer replaces in M1 (render adapter for chunk meshes). */
export function createTerrainView(material: THREE.Material): TerrainView {
  const group = new THREE.Group();
  const meshes = new Map<string, THREE.Mesh>();
  const clear = () => {
    for (const m of meshes.values()) {
      m.geometry.dispose();
      group.remove(m);
    }
    meshes.clear();
  };
  return {
    group,
    apply(data) {
      const old = meshes.get(data.id);
      if (old) {
        old.geometry.dispose();
        group.remove(old);
        meshes.delete(data.id);
      }
      if (data.triangleCount === 0) return;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(data.colors, 3));
      if (data.indices) geo.setIndex(new THREE.BufferAttribute(data.indices, 1));
      const mesh = new THREE.Mesh(geo, material);
      meshes.set(data.id, mesh);
      group.add(mesh);
    },
    clear,
    dispose: clear,
  };
}
