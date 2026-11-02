import { describe, expect, it } from 'vitest';
import { blockedBy, boxAt, groundUnder } from './collide';
import { stepPose, tiltOn } from './kinematics';
import type { DriveSpec } from './kinematics';

const diff: DriveSpec = { model: 'differential', speed: 1, turn: 1, wheelbase: 0.5 };

describe('the drive models', () => {
  it('a differential drive goes straight, turns on the spot, and traces a circle on a steady turn', () => {
    let p = { x: 0, y: 0, yaw: 0 };
    for (let i = 0; i < 100; i++) p = stepPose(p, { forward: 1, turn: 0, strafe: 0 }, diff, 0.01);
    expect(p.x).toBeCloseTo(1, 5);
    expect(p.y).toBeCloseTo(0, 5);
    p = { x: 0, y: 0, yaw: 0 };
    for (let i = 0; i < 100; i++) p = stepPose(p, { forward: 0, turn: 1, strafe: 0 }, diff, 0.01);
    expect(p.x).toBeCloseTo(0, 5);
    expect(p.yaw).toBeCloseTo(1, 5);
    // A full circle at v = 1, ω = 1: radius 1, back where it began after 2π seconds.
    p = { x: 0, y: 0, yaw: 0 };
    for (let i = 0; i < 628; i++) p = stepPose(p, { forward: 1, turn: 1, strafe: 0 }, diff, 0.01);
    expect(Math.hypot(p.x, p.y)).toBeLessThan(0.01);
  });

  it('an Ackermann drive cannot turn standing still and reverses its turn in reverse', () => {
    const car: DriveSpec = { model: 'ackermann', speed: 1, turn: 0.5, wheelbase: 1 };
    const still = stepPose({ x: 0, y: 0, yaw: 0 }, { forward: 0, turn: 1, strafe: 0 }, car, 1);
    expect(still.yaw).toBe(0);
    const ahead = stepPose({ x: 0, y: 0, yaw: 0 }, { forward: 1, turn: 1, strafe: 0 }, car, 0.1);
    const back = stepPose({ x: 0, y: 0, yaw: 0 }, { forward: -1, turn: 1, strafe: 0 }, car, 0.1);
    expect(ahead.yaw).toBeGreaterThan(0);
    expect(back.yaw).toBeLessThan(0);
    expect(ahead.yaw).toBeCloseTo(Math.tan(0.5) * 0.1, 5);
  });

  it('a holonomic drive strafes left in its own frame', () => {
    const omni: DriveSpec = { model: 'holonomic', speed: 2, turn: 1, wheelbase: 0.5 };
    const p = stepPose({ x: 0, y: 0, yaw: Math.PI / 2 }, { forward: 0, turn: 0, strafe: 1 }, omni, 0.5);
    // Facing +Y, left is -X.
    expect(p.x).toBeCloseTo(-1, 5);
    expect(p.y).toBeCloseTo(0, 5);
  });

  it('tilts with the ground: nose down going downhill, rolling towards the low side', () => {
    const slope = (x: number) => -0.2 * x; // falls along +X
    const t = tiltOn(slope, { x: 0, y: 0, yaw: 0 }, 1, 0.5);
    expect(t.pitch).toBeCloseTo(Math.atan(0.2), 5);
    expect(t.roll).toBeCloseTo(0, 5);
    const side = tiltOn((_x, y) => 0.1 * y, { x: 0, y: 0, yaw: 0 }, 1, 0.5);
    expect(side.roll).toBeCloseTo(Math.atan(0.1), 5);
  });
});

describe('where the drive may go', () => {
  const unit = { min: [-0.5, -0.5, 0] as [number, number, number], max: [0.5, 0.5, 1] as [number, number, number] };

  it('turns a local box into the world box around its placement', () => {
    const b = boxAt({ min: [0, -1, 0], max: [4, 1, 2] }, { xyz: [10, 0, 1], rpy: [0, 0, Math.PI / 2] });
    expect(b.min.map((v) => Math.round(v * 1000) / 1000 + 0)).toEqual([9, 0, 1]);
    expect(b.max.map((v) => Math.round(v * 1000) / 1000 + 0)).toEqual([11, 4, 3]);
  });

  it('rolls onto a slab, stops at a wall, passes under a lintel', () => {
    const slab = { name: 'slab', box: { min: [-5, -5, 0] as [number, number, number], max: [5, 5, 0.05] as [number, number, number] } };
    const wall = { name: 'wall', box: { min: [2, -5, 0] as [number, number, number], max: [2.2, 5, 2.6] as [number, number, number] } };
    const lintel = { name: 'lintel', box: { min: [1, -1, 2.1] as [number, number, number], max: [1.2, 1, 2.6] as [number, number, number] } };
    const robot = boxAt(unit, { xyz: [0, 0, 0], rpy: [0, 0, 0] });
    expect(groundUnder(robot, 0, [slab, wall], 0)).toBe(0.05);
    expect(blockedBy(robot, 0, [slab, wall, lintel])).toBeNull();
    const atWall = boxAt(unit, { xyz: [1.6, 0, 0.05], rpy: [0, 0, 0] });
    expect(blockedBy(atWall, 0.05, [slab, wall, lintel])?.name).toBe('wall');
    const underLintel = boxAt(unit, { xyz: [1.1, 0, 0.05], rpy: [0, 0, 0] });
    expect(blockedBy(underLintel, 0.05, [slab, lintel])).toBeNull();
    // A step too high to roll onto is a wall.
    const curb = { name: 'curb', box: { min: [-1, -1, 0] as [number, number, number], max: [1, 1, 0.2] as [number, number, number] } };
    expect(blockedBy(robot, 0, [curb])?.name).toBe('curb');
    expect(groundUnder(robot, 0, [curb], 0)).toBe(0);
  });
});
