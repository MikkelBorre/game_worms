import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { SHAKE, ScreenShake } from '../../src/render/shake';

const pose = (c: THREE.Camera) => [...c.position.toArray(), ...c.quaternion.toArray()];

describe('ScreenShake', () => {
  it('near blasts add more trauma than far ones, big blasts more than small ones', () => {
    const cam = new THREE.Vector3(0, 0, 0);
    const near = new ScreenShake();
    near.addExplosion([2, 0, 0], 3, cam);
    const far = new ScreenShake();
    far.addExplosion([60, 0, 0], 3, cam);
    const small = new ScreenShake();
    small.addExplosion([2, 0, 0], 1, cam);
    expect(near.trauma).toBeGreaterThan(0.5);
    expect(far.trauma).toBeLessThan(near.trauma / 4);
    expect(small.trauma).toBeLessThan(near.trauma);
  });

  it('restore() undoes exactly the offset apply() added, so the rig never sees the shake', () => {
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(3, 4, 5);
    camera.lookAt(0, 0, 0);
    const before = pose(camera);
    const s = new ScreenShake();
    s.add(1);
    s.apply(camera, 1 / 60);
    expect(camera.position.distanceTo(new THREE.Vector3(3, 4, 5))).toBeGreaterThan(1e-4);
    s.restore(camera);
    pose(camera).forEach((v, i) => expect(v).toBeCloseTo(before[i]!, 6));
  });

  it('does not fight an external camera move between frames', () => {
    const camera = new THREE.PerspectiveCamera();
    const s = new ScreenShake();
    s.add(1);
    s.apply(camera, 1 / 60);
    camera.position.set(10, 0, 0); // e.g. setPose() from the debug API
    s.restore(camera);
    expect(camera.position.toArray()).toEqual([10, 0, 0]);
  });

  it('trauma decays to zero', () => {
    const camera = new THREE.PerspectiveCamera();
    const s = new ScreenShake();
    s.add(1);
    const frames = Math.ceil((1 / SHAKE.decay) * 60) + 2;
    for (let i = 0; i < frames; i++) {
      s.restore(camera);
      s.apply(camera, 1 / 60);
    }
    expect(s.trauma).toBe(0);
  });
});
