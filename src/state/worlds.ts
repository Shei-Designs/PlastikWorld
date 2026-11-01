// Where worlds are kept, after PlastikCAD's project store (`src/state/projects.ts`
// there, lifted here with the names changed): the desktop app keeps them as
// `.plastikworld` files in a worlds folder (on Android, in the app's own
// storage); a plain browser keeps them in IndexedDB. Autosave writes here and
// the worlds browser lists it. A world is addressed by its key: the file's
// path on disk, a record key in the browser. The id inside the file identifies
// the world across copies and devices (that is what sync will use); the key
// says where it is now.
import { FILE_EXTENSION, FILE_FORMAT } from '../app';
import { HEAD_BYTES, headerOf, readHeader } from '../model/file';
import type { WorldHeader } from '../model/file';
import { newId } from '../model/math';
import * as platform from '../platform';

export interface WorldInfo {
  key: string;
  /** Null when the file was saved before worlds had ids; it gets one when opened. */
  id: string | null;
  name: string;
  /** The revision stamped in the file; null for files from before revisions. */
  revision: string | null;
  /** Milliseconds since the epoch. */
  modified: number;
  size: number;
  thumb: string | null;
}

export interface WorldStore {
  /** The folder worlds are kept in, for the settings line; null in the browser. */
  readonly location: string | null;
  list(): Promise<WorldInfo[]>;
  /** The world's file text. Rejects if it is gone. */
  read(key: string): Promise<string>;
  /**
   * Writes a world, new when `key` is null, and returns the key it is at now:
   * a file follows its world's name, so a rename moves it.
   */
  write(key: string | null, name: string, text: string): Promise<string>;
  remove(key: string): Promise<void>;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** A file name for a world name: no path separators or characters some file systems refuse, not too long. */
export function fileNameFor(name: string): string {
  const clean = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 80)
    .trim();
  return `${clean || 'Untitled'}.${FILE_EXTENSION}`;
}

/** `Name.plastikworld`, or `Name (2).plastikworld` when a different file already has that name (compared ignoring case, as some file systems do). */
export function uniqueFileName(wanted: string, taken: Iterable<string>, own?: string): string {
  const used = new Set(Array.from(taken, (n) => n.toLowerCase()));
  if (own) used.delete(own.toLowerCase());
  if (!used.has(wanted.toLowerCase())) return wanted;
  const stem = wanted.slice(0, wanted.length - FILE_EXTENSION.length - 1);
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n}).${FILE_EXTENSION}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

const baseName = (path: string): string => path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Whether a file already carries a world name: the same name ignoring case, with or without the number a clash gave it. */
const sameFile = (existing: string, wanted: string): boolean => {
  const stem = wanted.slice(0, wanted.length - FILE_EXTENSION.length - 1);
  return new RegExp(`^${escapeRegExp(stem)}( \\(\\d+\\))?\\.${FILE_EXTENSION}$`, 'i').test(existing);
};
const join = (dir: string, name: string): string => `${dir.replace(/[\\/]+$/, '')}/${name}`;

export class DiskWorlds implements WorldStore {
  private heads = new Map<string, { modified: number; size: number; header: WorldHeader }>();

  constructor(readonly location: string) {}

  async list(): Promise<WorldInfo[]> {
    const entries = await platform.listWorlds(this.location);
    const out: WorldInfo[] = [];
    for (const entry of entries) {
      let cached = this.heads.get(entry.path);
      if (!cached || cached.modified !== entry.modified || cached.size !== entry.size) {
        const header = await this.header(entry);
        // Not a world after all (some other JSON with the extension): left out.
        if (!header) continue;
        cached = { modified: entry.modified, size: entry.size, header };
        this.heads.set(entry.path, cached);
      }
      out.push({ key: entry.path, id: cached.header.id, name: cached.header.name, revision: cached.header.revision, modified: entry.modified, size: entry.size, thumb: cached.header.thumb });
    }
    for (const path of this.heads.keys()) if (!entries.some((e) => e.path === path)) this.heads.delete(path);
    return out;
  }

  private async header(entry: platform.WorldEntry): Promise<WorldHeader | null> {
    try {
      const head = decoder.decode(await platform.readHead(entry.path, HEAD_BYTES));
      const header = readHeader(head);
      if (header) return header;
      // Laid out some other way (a version 1 file, one edited by hand): the whole file has to be read.
      if (entry.size > 256 * 1024 * 1024) return null;
      return headerOf(decoder.decode((await platform.readPath(entry.path)).bytes));
    } catch {
      return null;
    }
  }

  async read(key: string): Promise<string> {
    return decoder.decode((await platform.readPath(key)).bytes);
  }

  async write(key: string | null, name: string, text: string): Promise<string> {
    const wanted = fileNameFor(name);
    let target = key;
    if (!key || !sameFile(baseName(key), wanted)) {
      const taken = (await platform.listWorlds(this.location)).map((e) => e.name);
      target = join(this.location, uniqueFileName(wanted, taken, key ? baseName(key) : undefined));
      if (key && target !== key) await platform.moveFile(key, target);
    }
    await platform.writePath(target!, encoder.encode(text));
    this.heads.delete(target!);
    return target!;
  }

  async remove(key: string): Promise<void> {
    await platform.removeFile(key);
    this.heads.delete(key);
  }
}

/** Worlds kept in memory: for tests, and the fallback when no storage is available. */
export class MemoryWorlds implements WorldStore {
  readonly location = null;
  readonly records = new Map<string, { name: string; text: string; modified: number }>();
  private serial = 0;
  private clock = 0;

  async list(): Promise<WorldInfo[]> {
    return Array.from(this.records, ([key, r]) => {
      const header = headerOf(r.text);
      return { key, id: header.id, name: r.name, revision: header.revision, modified: r.modified, size: r.text.length, thumb: header.thumb };
    });
  }

  async read(key: string): Promise<string> {
    const record = this.records.get(key);
    if (!record) throw new Error('This world is gone.');
    return record.text;
  }

  async write(key: string | null, name: string, text: string): Promise<string> {
    const at = key ?? `mem-${++this.serial}`;
    this.records.set(at, { name, text, modified: ++this.clock });
    return at;
  }

  async remove(key: string): Promise<void> {
    this.records.delete(key);
  }
}

// --- IndexedDB, for the browser --------------------------------------------

const META = 'meta';
const TEXTS = 'texts';

interface MetaRecord {
  key: string;
  id: string | null;
  name: string;
  revision: string | null;
  modified: number;
  size: number;
  thumb: string | null;
}

function openDb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(name, 1);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(META)) open.result.createObjectStore(META, { keyPath: 'key' });
      if (!open.result.objectStoreNames.contains(TEXTS)) open.result.createObjectStore(TEXTS);
    };
    open.onerror = () => reject(open.error);
    open.onsuccess = () => resolve(open.result);
  });
}

function transact<T>(name: string, mode: IDBTransactionMode, run: (tx: IDBTransaction) => IDBRequest<T> | void): Promise<T> {
  return openDb(name).then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction([META, TEXTS], mode);
        const request = run(tx);
        tx.oncomplete = () => {
          db.close();
          resolve(request ? request.result : (undefined as T));
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
        tx.onabort = tx.onerror;
      }),
  );
}

/** Worlds kept by the browser itself, per profile. */
export class DbWorlds implements WorldStore {
  readonly location = null;

  constructor(private readonly name: string = `${FILE_FORMAT}-worlds`) {}

  async list(): Promise<WorldInfo[]> {
    const rows = await transact<MetaRecord[]>(this.name, 'readonly', (tx) => tx.objectStore(META).getAll());
    return rows.map((r) => ({ key: r.key, id: r.id, name: r.name, revision: r.revision ?? null, modified: r.modified, size: r.size, thumb: r.thumb }));
  }

  async read(key: string): Promise<string> {
    const text = await transact<string | undefined>(this.name, 'readonly', (tx) => tx.objectStore(TEXTS).get(key));
    if (typeof text !== 'string') throw new Error('This world is gone.');
    return text;
  }

  async write(key: string | null, name: string, text: string): Promise<string> {
    const at = key ?? newId();
    const header = headerOf(text);
    await transact<void>(this.name, 'readwrite', (tx) => {
      tx.objectStore(META).put({ key: at, id: header.id, name, revision: header.revision, modified: Date.now(), size: text.length, thumb: header.thumb } satisfies MetaRecord);
      tx.objectStore(TEXTS).put(text, at);
    });
    return at;
  }

  async remove(key: string): Promise<void> {
    await transact<void>(this.name, 'readwrite', (tx) => {
      tx.objectStore(META).delete(key);
      tx.objectStore(TEXTS).delete(key);
    });
  }
}

// --- the store in use -----------------------------------------------------

let current: WorldStore | null = null;

/** The store worlds are kept in; `useWorldStore` first, or there is none. */
export function worldStore(): WorldStore {
  if (!current) throw new Error('The world storage is not ready yet.');
  return current;
}

export function useWorldStore(store: WorldStore): void {
  current = store;
}

/** Whether a store has been chosen (start-up has got that far). */
export const hasWorldStore = (): boolean => current !== null;

/**
 * Picks the store for this platform: the worlds folder on desktop (the one the
 * user chose, else the default; on Android the app's own storage, which cannot
 * be changed), IndexedDB in a browser, memory when even that is unavailable.
 * Returns the folder's default when there is one, so settings can say whether
 * it can be changed.
 */
export async function openWorldStore(chosenDir: string | null): Promise<{ fixed: boolean; defaultDir: string | null }> {
  if (platform.isDesktop()) {
    const home = await platform.defaultWorldsDir();
    const dir = home.fixed ? home.path : (chosenDir ?? home.path);
    useWorldStore(new DiskWorlds(dir));
    return { fixed: home.fixed, defaultDir: home.path };
  }
  if (typeof indexedDB === 'undefined') {
    useWorldStore(new MemoryWorlds());
    return { fixed: true, defaultDir: null };
  }
  useWorldStore(new DbWorlds());
  return { fixed: true, defaultDir: null };
}
