// The world file: JSON with a format marker and a version, so that a file from
// a later app can be refused with a clear word rather than misread.
import { FILE_FORMAT, FILE_VERSION } from '../app';
import { decodeText, encodeText } from '../io/format';
import { DEFAULT_PHYSICS, emptyWorld, IDENTITY_POSE } from './types';
import type { Asset, Light, Placed, Pose, SpawnPoint, Terrain, Vec3, World } from './types';

interface WorldFile {
  format: typeof FILE_FORMAT;
  version: number;
  world: World;
}

export function serializeWorld(world: World): Uint8Array {
  const file: WorldFile = { format: FILE_FORMAT, version: FILE_VERSION, world };
  return encodeText(JSON.stringify(file, null, 2) + '\n');
}

const isVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x));
const vec3 = (v: unknown, fallback: Vec3): Vec3 => (isVec3(v) ? [v[0], v[1], v[2]] : fallback);
const str = (v: unknown, fallback: string): string => (typeof v === 'string' ? v : fallback);
const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);
const record = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.map(record) : []);

const pose = (v: unknown): Pose => {
  const p = record(v);
  return { xyz: vec3(p.xyz, IDENTITY_POSE.xyz), rpy: vec3(p.rpy, IDENTITY_POSE.rpy) };
};

const source = (v: unknown, name: string) => {
  const s = record(v);
  return { name: str(s.name, name), path: typeof s.path === 'string' ? s.path : null, size: num(s.size, 0) };
};

function asset(raw: Record<string, unknown>, index: number): Asset | null {
  const id = str(raw.id, '');
  if (!id) return null;
  const name = str(raw.name, `Asset ${index + 1}`);
  if (raw.kind === 'robot') {
    const format = raw.format === 'ros' || raw.format === 'gazebo' || raw.format === 'mujoco' ? raw.format : null;
    if (!format) return null;
    return {
      kind: 'robot',
      id,
      name,
      format,
      source: source(raw.source, name),
      modelName: str(raw.modelName, name),
      entry: str(raw.entry, ''),
      rootBody: typeof raw.rootBody === 'string' ? raw.rootBody : null,
      usd: typeof raw.usd === 'string' ? raw.usd : null,
    };
  }
  return { kind: 'mesh', id, name, source: source(raw.source, name) };
}

function placed(raw: Record<string, unknown>, index: number, assets: Set<string>): Placed | null {
  const id = str(raw.id, '');
  const assetId = str(raw.asset, '');
  if (!id || !assets.has(assetId)) return null;
  const physics = record(raw.physics);
  const collision = physics.collision === 'box' || physics.collision === 'none' ? physics.collision : 'mesh';
  return {
    id,
    name: str(raw.name, `Object ${index + 1}`),
    asset: assetId,
    pose: pose(raw.pose),
    scale: Math.max(num(raw.scale, 1), 1e-6),
    physics: { static: bool(physics.static, DEFAULT_PHYSICS.static), mass: Math.max(num(physics.mass, DEFAULT_PHYSICS.mass), 0), friction: Math.max(num(physics.friction, DEFAULT_PHYSICS.friction), 0), collision },
  };
}

function light(raw: Record<string, unknown>, index: number): Light | null {
  const id = str(raw.id, '');
  if (!id) return null;
  const kind = raw.kind === 'point' || raw.kind === 'spot' ? raw.kind : 'sun';
  return {
    id,
    name: str(raw.name, `Light ${index + 1}`),
    kind,
    pose: pose(raw.pose),
    color: vec3(raw.color, [1, 1, 1]),
    intensity: Math.max(num(raw.intensity, 1), 0),
    castShadows: bool(raw.castShadows, kind === 'sun'),
    direction: vec3(raw.direction, [-0.5, 0.1, -0.9]),
    cone: num(raw.cone, Math.PI / 6),
  };
}

function spawn(raw: Record<string, unknown>, index: number): SpawnPoint | null {
  const id = str(raw.id, '');
  return id ? { id, name: str(raw.name, `Spawn ${index + 1}`), pose: pose(raw.pose) } : null;
}

function terrain(raw: Record<string, unknown>): Terrain {
  const sizeRaw = Array.isArray(raw.size) ? raw.size : [];
  const size: [number, number] = [Math.max(num(sizeRaw[0], 20), 0.1), Math.max(num(sizeRaw[1], 20), 0.1)];
  const friction = Math.max(num(raw.friction, 1), 0);
  if (raw.kind === 'heightmap') {
    const rows = Math.max(Math.round(num(raw.rows, 2)), 2);
    const cols = Math.max(Math.round(num(raw.cols, 2)), 2);
    const heights = Array.isArray(raw.heights) && raw.heights.length === rows * cols ? raw.heights.map((h) => Math.min(Math.max(num(h, 0), 0), 1)) : new Array<number>(rows * cols).fill(0);
    return { kind: 'heightmap', size, friction, rows, cols, height: Math.max(num(raw.height, 1), 0), heights };
  }
  return { kind: 'plane', size, friction };
}

/** Reads a world file; throws with a readable message when it is not one. */
export function parseWorld(bytes: Uint8Array): World {
  let data: unknown;
  try {
    data = JSON.parse(decodeText(bytes));
  } catch {
    throw new Error('This is not a world file (it is not valid JSON).');
  }
  const file = record(data);
  if (file.format !== FILE_FORMAT) throw new Error('This is not a world file.');
  const version = num(file.version, 0);
  if (version > FILE_VERSION) throw new Error(`This world was saved by a newer version of the app (file version ${version}); please update.`);
  const raw = record(file.world);
  const base = emptyWorld(str(raw.name, 'Untitled'));
  const assets = list(raw.assets).map(asset).filter((a): a is Asset => a !== null);
  const ids = new Set(assets.map((a) => a.id));
  const lights = list(raw.lights).map(light).filter((l): l is Light => l !== null);
  return {
    name: base.name,
    gravity: vec3(raw.gravity, base.gravity),
    terrain: terrain(record(raw.terrain)),
    assets,
    objects: list(raw.objects)
      .map((o, i) => placed(o, i, ids))
      .filter((o): o is Placed => o !== null),
    lights: raw.lights === undefined ? base.lights : lights,
    spawns: list(raw.spawns).map(spawn).filter((s): s is SpawnPoint => s !== null),
  };
}

/** Whether these bytes begin like a world file, without parsing it all. */
export function looksLikeWorld(bytes: Uint8Array): boolean {
  const head = decodeText(bytes.subarray(0, 200));
  return head.includes(`"${FILE_FORMAT}"`);
}
