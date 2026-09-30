import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/core/math';
import { renderHeightmapPixels } from '../../src/ui/minimap';
import { wormName, teamName } from '../../src/ui/names';
import { projectNameTags, type NameTagSource } from '../../src/ui/nameTags';

describe('default names', () => {
  it('per team lists, wraps with a suffix', () => {
    expect(teamName(0)).toBe('Hold 1');
    expect(wormName(0, 0)).toBe('Konrad');
    expect(wormName(0, 1)).toBe('Viktoria');
    expect(wormName(0, 2)).toBe('Aksel');
    expect(wormName(1, 0)).not.toBe('Konrad');
    expect(wormName(0, 6)).toBe('Konrad 2');
  });
});

describe('minimap raster', () => {
  it('colours water blue and land green/sand, row 0 = minZ (north)', () => {
    const res = 8;
    const heights = new Float32Array(res * res).fill(-5);
    // Land in the northern half (small z rows).
    for (let z = 0; z < 4; z++) for (let x = 0; x < res; x++) heights[z * res + x] = 10;
    const px = renderHeightmapPixels({ resolution: res, minX: -80, minZ: -80, size: 160, heights });
    const at = (x: number, z: number) => [...px.slice((z * res + x) * 4, (z * res + x) * 4 + 3)];
    const [lr, lg, lb] = at(3, 1);
    expect(lg).toBeGreaterThan(lr!);
    expect(lg).toBeGreaterThan(lb!);
    const [wr, , wb] = at(3, 7);
    expect(wb).toBeGreaterThan(wr!);
  });
});

describe('projectNameTags', () => {
  const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000);
  cam.position.set(0, 5, 20);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld();
  const worms: NameTagSource[] = [
    { id: 1, team: 0, hp: 100, alive: true, name: 'A' },
    { id: 2, team: 1, hp: 50, alive: true, name: 'B' }, // behind the camera
    { id: 3, team: 1, hp: 0, alive: false, name: 'C' }, // dead
    { id: 4, team: 0, hp: 80, alive: true, name: 'D' }, // far away
  ];
  const poses: Record<number, Vec3> = { 1: [0, 0, 0], 2: [0, 0, 40], 3: [1, 0, 0], 4: [0, 0, -150] };
  const pose = (id: number) => ({ pos: poses[id]! });

  it('projects visible worms to the screen and hides the rest', () => {
    const tags = projectNameTags(cam, worms, pose, { width: 1600, height: 900 });
    const byId = new Map(tags.map((t) => [t.id, t]));
    const a = byId.get(1)!;
    expect(a.visible).toBe(true);
    expect(a.screenX).toBeCloseTo(800, 0);
    expect(a.screenY).toBeGreaterThan(0);
    expect(a.screenY).toBeLessThan(450); // head anchor is above the screen centre
    expect(byId.get(2)!.visible).toBe(false);
    expect(byId.get(3)!.visible).toBe(false);
    const far = byId.get(4)!;
    expect(far.visible).toBe(true);
    expect(far.scale).toBeLessThan(a.scale);
  });

  it('honours hideId and the occlusion callback, reusing the out array', () => {
    const out = projectNameTags(cam, worms, pose, { width: 1600, height: 900, hideId: 1 });
    expect(out.find((t) => t.id === 1)!.visible).toBe(false);
    const again = projectNameTags(cam, worms, pose, {
      width: 1600,
      height: 900,
      out,
      occluded: (id) => id === 4,
    });
    expect(again).toBe(out);
    expect(again.find((t) => t.id === 1)!.visible).toBe(true);
    expect(again.find((t) => t.id === 4)!.visible).toBe(false);
  });
});
