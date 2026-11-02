// Google Drive as a remote for the sync engine: a folder of .plastikworld
// files, each tagged with its world id and revision in the file's app
// properties. PlastikCAD's `src/sync/drive.ts`, lifted. With the drive.file
// scope the app sees only files it created, which is all it needs, and
// nothing else in the Drive.
import { APP_NAME, FILE_EXTENSION, FILE_FORMAT, isWorldName } from '../app';
import type { Remote, RemoteFile } from './engine';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_TYPE = 'application/vnd.google-apps.folder';
const FILE_FIELDS = 'id,name,modifiedTime,appProperties';

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

interface DriveFile {
  id: string;
  name: string;
  modifiedTime?: string;
  appProperties?: Record<string, string>;
}

async function body<T>(response: Response, what: string): Promise<T> {
  if (!response.ok) {
    let message = `${response.status}`;
    try {
      const json = (await response.json()) as { error?: { message?: string } };
      if (json.error?.message) message = json.error.message;
    } catch {
      // No JSON in the answer.
    }
    throw new Error(`Google Drive could not ${what}: ${message}`);
  }
  return (await response.json()) as T;
}

const toRemote = (file: DriveFile): RemoteFile => ({
  id: file.id,
  name: file.name,
  worldId: file.appProperties?.worldId ?? null,
  revision: file.appProperties?.revision ?? null,
  modified: file.modifiedTime ? Date.parse(file.modifiedTime) : 0,
});

const quote = (s: string): string => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

export class DriveRemote implements Remote {
  private folderId: string | null = null;

  constructor(
    private readonly fetch: Fetch,
    readonly folderName = APP_NAME,
  ) {}

  /** The app's folder at the top of the Drive, made on first use. */
  async folder(): Promise<string> {
    if (this.folderId) return this.folderId;
    const q = `name = ${quote(this.folderName)} and mimeType = '${FOLDER_TYPE}' and 'root' in parents and trashed = false`;
    const found = await body<{ files: DriveFile[] }>(await this.fetch(`${API}/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=10`), 'find its folder');
    if (found.files.length) return (this.folderId = found.files[0].id);
    const made = await body<DriveFile>(
      await this.fetch(`${API}/files?fields=id`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: this.folderName, mimeType: FOLDER_TYPE, parents: ['root'] }),
      }),
      'make its folder',
    );
    return (this.folderId = made.id);
  }

  async list(): Promise<RemoteFile[]> {
    const folder = await this.folder();
    const q = `${quote(folder)} in parents and trashed = false and mimeType != '${FOLDER_TYPE}'`;
    const out: RemoteFile[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({ q, fields: `nextPageToken,files(${FILE_FIELDS})`, pageSize: '1000' });
      if (pageToken) params.set('pageToken', pageToken);
      const page = await body<{ files: DriveFile[]; nextPageToken?: string }>(await this.fetch(`${API}/files?${params}`), 'list the worlds');
      for (const file of page.files) if (isWorldName(file.name)) out.push(toRemote(file));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return out;
  }

  async download(file: RemoteFile): Promise<string> {
    const response = await this.fetch(`${API}/files/${encodeURIComponent(file.id)}?alt=media`);
    if (!response.ok) await body(response, `download ${file.name}`);
    return response.text();
  }

  async upload(existing: RemoteFile | null, name: string, text: string, meta: { worldId: string; revision: string | null }): Promise<RemoteFile> {
    const fileName = isWorldName(name) ? name : `${name}.${FILE_EXTENSION}`;
    const metadata: Record<string, unknown> = {
      name: fileName,
      mimeType: 'application/json',
      appProperties: { app: FILE_FORMAT, worldId: meta.worldId, revision: meta.revision ?? '' },
    };
    if (!existing) metadata.parents = [await this.folder()];
    const boundary = `${FILE_FORMAT}-${Math.random().toString(36).slice(2)}`;
    const parts = [
      `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
      `--${boundary}\r\ncontent-type: application/json\r\n\r\n${text}\r\n`,
      `--${boundary}--`,
    ].join('');
    const url = existing ? `${UPLOAD}/files/${encodeURIComponent(existing.id)}?uploadType=multipart&fields=${FILE_FIELDS}` : `${UPLOAD}/files?uploadType=multipart&fields=${FILE_FIELDS}`;
    const file = await body<DriveFile>(
      await this.fetch(url, { method: existing ? 'PATCH' : 'POST', headers: { 'content-type': `multipart/related; boundary=${boundary}` }, body: parts }),
      `upload ${name}`,
    );
    const remote = toRemote(file);
    // Drive echoes an empty revision as missing.
    if (remote.revision === '') remote.revision = null;
    return remote;
  }

  async remove(file: RemoteFile): Promise<void> {
    await body(
      await this.fetch(`${API}/files/${encodeURIComponent(file.id)}?fields=id`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ trashed: true }) }),
      `delete ${file.name}`,
    );
  }

  /** Who is signed in. */
  async account(): Promise<{ email: string; name: string }> {
    const about = await body<{ user?: { emailAddress?: string; displayName?: string } }>(await this.fetch(`${API}/about?fields=user`), 'read the account');
    return { email: about.user?.emailAddress ?? '', name: about.user?.displayName ?? '' };
  }
}
