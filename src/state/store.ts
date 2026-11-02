// The editor: one world, what is picked in it, and every action that can be
// taken on it. Kept outside React so that the viewer, keyboard shortcuts and
// menus all drive the same functions.
import { useSyncExternalStore } from 'react';
import { unzipSync, zipSync } from 'fflate';
import { APP_NAME, FILE_EXTENSION, isWorldName } from '../app';
import { gazeboBundle } from '../io/gazebo';
import { mujocoBundle } from '../io/mjcf';
import { isaacBundle } from '../io/usda';
import { encodeText } from '../io/format';
import type { ExportBundle, Resolved } from '../io/export';
import { rollingField } from '../io/heightmap';
import { DEFAULT_BRUSH, dab, generateField } from '../terrain/brush';
import type { Brush, FieldSpec, Window as BrushWindow } from '../terrain/brush';
import { heightsFromImage, readImage } from '../terrain/image';
import type { GreyImage, ImageFit } from '../terrain/image';
import { boxAround, copernicusTile, heightsFromDem, openDem, openDemUrl } from '../terrain/elevation';
import type { Dem, DemBox, DemFit, FetchLike } from '../terrain/elevation';
import { parseWorld, parseWorldText, serializeWorld, serializeWorldText } from '../model/file';
import { add, newId, uniqueName } from '../model/math';
import { DEFAULT_PHYSICS, GRID_DEFAULT, MATERIAL_PRESETS, assetPresent, emptyWorld, isProp } from '../model/types';
import type { Asset, Light, LightKind, Material, PartAsset, Pick, Placed, SpawnPoint, Terrain, Vec3, World, Zone } from '../model/types';
import { partById, settle } from '../parts/library';
import type { PartParams } from '../parts/library';
import * as platform from '../platform';
import { inspectPackage } from '../robot/package';
import type { PackageFiles } from '../robot/package';
import { collectFiles, forget, keepGlb, keepPart, keepRobot, resolveMesh, restoreAssets } from './assets';
import { loadPrefs, savePrefs } from './persist';
import { DiskWorlds, MemoryWorlds, fileNameFor, hasWorldStore, openWorldStore, useWorldStore, worldStore } from './worlds';
import type { WorldInfo } from './worlds';
import type { Engine, Prefs } from './persist';

export interface Notice {
  /** `ok` for something that went through (a save, an export), `info` for a plain word, `error` for what failed. */
  kind: 'error' | 'info' | 'ok';
  text: string;
  /** Something to do about it, offered as a button ("Show folder"). */
  action?: { label: string; run: () => void };
}

/** The thing the next click on the ground puts down. */
export type Placing = { kind: 'asset'; asset: string } | { kind: 'light'; light: LightKind } | { kind: 'spawn' };

/** A tool that takes the pointer on the ground: sculpting with a brush, or drawing a surface zone. */
export type Tool = { kind: 'sculpt'; brush: Brush } | { kind: 'zone' };

export interface EditorState {
  world: World;
  /** What the inspector shows. */
  pick: Pick | null;
  /** Ids of the selected objects, lights and spawn points (one id space). */
  selection: string[];
  /** Where the world lives in the store (its file's path on desktop), once it has been written. */
  key: string | null;
  /** The world as last saved or opened, to tell whether there are changes still to write. */
  saved: World | null;
  saving: boolean;
  placing: Placing | null;
  /** The tool the pointer drives on the ground, if any; the selection and placing give way to it. */
  tool: Tool | null;
  /** An image read as a heightmap, waiting for its size and height range in the import dialog. */
  heightmapImport: { name: string; image: GreyImage } | null;
  /** A DEM opened or fetched, with the box of it to take, waiting in the elevation dialog. */
  elevationImport: { dem: Dem; box: DemBox } | null;
  /** Where worlds are kept, once start-up has looked: the folder (null in a browser), and whether another can be chosen. */
  storage: { location: string | null; defaultDir: string | null; fixed: boolean } | null;
  /** The worlds browser is open. */
  browsing: boolean;
  /** The parts library is open. */
  library: boolean;
  /** On a narrow screen (a tablet), the side panel drawn over the viewport, if any. */
  panel: 'sidebar' | 'inspector' | null;
  worlds: WorldInfo[];
  exporting: boolean;
  about: boolean;
  prefs: Prefs;
  notice: Notice | null;
  busy: string | null;
  canUndo: boolean;
  canRedo: boolean;
}

let state: EditorState = {
  world: emptyWorld(),
  pick: { kind: 'world' },
  selection: [],
  key: null,
  saved: null,
  saving: false,
  placing: null,
  tool: null,
  heightmapImport: null,
  elevationImport: null,
  storage: null,
  browsing: false,
  library: false,
  panel: null,
  worlds: [],
  exporting: false,
  about: false,
  prefs: loadPrefs(),
  notice: null,
  busy: null,
  canUndo: false,
  canRedo: false,
};
state.saved = state.world;

const listeners = new Set<() => void>();
let past: World[] = [];
let future: World[] = [];
let gesture: { before: World; origins: Map<string, Vec3> } | null = null;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
let autosaveTimer: ReturnType<typeof setTimeout> | undefined;

function set(patch: Partial<EditorState>): void {
  const before = state;
  state = { ...state, ...patch, canUndo: past.length > 0, canRedo: future.length > 0 };
  if (state.prefs !== before.prefs) savePrefs(state.prefs);
  if (state.world !== before.world && isDirty()) scheduleAutosave();
  for (const l of listeners) l();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const getState = (): EditorState => state;

export function useEditor<T>(selector: (s: EditorState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

export const isDirty = (): boolean => state.world !== state.saved;

/** Tells the user something; errors stay until the next one, the rest fade. */
export function tell(kind: Notice['kind'], text: string, action?: Notice['action']): void {
  clearTimeout(noticeTimer);
  set({ notice: { kind, text, action } });
  if (kind !== 'error') noticeTimer = setTimeout(() => set({ notice: null }), action ? 12000 : 4000);
}

export const dismissNotice = (): void => set({ notice: null });

const fail = (err: unknown): void => tell('error', err instanceof Error ? err.message : String(err));

// --- edits -------------------------------------------------------------------

/** Applies a change to the world as one undo step. */
function edit(change: (world: World) => World, patch: Partial<EditorState> = {}): void {
  const next = change(state.world);
  if (next === state.world) {
    if (Object.keys(patch).length) set(patch);
    return;
  }
  past.push(state.world);
  if (past.length > 200) past.shift();
  future = [];
  set({ world: next, ...patch });
}

export function undo(): void {
  const previous = past.pop();
  if (!previous) return;
  future.push(state.world);
  set({ world: previous, selection: state.selection.filter((id) => has(previous, id)), pick: pickStill(previous) });
}

export function redo(): void {
  const next = future.pop();
  if (!next) return;
  past.push(state.world);
  set({ world: next, selection: state.selection.filter((id) => has(next, id)), pick: pickStill(next) });
}

const has = (world: World, id: string): boolean => world.objects.some((o) => o.id === id) || world.lights.some((l) => l.id === id) || world.spawns.some((s) => s.id === id);

/** The pick, unless the thing it pointed at is gone. */
function pickStill(world: World): Pick | null {
  const p = state.pick;
  if (!p || p.kind === 'world' || p.kind === 'terrain') return p;
  return has(world, p.id) ? p : { kind: 'world' };
}

const names = (world: World): string[] => [...world.objects.map((o) => o.name), ...world.lights.map((l) => l.name), ...world.spawns.map((s) => s.name), ...world.zones.map((z) => z.name)];

// --- selection -----------------------------------------------------------------

function pickOf(world: World, id: string): Pick | null {
  if (world.objects.some((o) => o.id === id)) return { kind: 'object', id };
  if (world.lights.some((l) => l.id === id)) return { kind: 'light', id };
  if (world.spawns.some((s) => s.id === id)) return { kind: 'spawn', id };
  if (world.zones.some((z) => z.id === id)) return { kind: 'zone', id };
  return null;
}

export function select(id: string | null, additive = false): void {
  if (id === null) {
    set({ selection: [], pick: { kind: 'world' }, placing: null });
    return;
  }
  const pick = pickOf(state.world, id);
  if (!pick) return;
  if (additive) {
    const selection = state.selection.includes(id) ? state.selection.filter((s) => s !== id) : [...state.selection, id];
    const last = selection[selection.length - 1];
    set({ selection, pick: last ? pickOf(state.world, last) : { kind: 'world' } });
  } else set({ selection: [id], pick });
}

export const pickTerrain = (): void => set({ selection: [], pick: { kind: 'terrain' }, placing: null });
export const pickWorld = (): void => set({ selection: [], pick: { kind: 'world' }, placing: null });

export function selectAll(): void {
  const selection = state.world.objects.map((o) => o.id);
  const last = selection[selection.length - 1];
  set({ selection, pick: last ? pickOf(state.world, last) : state.pick });
}

// --- placing and importing -------------------------------------------------------

const GLB_FILTER = [{ name: 'glTF binary (PlastikCAD export)', extensions: ['glb'] }];
const WORLD_FILTER = [{ name: `${APP_NAME} world`, extensions: [FILE_EXTENSION] }];

export const startPlacing = (placing: Placing): void => set({ placing, selection: [], tool: null });
export const cancelPlacing = (): void => set({ placing: null });

/** Puts the thing being placed down at a point on the ground. */
export function placeAt(point: Vec3): void {
  const placing = state.placing;
  if (!placing) return;
  if (placing.kind === 'asset') {
    const asset = state.world.assets.find((a) => a.id === placing.asset);
    if (asset) addPlaced(asset, point);
  } else if (placing.kind === 'light') addLight(placing.light, [point[0], point[1], point[2] + 2]);
  else addSpawn(point);
  set({ placing: null });
}

function addPlaced(asset: Asset, at: Vec3): void {
  const id = newId();
  const physics = asset.kind === 'robot' ? { ...DEFAULT_PHYSICS, static: false } : asset.kind === 'part' ? { ...(partById(asset.part)?.physics ?? DEFAULT_PHYSICS) } : { ...DEFAULT_PHYSICS };
  const placed: Placed = { id, name: uniqueName(asset.name, names(state.world)), asset: asset.id, pose: { xyz: at, rpy: [0, 0, 0] }, scale: 1, physics };
  edit((w) => ({ ...w, objects: [...w.objects, placed] }), { selection: [id], pick: { kind: 'object', id } });
}

// --- the parts library -------------------------------------------------------

export const showLibrary = (open: boolean): void => set({ library: open });

/** A piece from the library, as an asset of its own with the generator's defaults, placed at the origin and picked. */
export function addPart(partId: string, at: Vec3 = [0, 0, 0]): void {
  const def = partById(partId);
  if (!def) return;
  const asset: PartAsset = { kind: 'part', id: newId(), name: uniqueName(def.name, new Set(state.world.assets.map((a) => a.name))), part: partId, params: settle(def, {}), source: { name: 'Parts library', path: null, size: 0 } };
  keepPart(asset);
  edit((w) => ({ ...w, assets: [...w.assets, asset] }));
  addPlaced(asset, at);
  set({ library: false });
}

/** New numbers for a part: every placement of it changes, as one step of the history. */
export function updatePartParams(assetId: string, params: PartParams): void {
  const asset = state.world.assets.find((a) => a.id === assetId);
  if (asset?.kind !== 'part') return;
  const def = partById(asset.part);
  if (!def) return;
  const next: PartAsset = { ...asset, params: settle(def, { ...asset.params, ...params }) };
  forget(asset.id);
  keepPart(next);
  edit((w) => ({ ...w, assets: w.assets.map((a) => (a.id === assetId ? next : a)) }));
}

export function addLight(kind: LightKind, at: Vec3 = [0, 0, 3]): void {
  const id = newId();
  const base = kind === 'sun' ? 'Sun' : kind === 'spot' ? 'Spot light' : 'Point light';
  const light: Light = { id, name: uniqueName(base, names(state.world)), kind, pose: { xyz: at, rpy: [0, 0, 0] }, color: [1, 1, 1], intensity: 1, castShadows: kind === 'sun', direction: [-0.5, 0.1, -0.9], cone: Math.PI / 6 };
  edit((w) => ({ ...w, lights: [...w.lights, light] }), { selection: [id], pick: { kind: 'light', id } });
}

export function addSpawn(at: Vec3 = [0, 0, 0]): void {
  const id = newId();
  const spawn: SpawnPoint = { id, name: uniqueName('Spawn point', names(state.world)), pose: { xyz: at, rpy: [0, 0, 0] } };
  edit((w) => ({ ...w, spawns: [...w.spawns, spawn] }), { selection: [id], pick: { kind: 'spawn', id } });
}

/** Adds GLB files as assets and places each at the origin. */
export async function importObjects(files?: platform.PickedFile[]): Promise<void> {
  try {
    const picked = files ?? (await platform.pickFiles({ filters: GLB_FILTER, multiple: true }));
    for (const file of picked) {
      if (!/\.glb$/i.test(file.name)) {
        tell('error', `${file.name} is not a GLB. Export the object from PlastikCAD as GLB (meters, colours embedded).`);
        continue;
      }
      const name = file.name.replace(/\.glb$/i, '');
      const asset: Asset = { kind: 'mesh', id: newId(), name, source: { name: file.name, path: file.path, size: file.bytes.length }, data: file.bytes };
      keepGlb(asset);
      edit((w) => ({ ...w, assets: [...w.assets, asset] }));
      addPlaced(asset, [0, 0, 0]);
    }
  } catch (err) {
    fail(err);
  }
}

const ZIP_FILTER = [{ name: 'Robot package (zip)', extensions: ['zip'] }];

/**
 * The files of a zipped package, by path inside it. A zip of one top-level
 * folder (as PlastikCAD exports a ROS 2 package) is read from inside that
 * folder, so the paths match a folder picked directly.
 */
function unzipPackage(bytes: Uint8Array): PackageFiles {
  const entries = unzipSync(bytes);
  const paths = Object.keys(entries).filter((p) => !p.endsWith('/') && !p.startsWith('__MACOSX/'));
  const tops = new Set(paths.map((p) => p.split('/')[0]));
  const root = tops.size === 1 && paths.every((p) => p.includes('/')) ? `${[...tops][0]}/` : '';
  const files: Record<string, Uint8Array> = {};
  for (const p of paths) files[p.slice(root.length)] = entries[p];
  return { paths: Object.keys(files), read: async (p) => files[p] };
}

/**
 * Adds a robot package (ROS 2, Gazebo model or MuJoCo model) as an asset and
 * places it at the origin: a folder where one can be picked, the zip
 * PlastikCAD exports where it cannot (Android) or when one is dropped.
 */
export async function importRobot(zip?: platform.PickedFile): Promise<void> {
  try {
    let folder: { name: string; path: string | null; files: PackageFiles } | null;
    if (zip) folder = { name: zip.name.replace(/\.zip$/i, ''), path: zip.path, files: unzipPackage(zip.bytes) };
    else if (platform.canPickFolder()) folder = await platform.pickFolder();
    else {
      const [picked] = await platform.pickFiles({ filters: ZIP_FILTER });
      if (!picked) return;
      if (!/\.zip$/i.test(picked.name)) {
        tell('error', `${picked.name} is not a zip. Export the robot from PlastikCAD as a ROS 2 package zip and pick that.`);
        return;
      }
      folder = { name: picked.name.replace(/\.zip$/i, ''), path: picked.path, files: unzipPackage(picked.bytes) };
    }
    if (!folder) return;
    set({ busy: `Reading ${folder.name}…` });
    const info = await inspectPackage(folder.files);
    if (!info) {
      tell('error', `${folder.name} is not a robot package: no package.xml with a URDF, no model.sdf, and no MuJoCo XML were found in it.`);
      return;
    }
    // The package travels with the world: a world is one file, on every platform.
    const files = await collectFiles(folder.files);
    const asset: Asset = { kind: 'robot', id: newId(), name: info.modelName, format: info.format, source: { name: folder.name, path: folder.path, size: Object.values(files).reduce((n, f) => n + f.length, 0) }, modelName: info.modelName, entry: info.entry, rootBody: info.rootBody, usd: info.usd, files };
    const notes = await keepRobot(asset);
    edit((w) => ({ ...w, assets: [...w.assets, asset] }));
    addPlaced(asset, [0, 0, 0]);
    if (notes.length) tell('info', notes.join(' '));
    else tell('ok', `${asset.name} imported as a ${info.format === 'ros' ? 'ROS 2 package' : info.format === 'gazebo' ? 'Gazebo model' : 'MuJoCo model'}.`);
  } catch (err) {
    fail(err);
  } finally {
    set({ busy: null });
  }
}

/** Files dropped on the window (or opened from the Files app on Android): worlds open, GLBs come in as objects, zips as robot packages. */
export async function receiveFiles(files: platform.PickedFile[]): Promise<void> {
  const worlds = files.filter((f) => isWorldName(f.name));
  const glbs = files.filter((f) => /\.glb$/i.test(f.name));
  const zips = files.filter((f) => /\.zip$/i.test(f.name));
  const images = files.filter((f) => /\.(png|jpe?g|webp|bmp|gif)$/i.test(f.name));
  const dems = files.filter((f) => /\.tiff?$/i.test(f.name));
  if (worlds.length) await importWorldFile(worlds[0]);
  if (glbs.length) await importObjects(glbs);
  for (const zip of zips) await importRobot(zip);
  if (images.length) await importHeightmap(images[0]);
  if (dems.length) await importElevation(dems[0]);
  const other = files.length - worlds.length - glbs.length - zips.length - images.length - dems.length;
  if (other > 0) tell('info', `Only worlds, GLB objects, zipped robot packages, heightmap images and GeoTIFFs can be dropped here.`);
}

// --- changing things -----------------------------------------------------------

export function updateObject(id: string, patch: Partial<Placed>): void {
  edit((w) => ({ ...w, objects: w.objects.map((o) => (o.id === id ? { ...o, ...patch } : o)) }));
}

export function updateLight(id: string, patch: Partial<Light>): void {
  edit((w) => ({ ...w, lights: w.lights.map((l) => (l.id === id ? { ...l, ...patch } : l)) }));
}

export function updateSpawn(id: string, patch: Partial<SpawnPoint>): void {
  edit((w) => ({ ...w, spawns: w.spawns.map((s) => (s.id === id ? { ...s, ...patch } : s)) }));
}

export function updateTerrain(terrain: Terrain): void {
  edit((w) => ({ ...w, terrain }));
}

// --- sculpting ---------------------------------------------------------------
//
// A stroke works on a copy of the heights, dab by dab, with the viewer moving
// the vertices as it goes; the world takes the copy once the stroke ends, as
// one step of the history. The heights buffer is mutated during the stroke,
// which is why the copy is made first: the buffer the history holds must stay
// as it was.

let stroke: { before: World; heights: Float32Array; level: number; refresh: (window: BrushWindow) => void } | null = null;

export function setTool(tool: Tool | null): void {
  if (stroke) endSculpt(true);
  set({ tool, placing: null, selection: tool ? [] : state.selection, pick: tool ? { kind: 'terrain' } : state.pick });
}

export const setBrush = (patch: Partial<Brush>): void => set({ tool: { kind: 'sculpt', brush: { ...(state.tool?.kind === 'sculpt' ? state.tool.brush : DEFAULT_BRUSH), ...patch } } });

/** A stroke begins at a point on the ground; `refresh` is the viewer's way to move the touched vertices. */
export function beginSculpt(point: Vec3, refresh: (window: BrushWindow) => void): void {
  const t = state.world.terrain;
  if (state.tool?.kind !== 'sculpt' || t.kind !== 'heightmap') return;
  if (stroke) endSculpt(true);
  const heights = t.heights.slice();
  stroke = { before: state.world, heights, level: point[2], refresh };
  set({ world: { ...state.world, terrain: { ...t, heights } } });
}

export function sculptAt(point: Vec3, dt: number): void {
  const t = state.world.terrain;
  if (!stroke || state.tool?.kind !== 'sculpt' || t.kind !== 'heightmap') return;
  const window = dab(t, state.tool.brush, point[0], point[1], dt, stroke.level);
  if (window) stroke.refresh(window);
}

export function endSculpt(canceled: boolean): void {
  if (!stroke) return;
  const { before } = stroke;
  stroke = null;
  if (canceled) {
    set({ world: before });
    return;
  }
  // The world already holds the stroke; the history takes the world from before it.
  past.push(before);
  if (past.length > 200) past.shift();
  future = [];
  set({});
}

const IMAGE_FILTER = [{ name: 'Heightmap image', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }];

/** "Import heightmap image…": reads the image, then asks what it covers and how high it goes. */
export async function importHeightmap(file?: platform.PickedFile): Promise<void> {
  try {
    const picked = file ?? (await platform.pickFiles({ filters: IMAGE_FILTER }))[0];
    if (!picked) return;
    set({ busy: `Reading ${picked.name}…` });
    const image = await readImage(picked.name, picked.bytes);
    set({ heightmapImport: { name: picked.name, image }, tool: null, placing: null, pick: { kind: 'terrain' }, selection: [] });
  } catch (err) {
    fail(err);
  } finally {
    set({ busy: null });
  }
}

export const closeHeightmap = (): void => set({ heightmapImport: null });

/** Puts the read image on the terrain, one step of the history: the grid, the area it covers and the heights of black and white. */
export function applyHeightmap(fit: ImageFit, size: [number, number]): void {
  const pending = state.heightmapImport;
  if (!pending) return;
  const t = state.world.terrain;
  const heights = heightsFromImage(pending.image, fit);
  updateTerrain({ kind: 'heightmap', size, friction: t.friction, rows: fit.samples, cols: fit.samples, heights });
  set({ heightmapImport: null });
  const { width, height } = pending.image;
  if (width !== height) tell('info', `${pending.name} is ${width} × ${height}; it was stretched onto the square grid, so the terrain's width and depth say what it covers.`);
}

const DEM_FILTER = [{ name: 'GeoTIFF elevation', extensions: ['tif', 'tiff'] }];

/** "Elevation (GeoTIFF)…": opens a DEM the user has, with the middle of it chosen to start with. */
export async function importElevation(file?: platform.PickedFile): Promise<void> {
  try {
    const picked = file ?? (await platform.pickFiles({ filters: DEM_FILTER }))[0];
    if (!picked) return;
    set({ busy: `Reading ${picked.name}…` });
    const dem = await openDem(picked.name, picked.bytes);
    const side = Math.min(dem.width, dem.height);
    const box = { x0: Math.floor((dem.width - side) / 2), y0: Math.floor((dem.height - side) / 2), x1: Math.floor((dem.width - side) / 2) + side, y1: Math.floor((dem.height - side) / 2) + side };
    set({ elevationImport: { dem, box }, tool: null, placing: null, pick: { kind: 'terrain' }, selection: [] });
  } catch (err) {
    fail(err);
  } finally {
    set({ busy: null });
  }
}

/** The fetch tiles come through: the Rust side's in the app (the bucket sends no CORS headers), the browser's otherwise, which may be refused. */
async function tileFetcher(): Promise<FetchLike> {
  if (platform.isDesktop()) {
    const { fetch } = await import('@tauri-apps/plugin-http');
    return (url, init) => fetch(url, init);
  }
  return (url, init) => fetch(url, init);
}

/** Fetches the Copernicus GLO-30 tile holding a place and takes `radius` meters around it. */
export async function fetchElevation(lat: number, lon: number, radius: number): Promise<void> {
  const tile = copernicusTile(lat, lon);
  set({ busy: `Fetching ${tile.name}…` });
  try {
    const dem = await openDemUrl(tile.name, tile.url, await tileFetcher());
    const box = boxAround(dem, lat, lon, radius);
    set({ elevationImport: { dem, box }, tool: null, placing: null, pick: { kind: 'terrain' }, selection: [] });
    if (box.x0 === 0 || box.y0 === 0 || box.x1 === dem.width || box.y1 === dem.height) tell('info', 'The box reaches the edge of the 1° tile; only this tile is taken.');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    tell('error', platform.isDesktop() ? `Could not fetch the tile: ${message}` : `Could not fetch the tile from a browser (${message}); the desktop and Android apps fetch it through their own side.`);
  } finally {
    set({ busy: null });
  }
}

export const setElevationBox = (box: DemBox): void => {
  if (state.elevationImport) set({ elevationImport: { ...state.elevationImport, box } });
};
export const closeElevation = (): void => set({ elevationImport: null });

/** Puts the chosen box of the DEM on the terrain, one step of the history, sized to what it covers on the ground. */
export async function applyElevation(fit: DemFit): Promise<void> {
  const pending = state.elevationImport;
  if (!pending) return;
  set({ busy: 'Reading the elevation…' });
  try {
    const result = await heightsFromDem(pending.dem, pending.box, fit);
    const t = state.world.terrain;
    updateTerrain({ kind: 'heightmap', size: result.size, friction: t.friction, rows: fit.samples, cols: fit.samples, heights: result.heights });
    set({ elevationImport: null });
    tell('ok', `${result.size[0].toFixed(0)} × ${result.size[1].toFixed(0)} m of ${pending.dem.name}, ${result.lowest.toFixed(1)} to ${result.highest.toFixed(1)} m${result.filled ? `, ${result.filled} no-data samples filled from their neighbours` : ''}.`);
  } catch (err) {
    fail(err);
  } finally {
    set({ busy: null });
  }
}

/** Replaces the heights with a generated field, one step of the history. */
export function generateTerrain(spec: FieldSpec): void {
  const t = state.world.terrain;
  if (t.kind !== 'heightmap') return;
  updateTerrain({ ...t, heights: generateField(t.rows, t.cols, spec) });
}

/** Turns the ground into a rolling field, or back to a plane. */
export function setTerrainKind(kind: Terrain['kind']): void {
  const t = state.world.terrain;
  if (kind === t.kind) return;
  if (kind === 'plane') updateTerrain({ kind: 'plane', size: t.size, friction: t.friction });
  else updateTerrain({ kind: 'heightmap', size: t.size, friction: t.friction, rows: GRID_DEFAULT, cols: GRID_DEFAULT, heights: rollingField(GRID_DEFAULT, GRID_DEFAULT, 0.5) });
}

export function updateWorld(patch: Partial<{ name: string; gravity: Vec3 }>): void {
  edit((w) => ({ ...w, ...patch }));
}

export function deleteSelected(): void {
  const ids = new Set(state.selection);
  if (ids.size === 0) return;
  edit((w) => ({ ...w, objects: w.objects.filter((o) => !ids.has(o.id)), lights: w.lights.filter((l) => !ids.has(l.id)), spawns: w.spawns.filter((s) => !ids.has(s.id)), zones: w.zones.filter((z) => !ids.has(z.id)) }), { selection: [], pick: { kind: 'world' } });
}

/** Takes an asset out of the world, with everything placed from it. */
export function removeAsset(id: string): void {
  edit((w) => ({ ...w, assets: w.assets.filter((a) => a.id !== id), objects: w.objects.filter((o) => o.asset !== id) }), { selection: [], pick: { kind: 'world' } });
  forget(id);
}

export function duplicateSelected(): void {
  const ids = new Set(state.selection);
  if (ids.size === 0) return;
  const copies: string[] = [];
  edit((w) => {
    const taken = names(w);
    const shift = (xyz: Vec3): Vec3 => add(xyz, [0.5, 0, 0]);
    const objects = w.objects.filter((o) => ids.has(o.id)).map((o) => ({ ...o, id: newId(), name: uniqueName(o.name, taken), pose: { ...o.pose, xyz: shift(o.pose.xyz) } }));
    const lights = w.lights.filter((l) => ids.has(l.id)).map((l) => ({ ...l, id: newId(), name: uniqueName(l.name, taken), pose: { ...l.pose, xyz: shift(l.pose.xyz) } }));
    const spawns = w.spawns.filter((s) => ids.has(s.id)).map((s) => ({ ...s, id: newId(), name: uniqueName(s.name, taken), pose: { ...s.pose, xyz: shift(s.pose.xyz) } }));
    const zones = w.zones.filter((z) => ids.has(z.id)).map((z) => ({ ...z, id: newId(), name: uniqueName(z.name, taken), rect: [z.rect[0] + 0.5, z.rect[1], z.rect[2] + 0.5, z.rect[3]] as Zone['rect'] }));
    copies.push(...objects.map((o) => o.id), ...lights.map((l) => l.id), ...spawns.map((s) => s.id), ...zones.map((z) => z.id));
    return { ...w, objects: [...w.objects, ...objects], lights: [...w.lights, ...lights], spawns: [...w.spawns, ...spawns], zones: [...w.zones, ...zones] };
  });
  const last = copies[copies.length - 1];
  set({ selection: copies, pick: last ? pickOf(state.world, last) : state.pick });
}

/** Moves the selection by a step (the arrow keys). */
export function nudgeSelected(delta: Vec3): void {
  const ids = new Set(state.selection);
  if (ids.size === 0) return;
  edit((w) => moveAll(w, ids, delta));
}

function moveAll(w: World, ids: Set<string>, delta: Vec3, origins?: Map<string, Vec3>): World {
  const at = (id: string, xyz: Vec3): Vec3 => add(origins?.get(id) ?? xyz, delta);
  return {
    ...w,
    objects: w.objects.map((o) => (ids.has(o.id) ? { ...o, pose: { ...o.pose, xyz: at(o.id, o.pose.xyz) } } : o)),
    lights: w.lights.map((l) => (ids.has(l.id) ? { ...l, pose: { ...l.pose, xyz: at(l.id, l.pose.xyz) } } : l)),
    spawns: w.spawns.map((s) => (ids.has(s.id) ? { ...s, pose: { ...s.pose, xyz: at(s.id, s.pose.xyz) } } : s)),
    zones: w.zones.map((z) => (ids.has(z.id) ? { ...z, rect: [z.rect[0] + delta[0], z.rect[1] + delta[1], z.rect[2] + delta[0], z.rect[3] + delta[1]] } : z)),
  };
}

// --- surfaces ----------------------------------------------------------------

/** Adds a material from a preset (or a plain grey one) and returns its id. */
export function addMaterial(preset: Omit<Material, 'id'> = MATERIAL_PRESETS[1]): string {
  const id = newId();
  edit((w) => ({ ...w, materials: [...w.materials, { ...preset, id, name: uniqueName(preset.name, new Set(w.materials.map((m) => m.name))) }] }));
  return id;
}

export function updateMaterial(id: string, patch: Partial<Material>): void {
  edit((w) => ({ ...w, materials: w.materials.map((m) => (m.id === id ? { ...m, ...patch, id } : m)) }));
}

/** Takes a material out; the zones that had it go with it. */
export function removeMaterial(id: string): void {
  edit((w) => ({ ...w, materials: w.materials.filter((m) => m.id !== id), zones: w.zones.filter((z) => z.material !== id) }), { selection: [], pick: { kind: 'world' } });
}

/** A zone drawn on the ground; it takes the first material, adding one when the world has none yet. */
export function addZone(rect: Zone['rect']): void {
  const [x0, y0, x1, y1] = [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])];
  if (x1 - x0 < 0.05 || y1 - y0 < 0.05) return;
  const material = state.world.materials[0]?.id ?? addMaterial();
  const id = newId();
  edit((w) => ({ ...w, zones: [...w.zones, { id, name: uniqueName('Zone', names(w)), material, rect: [x0, y0, x1, y1] }] }), { selection: [id], pick: { kind: 'zone', id }, tool: null });
}

export function updateZone(id: string, patch: Partial<Zone>): void {
  edit((w) => ({ ...w, zones: w.zones.map((z) => (z.id === id ? { ...z, ...patch, id } : z)) }));
}

// --- drags from the viewer: one undo step per gesture --------------------------------

export function beginGesture(): void {
  const origins = new Map<string, Vec3>();
  const w = state.world;
  for (const o of w.objects) origins.set(o.id, o.pose.xyz);
  for (const l of w.lights) origins.set(l.id, l.pose.xyz);
  for (const s of w.spawns) origins.set(s.id, s.pose.xyz);
  gesture = { before: w, origins };
}

/** The dragged item moved by `delta` since the gesture began; the rest of the selection follows. */
export function moveBy(id: string, delta: Vec3): void {
  if (!gesture) return;
  const ids = new Set(state.selection.includes(id) ? state.selection : [id]);
  set({ world: moveAll(gesture.before, ids, delta, gesture.origins) });
}

export function endGesture(canceled: boolean): void {
  const g = gesture;
  gesture = null;
  if (!g) return;
  if (canceled) {
    set({ world: g.before });
    return;
  }
  if (state.world === g.before) return;
  const after = state.world;
  state = { ...state, world: g.before };
  edit(() => after);
}

// --- preferences ---------------------------------------------------------------------

export function setPrefs(patch: Partial<Prefs>): void {
  set({ prefs: { ...state.prefs, ...patch } });
}

export const toggleTheme = (): void => setPrefs({ theme: state.prefs.theme === 'dark' ? 'light' : 'dark' });

// --- files -----------------------------------------------------------------------------
//
// A world is saved as you work, as a PlastikCAD project is: a second after the
// last change, and when the window is hidden or closed. There is no Save;
// Ctrl+S writes what autosave would a moment later. "Open world file…" brings
// a file from anywhere in as a world of its own, a copy with a fresh id, so a
// file someone sent never passes for one of your own. "Save a copy…" writes
// the world wherever you like; the world itself stays with the app's worlds.

const AUTOSAVE_MS = 1000;
/** Taking the picture means drawing the scene again, so it is not done on every save. */
const THUMB_EVERY_MS = 10_000;
let thumbSource: (() => string | null) | null = null;
let thumbTakenAt = 0;
let writing: Promise<boolean> | null = null;
let lastSaveError: string | null = null;

/** The viewport offers its picture for the worlds browser. */
export function provideThumbnail(source: (() => string | null) | null): void {
  thumbSource = source;
}

const titleOf = (world: World): string => `${world.name}${isDirty() ? ' •' : ''} – ${APP_NAME}`;

function scheduleAutosave(): void {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => void saveWorld(), AUTOSAVE_MS);
}

/** Whether the world is worth a file yet: it has one already, something was put in it, or it was named. */
const worthSaving = (): boolean => state.key !== null || state.world.objects.length > 0 || state.world.assets.length > 0 || state.world.terrain.kind !== 'plane' || state.world.name !== 'Untitled';

function thumbFor(world: World, fresh: boolean): string | undefined {
  if (!thumbSource) return world.thumb;
  const now = Date.now();
  if (!fresh && world.thumb && now - thumbTakenAt < THUMB_EVERY_MS) return world.thumb;
  const shot = thumbSource();
  if (!shot) return world.thumb;
  thumbTakenAt = now;
  return shot;
}

/**
 * Writes the world to the store now, if anything changed. Resolves true once
 * it is saved (or there was nothing to save), false when the write failed; the
 * changes are then still pending and the next edit tries again.
 */
export function saveWorld(fresh = false): Promise<boolean> {
  clearTimeout(autosaveTimer);
  if (writing) return writing.then(() => saveWorld(fresh));
  if (!isDirty() || !worthSaving()) return Promise.resolve(true);
  if (!hasWorldStore()) return Promise.resolve(false);
  writing = write(fresh).finally(() => {
    writing = null;
  });
  return writing;
}

async function write(fresh: boolean): Promise<boolean> {
  // What is being written counts as saved once it is, even if more changed meanwhile.
  const world = state.world;
  // Every save is a revision following the one before it, so that sync can tell what changed where.
  const stamp = { revision: newId(), parent: world.revision, device: state.prefs.device, saved: new Date().toISOString(), thumb: thumbFor(world, fresh) };
  const stamped: World = { ...world, ...stamp };
  set({ saving: true });
  try {
    const key = await worldStore().write(state.key, world.name, serializeWorldText(stamped));
    const unchanged = state.world === world;
    // The stamps join the world without counting as a change of it; edits made meanwhile keep it pending.
    set({ key, world: unchanged ? stamped : { ...state.world, ...stamp }, saved: unchanged ? stamped : state.saved, saving: false, prefs: state.prefs.lastWorld === key ? state.prefs : { ...state.prefs, lastWorld: key } });
    lastSaveError = null;
    return true;
  } catch (err) {
    set({ saving: false });
    const message = err instanceof Error ? err.message : String(err);
    // The same failure on every keystroke is reported once.
    if (message !== lastSaveError) tell('error', `Could not save: ${message}`);
    lastSaveError = message;
    return false;
  }
}

/** Ctrl+S: there is nothing to do but write what autosave would have a moment later, and say so. */
export async function saveNow(): Promise<boolean> {
  const ok = await saveWorld(true);
  if (ok) tell('ok', state.key ? 'Saved.' : 'Nothing to save yet.');
  return ok;
}

function adopt(world: World, key: string | null): void {
  clearTimeout(autosaveTimer);
  past = [];
  future = [];
  thumbTakenAt = 0;
  set({ world, saved: world, key, saving: false, selection: [], pick: { kind: 'world' }, placing: null, browsing: false, prefs: state.prefs.lastWorld === key ? state.prefs : { ...state.prefs, lastWorld: key } });
}

/** Leaves the open world: autosave has written it, or the user chose to go on without. */
async function leaveWorld(): Promise<boolean> {
  if (!isDirty() || !worthSaving()) return true;
  if (await saveWorld(true)) return true;
  return platform.confirm('The latest changes could not be saved. Go on and lose them?', { title: 'Unsaved changes', okLabel: 'Go on', cancelLabel: 'Keep editing' });
}

export async function newWorld(): Promise<void> {
  if (!(await leaveWorld())) return;
  adopt(emptyWorld(), null);
}

/**
 * Loads an opened world's assets. A version 1 world kept them by path; on
 * desktop they are read back and put into the world, which the next save
 * then carries.
 */
async function settleAssets(): Promise<void> {
  const absent = state.world.assets.filter((a) => !assetPresent(a) && a.source.path);
  if (absent.length && platform.isDesktop()) {
    set({ busy: 'Reading assets…' });
    const filled = new Map<string, Asset>();
    for (const asset of absent) {
      try {
        if (asset.kind === 'mesh') filled.set(asset.id, { ...asset, data: (await platform.readPath(asset.source.path!)).bytes });
        else if (asset.kind === 'robot') filled.set(asset.id, { ...asset, files: await collectFiles((await platform.folderAt(asset.source.path!)).files) });
      } catch (err) {
        console.warn(`Could not read ${asset.name} back:`, err);
      }
    }
    if (filled.size) set({ world: { ...state.world, assets: state.world.assets.map((a) => filled.get(a.id) ?? a) } });
  }
  const notes = await restoreAssets(state.world.assets);
  if (notes.length) tell('info', notes.join(' '));
}

/** Opens a world from the store by its key. */
export async function openWorldKey(key: string): Promise<void> {
  if (key === state.key) {
    set({ browsing: false });
    return;
  }
  if (!(await leaveWorld())) return;
  set({ busy: 'Opening…' });
  try {
    const world = parseWorldText(await worldStore().read(key));
    adopt(world, key);
    await settleAssets();
  } catch (err) {
    fail(err);
  } finally {
    set({ busy: null });
  }
}

const folderOf = (path: string): string => path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))).replace(/[\\/]+$/, '');

/** A world file from anywhere (picked, dropped, passed on the command line) comes in as a world of its own: a copy with a fresh id. */
export async function importWorldFile(file: platform.PickedFile): Promise<void> {
  set({ busy: `Reading ${file.name}…` });
  try {
    const world = parseWorld(file.bytes);
    const store = worldStore();
    // A file already in the worlds folder is simply opened.
    if (file.path && store.location && folderOf(file.path) === store.location.replace(/[\\/]+$/, '')) return await openWorldKey(file.path);
    if (!(await leaveWorld())) return;
    world.id = newId();
    delete world.revision;
    delete world.parent;
    const key = await store.write(null, world.name, serializeWorldText(world));
    adopt(world, key);
    await settleAssets();
    tell('info', `"${world.name}" is now a world of its own in ${APP_NAME}. Changes are saved with the app's worlds, not in ${file.name}.`);
  } catch (err) {
    fail(err);
  } finally {
    set({ busy: null });
  }
}

/** "Open world file…": brings a world file from anywhere in as a world of its own. */
export async function openWorldFile(): Promise<void> {
  try {
    const [file] = await platform.pickFiles({ filters: WORLD_FILTER });
    if (file) await importWorldFile(file);
  } catch (err) {
    fail(err);
  }
}

/** "Save a copy…": writes the world to a place of the user's choosing, to share or keep. The world itself stays where it is. */
export async function saveCopy(): Promise<boolean> {
  try {
    await saveWorld(true);
    const target = await platform.saveAs(fileNameFor(state.world.name), WORLD_FILTER, serializeWorld(state.world), 'application/x-plastikworld');
    if (!target) return false;
    tell('ok', `Saved a copy as ${target.name}.`);
    return true;
  } catch (err) {
    fail(err);
    return false;
  }
}

/** The worlds browser: the worlds in the store, newest first. */
export async function openWorlds(): Promise<void> {
  set({ browsing: true });
  await refreshWorlds();
}

export const closeWorlds = (): void => set({ browsing: false });

export async function refreshWorlds(): Promise<void> {
  if (!hasWorldStore()) return;
  try {
    const items = await worldStore().list();
    set({ worlds: items.sort((a, b) => b.modified - a.modified || a.name.localeCompare(b.name)) });
  } catch (err) {
    fail(err);
  }
}

/** Desktop: keeps the worlds in another folder from now on. The open world stays open where it is. */
export async function chooseWorldsFolder(): Promise<void> {
  if (!state.storage || state.storage.fixed) return;
  const picked = await platform.pickWorldsFolder(state.storage.location ?? undefined);
  if (!picked) return;
  useWorldStore(new DiskWorlds(picked));
  set({ storage: { ...state.storage, location: picked }, prefs: { ...state.prefs, worldsDir: picked } });
  await refreshWorlds();
}

export async function deleteWorld(info: WorldInfo): Promise<void> {
  if (!(await platform.confirm(`Delete "${info.name}"? This cannot be undone.`, { title: 'Delete world', okLabel: 'Delete', cancelLabel: 'Keep' }))) return;
  try {
    if (info.key === state.key) {
      // Nothing pending may write it back after it is gone.
      clearTimeout(autosaveTimer);
      await writing;
    }
    await worldStore().remove(info.key);
    if (info.key === state.key) adopt(emptyWorld(), null);
    await refreshWorlds();
  } catch (err) {
    fail(err);
  }
}

/** Start-up: picks the store, then opens the file the app was started with, or the last world. */
export async function restoreSession(): Promise<void> {
  try {
    const home = await openWorldStore(state.prefs.worldsDir);
    set({ storage: { location: worldStore().location, defaultDir: home.defaultDir, fixed: home.fixed } });
  } catch (err) {
    fail(err);
    useWorldStore(new MemoryWorlds());
    set({ storage: { location: null, defaultDir: null, fixed: true } });
  }
  const [startup] = await platform.startupFiles();
  if (startup) {
    try {
      await importWorldFile(await platform.readPath(startup));
    } catch (err) {
      fail(err);
    }
    return;
  }
  const last = state.prefs.lastWorld;
  if (!last) return;
  try {
    if ((await worldStore().list()).some((w) => w.key === last)) await openWorldKey(last);
    else set({ prefs: { ...state.prefs, lastWorld: null } });
  } catch (err) {
    fail(err);
  }
}

export const showAbout = (open: boolean): void => set({ about: open });
/** Opens a side panel as a drawer on a narrow screen, or closes the one open. */
export const showPanel = (panel: 'sidebar' | 'inspector' | null): void => set({ panel: state.panel === panel ? null : panel });
export const showExport = (open: boolean): void => set({ exporting: open, placing: null });

// --- export ------------------------------------------------------------------------------

const WRITERS: Record<Engine, (world: World, resolved: Resolved) => ExportBundle> = { gazebo: gazeboBundle, mujoco: mujocoBundle, isaac: isaacBundle };

/** The bundle for an engine, with every mesh resolved; what the export dialog previews and writes. */
export async function buildBundle(engine: Engine): Promise<ExportBundle> {
  const resolved: Resolved = { meshes: {} };
  for (const asset of state.world.assets) {
    if (!isProp(asset)) continue;
    const mesh = await resolveMesh(asset.id);
    if (mesh) resolved.meshes[asset.id] = mesh;
  }
  return WRITERS[engine](state.world, resolved);
}

/** The robot packages' files, each under its folder in the bundle, from the assets the world carries. */
function packageEntries(bundle: ExportBundle): [string, Uint8Array][] {
  const out: [string, Uint8Array][] = [];
  for (const copy of bundle.copies) {
    const asset = state.world.assets.find((a) => a.id === copy.asset);
    if (asset?.kind !== 'robot') continue;
    for (const [path, bytes] of Object.entries(asset.files)) out.push([`${copy.to}/${path}`, bytes]);
  }
  return out;
}

/** Writes the bundle: into a chosen folder on desktop, as a zip download in a browser; the robot packages go in from the world. */
export async function exportWorld(engine: Engine): Promise<void> {
  set({ busy: 'Writing the world…' });
  try {
    const bundle = await buildBundle(engine);
    if (platform.isDesktop()) {
      const into = await platform.pickExportFolder();
      if (!into) return;
      const folder = `${into}/${bundle.name}`;
      for (const file of bundle.files) await platform.writePath(`${folder}/${file.path}`, 'text' in file ? encodeText(file.text) : file.bytes);
      for (const [path, bytes] of packageEntries(bundle)) await platform.writePath(`${folder}/${path}`, bytes);
      set({ exporting: false });
      tell(bundle.notes.length ? 'info' : 'ok', `${bundle.notes.length ? bundle.notes.join(' ') + ' ' : ''}Written to ${folder}. Run: ${bundle.launch}`, { label: 'Show folder', run: () => void platform.openPath(folder).catch(fail) });
    } else {
      // No folder to write into (a browser, Android): the bundle goes out as a zip.
      const entries: Record<string, Uint8Array> = {};
      for (const file of bundle.files) entries[`${bundle.name}/${file.path}`] = 'text' in file ? encodeText(file.text) : file.bytes;
      for (const [path, bytes] of packageEntries(bundle)) entries[`${bundle.name}/${path}`] = bytes;
      const zip = zipSync(entries, { level: 6 });
      const name = `${bundle.name}-${engine}.zip`;
      if (platform.keepsExports()) {
        // Android: into the app's folder in Downloads, and offered to other apps from there.
        const exported = await platform.exportToAppFolder('', name, zip, 'application/zip');
        set({ exporting: false });
        tell(bundle.notes.length ? 'info' : 'ok', `${bundle.notes.join(' ')} Written to ${exported.path}. Run: ${bundle.launch}`, { label: 'Share…', run: () => void platform.share([exported.uri], 'application/zip').catch(fail) });
      } else {
        await platform.writeTarget({ path: null, name }, zip, 'application/zip');
        set({ exporting: false });
        tell(bundle.notes.length ? 'info' : 'ok', `${bundle.notes.join(' ')} Run: ${bundle.launch}`);
      }
    }
  } catch (err) {
    fail(err);
  } finally {
    set({ busy: null });
  }
}

export { titleOf };
