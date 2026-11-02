// Reading and writing world files. A world is a single JSON document that
// holds the scene, its assets and its terrain, laid out like a PlastikCAD
// project: a header first, each field on a line of its own, so that a worlds
// folder can be listed by reading the start of each file (`readHeader`); the
// scene after it; the assets last, since they are the bulk of the file.
//
// Version 1 files kept assets by path and heights as 0..1 of a top height;
// they still open, with their assets marked absent until read back (the
// store does that on desktop) and their heights turned into meters.
import { FILE_FORMAT, FILE_VERSION } from '../app';
import { floatsFromBase64, floatsToBase64, fromBase64, toBase64 } from '../io/base64';
import { decodeText, encodeText } from '../io/format';
import { resample } from '../io/heightmap';
import { newId } from './math';
import { DEFAULT_PHYSICS, emptyWorld, GRID_SIZES, IDENTITY_POSE, snapGridSize } from './types';
import type { Asset, Light, Material, Placed, Pose, SpawnPoint, Terrain, Vec3, World, Zone } from './types';

/** Longest thumbnail written into a file. */
export const MAX_THUMB = 200_000;
/** How much of a file holds its header: everything before the scene, the thumbnail included. */
export const HEAD_BYTES = 256 * 1024;

const INDENT = '  ';

/** JSON with objects spread over lines and arrays of plain values (vectors) kept on one. */
function pretty(value: unknown, depth: number): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  const pad = INDENT.repeat(depth + 1);
  const end = INDENT.repeat(depth);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (value.every((v) => v === null || typeof v !== 'object')) return JSON.stringify(value);
    return `[\n${value.map((v) => pad + pretty(v, depth + 1)).join(',\n')}\n${end}]`;
  }
  const entries = Object.entries(value).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return '{}';
  return `{\n${entries.map(([k, v]) => `${pad}${JSON.stringify(k)}: ${pretty(v, depth + 1)}`).join(',\n')}\n${end}}`;
}

const terrainJson = (t: Terrain): Record<string, unknown> =>
  t.kind === 'heightmap' ? { kind: t.kind, size: t.size, friction: t.friction, rows: t.rows, cols: t.cols, heights: floatsToBase64(t.heights) } : { kind: t.kind, size: t.size, friction: t.friction };

const assetJson = (a: Asset): Record<string, unknown> =>
  a.kind === 'mesh'
    ? { kind: a.kind, id: a.id, name: a.name, source: a.source, data: toBase64(a.data) }
    : a.kind === 'part'
      ? { kind: a.kind, id: a.id, name: a.name, part: a.part, params: a.params, source: a.source }
      : { kind: a.kind, id: a.id, name: a.name, format: a.format, source: a.source, modelName: a.modelName, entry: a.entry, rootBody: a.rootBody, usd: a.usd, files: Object.fromEntries(Object.keys(a.files).sort().map((p) => [p, toBase64(a.files[p])])) };

/** The world as text: the header first, the scene, then the assets. */
export function serializeWorldText(world: World): string {
  const file = {
    format: FILE_FORMAT,
    version: FILE_VERSION,
    id: world.id,
    name: world.name,
    revision: world.revision,
    parent: world.parent,
    device: world.device,
    saved: world.saved,
    thumb: world.thumb,
    gravity: world.gravity,
    terrain: terrainJson(world.terrain),
    objects: world.objects,
    lights: world.lights,
    spawns: world.spawns,
    materials: world.materials,
    zones: world.zones,
    assets: world.assets.map(assetJson),
  };
  return pretty(file, 0) + '\n';
}

export const serializeWorld = (world: World): Uint8Array => encodeText(serializeWorldText(world));

const isVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x));
const vec3 = (v: unknown, fallback: Vec3): Vec3 => (isVec3(v) ? [v[0], v[1], v[2]] : fallback);
const str = (v: unknown, fallback: string): string => (typeof v === 'string' ? v : fallback);
const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);
const record = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.map(record) : []);
const readId = (raw: unknown): string | null => (typeof raw === 'string' && /^[a-z0-9]{8,32}$/.test(raw) ? raw : null);
const readThumb = (raw: unknown): string | undefined =>
  typeof raw === 'string' && raw.length <= MAX_THUMB && /^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(raw) ? raw : undefined;

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
    const files: Record<string, Uint8Array> = {};
    for (const [path, data] of Object.entries(record(raw.files))) if (typeof data === 'string' && path && !path.startsWith('/') && !path.includes('..')) files[path] = fromBase64(data);
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
      files,
    };
  }
  if (raw.kind === 'part') {
    const part = str(raw.part, '');
    if (!part) return null;
    const params: Record<string, number> = {};
    for (const [k, v] of Object.entries(record(raw.params))) if (typeof v === 'number' && Number.isFinite(v)) params[k] = v;
    return { kind: 'part', id, name, part, params, source: source(raw.source, 'Parts library') };
  }
  return { kind: 'mesh', id, name, source: source(raw.source, name), data: typeof raw.data === 'string' ? fromBase64(raw.data) : new Uint8Array(0) };
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

function material(raw: Record<string, unknown>, index: number): Material | null {
  const id = str(raw.id, '');
  return id ? { id, name: str(raw.name, `Material ${index + 1}`), friction: Math.max(num(raw.friction, 0.8), 0), restitution: Math.min(Math.max(num(raw.restitution, 0), 0), 1), color: vec3(raw.color, [0.5, 0.5, 0.5]) } : null;
}

function zone(raw: Record<string, unknown>, index: number, materials: Set<string>): Zone | null {
  const id = str(raw.id, '');
  const rect = Array.isArray(raw.rect) && raw.rect.length === 4 && raw.rect.every((v) => typeof v === 'number' && Number.isFinite(v)) ? (raw.rect as number[]) : null;
  const materialId = str(raw.material, '');
  if (!id || !rect || !materials.has(materialId)) return null;
  return { id, name: str(raw.name, `Zone ${index + 1}`), material: materialId, rect: [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])] };
}

function spawn(raw: Record<string, unknown>, index: number): SpawnPoint | null {
  const id = str(raw.id, '');
  return id ? { id, name: str(raw.name, `Spawn ${index + 1}`), pose: pose(raw.pose) } : null;
}

/** The heights of a heightmap as this version writes them (base64 floats, meters) or as version 1 did (a list of 0..1 under a top height). */
function heightsOf(raw: Record<string, unknown>, rows: number, cols: number, version: number): Float32Array | null {
  if (typeof raw.heights === 'string') return floatsFromBase64(raw.heights, rows * cols);
  if (Array.isArray(raw.heights) && raw.heights.length === rows * cols) {
    const scale = version <= 1 ? Math.max(num(raw.height, 1), 0) : 1;
    return Float32Array.from(raw.heights, (h) => num(h, 0) * scale);
  }
  return null;
}

function terrain(raw: Record<string, unknown>, version: number): Terrain {
  const sizeRaw = Array.isArray(raw.size) ? raw.size : [];
  const size: [number, number] = [Math.max(num(sizeRaw[0], 20), 0.1), Math.max(num(sizeRaw[1], 20), 0.1)];
  const friction = Math.max(num(raw.friction, 1), 0);
  if (raw.kind !== 'heightmap') return { kind: 'plane', size, friction };
  const rows = Math.max(Math.round(num(raw.rows, 2)), 2);
  const cols = Math.max(Math.round(num(raw.cols, 2)), 2);
  const heights = heightsOf(raw, rows, cols, version);
  // A grid of some other size (a version 1 file, or one edited by hand) goes onto the nearest allowed one.
  const n = rows === cols && (GRID_SIZES as readonly number[]).includes(rows) ? rows : snapGridSize(Math.max(rows, cols));
  if (!heights) return { kind: 'heightmap', size, friction, rows: n, cols: n, heights: new Float32Array(n * n) };
  if (n === rows && n === cols) return { kind: 'heightmap', size, friction, rows, cols, heights };
  return { kind: 'heightmap', size, friction, rows: n, cols: n, heights: resample({ rows, cols, heights }, n) };
}

/** Reads a world file; throws with a readable message when it is not one. */
export function parseWorld(bytes: Uint8Array): World {
  return parseWorldText(decodeText(bytes));
}

export function parseWorldText(text: string): World {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('This is not a world file (it is not valid JSON).');
  }
  const file = record(data);
  if (file.format !== FILE_FORMAT) throw new Error('This is not a world file.');
  const version = num(file.version, 0);
  if (version > FILE_VERSION) throw new Error(`This world was saved by a newer version of the app (file version ${version}); please update.`);
  // Version 1 kept everything under "world".
  const raw = version <= 1 ? record(file.world) : file;
  const base = emptyWorld(str(raw.name ?? file.name, 'Untitled'));
  const assets = list(raw.assets).map(asset).filter((a): a is Asset => a !== null);
  const ids = new Set(assets.map((a) => a.id));
  const lights = list(raw.lights).map(light).filter((l): l is Light => l !== null);
  const materials = list(raw.materials).map(material).filter((m): m is Material => m !== null);
  const materialIds = new Set(materials.map((m) => m.id));
  const world: World = {
    id: readId(file.id) ?? base.id,
    name: base.name,
    gravity: vec3(raw.gravity, base.gravity),
    terrain: terrain(record(raw.terrain), version),
    assets,
    objects: list(raw.objects)
      .map((o, i) => placed(o, i, ids))
      .filter((o): o is Placed => o !== null),
    lights: raw.lights === undefined ? base.lights : lights,
    spawns: list(raw.spawns).map(spawn).filter((s): s is SpawnPoint => s !== null),
    materials,
    zones: list(raw.zones)
      .map((z, i) => zone(z, i, materialIds))
      .filter((z): z is Zone => z !== null),
  };
  const revision = readId(file.revision);
  if (revision) world.revision = revision;
  const parent = readId(file.parent);
  if (parent) world.parent = parent;
  const device = readId(file.device);
  if (device) world.device = device;
  if (typeof file.saved === 'string' && !Number.isNaN(Date.parse(file.saved))) world.saved = file.saved;
  const thumb = readThumb(file.thumb);
  if (thumb) world.thumb = thumb;
  return world;
}

/** Whether these bytes begin like a world file, without parsing it all. */
export function looksLikeWorld(bytes: Uint8Array): boolean {
  const head = decodeText(bytes.subarray(0, 200));
  return head.includes(`"${FILE_FORMAT}"`);
}

export interface WorldHeader {
  /** Null when the file carries no id (saved by version 1). */
  id: string | null;
  name: string;
  revision: string | null;
  thumb: string | null;
}

/**
 * The header of a world from the start of its text, which need not be the
 * whole file: `serializeWorld` puts each header field on its own line before
 * the scene. Null when the text is not the start of a world file.
 */
export function readHeader(head: string): WorldHeader | null {
  if (!new RegExp(`^\\{\\s*\\n\\s*"format": "${FILE_FORMAT}",`).test(head)) return null;
  // Only what comes before the terrain is the header: the objects after it have names of their own.
  const sceneAt = head.search(/^\s*"(gravity|terrain|world)":/m);
  const header = sceneAt < 0 ? head : head.slice(0, sceneAt);
  const field = (name: string): string | null => {
    const match = new RegExp(`^\\s*"${name}": ("(?:[^"\\\\]|\\\\.)*")\\s*,?$`, 'm').exec(header);
    if (!match) return null;
    try {
      return JSON.parse(match[1]) as string;
    } catch {
      return null;
    }
  };
  const name = field('name');
  if (name === null && sceneAt < 0) return null;
  return { id: readId(field('id')), name: name?.trim() ? name : 'Untitled', revision: readId(field('revision')), thumb: readThumb(field('thumb') ?? undefined) ?? null };
}

/** The header of a world from its full text, for stores that keep whole texts. */
export function headerOf(text: string): WorldHeader {
  const header = readHeader(text.slice(0, HEAD_BYTES));
  if (header) return header;
  const world = parseWorldText(text);
  return { id: world.id, name: world.name, revision: world.revision ?? null, thumb: world.thumb ?? null };
}

/** A fresh id for a world. */
export const freshId = (): string => newId();
