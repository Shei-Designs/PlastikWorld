// The demo drive's motion: kinematic, no physics. A robot is told how fast
// to go and how hard to turn, and its pose follows; the ground is read, not
// simulated. Enough to check that a world fits the robot before it goes to a
// simulator, which is what the demo drive is for.
import type { Vec3 } from '../model/types';

export type DriveModel = 'differential' | 'ackermann' | 'holonomic';

export interface DriveSpec {
  model: DriveModel;
  /** Top speed forward, m/s. */
  speed: number;
  /** Top turn rate, rad/s (differential, holonomic) or the largest steering angle, rad (Ackermann). */
  turn: number;
  /** Axle to axle, m (Ackermann). */
  wheelbase: number;
}

export const DEFAULT_DRIVE: DriveSpec = { model: 'differential', speed: 1, turn: 1.5, wheelbase: 0.5 };

export const DRIVE_MODELS: { id: DriveModel; label: string; hint: string }[] = [
  { id: 'differential', label: 'Differential', hint: 'Two driven wheels: turns on the spot' },
  { id: 'ackermann', label: 'Ackermann', hint: 'Steered front wheels, like a car: cannot turn standing still' },
  { id: 'holonomic', label: 'Holonomic', hint: 'Mecanum or omni wheels: moves sideways too' },
];

/** What the driver asks for, each -1..1: forward (back), turn (left is positive), strafe (left is positive, holonomic only). */
export interface DriveInput {
  forward: number;
  turn: number;
  strafe: number;
}

export interface DrivePose {
  x: number;
  y: number;
  yaw: number;
}

const clamp1 = (v: number): number => Math.max(-1, Math.min(1, v));

/**
 * The pose after `dt` seconds of this input. Forward is +X of the robot's
 * own frame (`forward` of the robot's format, as the smoke fixtures say),
 * which the caller folds into `yaw`.
 */
export function stepPose(pose: DrivePose, input: DriveInput, spec: DriveSpec, dt: number): DrivePose {
  const f = clamp1(input.forward), t = clamp1(input.turn), s = clamp1(input.strafe);
  const v = f * spec.speed;
  let omega: number;
  let vx = v, vy = 0;
  switch (spec.model) {
    case 'differential':
      omega = t * spec.turn;
      break;
    case 'ackermann': {
      // The yaw rate of a bicycle: speed over the turning radius the steering angle gives; reversing turns the other way, as a car does.
      const steer = t * spec.turn;
      omega = (v * Math.tan(steer)) / Math.max(spec.wheelbase, 0.01);
      break;
    }
    case 'holonomic':
      omega = t * spec.turn;
      vy = s * spec.speed;
      break;
  }
  // Integrate on the arc, so a steady turn traces a circle rather than a polygon.
  const yaw = pose.yaw + omega * dt;
  const mid = pose.yaw + (omega * dt) / 2;
  const c = Math.cos(mid), sn = Math.sin(mid);
  return { x: pose.x + (vx * c - vy * sn) * dt, y: pose.y + (vx * sn + vy * c) * dt, yaw };
}

/** The tilt a ground gives a robot: pitch (nose down positive about Y) and roll from the heights fore, aft, left and right. */
export function tiltOn(height: (x: number, y: number) => number, pose: DrivePose, wheelbase: number, track: number): { roll: number; pitch: number } {
  const c = Math.cos(pose.yaw), s = Math.sin(pose.yaw);
  const hb = Math.max(wheelbase, 0.05) / 2, ht = Math.max(track, 0.05) / 2;
  const fore = height(pose.x + c * hb, pose.y + s * hb), aft = height(pose.x - c * hb, pose.y - s * hb);
  const left = height(pose.x - s * ht, pose.y + c * ht), right = height(pose.x + s * ht, pose.y - c * ht);
  return { pitch: -Math.atan2(fore - aft, 2 * hb), roll: Math.atan2(left - right, 2 * ht) };
}

/** The world rotation (roll, pitch, yaw) for a pose and tilt. */
export const rpyOf = (pose: DrivePose, tilt: { roll: number; pitch: number }): Vec3 => [tilt.roll, tilt.pitch, pose.yaw];
