import * as THREE from 'three';
import { lerpVec3, type Vec3 } from '../core/math';
import type { WormState } from '../sim/world';

const TEAM_COLORS = [0xe84a4a, 0x3f7fe8, 0x3fc25a, 0xf2c53d];

/** Placeholder worm visuals (capsules). The procedural worm model arrives in M2. */
export class WormView {
  readonly group = new THREE.Group();
  private meshes = new Map<number, THREE.Mesh>();
  private geo = new THREE.CapsuleGeometry(0.3, 0.5, 4, 12);
  private tmp: Vec3 = [0, 0, 0];

  sync(worms: readonly WormState[], alpha: number): void {
    for (const w of worms) {
      let mesh = this.meshes.get(w.id);
      if (!mesh) {
        mesh = new THREE.Mesh(
          this.geo,
          new THREE.MeshLambertMaterial({ color: TEAM_COLORS[w.team % TEAM_COLORS.length] }),
        );
        mesh.castShadow = true;
        this.meshes.set(w.id, mesh);
        this.group.add(mesh);
      }
      const p = lerpVec3(w.prevPos, w.pos, alpha, this.tmp);
      mesh.position.set(p[0], p[1], p[2]);
      mesh.visible = w.alive;
    }
  }

  clear(): void {
    for (const m of this.meshes.values()) {
      (m.material as THREE.Material).dispose();
      this.group.remove(m);
    }
    this.meshes.clear();
  }
}
