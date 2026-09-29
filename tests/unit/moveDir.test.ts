import { describe, expect, it } from 'vitest';
import { moveDirFromKeys } from '../../src/input/moveDir';

const none = { forward: false, back: false, left: false, right: false };

describe('moveDirFromKeys', () => {
  it('no keys => zero', () => {
    expect(moveDirFromKeys(none, 1.2)).toEqual([0, 0]);
    expect(moveDirFromKeys({ ...none, forward: true, back: true }, 0)).toEqual([0, 0]);
  });

  it('forward follows the heading (worm yaw convention)', () => {
    expect(moveDirFromKeys({ ...none, forward: true }, 0)).toEqual([0, 1]);
    const [x, z] = moveDirFromKeys({ ...none, forward: true }, Math.PI / 2);
    expect(x).toBeCloseTo(1);
    expect(z).toBeCloseTo(0);
  });

  it('right is 90° clockwise from forward when seen from above the camera', () => {
    // Heading 0 looks along +Z; the camera's right is then -X.
    const [x, z] = moveDirFromKeys({ ...none, right: true }, 0);
    expect(x).toBeCloseTo(-1);
    expect(z).toBeCloseTo(0);
  });

  it('diagonals are unit length', () => {
    const [x, z] = moveDirFromKeys({ ...none, forward: true, left: true }, 0.3);
    expect(Math.hypot(x, z)).toBeCloseTo(1, 5);
  });

  it('small heading jitter is quantised to the same command', () => {
    const a = moveDirFromKeys({ ...none, forward: true }, 1.0);
    const b = moveDirFromKeys({ ...none, forward: true }, 1.0 + 1e-4);
    expect(a).toEqual(b);
  });
});
