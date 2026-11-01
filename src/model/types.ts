// The world: what the app edits and what every engine writer reads. Deliberately small and
// engine-neutral: placed assets with poses and physics tags, a terrain, lights and spawn points.
// Units are SI throughout (meters, kilograms, radians) with Z up, as the simulators want them;
// PlastikCAD's exports arrive in meters already.

export type Vec3 = [number, number, number];

/** A frame in the world: translation in meters, then roll, pitch, yaw in radians about the fixed X, Y, Z axes (the ROS convention). */
export interface Pose {
  xyz: Vec3;
  rpy: Vec3;
}

export const IDENTITY_POSE: Pose = { xyz: [0, 0, 0], rpy: [0, 0, 0] };

/** Where a file the world refers to lives: its path on disk (desktop), or only its name when it came from a browser pick or a drop. */
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
}

/** The engines a robot package can be written for, and the file inside the package each one reads. */
export type RobotFormat = 'ros' | 'gazebo' | 'mujoco';

/**
 * A robot from PlastikCAD: a ROS 2 package (URDF), a Gazebo model folder
 * (model.sdf) or a MuJoCo model (MJCF). The folder is kept by reference; what
 * the writers need to know about it (its name, its base link or body) is read
 * once on import.
 */
export interface RobotAsset {
  kind: 'robot';
  id: string;
  name: string;
  format: RobotFormat;
  /** The folder the package lives in. */
  source: Source;
  /** The package or model name, as `model://` and `package://` URIs refer to it. */
  modelName: string;
  /** The file the engine reads, relative to the folder: `urdf/<name>.urdf`, `model.sdf` or `<name>.xml`. */
  entry: string;
  /** MuJoCo: the body under `<worldbody>` that `<attach>` brings in. Null when the file has none. */
  rootBody: string | null;
  /** Isaac: the USD stage the package carries (PlastikCAD writes one under `isaac/`), relative to the folder, if any. */
  usd: string | null;
}

export type Asset = MeshAsset | RobotAsset;

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
}

/** The ground: a flat plane, or a heightmap of `rows` × `cols` samples over `size`, each 0..1 of `height` meters. */
export type Terrain =
  | { kind: 'plane'; size: [number, number]; friction: number }
  | { kind: 'heightmap'; size: [number, number]; friction: number; rows: number; cols: number; height: number; heights: number[] };

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

/** A named pose: where a robot may be started from a launch file, or a goal for a navigation task. */
export interface SpawnPoint {
  id: string;
  name: string;
  pose: Pose;
}

export interface World {
  name: string;
  gravity: Vec3;
  terrain: Terrain;
  assets: Asset[];
  objects: Placed[];
  lights: Light[];
  spawns: SpawnPoint[];
}

/** Any of the things the sidebar lists and the inspector edits. */
export type Pick = { kind: 'object'; id: string } | { kind: 'light'; id: string } | { kind: 'spawn'; id: string } | { kind: 'terrain' } | { kind: 'world' };

export function emptyWorld(name = 'Untitled'): World {
  return {
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
  };
}

export const assetOf = (world: World, placed: Placed): Asset | undefined => world.assets.find((a) => a.id === placed.asset);
