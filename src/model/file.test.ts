import { describe, expect, it } from 'vitest';
import { encodeText } from '../io/format';
import { looksLikeWorld, parseWorld, serializeWorld } from './file';
import { emptyWorld } from './types';
import type { World } from './types';

const sample = (): World => {
  const w = emptyWorld('Yard');
  w.assets.push({ kind: 'mesh', id: 'a1', name: 'Crate', source: { name: 'Crate.glb', path: '/tmp/Crate.glb', size: 1234 } });
  w.assets.push({ kind: 'robot', id: 'r1', name: 'rover', format: 'ros', source: { name: 'reference_rover', path: '/tmp/reference_rover', size: 0 }, modelName: 'reference_rover', entry: 'urdf/reference_rover.urdf', rootBody: null, usd: 'isaac/reference_rover/reference_rover.usda' });
  w.objects.push({ id: 'o1', name: 'Crate', asset: 'a1', pose: { xyz: [1, 2, 0], rpy: [0, 0, 0.5] }, scale: 1, physics: { static: false, mass: 2, friction: 0.6, collision: 'box' } });
  w.objects.push({ id: 'o2', name: 'rover', asset: 'r1', pose: { xyz: [0, 0, 0.05], rpy: [0, 0, 0] }, scale: 1, physics: { static: false, mass: 1, friction: 0.8, collision: 'mesh' } });
  w.spawns.push({ id: 's1', name: 'Start', pose: { xyz: [0, 0, 0], rpy: [0, 0, 1] } });
  w.terrain = { kind: 'heightmap', size: [10, 8], friction: 0.9, rows: 2, cols: 3, height: 0.5, heights: [0, 0.5, 1, 1, 0.5, 0] };
  return w;
};

describe('world files', () => {
  it('round-trips a world', () => {
    const world = sample();
    const bytes = serializeWorld(world);
    expect(looksLikeWorld(bytes)).toBe(true);
    expect(parseWorld(bytes)).toEqual(world);
  });

  it('refuses what is not a world', () => {
    expect(() => parseWorld(encodeText('not json'))).toThrow(/not a world file/);
    expect(() => parseWorld(encodeText('{"format":"plastikcad","version":2}'))).toThrow(/not a world file/);
    expect(() => parseWorld(encodeText('{"format":"plastikcad-world","version":99,"world":{}}'))).toThrow(/newer version/);
  });

  it('fills in what a sparse file leaves out and drops what points nowhere', () => {
    const world = parseWorld(encodeText(JSON.stringify({ format: 'plastikcad-world', version: 1, world: { name: 'Sparse', assets: [{ id: 'a', kind: 'mesh' }], objects: [{ id: 'o', asset: 'a' }, { id: 'gone', asset: 'missing' }], terrain: { kind: 'heightmap', rows: 2, cols: 2, heights: [0, 2] } } })));
    expect(world.name).toBe('Sparse');
    expect(world.gravity).toEqual([0, 0, -9.81]);
    expect(world.objects).toHaveLength(1);
    expect(world.objects[0].physics.collision).toBe('mesh');
    expect(world.objects[0].pose).toEqual({ xyz: [0, 0, 0], rpy: [0, 0, 0] });
    // A heights list of the wrong length is replaced by flat ground.
    expect(world.terrain.kind === 'heightmap' && world.terrain.heights).toEqual([0, 0, 0, 0]);
    expect(world.lights).toHaveLength(1);
  });
});
