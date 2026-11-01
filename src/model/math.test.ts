import { describe, expect, it } from 'vitest';
import { compose, qmul, quatOf, rotate, rpyOf, tidyVec, uniqueName } from './math';
import type { Vec3 } from './types';

const close = (a: Vec3, b: Vec3, eps = 1e-9) => a.every((v, i) => Math.abs(v - b[i]) < eps);

describe('rotations', () => {
  it('turns roll, pitch, yaw into a quaternion and back', () => {
    for (const rpy of [[0, 0, 0], [0.3, -0.2, 1.1], [Math.PI / 2, 0, 0], [0, 0, Math.PI]] as Vec3[]) {
      expect(close(rpyOf(quatOf(rpy)), rpy)).toBe(true);
    }
  });

  it('a yaw of 90° turns +X into +Y', () => {
    expect(close(rotate(quatOf([0, 0, Math.PI / 2]), [1, 0, 0]), [0, 1, 0])).toBe(true);
  });

  it('a roll of 90° turns +Y into +Z', () => {
    expect(close(rotate(quatOf([Math.PI / 2, 0, 0]), [0, 1, 0]), [0, 0, 1])).toBe(true);
  });

  it('composes poses as a kinematic chain would', () => {
    const parent = { xyz: [1, 0, 0] as Vec3, rpy: [0, 0, Math.PI / 2] as Vec3 };
    const child = { xyz: [1, 0, 0] as Vec3, rpy: [0, 0, 0] as Vec3 };
    const world = compose(parent, child);
    expect(close(world.xyz, [1, 1, 0])).toBe(true);
    expect(close(world.rpy, [0, 0, Math.PI / 2])).toBe(true);
  });

  it('multiplies quaternions in order', () => {
    const a = quatOf([0, 0, Math.PI / 2]);
    const b = quatOf([Math.PI / 2, 0, 0]);
    // Rotate by b first, then a: +Y -> +Z (roll), then +Z stays +Z under yaw.
    expect(close(rotate(qmul(a, b), [0, 1, 0]), [0, 0, 1])).toBe(true);
  });
});

describe('helpers', () => {
  it('tidies floating point noise', () => {
    expect(tidyVec([1e-12, -0, 0.1 + 0.2])).toEqual([0, 0, 0.3]);
  });

  it('numbers names until they are unique', () => {
    expect(uniqueName('Box', ['Box', 'Box 2'])).toBe('Box 3');
    expect(uniqueName('Box', [])).toBe('Box');
  });
});
