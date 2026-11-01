// The files the world's assets refer to, as loaded in this session: a GLB's
// bytes, a robot's visual meshes. The world file keeps only paths; this cache
// is what the viewer draws and the writers read. On desktop a world's assets
// are read back from their paths when it opens; in a browser they must be
// imported again.
import { loadGlb, meshDataOf } from '../io/meshes';
import { boundsOf } from '../io/export';
import type { ResolvedMesh } from '../io/export';
import type { Asset, MeshAsset, Pose, RobotAsset, Vec3 } from '../model/types';
import * as platform from '../platform';
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

export function keepGlb(asset: MeshAsset, bytes: Uint8Array): void {
  set(asset.id, { kind: 'glb', bytes, resolved: null });
}

/** The robot's visual meshes, read from its package files and placed in its frame. Meshes other than OBJ are skipped. */
export async function keepRobot(asset: RobotAsset, files: PackageFiles): Promise<string[]> {
  const notes: string[] = [];
  const parts: RobotPart[] = [];
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

/** Reads an opened world's assets back from disk (desktop); marks the ones that cannot be read. */
export async function restoreAssets(assets: Asset[]): Promise<string[]> {
  const notes: string[] = [];
  for (const asset of assets) {
    if (cache.has(asset.id)) continue;
    if (!asset.source.path || !platform.isDesktop()) {
      set(asset.id, { kind: 'missing' });
      if (!platform.isDesktop()) notes.push(`${asset.name}: import it again to see it (a browser cannot read files by path).`);
      continue;
    }
    try {
      if (asset.kind === 'mesh') keepGlb(asset, (await platform.readPath(asset.source.path)).bytes);
      else notes.push(...(await keepRobot(asset, (await platform.folderAt(asset.source.path)).files)));
    } catch (err) {
      set(asset.id, { kind: 'missing' });
      notes.push(`${asset.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
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
