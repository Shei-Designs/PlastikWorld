// The sync engine: brings a world store and a remote copy of it into line,
// remembering per world what both sides last agreed on. PlastikCAD's
// `src/sync/engine.ts`, lifted with projects become worlds. It knows nothing
// of Google Drive or of the editor; those plug in through the interfaces below.
//
// A world is matched across the two sides by the id in its file header. Each
// save stamps a revision; a side has changed when its revision is not the one
// recorded at the last sync. Changes on one side are copied to the other.
// Changes on both sides are merged object by object; where the same object
// was changed differently, both versions are kept, the remote one as a world
// of its own, so that nothing anyone did is lost on either device.
import { parseWorldText, serializeWorldText } from '../model/file';
import { newId } from '../model/math';
import type { WorldInfo, WorldStore } from '../state/worlds';
import { mergeWorlds } from './merge';

export interface RemoteFile {
  id: string;
  name: string;
  /** From the file's metadata; null for a file the remote holds without one. */
  worldId: string | null;
  revision: string | null;
  /** Milliseconds since the epoch. */
  modified: number;
}

export interface Remote {
  list(): Promise<RemoteFile[]>;
  download(file: RemoteFile): Promise<string>;
  /** Creates a file (`existing` null) or replaces one, and returns it as it now is. */
  upload(existing: RemoteFile | null, name: string, text: string, meta: { worldId: string; revision: string | null }): Promise<RemoteFile>;
  remove(file: RemoteFile): Promise<void>;
}

/** What both sides last agreed on for one world. */
export interface SyncRecord {
  worldId: string;
  fileId: string;
  /** The revision at the last sync, null for files from before revisions. */
  revision: string | null;
  /** The text at the last sync, the base of a three-way merge. */
  baseText: string;
}

export interface SyncState {
  all(): Promise<SyncRecord[]>;
  put(record: SyncRecord): Promise<void>;
  remove(worldId: string): Promise<void>;
}

export interface SyncReport {
  /** World names, for telling the user. */
  uploaded: string[];
  downloaded: string[];
  merged: string[];
  /** Worlds whose remote version was kept as a world of its own beside the local one. */
  kept: string[];
  deletedLocally: string[];
  deletedRemotely: string[];
  /** Keys in the local store that were written or removed, for the editor to take in. */
  changedKeys: string[];
  removedKeys: string[];
  /** Local files that moved because the world was renamed on the other side. */
  movedKeys: { from: string; to: string }[];
}

export interface SyncOptions {
  /** This device's id, stamped into merged saves. */
  device: string;
  /** Name for the remote version kept beside a local one in a conflict. */
  copyName?: (name: string) => string;
}

export class MemorySyncState implements SyncState {
  readonly records = new Map<string, SyncRecord>();
  async all(): Promise<SyncRecord[]> {
    return [...this.records.values()];
  }
  async put(record: SyncRecord): Promise<void> {
    this.records.set(record.worldId, record);
  }
  async remove(worldId: string): Promise<void> {
    this.records.delete(worldId);
  }
}

/** One pass over everything. Errors in one world do not stop the others; the first is rethrown at the end. */
export async function synchronize(local: WorldStore, remote: Remote, state: SyncState, options: SyncOptions): Promise<SyncReport> {
  const report: SyncReport = { uploaded: [], downloaded: [], merged: [], kept: [], deletedLocally: [], deletedRemotely: [], changedKeys: [], removedKeys: [], movedKeys: [] };
  const copyName = options.copyName ?? ((name: string) => `${name} (other device)`);

  const locals = new Map<string, WorldInfo>();
  for (const info of await local.list()) {
    // Files without an id are not synced until they are opened and get one; a second file with the same id is left alone.
    if (info.id && !locals.has(info.id)) locals.set(info.id, info);
  }
  const remotes = new Map<string, RemoteFile>();
  for (const file of await remote.list()) {
    if (file.worldId && !remotes.has(file.worldId)) remotes.set(file.worldId, file);
  }
  const records = new Map((await state.all()).map((r) => [r.worldId, r]));

  const texts = new Map<string, string>();
  const localText = async (info: WorldInfo): Promise<string> => {
    let text = texts.get(info.key);
    if (text === undefined) texts.set(info.key, (text = await local.read(info.key)));
    return text;
  };
  const localChanged = async (info: WorldInfo, record: SyncRecord): Promise<boolean> =>
    info.revision !== null || record.revision !== null ? info.revision !== record.revision : (await localText(info)) !== record.baseText;
  const remoteChanged = async (file: RemoteFile, record: SyncRecord): Promise<boolean> =>
    file.revision !== null || record.revision !== null ? file.revision !== record.revision : (await remote.download(file)) !== record.baseText;

  const writeLocal = async (info: WorldInfo | undefined, name: string, text: string): Promise<string> => {
    const key = await local.write(info?.key ?? null, name, text);
    report.changedKeys.push(key);
    if (info && key !== info.key) report.movedKeys.push({ from: info.key, to: key });
    return key;
  };
  const record = (worldId: string, file: RemoteFile, revision: string | null, baseText: string) => state.put({ worldId, fileId: file.id, revision, baseText });

  let firstError: unknown = null;
  for (const worldId of new Set([...locals.keys(), ...remotes.keys(), ...records.keys()])) {
    const info = locals.get(worldId);
    const file = remotes.get(worldId);
    const known = records.get(worldId);
    try {
      if (info && !file && !known) {
        // New here.
        const text = await localText(info);
        const uploaded = await remote.upload(null, info.name, text, { worldId, revision: info.revision });
        await record(worldId, uploaded, info.revision, text);
        report.uploaded.push(info.name);
      } else if (!info && file && !known) {
        // New on the other side.
        const text = await remote.download(file);
        const world = parseWorldText(text);
        await writeLocal(undefined, world.name, text);
        await record(worldId, file, file.revision ?? world.revision ?? null, text);
        report.downloaded.push(world.name);
      } else if (info && !file && known) {
        if (await localChanged(info, known)) {
          // Deleted remotely but changed here since: the change wins and the world goes back up.
          const text = await localText(info);
          const uploaded = await remote.upload(null, info.name, text, { worldId, revision: info.revision });
          await record(worldId, uploaded, info.revision, text);
          report.uploaded.push(info.name);
        } else {
          await local.remove(info.key);
          report.removedKeys.push(info.key);
          await state.remove(worldId);
          report.deletedLocally.push(info.name);
        }
      } else if (!info && file && known) {
        if (await remoteChanged(file, known)) {
          // Deleted here but changed on the other side since: it comes back.
          const text = await remote.download(file);
          const world = parseWorldText(text);
          await writeLocal(undefined, world.name, text);
          await record(worldId, file, file.revision ?? world.revision ?? null, text);
          report.downloaded.push(world.name);
        } else {
          await remote.remove(file);
          await state.remove(worldId);
          report.deletedRemotely.push(file.name.replace(/\.plastikworld$/i, ''));
        }
      } else if (!info && !file && known) {
        await state.remove(worldId);
      } else if (info && file && !known) {
        // Both sides have it but this device never synced it: a second device with its own copy, or lost state.
        const text = await localText(info);
        const remoteText = await remote.download(file);
        if (text === remoteText || (info.revision !== null && info.revision === file.revision)) {
          await record(worldId, file, info.revision, text);
        } else {
          await reconcile(info, file, null, text, remoteText);
        }
      } else if (info && file && known) {
        const changedHere = await localChanged(info, known);
        const changedThere = await remoteChanged(file, known);
        if (!changedHere && !changedThere) continue;
        const text = await localText(info);
        if (changedHere && !changedThere) {
          const uploaded = await remote.upload(file, info.name, text, { worldId, revision: info.revision });
          await record(worldId, uploaded, info.revision, text);
          report.uploaded.push(info.name);
        } else if (!changedHere && changedThere) {
          const remoteText = await remote.download(file);
          const world = parseWorldText(remoteText);
          await writeLocal(info, world.name, remoteText);
          await record(worldId, file, file.revision ?? world.revision ?? null, remoteText);
          report.downloaded.push(world.name);
        } else {
          await reconcile(info, file, known.baseText, text, await remote.download(file));
        }
      }
    } catch (e) {
      firstError ??= e;
    }
  }
  if (firstError) throw firstError;
  return report;

  /** Both sides changed: merge, or keep both. */
  async function reconcile(info: WorldInfo, file: RemoteFile, baseText: string | null, text: string, remoteText: string): Promise<void> {
    const localWorld = parseWorldText(text);
    const remoteWorld = parseWorldText(remoteText);
    const base = baseText === null ? null : parseWorldText(baseText);
    const { world, conflicts } = mergeWorlds(base, localWorld, remoteWorld);
    if (conflicts === 0) {
      const merged = { ...world, revision: newId(), parent: localWorld.revision, device: options.device, saved: new Date().toISOString() };
      const mergedText = serializeWorldText(merged);
      await writeLocal(info, merged.name, mergedText);
      const uploaded = await remote.upload(file, merged.name, mergedText, { worldId: merged.id, revision: merged.revision });
      await record(merged.id, uploaded, merged.revision, mergedText);
      report.merged.push(merged.name);
      return;
    }
    // The remote version lives on as a world of its own, on both sides; the local one stays as it is.
    const copy = { ...remoteWorld, id: newId(), name: copyName(remoteWorld.name), revision: newId(), parent: remoteWorld.revision, device: options.device, saved: new Date().toISOString() };
    const copyText = serializeWorldText(copy);
    await writeLocal(undefined, copy.name, copyText);
    const copyFile = await remote.upload(null, copy.name, copyText, { worldId: copy.id, revision: copy.revision });
    await record(copy.id, copyFile, copy.revision, copyText);
    const uploaded = await remote.upload(file, info.name, text, { worldId: info.id!, revision: info.revision });
    await record(info.id!, uploaded, info.revision, text);
    report.kept.push(remoteWorld.name);
  }
}
