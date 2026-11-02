// The parts library: generic pieces of a world made from a few numbers, for
// indoor and outdoor scenes, built here rather than shipped as meshes, so
// the app stays small and every piece stays editable. Each part is a list of
// convex pieces (MuJoCo collides with a mesh as its convex hull, so a room
// is its walls, not one hollow shape) in meters, Z up, its base on z = 0.
import type { MeshData } from '../io/export';
import type { Physics, Vec3 } from '../model/types';
import { box, cylinder, merge, sphere } from './mesh';
import type { Piece } from './mesh';

export type PartCategory = 'structure' | 'indoor' | 'outdoor' | 'road';

export interface ParamSpec {
  id: string;
  label: string;
  unit?: string;
  min: number;
  max: number;
  step: number;
  value: number;
}

export type PartParams = Record<string, number>;

export interface PartDef {
  id: string;
  name: string;
  category: PartCategory;
  blurb: string;
  params: ParamSpec[];
  /** The pieces for the parameters given (the spec's defaults where a value is missing). */
  build(params: PartParams): Piece[];
  /** What the piece is placed as: a wall is fixed, a cone is loose. */
  physics: Physics;
}

const C = {
  wall: [0.86, 0.84, 0.78] as Vec3,
  concrete: [0.62, 0.62, 0.6] as Vec3,
  asphalt: [0.2, 0.2, 0.22] as Vec3,
  paint: [0.95, 0.95, 0.9] as Vec3,
  wood: [0.6, 0.42, 0.24] as Vec3,
  steel: [0.5, 0.52, 0.55] as Vec3,
  orange: [0.95, 0.42, 0.1] as Vec3,
  white: [0.92, 0.92, 0.92] as Vec3,
  trunk: [0.36, 0.26, 0.16] as Vec3,
  leaf: [0.22, 0.45, 0.18] as Vec3,
  rock: [0.45, 0.43, 0.4] as Vec3,
  rubber: [0.12, 0.12, 0.12] as Vec3,
  cardboard: [0.76, 0.6, 0.4] as Vec3,
};

const fixed: Physics = { static: true, mass: 1, friction: 0.8, collision: 'mesh' };
// A loose part collides as its box: Gazebo's DART drops the friction set on a mesh and rocks a moving mesh on a
// heightmap, and a box is what a crate, a pallet or a cone needs to slide, stack and be pushed about.
const loose = (mass: number, friction = 0.6): Physics => ({ static: false, mass, friction, collision: 'box' });
const p = (id: string, label: string, value: number, min: number, max: number, step: number, unit = 'm'): ParamSpec => ({ id, label, unit, min, max, step, value });

export const PARTS: PartDef[] = [
  {
    id: 'wall',
    name: 'Wall',
    category: 'structure',
    blurb: 'A straight wall along X, with a doorway in it if asked.',
    params: [p('length', 'Length', 4, 0.2, 100, 0.5), p('height', 'Height', 2.4, 0.2, 20, 0.1), p('thickness', 'Thickness', 0.2, 0.02, 2, 0.05), p('door', 'Doorway width', 0, 0, 10, 0.1), p('doorHeight', 'Doorway height', 2.1, 0.5, 10, 0.1)],
    physics: fixed,
    build: ({ length, height, thickness, door, doorHeight }) => wallPieces(length, height, thickness, door, Math.min(doorHeight, height), C.wall),
  },
  {
    id: 'room',
    name: 'Room',
    category: 'structure',
    blurb: 'Four walls on a floor slab with an apron around, a doorway in the +X wall.',
    params: [p('width', 'Width (X)', 5, 1, 50, 0.5), p('depth', 'Depth (Y)', 4, 1, 50, 0.5), p('height', 'Height', 2.6, 0.5, 20, 0.1), p('thickness', 'Wall thickness', 0.15, 0.02, 1, 0.05), p('door', 'Doorway width', 1.2, 0, 10, 0.1), p('floor', 'Floor thickness', 0.05, 0.01, 0.5, 0.01)],
    physics: fixed,
    build: ({ width, depth, height, thickness, door, floor }) => {
      const t = thickness;
      // The slab reaches half a meter past the walls, so a robot leaving by the door is not dropped off its edge at once.
      const pieces: Piece[] = [box([0, 0, floor / 2], [width + 2 * t + 1, depth + 2 * t + 1, floor], C.concrete)];
      const z = floor;
      // The +X wall carries the doorway, in the middle, at most as wide as the wall.
      pieces.push(...wallPieces(depth + 2 * t, height, t, Math.min(door, depth), Math.min(2.1, height), C.wall, [width / 2 + t / 2, 0, z], Math.PI / 2));
      pieces.push(...wallPieces(depth + 2 * t, height, t, 0, 0, C.wall, [-width / 2 - t / 2, 0, z], Math.PI / 2));
      pieces.push(...wallPieces(width, height, t, 0, 0, C.wall, [0, depth / 2 + t / 2, z], 0));
      pieces.push(...wallPieces(width, height, t, 0, 0, C.wall, [0, -depth / 2 - t / 2, z], 0));
      return pieces;
    },
  },
  {
    id: 'slab',
    name: 'Floor slab',
    category: 'structure',
    blurb: 'A flat slab: a floor, a platform, a loading dock.',
    params: [p('width', 'Width (X)', 4, 0.2, 100, 0.5), p('depth', 'Depth (Y)', 4, 0.2, 100, 0.5), p('thickness', 'Thickness', 0.2, 0.02, 5, 0.05)],
    physics: fixed,
    build: ({ width, depth, thickness }) => [box([0, 0, thickness / 2], [width, depth, thickness], C.concrete)],
  },
  {
    id: 'ramp',
    name: 'Ramp',
    category: 'structure',
    blurb: 'A wedge rising along +X.',
    params: [p('length', 'Length', 3, 0.2, 50, 0.5), p('width', 'Width', 1.5, 0.2, 20, 0.1), p('height', 'Height', 0.5, 0.02, 10, 0.05)],
    physics: fixed,
    build: ({ length, width, height }) => [wedge(length, width, height, C.concrete)],
  },
  {
    id: 'stairs',
    name: 'Stairs',
    category: 'structure',
    blurb: 'Steps climbing along +X, each a solid block.',
    params: [p('steps', 'Steps', 6, 1, 60, 1, ''), p('rise', 'Rise', 0.17, 0.02, 1, 0.01), p('run', 'Run', 0.28, 0.05, 2, 0.01), p('width', 'Width', 1.2, 0.2, 20, 0.1)],
    physics: fixed,
    build: ({ steps, rise, run, width }) => {
      const n = Math.max(1, Math.round(steps));
      const pieces: Piece[] = [];
      for (let i = 0; i < n; i++) pieces.push(box([run * (i + 0.5), 0, (rise * (i + 1)) / 2], [run, width, rise * (i + 1)], C.concrete));
      return pieces;
    },
  },
  {
    id: 'fence',
    name: 'Fence',
    category: 'outdoor',
    blurb: 'Posts along X with two rails.',
    params: [p('length', 'Length', 6, 0.5, 200, 0.5), p('height', 'Height', 1.2, 0.3, 5, 0.1), p('spacing', 'Post spacing', 2, 0.5, 10, 0.5)],
    physics: fixed,
    build: ({ length, height, spacing }) => {
      const pieces: Piece[] = [];
      const posts = Math.max(2, Math.round(length / spacing) + 1);
      for (let i = 0; i < posts; i++) pieces.push(box([-length / 2 + (i / (posts - 1)) * length, 0, height / 2], [0.08, 0.08, height], C.wood));
      for (const z of [height * 0.45, height * 0.9]) pieces.push(box([0, 0, z], [length, 0.04, 0.1], C.wood));
      return pieces;
    },
  },
  {
    id: 'road',
    name: 'Road',
    category: 'road',
    blurb: 'A stretch of asphalt along X with a dashed centre line and curbs.',
    params: [p('length', 'Length', 20, 1, 500, 1), p('width', 'Width', 7, 2, 30, 0.5), p('curb', 'Curb height', 0.12, 0, 0.5, 0.02)],
    physics: fixed,
    build: ({ length, width, curb }) => {
      const pieces: Piece[] = [box([0, 0, 0.01], [length, width, 0.02], C.asphalt)];
      for (let x = -length / 2 + 1; x < length / 2 - 1; x += 4) pieces.push(box([x + 1, 0, 0.021], [2, 0.12, 0.002], C.paint));
      if (curb > 0) for (const s of [1, -1]) pieces.push(box([0, s * (width / 2 + 0.1), curb / 2], [length, 0.2, curb], C.concrete));
      return pieces;
    },
  },
  {
    id: 'parking',
    name: 'Parking lot',
    category: 'road',
    blurb: 'Asphalt with painted bays along +Y and a curb around.',
    params: [p('bays', 'Bays', 6, 1, 60, 1, ''), p('bayWidth', 'Bay width', 2.6, 2, 4, 0.1), p('bayLength', 'Bay length', 5, 3, 8, 0.5), p('aisle', 'Aisle', 6, 2, 12, 0.5)],
    physics: fixed,
    build: ({ bays, bayWidth, bayLength, aisle }) => {
      const n = Math.max(1, Math.round(bays));
      const width = n * bayWidth + 1, depth = bayLength + aisle + 1;
      const pieces: Piece[] = [box([0, 0, 0.01], [width, depth, 0.02], C.asphalt)];
      const y0 = depth / 2 - 0.5 - bayLength;
      for (let i = 0; i <= n; i++) pieces.push(box([-width / 2 + 0.5 + i * bayWidth, y0 + bayLength / 2, 0.021], [0.1, bayLength, 0.002], C.paint));
      for (const [x, y, sx, sy] of [
        [0, depth / 2 + 0.1, width + 0.4, 0.2],
        [0, -depth / 2 - 0.1, width + 0.4, 0.2],
        [width / 2 + 0.1, 0, 0.2, depth],
        [-width / 2 - 0.1, 0, 0.2, depth],
      ])
        pieces.push(box([x, y, 0.06], [sx, sy, 0.12], C.concrete));
      return pieces;
    },
  },
  {
    id: 'curb',
    name: 'Curb',
    category: 'road',
    blurb: 'A straight curb along X.',
    params: [p('length', 'Length', 4, 0.2, 100, 0.5), p('height', 'Height', 0.12, 0.02, 0.5, 0.01), p('width', 'Width', 0.2, 0.05, 1, 0.05)],
    physics: fixed,
    build: ({ length, height, width }) => [box([0, 0, height / 2], [length, width, height], C.concrete)],
  },
  {
    id: 'barrier',
    name: 'Jersey barrier',
    category: 'road',
    blurb: 'A concrete road barrier, wide at the foot.',
    params: [p('length', 'Length', 3, 0.5, 20, 0.5), p('height', 'Height', 0.8, 0.3, 2, 0.1)],
    physics: fixed,
    build: ({ length, height }) => [box([0, 0, height * 0.15], [length, 0.6, height * 0.3], C.concrete), box([0, 0, height * 0.65], [length, 0.3, height * 0.7], C.concrete)],
  },
  {
    id: 'cone',
    name: 'Traffic cone',
    category: 'road',
    blurb: 'An orange cone on a square base; loose, so a robot can knock it over.',
    params: [p('height', 'Height', 0.7, 0.2, 2, 0.05)],
    physics: loose(2, 0.7),
    build: ({ height }) => [box([0, 0, 0.02], [height * 0.55, height * 0.55, 0.04], C.rubber), cylinder([0, 0, 0.04], height * 0.2, height - 0.04, C.orange, 16, height * 0.04)],
  },
  {
    id: 'lamp',
    name: 'Lamp post',
    category: 'outdoor',
    blurb: 'A steel post with an arm and a lamp head.',
    params: [p('height', 'Height', 6, 2, 15, 0.5), p('arm', 'Arm', 1.5, 0, 4, 0.25)],
    physics: fixed,
    build: ({ height, arm }) => {
      const pieces: Piece[] = [cylinder([0, 0, 0], 0.08, height, C.steel, 12, 0.06)];
      if (arm > 0) pieces.push(box([arm / 2, 0, height - 0.05], [arm, 0.08, 0.08], C.steel));
      pieces.push(box([arm, 0, height - 0.15], [0.5, 0.25, 0.15], C.white));
      return pieces;
    },
  },
  {
    id: 'tree',
    name: 'Tree',
    category: 'outdoor',
    blurb: 'A trunk and a round canopy; collides as its trunk and canopy both.',
    params: [p('height', 'Height', 6, 1, 30, 0.5), p('canopy', 'Canopy radius', 2, 0.3, 12, 0.25), p('seed', 'Seed', 1, 1, 1000, 1, '')],
    physics: fixed,
    build: ({ height, canopy, seed }) => [cylinder([0, 0, 0], Math.max(0.06, height * 0.03), height - canopy, C.trunk, 10, Math.max(0.04, height * 0.02)), sphere([0, 0, height - canopy], canopy, C.leaf, 12, 0.12, Math.round(seed), 0.85)],
  },
  {
    id: 'rock',
    name: 'Rock',
    category: 'outdoor',
    blurb: 'A boulder, different for every seed.',
    params: [p('size', 'Size', 1, 0.1, 10, 0.1), p('seed', 'Seed', 1, 1, 1000, 1, '')],
    physics: fixed,
    // Squashed to three quarters and set so its underside just meets the ground.
    build: ({ size, seed }) => [sphere([0, 0, size * 0.4], size / 2, C.rock, 10, 0.25, Math.round(seed), 0.75)],
  },
  {
    id: 'bridge',
    name: 'Bridge span',
    category: 'outdoor',
    blurb: 'A deck along X on two piers, with railings: spans a valley sculpted into the terrain.',
    params: [p('length', 'Length', 12, 2, 100, 1), p('width', 'Width', 3, 1, 20, 0.5), p('height', 'Deck height', 3, 0.3, 50, 0.5)],
    physics: fixed,
    build: ({ length, width, height }) => {
      const pieces: Piece[] = [box([0, 0, height - 0.15], [length, width, 0.3], C.concrete)];
      for (const x of [-length / 2 + 0.5, length / 2 - 0.5]) pieces.push(box([x, 0, (height - 0.3) / 2], [1, width * 0.8, height - 0.3], C.concrete));
      for (const s of [1, -1]) pieces.push(box([0, s * (width / 2 - 0.05), height + 0.5], [length, 0.1, 1], C.steel));
      return pieces;
    },
  },
  {
    id: 'crate',
    name: 'Crate',
    category: 'indoor',
    blurb: 'A cardboard box; loose by default.',
    params: [p('size', 'Size', 0.5, 0.05, 3, 0.05)],
    physics: loose(5, 0.6),
    build: ({ size }) => [box([0, 0, size / 2], [size, size, size], C.cardboard)],
  },
  {
    id: 'pallet',
    name: 'Pallet',
    category: 'indoor',
    blurb: 'A wooden pallet, 1.2 by 0.8 m unless told otherwise.',
    params: [p('length', 'Length', 1.2, 0.5, 3, 0.1), p('width', 'Width', 0.8, 0.5, 3, 0.1)],
    physics: loose(20, 0.7),
    build: ({ length, width }) => {
      const pieces: Piece[] = [];
      for (const y of [-width / 2 + 0.05, 0, width / 2 - 0.05]) pieces.push(box([0, y, 0.05], [length, 0.1, 0.1], C.wood));
      for (let i = 0; i < 7; i++) pieces.push(box([-length / 2 + 0.05 + (i * (length - 0.1)) / 6, 0, 0.12], [0.1, width, 0.04], C.wood));
      return pieces;
    },
  },
  {
    id: 'table',
    name: 'Table',
    category: 'indoor',
    blurb: 'A top on four legs.',
    params: [p('length', 'Length', 1.6, 0.4, 5, 0.1), p('width', 'Width', 0.8, 0.3, 3, 0.1), p('height', 'Height', 0.75, 0.3, 1.5, 0.05)],
    physics: fixed,
    build: ({ length, width, height }) => {
      const pieces: Piece[] = [box([0, 0, height - 0.02], [length, width, 0.04], C.wood)];
      for (const x of [-length / 2 + 0.05, length / 2 - 0.05]) for (const y of [-width / 2 + 0.05, width / 2 - 0.05]) pieces.push(box([x, y, (height - 0.04) / 2], [0.06, 0.06, height - 0.04], C.wood));
      return pieces;
    },
  },
  {
    id: 'shelf',
    name: 'Shelving',
    category: 'indoor',
    blurb: 'A rack of shelves, open at the front (-Y).',
    params: [p('length', 'Length', 2, 0.5, 10, 0.5), p('depth', 'Depth', 0.6, 0.3, 1.5, 0.1), p('height', 'Height', 2, 0.5, 6, 0.1), p('shelves', 'Shelves', 4, 1, 12, 1, '')],
    physics: fixed,
    build: ({ length, depth, height, shelves }) => {
      const n = Math.max(1, Math.round(shelves));
      const pieces: Piece[] = [];
      for (const x of [-length / 2 + 0.03, length / 2 - 0.03]) for (const y of [-depth / 2 + 0.03, depth / 2 - 0.03]) pieces.push(box([x, y, height / 2], [0.06, 0.06, height], C.steel));
      for (let i = 0; i < n; i++) pieces.push(box([0, 0, 0.1 + (i * (height - 0.2)) / Math.max(1, n - 1)], [length, depth, 0.03], C.steel));
      return pieces;
    },
  },
];

export const partById = (id: string): PartDef | undefined => PARTS.find((p) => p.id === id);

/** The spec's defaults with `params` over them, clamped and stepped, so a part always builds. */
export function settle(def: PartDef, params: PartParams): PartParams {
  const out: PartParams = {};
  for (const spec of def.params) {
    const raw = params[spec.id];
    const v = typeof raw === 'number' && Number.isFinite(raw) ? raw : spec.value;
    out[spec.id] = Math.min(spec.max, Math.max(spec.min, v));
  }
  return out;
}

/** The part's pieces and their merged mesh. */
export function buildPart(def: PartDef, params: PartParams): { pieces: MeshData[]; merged: MeshData } {
  const pieces = def.build(settle(def, params));
  return { pieces: pieces.map((p) => p.data), merged: merge(pieces) };
}

// --- helpers --------------------------------------------------------------------

/** A wall along X about `at`, turned by `yaw`, with a doorway (two jambs and a lintel) when `door` is more than 0. */
function wallPieces(length: number, height: number, thickness: number, door: number, doorHeight: number, color: Vec3, at: Vec3 = [0, 0, 0], yaw = 0): Piece[] {
  const place = (lx: number, size: Vec3, lz: number): Piece => {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    return box([at[0] + lx * c, at[1] + lx * s, at[2] + lz], size, color, yaw);
  };
  if (door <= 0 || door >= length) return [place(0, [length, thickness, height], height / 2)];
  const side = (length - door) / 2;
  const pieces = [place(-length / 2 + side / 2, [side, thickness, height], height / 2), place(length / 2 - side / 2, [side, thickness, height], height / 2)];
  if (doorHeight < height) pieces.push(place(0, [door, thickness, height - doorHeight], doorHeight + (height - doorHeight) / 2));
  return pieces;
}

/** A wedge rising along +X: triangular sides, flat top. */
function wedge(length: number, width: number, height: number, color: Vec3): Piece {
  const hw = width / 2;
  const positions = [0, -hw, 0, length, -hw, 0, length, -hw, height, 0, hw, 0, length, hw, 0, length, hw, height];
  const indices = [0, 1, 2, 3, 5, 4, 0, 3, 4, 0, 4, 1, 1, 4, 5, 1, 5, 2, 0, 2, 5, 0, 5, 3];
  const colors = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    colors[i] = color[0];
    colors[i + 1] = color[1];
    colors[i + 2] = color[2];
  }
  return { data: { positions: Float32Array.from(positions), indices: Uint32Array.from(indices), colors }, color };
}
