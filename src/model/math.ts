// The little vector and rotation arithmetic the writers and the viewer share.
import type { Pose, Vec3 } from './types';

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (v: Vec3, k: number): Vec3 => [v[0] * k, v[1] * k, v[2] * k];
export const length = (v: Vec3): number => Math.hypot(v[0], v[1], v[2]);
export const normalize = (v: Vec3): Vec3 => {
  const l = length(v);
  return l > 0 ? scale(v, 1 / l) : [0, 0, 1];
};

/** A rotation as a unit quaternion [w, x, y, z] (MuJoCo's and USD's order). */
export type Quat = [number, number, number, number];

/** Roll, pitch, yaw about the fixed X, Y, Z axes (applied in that order) as a quaternion. */
export function quatOf([r, p, y]: Vec3): Quat {
  const cr = Math.cos(r / 2), sr = Math.sin(r / 2);
  const cp = Math.cos(p / 2), sp = Math.sin(p / 2);
  const cy = Math.cos(y / 2), sy = Math.sin(y / 2);
  return [cr * cp * cy + sr * sp * sy, sr * cp * cy - cr * sp * sy, cr * sp * cy + sr * cp * sy, cr * cp * sy - sr * sp * cy];
}

/** The roll, pitch, yaw of a quaternion, the inverse of `quatOf`. */
export function rpyOf([w, x, y, z]: Quat): Vec3 {
  const roll = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y));
  const s = 2 * (w * y - z * x);
  const pitch = Math.abs(s) >= 1 ? (Math.sign(s) * Math.PI) / 2 : Math.asin(s);
  const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
  return [roll, pitch, yaw];
}

export const qmul = (a: Quat, b: Quat): Quat => [
  a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
  a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
  a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
  a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
];

/** `v` turned by `q`. */
export function rotate(q: Quat, v: Vec3): Vec3 {
  const [w, x, y, z] = q;
  // v + 2w(u × v) + 2(u × (u × v)) with u = (x, y, z)
  const ux = y * v[2] - z * v[1], uy = z * v[0] - x * v[2], uz = x * v[1] - y * v[0];
  const uux = y * uz - z * uy, uuy = z * ux - x * uz, uuz = x * uy - y * ux;
  return [v[0] + 2 * (w * ux + uux), v[1] + 2 * (w * uy + uuy), v[2] + 2 * (w * uz + uuz)];
}

/** The pose of `child` given in `parent`'s frame, as a pose in the world. */
export function compose(parent: Pose, child: Pose): Pose {
  const q = quatOf(parent.rpy);
  return { xyz: add(parent.xyz, rotate(q, child.xyz)), rpy: rpyOf(qmul(q, quatOf(child.rpy))) };
}

/** Rounds away floating-point noise for display and for files. */
export const tidy = (v: number, decimals = 6): number => {
  const k = 10 ** decimals;
  const r = Math.round(v * k) / k;
  return Object.is(r, -0) ? 0 : r;
};
export const tidyVec = (v: Vec3, decimals = 6): Vec3 => [tidy(v[0], decimals), tidy(v[1], decimals), tidy(v[2], decimals)];

export const degrees = (radians: number): number => (radians * 180) / Math.PI;
export const radians = (degrees: number): number => (degrees * Math.PI) / 180;

/** A short id for a new thing in the world. */
export function newId(): string {
  const bytes = new Uint8Array(8);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** `base`, or `base 2`, `base 3`... until it is not among `taken`. */
export function uniqueName(base: string, taken: Iterable<string>): string {
  const set = new Set(taken);
  if (!set.has(base)) return base;
  for (let i = 2; ; i++) if (!set.has(`${base} ${i}`)) return `${base} ${i}`;
}
