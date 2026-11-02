// The little geometry the part generators are built from: boxes, cylinders,
// cones and spheres as triangles in meters, Z up, each a convex piece with a
// colour, and a way to merge pieces into one mesh. MuJoCo collides with a
// mesh as its convex hull, so a part keeps its pieces apart for it, while the
// other engines and the viewer take the merged mesh.
import type { MeshData } from '../io/export';
import type { Vec3 } from '../model/types';

/** A convex piece of a part: its triangles, and one colour for all of them. */
export interface Piece {
  data: MeshData;
  color: Vec3;
}

function withColor(positions: number[], indices: number[], color: Vec3): Piece {
  const colors = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    colors[i] = color[0];
    colors[i + 1] = color[1];
    colors[i + 2] = color[2];
  }
  return { data: { positions: Float32Array.from(positions), indices: Uint32Array.from(indices), colors }, color };
}

/** A box of `size` about `center`, flat faces (each face its own four vertices). */
export function box(center: Vec3, size: Vec3, color: Vec3, yaw = 0): Piece {
  const [hx, hy, hz] = [size[0] / 2, size[1] / 2, size[2] / 2];
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const positions: number[] = [];
  const indices: number[] = [];
  const faces: [Vec3, Vec3, Vec3][] = [
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
    [[0, 0, -1], [0, 1, 0], [1, 0, 0]],
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [0, 0, 1], [1, 0, 0]],
    [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
  ];
  for (const [n, u, v] of faces) {
    const base = positions.length / 3;
    for (const [a, b] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ]) {
      const lx = n[0] * hx + u[0] * a * hx + v[0] * b * hx, ly = n[1] * hy + u[1] * a * hy + v[1] * b * hy, lz = n[2] * hz + u[2] * a * hz + v[2] * b * hz;
      positions.push(center[0] + lx * c - ly * s, center[1] + lx * s + ly * c, center[2] + lz);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return withColor(positions, indices, color);
}

/** A cylinder (or a cone when `topRadius` is 0, a frustum between) about a vertical axis, its base at `base`. */
export function cylinder(base: Vec3, radius: number, height: number, color: Vec3, segments = 16, topRadius = radius): Piece {
  const positions: number[] = [];
  const indices: number[] = [];
  const [cx, cy, cz] = base;
  const bottom: number[] = [], top: number[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    bottom.push(positions.length / 3);
    positions.push(cx + radius * Math.cos(a), cy + radius * Math.sin(a), cz);
    top.push(positions.length / 3);
    positions.push(cx + topRadius * Math.cos(a), cy + topRadius * Math.sin(a), cz + height);
  }
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments;
    indices.push(bottom[i], bottom[j], top[j], bottom[i], top[j], top[i]);
  }
  // Caps: fans about the middle.
  const bc = positions.length / 3;
  positions.push(cx, cy, cz);
  for (let i = 0; i < segments; i++) indices.push(bc, bottom[(i + 1) % segments], bottom[i]);
  if (topRadius > 0) {
    const tc = positions.length / 3;
    positions.push(cx, cy, cz + height);
    for (let i = 0; i < segments; i++) indices.push(tc, top[i], top[(i + 1) % segments]);
  }
  return withColor(positions, indices, color);
}

/** A sphere about `center`, optionally roughened: each vertex pushed in or out by up to `rough` of the radius, by a seeded hash, for rocks. */
export function sphere(center: Vec3, radius: number, color: Vec3, segments = 12, rough = 0, seed = 1, squash = 1): Piece {
  const positions: number[] = [];
  const indices: number[] = [];
  const rings = Math.max(3, Math.round(segments / 2));
  const noise = (i: number, j: number) => {
    let h = (i * 73856093) ^ (j * 19349663) ^ (seed * 83492791);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return (((h ^ (h >>> 16)) >>> 0) % 1000) / 1000 - 0.5;
  };
  for (let i = 0; i <= rings; i++) {
    const phi = (i / rings) * Math.PI;
    for (let j = 0; j < segments; j++) {
      const theta = (j / segments) * Math.PI * 2;
      const r = radius * (1 + (i === 0 || i === rings ? 0 : rough * 2 * noise(i, j)));
      positions.push(center[0] + r * Math.sin(phi) * Math.cos(theta), center[1] + r * Math.sin(phi) * Math.sin(theta), center[2] + r * Math.cos(phi) * squash);
    }
  }
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segments; j++) {
      const a = i * segments + j, b = i * segments + ((j + 1) % segments), c = (i + 1) * segments + j, d = (i + 1) * segments + ((j + 1) % segments);
      if (i > 0) indices.push(a, c, b);
      if (i < rings - 1) indices.push(b, c, d);
    }
  }
  return withColor(positions, indices, color);
}

/** One mesh from many pieces, vertex colours kept. */
export function merge(pieces: Piece[]): MeshData {
  const count = pieces.reduce((n, p) => n + p.data.positions.length, 0);
  const positions = new Float32Array(count), colors = new Float32Array(count);
  const indices = new Uint32Array(pieces.reduce((n, p) => n + p.data.indices.length, 0));
  let v = 0, f = 0;
  for (const p of pieces) {
    positions.set(p.data.positions, v * 3);
    colors.set(p.data.colors ?? new Float32Array(p.data.positions.length), v * 3);
    for (let i = 0; i < p.data.indices.length; i++) indices[f + i] = p.data.indices[i] + v;
    v += p.data.positions.length / 3;
    f += p.data.indices.length;
  }
  return { positions, indices, colors };
}
