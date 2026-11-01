// The world's assets as loaded in this session: a GLB's triangles, a robot's
// visual meshes, read from the bytes the world carries. The world file holds
// the bytes; this cache is what the viewer draws and the writers read.
import { loadGlb, meshDataOf } from '../io/meshes';
import { boundsOf } from '../io/export';
import type { ResolvedMesh } from '../io/export';
import { assetPresent } from '../model/types';
import type { Asset, MeshAsset, Pose, RobotAsset, Vec3 } from '../model/types';
import { visualsOf } from '../robot/package';
import type { PackageFiles } from '../robot/package';

export interface RobotPart {
  obj: Uint8Array;
  mtl: Uint8Array | null;
  pose: Pose;
  scale: Vec3;
}

export type Loaded = { kind: 'glb'; bytes: Uint8Array; resolved: ResolvedMesh | null } | { kind: 'robot'; parts: RobotPart[] } | { kind: 'missing' };

const cache = new Map<string, Loaded>();
const listeners = new Set<() => void>();
let epoch = 0;

export const assetEpoch = (): number => epoch;
export const subscribeAssets = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

function set(id: string, loaded: Loaded): void {
  cache.set(id, loaded);
  epoch++;
  for (const l of listeners) l();
}

export const loadedAsset = (id: string): Loaded | undefined => cache.get(id);

export function forget(id: string): void {
  if (cache.delete(id)) {
    epoch++;
    for (const l of listeners) l();
  }
}

/** A package's files as the readers want them, from the map the world carries. */
export const packageFiles = (files: Record<string, Uint8Array>): PackageFiles => ({ paths: Object.keys(files), read: async (p) => files[p] ?? Promise.reject(new Error(`${p} is not in the package`)) });

/** Reads every file of a picked package folder into the map a world carries. */
export async function collectFiles(files: PackageFiles): Promise<Record<string, Uint8Array>> {
  const out: Record<string, Uint8Array> = {};
  for (const path of files.paths) out[path.replace(/\\/g, '/')] = await files.read(path);
  return out;
}

export function keepGlb(asset: MeshAsset): void {
  set(asset.id, assetPresent(asset) ? { kind: 'glb', bytes: asset.data, resolved: null } : { kind: 'missing' });
}

/** The robot's visual meshes, read from its package files and placed in its frame. Meshes other than OBJ are skipped. */
export async function keepRobot(asset: RobotAsset): Promise<string[]> {
  const notes: string[] = [];
  const parts: RobotPart[] = [];
  if (!assetPresent(asset)) {
    set(asset.id, { kind: 'missing' });
    return notes;
  }
  const files = packageFiles(asset.files);
  try {
    const entry = await files.read(asset.entry);
    const paths = new Set(files.paths);
    for (const visual of visualsOf(asset.format, entry)) {
      if (!/\.obj$/i.test(visual.file)) {
        notes.push(`${asset.name}: ${visual.file} is not an OBJ, so it is not drawn (the export still carries it).`);
        continue;
      }
      if (!paths.has(visual.file)) {
        notes.push(`${asset.name}: ${visual.file} is missing from the package.`);
        continue;
      }
      const mtlPath = visual.file.replace(/\.obj$/i, '.mtl');
      parts.push({ obj: await files.read(visual.file), mtl: paths.has(mtlPath) ? await files.read(mtlPath) : null, pose: visual.pose, scale: visual.scale });
    }
    set(asset.id, { kind: 'robot', parts });
  } catch (err) {
    notes.push(`${asset.name}: ${err instanceof Error ? err.message : String(err)}`);
    set(asset.id, { kind: 'missing' });
  }
  return notes;
}

/** Loads an opened world's assets from the bytes it carries; says which ones carry none. */
export async function restoreAssets(assets: Asset[]): Promise<string[]> {
  const notes: string[] = [];
  for (const asset of assets) {
    if (cache.has(asset.id)) continue;
    if (!assetPresent(asset)) {
      set(asset.id, { kind: 'missing' });
      notes.push(`${asset.name}: its file is not with this world; import it again.`);
      continue;
    }
    if (asset.kind === 'mesh') keepGlb(asset);
    else notes.push(...(await keepRobot(asset)));
  }
  return notes;
}

/** A GLB's triangles and box, for the writers; computed once per asset. */
export async function resolveMesh(id: string): Promise<ResolvedMesh | null> {
  const loaded = cache.get(id);
  if (!loaded || loaded.kind !== 'glb') return null;
  if (loaded.resolved) return loaded.resolved;
  try {
    const data = meshDataOf(await loadGlb(loaded.bytes));
    loaded.resolved = { glb: loaded.bytes, data, bounds: boundsOf(data) };
  } catch (err) {
    console.warn('Could not read the mesh:', err);
    loaded.resolved = { glb: loaded.bytes, data: null, bounds: { min: [0, 0, 0], max: [0, 0, 0] } };
  }
  return loaded.resolved;
}
