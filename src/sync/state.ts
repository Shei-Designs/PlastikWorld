// Where this device remembers what it last agreed on with the remote, per
// world: IndexedDB, which the desktop webview and browsers alike have.
// PlastikCAD's `src/sync/state.ts`, lifted, without its second store for parts.
import type { SyncRecord, SyncState } from './engine';

const DB_NAME = 'plastikworld-sync';
const STORE = 'records';
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(STORE)) open.result.createObjectStore(STORE, { keyPath: 'worldId' });
    };
    open.onerror = () => reject(open.error);
    open.onsuccess = () => resolve(open.result);
  });
}

function transact<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const request = run(tx.objectStore(STORE));
        tx.oncomplete = () => {
          db.close();
          resolve(request ? request.result : (undefined as T));
        };
        tx.onerror = tx.onabort = () => {
          db.close();
          reject(tx.error ?? new Error('The sync state could not be stored.'));
        };
      }),
  );
}

export class DbSyncState implements SyncState {
  all(): Promise<SyncRecord[]> {
    return transact<SyncRecord[]>('readonly', (s) => s.getAll());
  }
  put(record: SyncRecord): Promise<void> {
    return transact<void>('readwrite', (s) => void s.put(record));
  }
  remove(worldId: string): Promise<void> {
    return transact<void>('readwrite', (s) => void s.delete(worldId));
  }
  /** Forgets everything, when the account is unlinked. */
  clear(): Promise<void> {
    return transact<void>('readwrite', (s) => void s.clear());
  }
}
