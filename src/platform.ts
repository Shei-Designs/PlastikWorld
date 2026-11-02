// The one module that knows whether the UI runs in the desktop app (Tauri) or
// in a plain browser, as it does during development (`pnpm dev`). Tauri's
// window, webview and dialog modules are imported on demand, so the browser
// never loads them. Lifted from PlastikCAD's `src/platform.ts`, Android
// branches included: there the pickers hand out content URIs through the
// device plugin, exports go to the app's folder in Downloads and the share
// sheet, and a folder cannot be picked at all (a robot package comes in as the
// zip PlastikCAD exports).
import { addPluginListener, invoke, isTauri } from '@tauri-apps/api/core';
import { APP_NAME } from './app';
import type { PackageFiles } from './robot/package';

export interface FileFilter {
  name: string;
  extensions: string[];
}

export interface PickedFile {
  name: string;
  /** Absolute path; null in the browser. */
  path: string | null;
  bytes: Uint8Array;
}

export function isDesktop(): boolean {
  return isTauri();
}

/** The Android app: the Tauri shell in an Android webview. */
export function isAndroid(): boolean {
  return isTauri() && typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);
}

/** Whether a folder can be picked here: desktop and browsers can, Android cannot (its pickers hand out one document at a time). */
export const canPickFolder = (): boolean => !isAndroid();

const baseName = (path: string): string => path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);

/** Calls one of the commands in `src-tauri/src/lib.rs`, which reject with a plain string. */
async function command<T>(name: string, args?: Record<string, unknown> | Uint8Array, headers?: Record<string, string>): Promise<T> {
  if (!isTauri()) throw new Error(`${name} is only available in the desktop app`);
  try {
    return await invoke<T>(name, args, headers && { headers });
  } catch (reason) {
    throw reason instanceof Error ? reason : new Error(String(reason));
  }
}

async function readBrowserFile(file: File): Promise<PickedFile> {
  return { name: file.name, path: null, bytes: new Uint8Array(await file.arrayBuffer()) };
}

/** Keeps the files that could be read: one bad entry (a dropped folder, say) should not lose the rest. */
async function readable(reads: Promise<PickedFile>[]): Promise<PickedFile[]> {
  const results = await Promise.allSettled(reads);
  return results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
}

/**
 * Tauri registers listeners asynchronously, but callers want an unsubscribe
 * function straight away; this one also works if called before registration
 * has finished.
 */
function listen(register: () => Promise<() => void>): () => void {
  let canceled = false;
  let unlisten: (() => void) | null = null;
  register().then((stop) => {
    if (canceled) stop();
    else unlisten = stop;
  }, console.error);
  return () => {
    canceled = true;
    unlisten?.();
  };
}

function pickInBrowser(filters: FileFilter[], multiple: boolean, directory = false): Promise<File[]> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = multiple;
    if (directory) input.setAttribute('webkitdirectory', '');
    const extensions = filters.flatMap((filter) => filter.extensions);
    if (!directory && !extensions.includes('*')) input.accept = extensions.map((extension) => `.${extension}`).join(',');
    input.style.display = 'none';
    const settle = (files: File[] | Error) => {
      input.remove();
      if (files instanceof Error) reject(files);
      else resolve(files);
    };
    input.addEventListener('change', () => settle(Array.from(input.files ?? [])));
    input.addEventListener('cancel', () => settle([]));
    // Attached to the page so it cannot be collected while the picker is open.
    document.body.append(input);
    input.click();
  });
}

/** Native open dialog, or a hidden <input type="file"> in the browser. Empty array if canceled. */
export async function pickFiles(options: { filters: FileFilter[]; multiple?: boolean }): Promise<PickedFile[]> {
  const multiple = options.multiple ?? false;
  if (!isTauri()) return Promise.all((await pickInBrowser(options.filters, multiple)).map(readBrowserFile));
  if (isAndroid()) {
    // The device plugin's picker: every file is offered, as the system picker filters by the type a file was
    // stored with, which a GLB or a world file rarely has (they show greyed out), and the app reads what each
    // one is itself.
    const { uris } = await invoke<{ uris: string[] }>('plugin:device|pick_documents', { multiple });
    return Promise.all(uris.map(readPath));
  }
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked: string | string[] | null = await open({ filters: options.filters, multiple });
  if (picked === null) return [];
  return Promise.all((Array.isArray(picked) ? picked : [picked]).map(readPath));
}

/** Desktop and Android (a path, or a content URI). Rejects with a readable Error if the file cannot be read. */
export async function readPath(path: string): Promise<PickedFile> {
  // Tauri delivers the bytes as an array of numbers where it cannot use a binary response.
  const data = await command<ArrayBuffer | number[]>('read_file', { path });
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : Uint8Array.from(data);
  return { name: await nameOf(path), path, bytes };
}

/**
 * The file's name with its extension. A path ends in it; a `content://` URI
 * from an Android picker may carry it in its last segment ("primary:Download/box.glb")
 * or not at all, in which case the app asks the provider.
 */
async function nameOf(path: string): Promise<string> {
  if (!path.includes('://')) return baseName(path);
  let segment = baseName(path);
  try {
    segment = baseName(decodeURIComponent(segment));
  } catch {
    // Left as it came.
  }
  if (/\.[^.]+$/.test(segment)) return segment;
  const asked = await command<string | null>('file_name', { path }).catch(() => null);
  return asked ?? segment;
}

/**
 * Android: writes an export into the app's own folder in Downloads
 * (`Download/PlastikWorld/<folder>/<name>`), replacing a file of that name, with
 * no dialog. Resolves with the file's content URI and the path as the Files
 * app shows it.
 */
export async function exportToAppFolder(folder: string, name: string, bytes: Uint8Array, mime: string): Promise<{ uri: string; path: string }> {
  return command<{ uri: string; path: string }>('save_export', bytes, {
    folder: encodeURIComponent(folder),
    name: encodeURIComponent(name),
    mime: encodeURIComponent(mime),
  });
}

/** Whether exports are named in the app and kept in its own folder (Android), rather than placed through a save dialog. */
export const keepsExports = (): boolean => isAndroid();

/** Android: opens the share sheet with the given files. */
export async function share(uris: string[], mime: string): Promise<void> {
  await invoke('plugin:device|share', { uris, mime });
}

/** Android: opens the share sheet with a file made for the occasion (a zip of an export bundle), staged in the app's cache. */
export async function shareBytes(name: string, bytes: Uint8Array, mime: string): Promise<void> {
  const path = await command<string>('stage_share', bytes, { name: encodeURIComponent(name) });
  await share([path], mime);
}

/** A folder picked as a robot package: its name, its path (null in the browser) and its files. */
export interface PickedFolder {
  name: string;
  path: string | null;
  files: PackageFiles;
}

/**
 * Asks for a folder: the native folder picker on desktop, a directory pick in
 * the browser (which hands over the files inside, with their relative paths).
 * Null if canceled.
 */
export async function pickFolder(): Promise<PickedFolder | null> {
  if (isAndroid()) throw new Error('Android hands out one file at a time: import the robot package as the zip PlastikCAD exports.');
  if (!isTauri()) {
    const files = await pickInBrowser([], true, true);
    if (files.length === 0) return null;
    const byPath = new Map<string, File>();
    let name = 'package';
    for (const file of files) {
      const rel = file.webkitRelativePath || file.name;
      const slash = rel.indexOf('/');
      if (slash > 0) name = rel.slice(0, slash);
      byPath.set(slash > 0 ? rel.slice(slash + 1) : rel, file);
    }
    return {
      name,
      path: null,
      files: {
        paths: [...byPath.keys()],
        read: async (path) => {
          const file = byPath.get(path);
          if (!file) throw new Error(`No file ${path} in the folder`);
          return new Uint8Array(await file.arrayBuffer());
        },
      },
    };
  }
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({ directory: true, multiple: false });
  if (typeof picked !== 'string') return null;
  return folderAt(picked);
}

/** Desktop only: a folder on disk as a package. */
export async function folderAt(path: string): Promise<PickedFolder> {
  const paths = await command<string[]>('read_tree', { dir: path });
  return {
    name: baseName(path),
    path,
    files: { paths, read: async (rel) => (await readPath(`${path}/${rel}`)).bytes },
  };
}

/** Where a file is to be saved: a path on desktop, or just a name in the browser (a download). */
export interface SaveTarget {
  path: string | null;
  name: string;
}

/** Asks where to save: the native dialog on desktop, nothing in the browser (a download goes where the browser puts it). Null if canceled. */
export async function chooseSave(suggestedName: string, filters: FileFilter[]): Promise<SaveTarget | null> {
  if (!isTauri()) return { path: null, name: suggestedName };
  const { save } = await import('@tauri-apps/plugin-dialog');
  const path = await save({ defaultPath: suggestedName, filters });
  if (!path) return null;
  return { path, name: baseName(path) };
}

/** Writes to a place chosen with `chooseSave`. */
export async function writeTarget(target: SaveTarget, bytes: Uint8Array, mime: string): Promise<void> {
  if (target.path !== null) return writePath(target.path, bytes);
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = target.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Native save dialog then write (desktop), or a download (browser, where `path` is null). Null if canceled. */
export async function saveAs(suggestedName: string, filters: FileFilter[], bytes: Uint8Array, mime: string): Promise<SaveTarget | null> {
  if (isAndroid()) {
    // Into the app's folder in Downloads, with no dialog; shared from there.
    const exported = await exportToAppFolder('', suggestedName, bytes, mime);
    return { path: exported.path, name: suggestedName };
  }
  const target = await chooseSave(suggestedName, filters);
  if (!target) return null;
  await writeTarget(target, bytes, mime);
  return target;
}

/** Desktop only: overwrite a known path atomically. */
export async function writePath(path: string, bytes: Uint8Array): Promise<void> {
  // The bytes are the request body, so the path travels in a header, and header values must be ASCII.
  await command<void>('write_file', bytes, { path: encodeURIComponent(path) });
}

/** Desktop only: copies a folder and everything in it. */
export async function copyTree(from: string, to: string): Promise<void> {
  await command<void>('copy_tree', { from, to });
}

/** Desktop only: asks for a folder to export into. Null if canceled. */
export async function pickExportFolder(): Promise<string | null> {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({ directory: true, multiple: false, title: 'Export into' });
  return typeof picked === 'string' ? picked : null;
}

/** Desktop only: where a program is (a name searched on the PATH, or a path, `~` allowed), or null when it is not there. */
export async function findProgram(program: string): Promise<string | null> {
  if (!isDesktop()) return null;
  return command<string | null>('find_program', { program });
}

/** Desktop only: starts a program in a folder and leaves it running; its output goes to launch.log in that folder. */
export async function launch(program: string, args: string[], cwd: string): Promise<void> {
  await command<number>('launch_program', { program, args, cwd });
}

/** Desktop only: shows a file or folder in the system file manager. */
export async function openPath(path: string): Promise<void> {
  await command<void>('open_path', { path });
}

/** Opens a web address: in the system browser on desktop, a new tab in a browser. */
export async function openUrl(url: string): Promise<void> {
  if (!isTauri()) {
    window.open(url, '_blank', 'noopener');
    return;
  }
  await command<void>('open_url', { url });
}

/** A world in the worlds folder, as the desktop app lists them. */
export interface WorldEntry {
  name: string;
  path: string;
  size: number;
  /** Milliseconds since the epoch. */
  modified: number;
}

/** Desktop only: the worlds directly inside a folder, which is created if missing. */
export async function listWorlds(dir: string): Promise<WorldEntry[]> {
  return command<WorldEntry[]>('list_worlds', { dir });
}

/** Desktop only. */
export async function removeFile(path: string): Promise<void> {
  await command<void>('remove_file', { path });
}

/** Desktop only: the first `limit` bytes of a file, enough for a world's header. */
export async function readHead(path: string, limit: number): Promise<Uint8Array> {
  const data = await command<ArrayBuffer | number[]>('read_head', { path, limit });
  return data instanceof ArrayBuffer ? new Uint8Array(data) : Uint8Array.from(data);
}

/** Desktop only: renames a world's file when its world was renamed. Never over an existing file. */
export async function moveFile(from: string, to: string): Promise<void> {
  await command<void>('move_file', { from, to });
}

/** Desktop only: where worlds go unless the user picked a folder; `fixed` where no other folder can be chosen (Android). */
export async function defaultWorldsDir(): Promise<{ path: string; fixed: boolean }> {
  return command<{ path: string; fixed: boolean }>('default_worlds_dir');
}

/** Desktop only: native folder picker for the worlds folder. Null if canceled. */
export async function pickWorldsFolder(defaultPath?: string): Promise<string | null> {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({ directory: true, multiple: false, defaultPath });
  return typeof picked === 'string' ? picked : null;
}

// --- signing in to Google, for Drive sync (PlastikCAD's, lifted) ----------------------

/** A sign-in waiting for the browser to come back: where it is sent back to, and the loopback port that listens. */
export interface SignInSession {
  redirect: string;
  port: number;
}

/** Desktop: readies a loopback port for the sign-in to come back to. */
export async function oauthStart(): Promise<SignInSession> {
  const port = await command<number>('oauth_start');
  return { redirect: `http://127.0.0.1:${port}/`, port };
}

/** Desktop: opens the sign-in page in the system browser and resolves with the query string the browser is sent back with. */
export const oauthWait = (session: SignInSession, url: string): Promise<string> => command<string>('oauth_wait', { port: session.port, url });

export const oauthCancel = (session: SignInSession): Promise<void> => command<void>('oauth_cancel', { port: session.port });

/**
 * Android: an access token for the scope from Google Play services, which
 * knows the app by its package and signing key (Google takes no redirect URL
 * from an Android app). The first time Google's own sheet asks the user; after
 * that the grant is remembered. `silent` asks only for what is granted already
 * and rejects with "needs-sign-in" otherwise; a sheet dismissed rejects with
 * "cancelled".
 */
export async function androidAuthorize(scope: string, silent: boolean): Promise<string> {
  const { accessToken } = await invoke<{ accessToken: string }>('plugin:device|authorize', { scope, silent });
  return accessToken;
}

/** Android: forgets a token Play services holds, so the account is asked again next time. */
export const androidClearToken = (token: string): Promise<void> => invoke<void>('plugin:device|clear_token', { token }).catch(() => undefined);

/** The world the app was started with: the file passed on the command line on desktop. None in the browser. */
export async function startupFiles(): Promise<string[]> {
  if (!isTauri()) return [];
  if (isAndroid()) return (await invoke<{ uris: string[] }>('plugin:device|opened_files').catch(() => ({ uris: [] }))).uris;
  const path = await command<string | null>('startup_file');
  return path ? [path] : [];
}

/**
 * Android: files handed to the running app (a tap in the Files app while it is
 * open). Fetched when the plugin says some arrived. Returns an unsubscribe function.
 */
export function onFilesOpened(handler: (paths: string[]) => void): () => void {
  if (!isAndroid()) return () => {};
  let stopped = false;
  let stop: (() => void) | null = null;
  addPluginListener('device', 'opened', async () => {
    const { uris } = await invoke<{ uris: string[] }>('plugin:device|opened_files');
    if (uris.length > 0) handler(uris);
  })
    .then((listener) => {
      stop = () => void listener.unregister();
      if (stopped) stop();
    })
    .catch(console.error);
  return () => {
    stopped = true;
    stop?.();
  };
}

export function setWindowTitle(title: string): void {
  document.title = title;
  if (!isTauri()) return;
  // The native title bar does not follow document.title.
  import('@tauri-apps/api/window').then(({ getCurrentWindow }) => getCurrentWindow().setTitle(title)).catch(console.error);
}

/** Files dropped on the window (native drag-drop on desktop, HTML5 drop in the browser). Returns an unsubscribe function. */
export function onFilesDropped(handler: (files: PickedFile[]) => void): () => void {
  const deliver = (files: PickedFile[]) => {
    if (files.length > 0) handler(files);
  };
  if (isTauri()) {
    return listen(async () => {
      const { getCurrentWebview } = await import('@tauri-apps/api/webview');
      return getCurrentWebview().onDragDropEvent((event) => {
        if (event.payload.type === 'drop') void readable(event.payload.paths.map(readPath)).then(deliver);
      });
    });
  }
  // Both events must be canceled, or the browser navigates to the dropped file.
  const allow = (event: DragEvent) => event.preventDefault();
  const drop = (event: DragEvent) => {
    event.preventDefault();
    void readable(Array.from(event.dataTransfer?.files ?? [], readBrowserFile)).then(deliver);
  };
  window.addEventListener('dragover', allow);
  window.addEventListener('drop', drop);
  return () => {
    window.removeEventListener('dragover', allow);
    window.removeEventListener('drop', drop);
  };
}

/** Yes/no question: native dialog on desktop, window.confirm in the browser. */
export async function confirm(message: string, options: { title?: string; okLabel?: string; cancelLabel?: string } = {}): Promise<boolean> {
  if (!isTauri()) return window.confirm(message);
  const { ask } = await import('@tauri-apps/plugin-dialog');
  return ask(message, { title: options.title ?? APP_NAME, okLabel: options.okLabel, cancelLabel: options.cancelLabel });
}

/**
 * Saves before the window closes while `isDirty()` is true. On desktop the
 * close request is held while `flush` writes; if that fails the user is asked
 * whether to close anyway. In a browser only the standard prompt can be shown.
 * Returns an unsubscribe function.
 */
export function guardClose(isDirty: () => boolean, flush: () => Promise<boolean>): () => void {
  if (isTauri()) {
    let closing = false;
    return listen(async () => {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const window = getCurrentWindow();
      return window.onCloseRequested(async (event) => {
        if (!isDirty()) return;
        event.preventDefault();
        if (closing) return;
        closing = true;
        try {
          const saved = await flush();
          const close =
            saved ||
            (await confirm('The latest changes could not be saved. Close anyway and lose them?', {
              title: 'Unsaved changes',
              okLabel: 'Close anyway',
              cancelLabel: 'Keep editing',
            }));
          if (close) await window.destroy();
        } finally {
          closing = false;
        }
      });
    });
  }
  const warn = (event: BeforeUnloadEvent) => {
    if (isDirty()) event.preventDefault();
  };
  window.addEventListener('beforeunload', warn);
  return () => window.removeEventListener('beforeunload', warn);
}
