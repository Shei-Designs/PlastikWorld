import { describe, expect, it } from 'vitest';
import { encodeText } from '../io/format';
import { HEAD_BYTES, headerOf, looksLikeWorld, parseWorld, readHeader, serializeWorld, serializeWorldText } from './file';
import { emptyWorld } from './types';
import type { World } from './types';

const sample = (): World => {
  const w = emptyWorld('Yard');
  w.id = 'abcdef0123456789';
  w.assets.push({ kind: 'mesh', id: 'a1', name: 'Crate', source: { name: 'Crate.glb', path: '/tmp/Crate.glb', size: 1234 }, data: new Uint8Array([103, 108, 84, 70, 0, 255]) });
  w.assets.push({
    kind: 'robot',
    id: 'r1',
    name: 'rover',
    format: 'ros',
    source: { name: 'reference_rover', path: '/tmp/reference_rover', size: 0 },
    modelName: 'reference_rover',
    entry: 'urdf/reference_rover.urdf',
    rootBody: null,
    usd: 'isaac/reference_rover/reference_rover.usda',
    files: { 'urdf/reference_rover.urdf': encodeText('<robot/>'), 'meshes/base.obj': encodeText('o base') },
  });
  w.objects.push({ id: 'o1', name: 'Crate', asset: 'a1', pose: { xyz: [1, 2, 0], rpy: [0, 0, 0.5] }, scale: 1, physics: { static: false, mass: 2, friction: 0.6, collision: 'box' } });
  w.objects.push({ id: 'o2', name: 'rover', asset: 'r1', pose: { xyz: [0, 0, 0.05], rpy: [0, 0, 0] }, scale: 1, physics: { static: false, mass: 1, friction: 0.8, collision: 'mesh' } });
  w.spawns.push({ id: 's1', name: 'Start', pose: { xyz: [0, 0, 0], rpy: [0, 0, 1] } });
  w.terrain = { kind: 'heightmap', size: [10, 8], friction: 0.9, rows: 65, cols: 65, heights: Float32Array.from({ length: 65 * 65 }, (_, i) => Math.sin(i) * 1.5) };
  w.revision = 'rev00000000000001';
  w.saved = '2026-11-01T20:00:00.000Z';
  return w;
};

describe('world files', () => {
  it('round-trips a world, assets and heights included', () => {
    const world = sample();
    const bytes = serializeWorld(world);
    expect(looksLikeWorld(bytes)).toBe(true);
    expect(parseWorld(bytes)).toEqual(world);
  });

  it('puts the header first, readable from the start of the file', () => {
    const world = sample();
    world.thumb = 'data:image/jpeg;base64,/9j/4AAQ';
    const text = serializeWorldText(world);
    expect(text.indexOf('"terrain"')).toBeGreaterThan(text.indexOf('"thumb"'));
    expect(text.indexOf('"assets"')).toBeGreaterThan(text.indexOf('"spawns"'));
    expect(readHeader(text.slice(0, HEAD_BYTES))).toEqual({ id: world.id, name: 'Yard', revision: 'rev00000000000001', thumb: world.thumb });
    expect(headerOf(text)).toEqual(readHeader(text));
    expect(readHeader('{"format":"something-else"}')).toBeNull();
    // Objects after the header have names of their own, which must not pass for the world's.
    const named = serializeWorldText({ ...sample(), name: 'Real name' });
    expect(readHeader(named.slice(0, HEAD_BYTES))?.name).toBe('Real name');
  });

  it('refuses what is not a world', () => {
    expect(() => parseWorld(encodeText('not json'))).toThrow(/not a world file/);
    expect(() => parseWorld(encodeText('{"format":"plastikcad","version":2}'))).toThrow(/not a world file/);
    expect(() => parseWorld(encodeText('{"format":"plastikcad-world","version":99,"world":{}}'))).toThrow(/newer version/);
  });

  it('opens a version 1 file: assets by path come in absent, heights become meters on an allowed grid', () => {
    const v1 = {
      format: 'plastikcad-world',
      version: 1,
      world: {
        name: 'Old yard',
        assets: [{ id: 'a', kind: 'mesh', name: 'Crate', source: { name: 'Crate.glb', path: '/tmp/Crate.glb', size: 9 } }],
        objects: [{ id: 'o', asset: 'a' }],
        terrain: { kind: 'heightmap', size: [10, 10], rows: 3, cols: 3, height: 2, heights: [0, 0, 0, 0, 0.5, 0, 0, 0, 1] },
      },
    };
    const world = parseWorld(encodeText(JSON.stringify(v1)));
    expect(world.name).toBe('Old yard');
    expect(world.id).toMatch(/^[a-z0-9]{8,32}$/);
    expect(world.assets[0]).toMatchObject({ kind: 'mesh', id: 'a', source: { path: '/tmp/Crate.glb' } });
    expect(world.assets[0].kind === 'mesh' && world.assets[0].data.length).toBe(0);
    expect(world.objects).toHaveLength(1);
    if (world.terrain.kind !== 'heightmap') throw new Error('expected a heightmap');
    expect([world.terrain.rows, world.terrain.cols]).toEqual([65, 65]);
    // The middle sample was 0.5 of 2 m; the far corner 1 of 2 m.
    expect(world.terrain.heights[32 * 65 + 32]).toBeCloseTo(1);
    expect(world.terrain.heights[65 * 65 - 1]).toBeCloseTo(2);
  });

  it('fills in what a sparse file leaves out and drops what points nowhere', () => {
    const world = parseWorld(encodeText(JSON.stringify({ format: 'plastikcad-world', version: 2, name: 'Sparse', assets: [{ id: 'a', kind: 'mesh' }], objects: [{ id: 'o', asset: 'a' }, { id: 'gone', asset: 'missing' }], terrain: { kind: 'heightmap', rows: 2, cols: 2, heights: [0, 2] } })));
    expect(world.name).toBe('Sparse');
    expect(world.gravity).toEqual([0, 0, -9.81]);
    expect(world.objects).toHaveLength(1);
    expect(world.objects[0].physics.collision).toBe('mesh');
    expect(world.objects[0].pose).toEqual({ xyz: [0, 0, 0], rpy: [0, 0, 0] });
    // A heights list of the wrong length is replaced by flat ground on an allowed grid.
    expect(world.terrain.kind === 'heightmap' && world.terrain.rows).toBe(65);
    expect(world.terrain.kind === 'heightmap' && world.terrain.heights.every((h) => h === 0)).toBe(true);
    expect(world.lights).toHaveLength(1);
  });
});
