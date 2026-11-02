// The sync engine against an in-memory store and a fake remote, the merge, and
// the Drive client against a fake fetch. PlastikCAD's `src/sync/sync.test.ts`,
// lifted with worlds in place of designs.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseWorldText, serializeWorldText } from '../model/file';
import { newId } from '../model/math';
import { DEFAULT_PHYSICS, emptyWorld } from '../model/types';
import type { Asset, Placed, World } from '../model/types';
import { MemoryWorlds } from '../state/worlds';
import { DriveRemote } from './drive';
import { MemorySyncState, synchronize } from './engine';
import type { Remote, RemoteFile, SyncReport } from './engine';
import { authUrl, challengeOf, revoke } from './google';
import { mergeWorlds } from './merge';

vi.mock('../platform', () => ({ isDesktop: () => false, isAndroid: () => false, oauthStart: async () => ({ redirect: 'http://127.0.0.1:0/', port: 0 }), oauthWait: async () => '', oauthCancel: async () => {} }));

/** A remote that keeps files in memory and counts what it was asked to do. */
class FakeRemote implements Remote {
  files = new Map<string, { file: RemoteFile; text: string }>();
  calls = { list: 0, download: 0, upload: 0, remove: 0 };
  failOn: string | null = null;
  private serial = 0;
  async list(): Promise<RemoteFile[]> {
    this.calls.list++;
    return [...this.files.values()].map((f) => f.file);
  }
  async download(file: RemoteFile): Promise<string> {
    this.calls.download++;
    const found = this.files.get(file.id);
    if (!found) throw new Error('gone');
    return found.text;
  }
  async upload(existing: RemoteFile | null, name: string, text: string, meta: { worldId: string; revision: string | null }): Promise<RemoteFile> {
    this.calls.upload++;
    if (this.failOn === meta.worldId) throw new Error(`cannot upload ${name}`);
    const id = existing?.id ?? `remote-${++this.serial}`;
    const file: RemoteFile = { id, name: `${name}.plastikworld`, worldId: meta.worldId, revision: meta.revision, modified: Date.now() };
    this.files.set(id, { file, text });
    return file;
  }
  async remove(file: RemoteFile): Promise<void> {
    this.calls.remove++;
    this.files.delete(file.id);
  }
  /** Puts a world there as another device would have. */
  put(world: World): RemoteFile {
    const id = `remote-${++this.serial}`;
    const file: RemoteFile = { id, name: `${world.name}.plastikworld`, worldId: world.id, revision: world.revision ?? null, modified: Date.now() };
    this.files.set(id, { file, text: serializeWorldText(world) });
    return file;
  }
  /** Changes a world there, as a save on another device would. */
  change(world: World): void {
    const found = [...this.files.values()].find((f) => f.file.worldId === world.id)!;
    found.text = serializeWorldText(world);
    found.file = { ...found.file, revision: world.revision!, name: `${world.name}.plastikworld` };
  }
  textOf(worldId: string): string | undefined {
    return [...this.files.values()].find((f) => f.file.worldId === worldId)?.text;
  }
}

const CRATE: Asset = { kind: 'mesh', id: 'crate001', name: 'Crate', source: { name: 'Crate.glb', path: null, size: 0 }, data: new Uint8Array() };
const crate = (id: string, x = 0): Placed => ({ id, name: `Crate ${id}`, asset: CRATE.id, pose: { xyz: [x, 0, 0.5], rpy: [0, 0, 0] }, scale: 1, physics: { ...DEFAULT_PHYSICS } });
const yard = (id: string, name: string, objects: Placed[], revision = newId()): World => ({ ...emptyWorld(name), id, assets: [CRATE], objects, revision, device: 'device0a' });
/** The same world, changed: new objects and a new revision following the old. */
const edited = (world: World, objects: Placed[], name = world.name): World => ({ ...world, name, objects, revision: newId(), parent: world.revision });
const xOf = (world: World | undefined) => world?.objects.map((o) => [o.id, o.pose.xyz[0]]);

let local: MemoryWorlds;
let remote: FakeRemote;
let state: MemorySyncState;
const sync = (): Promise<SyncReport> => synchronize(local, remote, state, { device: 'device0a' });
const localWorld = async (worldId: string): Promise<World | undefined> => {
  for (const info of await local.list()) if (info.id === worldId) return parseWorldText(await local.read(info.key));
  return undefined;
};

beforeEach(() => {
  local = new MemoryWorlds();
  remote = new FakeRemote();
  state = new MemorySyncState();
});

describe('sync engine', () => {
  it('uploads what is new here and downloads what is new there, then has nothing to do', async () => {
    const mine = yard('world001', 'Mine', [crate('a')]);
    await local.write(null, mine.name, serializeWorldText(mine));
    const theirs = yard('world002', 'Theirs', [crate('b')]);
    remote.put(theirs);
    const report = await sync();
    expect(report.uploaded).toEqual(['Mine']);
    expect(report.downloaded).toEqual(['Theirs']);
    expect(remote.textOf('world001')).toBe(serializeWorldText(mine));
    expect((await localWorld('world002'))?.objects.map((o) => o.id)).toEqual(['b']);
    expect(report.changedKeys).toEqual(['mem-2']);
    expect(state.records.size).toBe(2);
    remote.calls = { list: 0, download: 0, upload: 0, remove: 0 };
    const second = await sync();
    expect(second).toMatchObject({ uploaded: [], downloaded: [], merged: [], kept: [], changedKeys: [] });
    expect(remote.calls).toEqual({ list: 1, download: 0, upload: 0, remove: 0 });
  });

  it('copies a change made on one side to the other, renaming the file to follow', async () => {
    const world = yard('world001', 'Yard', [crate('a')]);
    const key = await local.write(null, world.name, serializeWorldText(world));
    await sync();
    // Edited here.
    const v2 = edited(world, [crate('a', 5)]);
    await local.write(key, v2.name, serializeWorldText(v2));
    expect((await sync()).uploaded).toEqual(['Yard']);
    expect(parseWorldText(remote.textOf('world001')!).objects[0].pose.xyz[0]).toBe(5);
    // Edited and renamed there.
    remote.change(edited(v2, [crate('a', 7)], 'Back yard'));
    const report = await sync();
    expect(report.downloaded).toEqual(['Back yard']);
    expect(report.changedKeys).toEqual([key]);
    const here = await localWorld('world001');
    expect(here?.name).toBe('Back yard');
    expect(here?.objects[0].pose.xyz[0]).toBe(7);
    expect((await local.list())[0].name).toBe('Back yard');
  });

  it('merges changes to different objects made on both sides', async () => {
    const world = yard('world001', 'Yard', [crate('a'), crate('b')]);
    const key = await local.write(null, world.name, serializeWorldText(world));
    await sync();
    const here = edited(world, [crate('a', 5), crate('b'), crate('c')]);
    await local.write(key, here.name, serializeWorldText(here));
    remote.change(edited(world, [crate('a'), crate('b', -5)]));
    const report = await sync();
    expect(report.merged).toEqual(['Yard']);
    expect(report.kept).toEqual([]);
    const merged = (await localWorld('world001'))!;
    expect(xOf(merged)).toEqual([
      ['a', 5],
      ['b', -5],
      ['c', 0],
    ]);
    expect(merged.revision).not.toBe(here.revision);
    expect(merged.parent).toBe(here.revision);
    expect(merged.device).toBe('device0a');
    expect(remote.textOf('world001')).toBe(serializeWorldText(merged));
    // Both sides now agree.
    expect((await sync()).changedKeys).toEqual([]);
  });

  it('keeps both versions when the same object was changed on both sides', async () => {
    const world = yard('world001', 'Yard', [crate('a')]);
    const key = await local.write(null, world.name, serializeWorldText(world));
    await sync();
    const here = edited(world, [crate('a', 5)]);
    await local.write(key, here.name, serializeWorldText(here));
    remote.change(edited(world, [crate('a', -5)]));
    const report = await sync();
    expect(report.kept).toEqual(['Yard']);
    const names = (await local.list()).map((p) => p.name).sort();
    expect(names).toEqual(['Yard', 'Yard (other device)']);
    // The local version went up over the remote one; the remote version is a new world on both sides.
    expect(parseWorldText(remote.textOf('world001')!).objects[0].pose.xyz[0]).toBe(5);
    const copy = (await local.list()).find((p) => p.name === 'Yard (other device)')!;
    expect(copy.id).not.toBe('world001');
    expect(parseWorldText(await local.read(copy.key)).objects[0].pose.xyz[0]).toBe(-5);
    expect(remote.textOf(copy.id!)).toBeDefined();
    expect(remote.files.size).toBe(2);
    expect((await sync()).changedKeys).toEqual([]);
  });

  it('carries deletions across, unless the other side changed the world since', async () => {
    const a = yard('world001', 'A', [crate('a')]);
    const b = yard('world002', 'B', [crate('b')]);
    const c = yard('world003', 'C', [crate('c')]);
    const keyA = await local.write(null, a.name, serializeWorldText(a));
    const keyB = await local.write(null, b.name, serializeWorldText(b));
    const keyC = await local.write(null, c.name, serializeWorldText(c));
    await sync();
    // A deleted here; B deleted there; C deleted there but edited here.
    await local.remove(keyA);
    for (const id of ['world002', 'world003']) remote.files.delete([...remote.files.values()].find((f) => f.file.worldId === id)!.file.id);
    const c2 = edited(c, [crate('c', 9)]);
    await local.write(keyC, c2.name, serializeWorldText(c2));
    const report = await sync();
    expect(report.deletedRemotely).toEqual(['A']);
    expect(report.deletedLocally).toEqual(['B']);
    expect(report.removedKeys).toEqual([keyB]);
    expect(report.uploaded).toEqual(['C']);
    expect(remote.textOf('world001')).toBeUndefined();
    expect(await localWorld('world002')).toBeUndefined();
    expect(parseWorldText(remote.textOf('world003')!).objects[0].pose.xyz[0]).toBe(9);
    expect([...state.records.keys()]).toEqual(['world003']);
  });

  it('records a world both sides already hold identically, and keeps both when they differ with no common base', async () => {
    const same = yard('world001', 'Same', [crate('a')]);
    await local.write(null, same.name, serializeWorldText(same));
    remote.put(same);
    const other = yard('world002', 'Other', [crate('b')]);
    await local.write(null, other.name, serializeWorldText(other));
    remote.put(edited(other, [crate('b', 3)]));
    const report = await sync();
    expect(report.uploaded).toEqual([]);
    expect(report.kept).toEqual(['Other']);
    expect(state.records.has('world001')).toBe(true);
    expect((await local.list()).length).toBe(3);
  });

  it('goes on past a world that fails and reports the failure at the end', async () => {
    await local.write(null, 'Bad', serializeWorldText(yard('world001', 'Bad', [crate('a')])));
    await local.write(null, 'Good', serializeWorldText(yard('world002', 'Good', [crate('b')])));
    remote.failOn = 'world001';
    await expect(sync()).rejects.toThrow(/cannot upload Bad/);
    expect(remote.textOf('world002')).toBeDefined();
    expect(remote.textOf('world001')).toBeUndefined();
    remote.failOn = null;
    expect((await sync()).uploaded).toEqual(['Bad']);
  });

  it('leaves files without an id alone', async () => {
    const text = serializeWorldText(yard('world001', 'Old', [crate('a')])).replace(/ {2}"id": "world001",\n/, '');
    expect(text).not.toContain('world001');
    await local.write(null, 'Old', text);
    const report = await sync();
    expect(report.uploaded).toEqual([]);
    expect(remote.files.size).toBe(0);
  });
});

describe('three-way merge', () => {
  const base = (): World => yard('basewrld', 'Base', [crate('a'), crate('b'), crate('c')], 'revision1');

  it("takes each side's changes, deletions included, and slots remote additions where they were", () => {
    const b = base();
    const local = { ...b, objects: [crate('a', 1), crate('c')] }; // b deleted here, a moved
    const remote = { ...b, objects: [crate('a'), crate('x'), crate('b'), crate('c', 2)] }; // x added before b, c moved there
    const { world, conflicts } = mergeWorlds(b, local, remote);
    expect(conflicts).toBe(0);
    expect(xOf(world)).toEqual([
      ['a', 1],
      ['x', 0],
      ['c', 2],
    ]);
  });

  it('counts an object changed differently on both sides as a conflict and keeps the local one', () => {
    const b = base();
    const { world, conflicts } = mergeWorlds(b, { ...b, objects: [crate('a', 1), crate('b'), crate('c')] }, { ...b, objects: [crate('a', 2), crate('b'), crate('c')] });
    expect(conflicts).toBe(1);
    expect(world.objects[0].pose.xyz[0]).toBe(1);
    // The same change on both sides is no conflict.
    expect(mergeWorlds(b, { ...b, objects: [crate('a', 3)] }, { ...b, objects: [crate('a', 3)] }).conflicts).toBe(0);
  });

  it('keeps an edit over a deletion, takes a rename from the side that renamed, and unites assets', () => {
    const b = base();
    const second: Asset = { ...CRATE, id: 'pallet01', name: 'Pallet' };
    const local = { ...b, objects: [crate('b'), crate('c')] };
    const remote = { ...b, name: 'Renamed', objects: [crate('a', 4), crate('b'), crate('c')], assets: [CRATE, second] };
    const { world } = mergeWorlds(b, local, remote);
    expect(world.name).toBe('Renamed');
    expect(world.objects.map((n) => n.id)).toEqual(['a', 'b', 'c']);
    expect(world.assets.map((a) => a.id)).toEqual(['crate001', 'pallet01']);
    // Without a base, an object that differs on the two sides is a conflict; one only one side has is an addition.
    expect(mergeWorlds(null, local, remote).conflicts).toBe(0);
    expect(mergeWorlds(null, { ...local, objects: [crate('b', 1)] }, remote).conflicts).toBe(1);
  });

  it('takes the terrain from the side that shaped it, and counts sculpting on both sides as a conflict', () => {
    const b = base();
    const hills = (h: number): World['terrain'] => ({ kind: 'heightmap', size: [20, 20], friction: 1, rows: 3, cols: 3, heights: new Float32Array(9).fill(h) });
    const sculpted = { ...b, terrain: hills(1) };
    expect(mergeWorlds(b, b, sculpted).world.terrain).toEqual(hills(1));
    expect(mergeWorlds(b, sculpted, b).world.terrain).toEqual(hills(1));
    const both = mergeWorlds(b, sculpted, { ...b, terrain: hills(2) });
    expect(both.conflicts).toBe(1);
    expect(both.world.terrain).toEqual(hills(1));
    // The same heights on both sides are no conflict, and the environment goes with the side that set it.
    expect(mergeWorlds(b, sculpted, { ...b, terrain: hills(1), environment: { ...b.environment, sky: 'dusk' } })).toMatchObject({ conflicts: 0, world: { environment: { sky: 'dusk' } } });
  });
});

describe('Google sign-in pieces', () => {
  it('derives the PKCE challenge the way RFC 7636 shows', async () => {
    expect(await challengeOf('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    const url = new URL(authUrl('http://127.0.0.1:1234/', 'chal', 'st'));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/drive.file');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:1234/');
  });
});

describe('revoking the grant', () => {
  it('posts the refresh token to Google and shrugs off failure', async () => {
    const calls: { url: string; body: string }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body) });
      if (calls.length === 1) return new Response('{}', { status: 200 });
      throw new Error('offline');
    }) as typeof fetch;
    try {
      const tokens = { access: 'a', refresh: 'r-token', expires: 0, email: null };
      expect(await revoke(tokens)).toBe(true);
      expect(calls[0]).toEqual({ url: 'https://oauth2.googleapis.com/revoke', body: 'token=r-token' });
      expect(await revoke(tokens)).toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('Google Drive remote', () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const answers: ((url: string, init?: RequestInit) => unknown)[] = [];
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    const answer = answers.shift();
    if (!answer) throw new Error(`unexpected request ${url}`);
    const value = answer(url, init);
    if (value instanceof Response) return value;
    return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  beforeEach(() => {
    calls.length = 0;
    answers.length = 0;
  });

  it('makes its folder when there is none, lists page by page and keeps only worlds', async () => {
    const drive = new DriveRemote(fetch);
    answers.push(() => ({ files: [] }), () => ({ id: 'folder1' }));
    answers.push(() => ({ files: [{ id: 'f1', name: 'A.plastikworld', modifiedTime: '2026-11-02T10:00:00Z', appProperties: { worldId: 'world001', revision: 'r1' } }, { id: 'f2', name: 'notes.txt' }], nextPageToken: 'more' }));
    answers.push(() => ({ files: [{ id: 'f3', name: 'B.plastikworld' }] }));
    const files = await drive.list();
    expect(calls[1].init?.method).toBe('POST');
    expect(JSON.parse(calls[1].init!.body as string)).toMatchObject({ name: 'PlastikWorld', parents: ['root'] });
    expect(decodeURIComponent(calls[2].url.replace(/\+/g, ' '))).toContain("'folder1' in parents and trashed = false");
    expect(calls[3].url).toContain('pageToken=more');
    expect(files).toEqual([
      { id: 'f1', name: 'A.plastikworld', worldId: 'world001', revision: 'r1', modified: Date.parse('2026-11-02T10:00:00Z') },
      { id: 'f3', name: 'B.plastikworld', worldId: null, revision: null, modified: 0 },
    ]);
    // The folder is remembered.
    answers.push(() => ({ files: [] }));
    await drive.list();
    expect(calls.length).toBe(5);
  });

  it('uploads as multipart, creating in the folder or replacing in place, and trashes to delete', async () => {
    const drive = new DriveRemote(fetch);
    answers.push(() => ({ files: [{ id: 'folder1', name: 'PlastikWorld' }] }));
    answers.push(() => ({ id: 'new1', name: 'Yard.plastikworld', appProperties: { worldId: 'world001', revision: 'r1' } }));
    const made = await drive.upload(null, 'Yard', '{"x":1}', { worldId: 'world001', revision: 'r1' });
    expect(made).toMatchObject({ id: 'new1', worldId: 'world001', revision: 'r1' });
    const create = calls[1];
    expect(create.url).toMatch(/^https:\/\/www\.googleapis\.com\/upload\/drive\/v3\/files\?uploadType=multipart/);
    expect(create.init?.method).toBe('POST');
    const body = create.init!.body as string;
    const boundary = /boundary=(.+)$/.exec(create.init!.headers!['content-type' as keyof HeadersInit] as string)![1];
    expect(body.split(`--${boundary}`).length).toBe(4);
    expect(body).toContain('"parents":["folder1"]');
    expect(body).toContain('"appProperties":{"app":"plastikcad-world","worldId":"world001","revision":"r1"}');
    expect(body).toContain('\r\n\r\n{"x":1}\r\n');

    answers.push(() => ({ id: 'new1', name: 'Yard.plastikworld', appProperties: { worldId: 'world001', revision: 'r2' } }));
    await drive.upload(made, 'Yard', '{"x":2}', { worldId: 'world001', revision: 'r2' });
    expect(calls[2].url).toContain('/upload/drive/v3/files/new1?uploadType=multipart');
    expect(calls[2].init?.method).toBe('PATCH');
    expect(calls[2].init!.body as string).not.toContain('parents');

    answers.push(() => ({ id: 'new1' }));
    await drive.remove(made);
    expect(calls[3].init).toMatchObject({ method: 'PATCH', body: '{"trashed":true}' });

    answers.push(() => new Response(JSON.stringify({ error: { message: 'Rate limit exceeded' } }), { status: 403 }));
    await expect(drive.download(made)).rejects.toThrow('Google Drive could not download Yard.plastikworld: Rate limit exceeded');
  });
});
