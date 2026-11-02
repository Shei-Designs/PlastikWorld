// Keeps the world store in step with the linked cloud account: a little after
// every save, when the app starts, comes online or is asked to, and every few
// minutes. PlastikCAD's `src/sync/sync.ts`, lifted. Status is published for
// the UI; the editor is told what changed under it. Nothing here knows about
// the editor's state.
import { useSyncExternalStore } from 'react';
import { hasWorldStore, worldStore } from '../state/worlds';
import { DriveRemote } from './drive';
import { synchronize } from './engine';
import type { SyncReport } from './engine';
import { authorizedFetch, cancelSignIn, isConfigured, loadTokens, NeedsSignIn, revoke, saveTokens, signIn } from './google';
import type { Tokens } from './google';
import { DbSyncState } from './state';

export interface SyncStatus {
  /** Whether this build knows a Google client at all. */
  configured: boolean;
  linked: boolean;
  email: string | null;
  busy: boolean;
  /** When the last pass finished without error, ms since the epoch. */
  lastSync: number | null;
  error: string | null;
  offline: boolean;
}

/** After a save, how long to wait for more before syncing. */
const AFTER_SAVE_MS = 5000;
const EVERY_MS = 3 * 60_000;

let status: SyncStatus = { configured: isConfigured(), linked: false, email: null, busy: false, lastSync: null, error: null, offline: false };
const listeners = new Set<() => void>();
let tokens: Tokens | null = null;
let remote: DriveRemote | null = null;
const state = typeof indexedDB === 'undefined' ? null : new DbSyncState();
let device = '';
let onChanged: ((report: SyncReport) => void) | null = null;
let onNotice: ((text: string) => void) | null = null;
let beforeSync: (() => Promise<unknown>) | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let interval: ReturnType<typeof setInterval> | undefined;
let running: Promise<SyncReport | null> | null = null;
let again = false;

function publish(patch: Partial<SyncStatus>): void {
  status = { ...status, ...patch };
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const getSyncStatus = (): SyncStatus => status;
export const useSyncStatus = (): SyncStatus => useSyncExternalStore(subscribe, () => status);

function useTokens(next: Tokens | null): void {
  tokens = next;
  saveTokens(next);
  remote = next ? new DriveRemote(authorizedFetch(() => tokens, useTokens)) : null;
  publish({ linked: next !== null, email: next?.email ?? null });
}

/**
 * Picks up the linked account, if any, and starts the schedule. `changed` is
 * told what each pass wrote or removed among the worlds; `flush` runs before
 * a pass so that pending edits are on disk first.
 */
export function initSync(options: { device: string; changed: (report: SyncReport) => void; notice: (text: string) => void; flush: () => Promise<unknown> }): void {
  device = options.device;
  onChanged = options.changed;
  onNotice = options.notice;
  beforeSync = options.flush;
  useTokens(loadTokens());
  clearInterval(interval);
  interval = setInterval(() => void syncNow(), EVERY_MS);
  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => void syncNow());
    window.addEventListener('focus', () => requestSync(1000));
  }
  if (tokens) requestSync(2000);
}

/** Signs in and runs a first pass. Rejects with a message fit to show. */
export async function linkAccount(): Promise<void> {
  if (!status.configured) throw new Error('Google Drive sync is not set up in this build.');
  publish({ busy: true, error: null });
  try {
    const fresh = await signIn();
    useTokens(fresh);
    const who = await remote!.account().catch(() => null);
    if (who?.email) useTokens({ ...fresh, email: who.email });
  } finally {
    publish({ busy: false });
  }
  await syncNow();
}

/** Gives up a sign-in under way; `linkAccount` then rejects with "cancelled". */
export const cancelLink = (): void => cancelSignIn();

/** Forgets the account, tells Google so, and drops what was agreed with it; the local worlds stay. */
export async function unlinkAccount(): Promise<void> {
  clearTimeout(timer);
  await running;
  const old = tokens;
  useTokens(null);
  await state?.clear();
  publish({ lastSync: null, error: null });
  if (old) await revoke(old);
}

/** Syncs once the dust has settled; a pass already waiting is pushed back. */
export function requestSync(delay = AFTER_SAVE_MS): void {
  if (!tokens) return;
  clearTimeout(timer);
  timer = setTimeout(() => void syncNow(), delay);
}

/** One pass now, or joins the one running (and runs once more after it, since something may have changed since it started). */
export function syncNow(): Promise<SyncReport | null> {
  clearTimeout(timer);
  if (running) {
    again = true;
    return running;
  }
  running = pass().finally(() => {
    running = null;
    if (again) {
      again = false;
      requestSync(500);
    }
  });
  return running;
}

async function pass(): Promise<SyncReport | null> {
  if (!tokens || !remote || !state || !hasWorldStore()) return null;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    publish({ offline: true });
    return null;
  }
  publish({ busy: true, offline: false });
  try {
    await beforeSync?.();
    const report = await synchronize(worldStore(), remote, state, { device });
    if (report.changedKeys.length || report.removedKeys.length || report.kept.length) onChanged?.(report);
    publish({ busy: false, lastSync: Date.now(), error: null });
    return report;
  } catch (e) {
    if (e instanceof NeedsSignIn) {
      // The grant is gone (revoked from the Google account, say): said once, here and in the worlds browser.
      useTokens(null);
      publish({ busy: false, error: e.message });
      onNotice?.(`Google Drive sync stopped: ${e.message}`);
      return null;
    }
    const message = e instanceof Error ? e.message : String(e);
    // Network trouble is not an error worth a red line; it will be tried again.
    const offline = /Failed to fetch|NetworkError|Load failed|network/i.test(message);
    publish({ busy: false, error: offline ? null : message, offline });
    return null;
  }
}
