// The editor: one world, what is picked in it, and every action that can be
// taken on it. Kept outside React so that the viewer, keyboard shortcuts and
// menus all drive the same functions.
import { useSyncExternalStore } from 'react';
import { zipSync } from 'fflate';
import { APP_NAME, FILE_EXTENSION, isWorldName } from '../app';
import { gazeboBundle } from '../io/gazebo';
import { mujocoBundle } from '../io/mjcf';
import { isaacBundle } from '../io/usda';
import { encodeText } from '../io/format';
import type { ExportBundle, Resolved } from '../io/export';
import { rollingField } from '../io/heightmap';
import { parseWorld, serializeWorld } from '../model/file';
import { add, newId, uniqueName } from '../model/math';
import { DEFAULT_PHYSICS, emptyWorld } from '../model/types';
import type { Asset, Light, LightKind, Pick, Placed, SpawnPoint, Terrain, Vec3, World } from '../model/types';
import * as platform from '../platform';
import { inspectPackage } from '../robot/package';
import { forget, keepGlb, keepRobot, resolveMesh, restoreAssets } from './assets';
import { loadPrefs, savePrefs } from './persist';
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

export interface EditorState {
  world: World;
  /** What the inspector shows. */
  pick: Pick | null;
  /** Ids of the selected objects, lights and spawn points (one id space). */
  selection: string[];
  /** Where the world file lives, once it has been written (desktop). */
  path: string | null;
  /** The world as last saved or opened, to tell whether there are changes still to write. */
  saved: World | null;
  saving: boolean;
  placing: Placing | null;
  /** Where worlds are kept, once start-up has looked: the folder (null in a browser). */
  storage: { location: string | null; defaultDir: string | null } | null;
  /** The worlds browser is open. */
  browsing: boolean;
  worlds: platform.WorldEntry[];
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
  path: null,
  saved: null,
  saving: false,
  placing: null,
  storage: null,
  browsing: false,
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

const names = (world: World): string[] => [...world.objects.map((o) => o.name), ...world.lights.map((l) => l.name), ...world.spawns.map((s) => s.name)];

// --- selection -----------------------------------------------------------------

function pickOf(world: World, id: string): Pick | null {
  if (world.objects.some((o) => o.id === id)) return { kind: 'object', id };
  if (world.lights.some((l) => l.id === id)) return { kind: 'light', id };
  if (world.spawns.some((s) => s.id === id)) return { kind: 'spawn', id };
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

export const startPlacing = (placing: Placing): void => set({ placing, selection: [] });
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
  const placed: Placed = { id, name: uniqueName(asset.name, names(state.world)), asset: asset.id, pose: { xyz: at, rpy: [0, 0, 0] }, scale: 1, physics: asset.kind === 'robot' ? { ...DEFAULT_PHYSICS, static: false } : { ...DEFAULT_PHYSICS } };
  edit((w) => ({ ...w, objects: [...w.objects, placed] }), { selection: [id], pick: { kind: 'object', id } });
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
      const asset: Asset = { kind: 'mesh', id: newId(), name, source: { name: file.name, path: file.path, size: file.bytes.length } };
      keepGlb(asset, file.bytes);
      edit((w) => ({ ...w, assets: [...w.assets, asset] }));
      addPlaced(asset, [0, 0, 0]);
    }
  } catch (err) {
    fail(err);
  }
}

/** Adds a robot package folder (ROS 2, Gazebo model or MuJoCo model) as an asset and places it at the origin. */
export async function importRobot(): Promise<void> {
  try {
    const folder = await platform.pickFolder();
    if (!folder) return;
    set({ busy: `Reading ${folder.name}…` });
    const info = await inspectPackage(folder.files);
    if (!info) {
      tell('error', `${folder.name} is not a robot package: no package.xml with a URDF, no model.sdf, and no MuJoCo XML were found in it.`);
      return;
    }
    const asset: Asset = { kind: 'robot', id: newId(), name: info.modelName, format: info.format, source: { name: folder.name, path: folder.path, size: 0 }, modelName: info.modelName, entry: info.entry, rootBody: info.rootBody, usd: info.usd };
    const notes = await keepRobot(asset, folder.files);
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

/** Files dropped on the window: worlds open, GLBs come in as objects. */
export async function receiveFiles(files: platform.PickedFile[]): Promise<void> {
  const worlds = files.filter((f) => isWorldName(f.name));
  const glbs = files.filter((f) => /\.glb$/i.test(f.name));
  if (worlds.length) await openWorld(worlds[0]);
  if (glbs.length) await importObjects(glbs);
  const other = files.length - worlds.length - glbs.length;
  if (other > 0) tell('info', `Only worlds and GLB objects can be dropped here; a robot package is imported from its folder.`);
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

/** Turns the ground into a rolling field, or back to a plane. */
export function setTerrainKind(kind: Terrain['kind']): void {
  const t = state.world.terrain;
  if (kind === t.kind) return;
  if (kind === 'plane') updateTerrain({ kind: 'plane', size: t.size, friction: t.friction });
  else updateTerrain({ kind: 'heightmap', size: t.size, friction: t.friction, rows: 65, cols: 65, height: 0.3, heights: rollingField(65, 65) });
}

export function updateWorld(patch: Partial<{ name: string; gravity: Vec3 }>): void {
  edit((w) => ({ ...w, ...patch }));
}

export function deleteSelected(): void {
  const ids = new Set(state.selection);
  if (ids.size === 0) return;
  edit((w) => ({ ...w, objects: w.objects.filter((o) => !ids.has(o.id)), lights: w.lights.filter((l) => !ids.has(l.id)), spawns: w.spawns.filter((s) => !ids.has(s.id)) }), { selection: [], pick: { kind: 'world' } });
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
    copies.push(...objects.map((o) => o.id), ...lights.map((l) => l.id), ...spawns.map((s) => s.id));
    return { ...w, objects: [...w.objects, ...objects], lights: [...w.lights, ...lights], spawns: [...w.spawns, ...spawns] };
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
  };
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

const titleOf = (world: World): string => `${world.name}${isDirty() ? ' •' : ''} – ${APP_NAME}`;

function scheduleAutosave(): void {
  clearTimeout(autosaveTimer);
  if (!state.path) return;
  autosaveTimer = setTimeout(() => void saveNow(), 1500);
}

export async function newWorld(): Promise<void> {
  if (isDirty() && !(await platform.confirm('Start a new world and lose the changes to this one?', { title: 'Unsaved changes', okLabel: 'Start new', cancelLabel: 'Keep editing' }))) return;
  past = [];
  future = [];
  const world = emptyWorld();
  set({ world, saved: world, path: null, selection: [], pick: { kind: 'world' }, placing: null, prefs: { ...state.prefs, lastWorld: null } });
}

/** Writes the world where it lives, or asks where. True when written. */
export async function saveNow(): Promise<boolean> {
  clearTimeout(autosaveTimer);
  if (!state.path) return saveAs();
  if (state.saving) return true;
  set({ saving: true });
  const world = state.world;
  try {
    await platform.writePath(state.path, serializeWorld(world));
    set({ saved: world, saving: false });
    return true;
  } catch (err) {
    set({ saving: false });
    fail(err);
    return false;
  }
}

export async function saveAs(): Promise<boolean> {
  try {
    const world = state.world;
    const target = await platform.saveAs(`${world.name}.${FILE_EXTENSION}`, WORLD_FILTER, serializeWorld(world), 'application/x-plastikworld');
    if (!target) return false;
    set({ saved: world, path: target.path, prefs: { ...state.prefs, lastWorld: target.path } });
    tell('ok', `Saved ${target.name}.`);
    return true;
  } catch (err) {
    fail(err);
    return false;
  }
}

/** Opens a world from a picked or dropped file. */
export async function openWorld(file: platform.PickedFile): Promise<void> {
  if (isDirty() && !(await platform.confirm(`Open ${file.name} and lose the changes to this world?`, { title: 'Unsaved changes', okLabel: 'Open', cancelLabel: 'Keep editing' }))) return;
  try {
    const world = parseWorld(file.bytes);
    past = [];
    future = [];
    set({ world, saved: world, path: file.path, selection: [], pick: { kind: 'world' }, placing: null, browsing: false, prefs: { ...state.prefs, lastWorld: file.path }, busy: 'Reading assets…' });
    const notes = await restoreAssets(world.assets);
    if (notes.length) tell('info', notes.join(' '));
  } catch (err) {
    fail(err);
  } finally {
    set({ busy: null });
  }
}

export async function openWorldFile(): Promise<void> {
  try {
    const [file] = await platform.pickFiles({ filters: WORLD_FILTER });
    if (file) await openWorld(file);
  } catch (err) {
    fail(err);
  }
}

export async function openWorldPath(path: string): Promise<void> {
  try {
    await openWorld(await platform.readPath(path));
  } catch (err) {
    fail(err);
  }
}

/** The worlds browser: lists the worlds folder (desktop); in a browser, just the file picker. */
export async function openWorlds(): Promise<void> {
  if (!platform.isDesktop()) return openWorldFile();
  set({ browsing: true });
  await refreshWorlds();
}

export const closeWorlds = (): void => set({ browsing: false });

export async function refreshWorlds(): Promise<void> {
  const location = state.storage?.location;
  if (!location) return;
  try {
    set({ worlds: await platform.listWorlds(location) });
  } catch (err) {
    fail(err);
  }
}

export async function chooseWorldsFolder(): Promise<void> {
  const picked = await platform.pickWorldsFolder(state.storage?.location ?? undefined);
  if (!picked) return;
  set({ storage: { ...state.storage!, location: picked }, prefs: { ...state.prefs, worldsDir: picked } });
  await refreshWorlds();
}

export async function deleteWorldFile(entry: platform.WorldEntry): Promise<void> {
  if (!(await platform.confirm(`Delete ${entry.name}? This cannot be undone.`, { title: 'Delete world', okLabel: 'Delete', cancelLabel: 'Keep' }))) return;
  try {
    await platform.removeFile(entry.path);
    if (state.path === entry.path) set({ path: null, prefs: { ...state.prefs, lastWorld: null } });
    await refreshWorlds();
  } catch (err) {
    fail(err);
  }
}

/** Start-up: finds the worlds folder, then opens the file the app was started with, or the last one. */
export async function restoreSession(): Promise<void> {
  if (!platform.isDesktop()) {
    set({ storage: { location: null, defaultDir: null } });
    return;
  }
  try {
    const home = await platform.defaultWorldsDir();
    set({ storage: { location: state.prefs.worldsDir ?? home.path, defaultDir: home.path } });
  } catch (err) {
    fail(err);
  }
  const [startup] = await platform.startupFiles();
  const path = startup ?? state.prefs.lastWorld;
  if (path) await openWorldPath(path);
}

export const showAbout = (open: boolean): void => set({ about: open });
export const showExport = (open: boolean): void => set({ exporting: open, placing: null });

// --- export ------------------------------------------------------------------------------

const WRITERS: Record<Engine, (world: World, resolved: Resolved) => ExportBundle> = { gazebo: gazeboBundle, mujoco: mujocoBundle, isaac: isaacBundle };

/** The bundle for an engine, with every mesh resolved; what the export dialog previews and writes. */
export async function buildBundle(engine: Engine): Promise<ExportBundle> {
  const resolved: Resolved = { meshes: {} };
  for (const asset of state.world.assets) {
    if (asset.kind !== 'mesh') continue;
    const mesh = await resolveMesh(asset.id);
    if (mesh) resolved.meshes[asset.id] = mesh;
  }
  return WRITERS[engine](state.world, resolved);
}

/** Writes the bundle: into a chosen folder on desktop (robot packages copied in), as a zip download in a browser. */
export async function exportWorld(engine: Engine): Promise<void> {
  set({ busy: 'Writing the world…' });
  try {
    const bundle = await buildBundle(engine);
    if (platform.isDesktop()) {
      const into = await platform.pickExportFolder();
      if (!into) return;
      const folder = `${into}/${bundle.name}`;
      for (const file of bundle.files) await platform.writePath(`${folder}/${file.path}`, 'text' in file ? encodeText(file.text) : file.bytes);
      for (const copy of bundle.copies) await platform.copyTree(copy.from, `${folder}/${copy.to}`);
      set({ exporting: false });
      tell(bundle.notes.length ? 'info' : 'ok', `${bundle.notes.length ? bundle.notes.join(' ') + ' ' : ''}Written to ${folder}. Run: ${bundle.launch}`, { label: 'Show folder', run: () => void platform.openPath(folder).catch(fail) });
    } else {
      const entries: Record<string, Uint8Array> = {};
      for (const file of bundle.files) entries[`${bundle.name}/${file.path}`] = 'text' in file ? encodeText(file.text) : file.bytes;
      const zip = zipSync(entries, { level: 6 });
      await platform.writeTarget({ path: null, name: `${bundle.name}-${engine}.zip` }, zip, 'application/zip');
      set({ exporting: false });
      const copies = bundle.copies.length ? ` The robot packages (${bundle.copies.map((c) => c.to).join(', ')}) must be copied in by hand: a browser cannot read folders.` : '';
      tell(bundle.notes.length ? 'info' : 'ok', `${bundle.notes.join(' ')}${copies} Run: ${bundle.launch}`);
    }
  } catch (err) {
    fail(err);
  } finally {
    set({ busy: null });
  }
}

export { titleOf };
