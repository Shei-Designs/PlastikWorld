// The world: what the app edits and what every engine writer reads. Deliberately small and
// engine-neutral: placed assets with poses and physics tags, a terrain, lights and spawn points.
// Units are SI throughout (meters, kilograms, radians) with Z up, as the simulators want them;
// PlastikCAD's exports arrive in meters already.
//
// A world carries its assets inside it (a GLB's bytes, a robot package's files), as a
// PlastikCAD project carries its imports: one file is one world, so autosave, sync and
// Android (where a file picked once cannot be read again by path) all work the same way.
import { newId } from './math';

export type Vec3 = [number, number, number];

/** A frame in the world: translation in meters, then roll, pitch, yaw in radians about the fixed X, Y, Z axes (the ROS convention). */
export interface Pose {
  xyz: Vec3;
  rpy: Vec3;
}

export const IDENTITY_POSE: Pose = { xyz: [0, 0, 0], rpy: [0, 0, 0] };

/** Where an asset came from: the file's name, and its path on disk when the desktop app picked it, so it can be imported again after PlastikCAD re-exports it. */
export interface Source {
  name: string;
  path: string | null;
  size: number;
}

/** A static object from PlastikCAD (a GLB: meters, Y up as glTF wants, colours embedded). */
export interface MeshAsset {
  kind: 'mesh';
  id: string;
  name: string;
  source: Source;
  /** The GLB itself. Empty when a file from before worlds carried their assets could not be read back. */
  data: Uint8Array;
}

/** The engines a robot package can be written for, and the file inside the package each one reads. */
export type RobotFormat = 'ros' | 'gazebo' | 'mujoco';

/**
 * A robot from PlastikCAD: a ROS 2 package (URDF), a Gazebo model folder
 * (model.sdf) or a MuJoCo model (MJCF). The package's files travel with the
 * world; what the writers need to know about it (its name, its base link or
 * body) is read once on import.
 */
export interface RobotAsset {
  kind: 'robot';
  id: string;
  name: string;
  format: RobotFormat;
  /** The folder the package came from. */
  source: Source;
  /** The package or model name, as `model://` and `package://` URIs refer to it. */
  modelName: string;
  /** The file the engine reads, relative to the folder: `urdf/<name>.urdf`, `model.sdf` or `<name>.xml`. */
  entry: string;
  /** MuJoCo: the body under `<worldbody>` that `<attach>` brings in. Null when the file has none. */
  rootBody: string | null;
  /** Isaac: the USD stage the package carries (PlastikCAD writes one under `isaac/`), relative to the folder, if any. */
  usd: string | null;
  /** The package's files by path relative to its folder, forward slashes. Empty for a package that could not be read back. */
  files: Record<string, Uint8Array>;
  /** How the package says the robot is driven (its Gazebo plugin, its drive.json), for the demo drive; absent when it says nothing. */
  drive?: { model: 'differential' | 'ackermann' | 'holonomic'; speed: number; turn: number; wheelbase: number };
  /** Forward in the robot's own frame, as an angle from its +X, when the package says (a PlastikCAD MuJoCo export does). */
  forward?: number;
}

/** A piece from the parts library: made from its parameters whenever it is needed, so the world carries only the numbers. */
export interface PartAsset {
  kind: 'part';
  id: string;
  name: string;
  /** The generator's id in `src/parts/library.ts`. */
  part: string;
  params: Record<string, number>;
  source: Source;
}

export type Asset = MeshAsset | RobotAsset | PartAsset;

/** Whether an asset's data is with the world (it can be drawn and exported). */
export const assetPresent = (asset: Asset): boolean => (asset.kind === 'mesh' ? asset.data.length > 0 : asset.kind === 'robot' ? Object.keys(asset.files).length > 0 : true);

/** Whether an asset is a prop with triangles of its own (a GLB or a library part), as against a robot. */
export const isProp = (asset: Asset | undefined): asset is MeshAsset | PartAsset => asset?.kind === 'mesh' || asset?.kind === 'part';

/** How an object takes part in the physics. */
export interface Physics {
  /** Fixed in the world (a wall, a staircase) rather than free to move. */
  static: boolean;
  /** Kilograms, for a free object. */
  mass: number;
  /** Coulomb friction of its surface. */
  friction: number;
  /** What the engine collides with: the mesh itself, its bounding box, or nothing. */
  collision: 'mesh' | 'box' | 'none';
}

export const DEFAULT_PHYSICS: Physics = { static: true, mass: 1, friction: 0.8, collision: 'mesh' };

/** An asset placed in the world. A robot is placed too: its pose is where it starts. */
export interface Placed {
  id: string;
  name: string;
  asset: string;
  pose: Pose;
  /** A uniform scale on a mesh; robots are never scaled. */
  scale: number;
  physics: Physics;
  /** How the demo drive moves it, once chosen (`src/drive/kinematics.ts`); unset means the default differential drive. */
  drive?: { model: 'differential' | 'ackermann' | 'holonomic'; speed: number; turn: number; wheelbase: number };
}

/**
 * The sample counts a heightmap may have along each side: 2^n + 1, the size
 * Gazebo's heightmap images must be, so that all three engines get the very
 * same samples and nothing is resampled on the way out. 1025 is the working
 * ceiling (Isaac gets the ground as a triangle mesh, two million of them at
 * that size); 2049 is allowed with a warning.
 */
export const GRID_SIZES = [65, 129, 257, 513, 1025, 2049] as const;
export const GRID_MAX = 1025;
export const GRID_DEFAULT = 129;

/** The grid size nearest to `n` among those allowed. */
export function snapGridSize(n: number): number {
  let best: number = GRID_SIZES[0];
  for (const size of GRID_SIZES) if (Math.abs(size - n) < Math.abs(best - n)) best = size;
  return best;
}

/**
 * The ground: a flat plane, or a heightmap of `rows` × `cols` samples over
 * `size`, in meters. Rows run along Y from -Y, columns along X from -X; the
 * grid is square (`rows === cols`, one of GRID_SIZES) in every world the app
 * writes, while the area may be oblong.
 */
export type Terrain =
  | { kind: 'plane'; size: [number, number]; friction: number }
  | { kind: 'heightmap'; size: [number, number]; friction: number; rows: number; cols: number; heights: Float32Array };

export type LightKind = 'sun' | 'point' | 'spot';

export interface Light {
  id: string;
  name: string;
  kind: LightKind;
  pose: Pose;
  /** Linear RGB, 0..1. */
  color: Vec3;
  intensity: number;
  castShadows: boolean;
  /** A sun's direction (unit vector); points and spots use the pose instead. */
  direction: Vec3;
  /** A spot's cone, radians. */
  cone: number;
}

/** A surface the ground can have: what the engines read as friction and restitution, and the colour it is painted in the viewport. */
export interface Material {
  id: string;
  name: string;
  /** Coulomb friction. */
  friction: number;
  /** Bounciness, 0..1. */
  restitution: number;
  /** Linear RGB, 0..1. */
  color: Vec3;
}

/** Ready-made surfaces, to add to a world. */
export const MATERIAL_PRESETS: Omit<Material, 'id'>[] = [
  { name: 'Asphalt', friction: 0.9, restitution: 0.1, color: [0.22, 0.22, 0.24] },
  { name: 'Concrete', friction: 0.8, restitution: 0.1, color: [0.62, 0.62, 0.6] },
  { name: 'Grass', friction: 0.6, restitution: 0.05, color: [0.25, 0.5, 0.18] },
  { name: 'Gravel', friction: 0.7, restitution: 0.05, color: [0.5, 0.46, 0.4] },
  { name: 'Sand', friction: 0.5, restitution: 0.02, color: [0.78, 0.68, 0.45] },
  { name: 'Mud', friction: 0.3, restitution: 0, color: [0.35, 0.25, 0.15] },
  { name: 'Ice', friction: 0.05, restitution: 0.02, color: [0.75, 0.88, 0.95] },
  { name: 'Rubber', friction: 1.2, restitution: 0.3, color: [0.1, 0.1, 0.1] },
];

/**
 * A patch of the ground with a surface of its own: a rectangle in the
 * terrain's frame, meters, [x0, y0, x1, y1]. Rectangles first, since a
 * MuJoCo heightfield is one; Isaac binds the material to the faces inside,
 * Gazebo and MuJoCo get a collision piece per zone laid over the ground.
 */
export interface Zone {
  id: string;
  name: string;
  /** The material's id in `World.materials`. */
  material: string;
  rect: [number, number, number, number];
}

/** A named pose: where a robot may be started from a launch file, or a goal for a navigation task. */
export interface SpawnPoint {
  id: string;
  name: string;
  pose: Pose;
}

export interface World {
  /** Identifies the world across copies and devices (what sync matches on); the file's name is only where it is now. */
  id: string;
  name: string;
  gravity: Vec3;
  terrain: Terrain;
  assets: Asset[];
  objects: Placed[];
  lights: Light[];
  spawns: SpawnPoint[];
  /** The surfaces the ground can have, and where it has them. */
  materials: Material[];
  zones: Zone[];
  environment: Environment;
  /** Stamped on each save, so that two devices can tell whether the other changed the world since they last agreed. */
  revision?: string;
  /** The revision this one followed. */
  parent?: string;
  /** The device that saved it. */
  device?: string;
  /** When it was saved, ISO 8601. */
  saved?: string;
  /** A small JPEG data URL of the viewport, for the worlds browser. */
  thumb?: string;
}

/** The sky, the fog and the wind: what all three engines can take of the weather, the rest is parked. */
export interface Environment {
  /** The look of the sky and the time of day; cameras and lidar see it in Gazebo and Isaac, MuJoCo draws it only. */
  sky: SkyPreset;
  /** Linear fog, for cameras and lidar; null for clear air. */
  fog: { color: Vec3; start: number; end: number } | null;
  /** A steady wind, m/s, in the world frame; zero for still air. Gazebo and MuJoCo blow, Isaac has no wind. */
  wind: Vec3;
}

export type SkyPreset = 'clear' | 'overcast' | 'dusk' | 'night';

export const SKY_PRESETS: { id: SkyPreset; label: string; hour: number; color: Vec3; horizon: Vec3; ambient: number }[] = [
  { id: 'clear', label: 'Clear day', hour: 12, color: [0.45, 0.65, 0.95], horizon: [0.82, 0.88, 0.95], ambient: 0.4 },
  { id: 'overcast', label: 'Overcast', hour: 13, color: [0.62, 0.65, 0.7], horizon: [0.78, 0.8, 0.82], ambient: 0.55 },
  { id: 'dusk', label: 'Dusk', hour: 18.5, color: [0.28, 0.25, 0.45], horizon: [0.95, 0.55, 0.3], ambient: 0.25 },
  { id: 'night', label: 'Night', hour: 23, color: [0.03, 0.04, 0.09], horizon: [0.08, 0.09, 0.15], ambient: 0.06 },
];

export const DEFAULT_ENVIRONMENT: Environment = { sky: 'clear', fog: null, wind: [0, 0, 0] };

export const skyOf = (preset: SkyPreset) => SKY_PRESETS.find((p) => p.id === preset) ?? SKY_PRESETS[0];

/** Any of the things the sidebar lists and the inspector edits. */
export type Pick = { kind: 'object'; id: string } | { kind: 'light'; id: string } | { kind: 'spawn'; id: string } | { kind: 'zone'; id: string } | { kind: 'terrain' } | { kind: 'world' };

export function emptyWorld(name = 'Untitled'): World {
  return {
    id: newId(),
    name,
    gravity: [0, 0, -9.81],
    terrain: { kind: 'plane', size: [20, 20], friction: 1 },
    assets: [],
    objects: [],
    lights: [
      {
        id: 'sun',
        name: 'Sun',
        kind: 'sun',
        pose: { xyz: [0, 0, 10], rpy: [0, 0, 0] },
        color: [0.8, 0.8, 0.8],
        intensity: 1,
        castShadows: true,
        direction: [-0.5, 0.1, -0.9],
        cone: Math.PI / 6,
      },
    ],
    spawns: [],
    materials: [],
    zones: [],
    environment: { ...DEFAULT_ENVIRONMENT },
  };
}

export const materialOf = (world: World, zone: Zone): Material | undefined => world.materials.find((m) => m.id === zone.material);

export const assetOf = (world: World, placed: Placed): Asset | undefined => world.assets.find((a) => a.id === placed.asset);
