// Where the demo drive may go: boxes around the props, the robot's own box,
// and the rule that a box low enough to drive onto is ground (a room's floor,
// a slab) while anything higher than a step is a wall. Boxes only: enough to
// find a doorway too narrow or a shelf in the way, which is the point.
import type { Bounds } from '../io/export';
import type { Pose, Vec3 } from '../model/types';

export type Box = Bounds;

/** The axis-aligned box around a local box placed at a pose (yaw only; a tilted prop is taken flat) and scale. */
export function boxAt(local: Box, pose: Pose, scale = 1): Box {
  const c = Math.cos(pose.rpy[2]), s = Math.sin(pose.rpy[2]);
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const x of [local.min[0], local.max[0]]) {
    for (const y of [local.min[1], local.max[1]]) {
      const wx = pose.xyz[0] + (x * c - y * s) * scale, wy = pose.xyz[1] + (x * s + y * c) * scale;
      min[0] = Math.min(min[0], wx);
      max[0] = Math.max(max[0], wx);
      min[1] = Math.min(min[1], wy);
      max[1] = Math.max(max[1], wy);
    }
  }
  min[2] = pose.xyz[2] + local.min[2] * scale;
  max[2] = pose.xyz[2] + local.max[2] * scale;
  return { min, max };
}

const overlapsXY = (a: Box, b: Box, margin = 0): boolean => a.min[0] < b.max[0] + margin && a.max[0] > b.min[0] - margin && a.min[1] < b.max[1] + margin && a.max[1] > b.min[1] - margin;

/** An obstacle: a prop's box in the world, and what it is, for the message. */
export interface Obstacle {
  name: string;
  box: Box;
}

/** How high a step the drive rolls onto rather than stops at, meters. */
export const STEP = 0.08;

/**
 * The ground under the robot's footprint: the terrain, or the top of any
 * obstacle under it no higher than a step above where the robot now stands
 * (so it rolls onto a slab and off it again).
 */
export function groundUnder(foot: Box, terrain: number, obstacles: Obstacle[], standing: number): number {
  let ground = terrain;
  for (const o of obstacles) {
    if (!overlapsXY(foot, o.box)) continue;
    const top = o.box.max[2];
    if (top <= standing + STEP && top > ground) ground = top;
  }
  return ground;
}

/**
 * What the robot's box would hit at a pose: the first obstacle that overlaps
 * it and rises more than a step above where the robot stands, or null.
 */
export function blockedBy(robot: Box, standing: number, obstacles: Obstacle[], margin = 0.02): Obstacle | null {
  for (const o of obstacles) {
    if (!overlapsXY(robot, o.box, margin)) continue;
    if (o.box.max[2] <= standing + STEP) continue; // ground, or something low enough to roll over
    if (o.box.min[2] >= robot.max[2]) continue; // a lintel, a bridge deck overhead
    return o;
  }
  return null;
}
