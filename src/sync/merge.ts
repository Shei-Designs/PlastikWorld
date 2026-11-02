// Three-way merge of two versions of a world that grew apart from a common
// base, after PlastikCAD's `src/sync/merge.ts`: each list of things with ids
// (objects, lights, spawns, zones, materials, assets) is merged item by item.
// An item changed on one side only takes that side's version, one deleted on
// one side and left alone on the other goes, and one changed differently on
// both sides is a conflict. The terrain is one thing, as PlastikCAD's robot
// is: the side that changed it has it, and sculpting on both sides at once is
// a conflict, since two sets of heights cannot be merged.
import type { Asset, Terrain, World } from '../model/types';

export interface Merged {
  world: World;
  /** Things changed differently on both sides; the local version was kept for each. */
  conflicts: number;
}

interface WithId {
  id: string;
}

/** An asset without its bytes: the data behind an id never changes, so the sizes stand in for it. */
function assetText(a: Asset): string {
  if (a.kind === 'mesh') return JSON.stringify({ ...a, data: a.data.length });
  if (a.kind === 'part') return JSON.stringify(a);
  return JSON.stringify({ ...a, files: Object.keys(a.files).sort().map((p) => [p, a.files[p].length]) });
}

function sameTerrain(a: Terrain, b: Terrain): boolean {
  if (a === b) return true;
  if (a.kind !== b.kind || a.size[0] !== b.size[0] || a.size[1] !== b.size[1] || a.friction !== b.friction) return false;
  if (a.kind !== 'heightmap' || b.kind !== 'heightmap') return true;
  if (a.rows !== b.rows || a.cols !== b.cols || a.heights.length !== b.heights.length) return false;
  for (let i = 0; i < a.heights.length; i++) if (a.heights[i] !== b.heights[i]) return false;
  return true;
}

/**
 * One list merged. `base` null means the common version is unknown, in which
 * case every difference counts as a conflict. The result keeps the local
 * order, with items added remotely slotted in where the remote side had them.
 */
function mergeList<T extends WithId>(base: T[] | null, local: T[], remote: T[], text: (item: T) => string): { items: T[]; conflicts: number } {
  const same = (a: T | undefined, b: T | undefined): boolean => a === b || (a !== undefined && b !== undefined && text(a) === text(b));
  const B = new Map((base ?? []).map((n) => [n.id, n]));
  const L = new Map(local.map((n) => [n.id, n]));
  const R = new Map(remote.map((n) => [n.id, n]));
  const picked = new Map<string, T>();
  let conflicts = 0;
  for (const id of new Set([...L.keys(), ...R.keys(), ...B.keys()])) {
    const b = B.get(id);
    const l = L.get(id);
    const r = R.get(id);
    if (same(l, r)) {
      if (l) picked.set(id, l);
      continue;
    }
    const localChanged = !same(l, b);
    const remoteChanged = !same(r, b);
    if (!localChanged) {
      if (r) picked.set(id, r);
    } else if (!remoteChanged) {
      if (l) picked.set(id, l);
    } else if (l && r) {
      // Changed differently on both sides.
      conflicts++;
      picked.set(id, l);
    } else {
      // Deleted on one side, edited on the other: the edit is kept.
      picked.set(id, (l ?? r)!);
    }
  }
  const items: T[] = [];
  for (const item of local) if (picked.has(item.id)) items.push(picked.get(item.id)!);
  // Remote additions go after the nearest item that precedes them remotely and is in the result.
  const remoteIds = remote.map((n) => n.id);
  for (let i = 0; i < remoteIds.length; i++) {
    const id = remoteIds[i];
    if (L.has(id) || !picked.has(id)) continue;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const index = items.findIndex((n) => n.id === remoteIds[j]);
      if (index >= 0) {
        at = index + 1;
        break;
      }
    }
    items.splice(at, 0, picked.get(id)!);
  }
  return { items, conflicts };
}

const json = (v: unknown): string => JSON.stringify(v);

export function mergeWorlds(base: World | null, local: World, remote: World): Merged {
  let conflicts = 0;
  const list = <K extends 'objects' | 'lights' | 'spawns' | 'zones' | 'materials'>(key: K): World[K] => {
    const merged = mergeList<WithId>(base ? base[key] : null, local[key], remote[key], json);
    conflicts += merged.conflicts;
    return merged.items as World[K];
  };
  const objects = list('objects');
  const lights = list('lights');
  const spawns = list('spawns');
  const zones = list('zones');
  const materials = list('materials');
  const assets = mergeList(base ? base.assets : null, local.assets, remote.assets, assetText);
  conflicts += assets.conflicts;

  // The one-of-a-kind fields: the side that changed one has it, the local side when both did.
  const pick = <T>(l: T, r: T, b: T | undefined, same: (a: T, b: T) => boolean, conflict: boolean): T => {
    if (same(l, r)) return l;
    if (base && same(l, b as T)) return r;
    if (base && same(r, b as T)) return l;
    if (conflict) conflicts++;
    return l;
  };
  const sameJson = (a: unknown, b: unknown) => json(a) === json(b);
  const name = pick(local.name, remote.name, base?.name, (a, b) => a === b, false);
  const gravity = pick(local.gravity, remote.gravity, base?.gravity, sameJson, false);
  const environment = pick(local.environment, remote.environment, base?.environment, sameJson, false);
  const terrain = pick(local.terrain, remote.terrain, base?.terrain, sameTerrain, true);

  return { world: { ...local, name, gravity, environment, terrain, objects, lights, spawns, zones, materials, assets: assets.items }, conflicts };
}
