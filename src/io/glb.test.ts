import { describe, expect, it } from 'vitest';
import { emptyWorld } from '../model/types';
import type { RobotAsset } from '../model/types';
import type { MeshData, Resolved } from './export';
import { boundsOf } from './export';
import { blenderBundle, encodeGlb, glbJson, normalsOf } from './glb';

/** A unit quad in the XY plane at z = 0, facing +Z. */
const quad: MeshData = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2, 0, 2, 3]), colors: null };

describe('the GLB writer', () => {
  it('writes a well-formed GLB with the scene turned Y up at the root and each mesh at its pose', () => {
    const bytes = encodeGlb([{ name: 'Quad', data: quad, pose: { xyz: [2, 1, 0.5], rpy: [0, 0, Math.PI / 2] }, scale: 2, color: [1, 0, 0] }]);
    const dv = new DataView(bytes.buffer);
    expect(dv.getUint32(0, true)).toBe(0x46546c67);
    expect(dv.getUint32(4, true)).toBe(2);
    expect(dv.getUint32(8, true)).toBe(bytes.length);
    expect(bytes.length % 4).toBe(0);
    const json = glbJson(bytes) as { nodes: Record<string, unknown>[]; accessors: Record<string, unknown>[]; buffers: { byteLength: number }[]; meshes: unknown[]; materials: { pbrMetallicRoughness: { baseColorFactor: number[] } }[] };
    const root = json.nodes[json.nodes.length - 1];
    expect(root.name).toBe('World');
    expect(root.rotation).toEqual([-Math.SQRT1_2, 0, 0, Math.SQRT1_2]);
    expect(root.children).toEqual([0]);
    const node = json.nodes[0];
    expect(node.translation).toEqual([2, 1, 0.5]);
    expect(node.scale).toEqual([2, 2, 2]);
    const [x, y, z, w] = node.rotation as number[];
    expect([x, y, z]).toEqual([0, 0, expect.closeTo(Math.SQRT1_2, 6)]);
    expect(w).toBeCloseTo(Math.SQRT1_2, 6);
    // Positions carry their extent, as the spec requires; normals and indices follow in the one buffer.
    expect(json.accessors[0]).toMatchObject({ componentType: 5126, count: 4, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] });
    expect(json.accessors[2]).toMatchObject({ componentType: 5125, count: 6, type: 'SCALAR' });
    expect(json.buffers[0].byteLength).toBe(4 * 12 * 2 + 6 * 4);
    expect(json.materials[0].pbrMetallicRoughness.baseColorFactor).toEqual([1, 0, 0, 1]);
  });

  it('gives a flat mesh normals that face up, and a sloped one normals that lean', () => {
    const n = normalsOf(quad);
    expect(Array.from(n.slice(0, 3))).toEqual([0, 0, 1]);
    const slope: MeshData = { ...quad, positions: new Float32Array([0, 0, 0, 1, 0, 1, 1, 1, 1, 0, 1, 0]) };
    const s = normalsOf(slope);
    expect(s[0]).toBeCloseTo(-Math.SQRT1_2, 5);
    expect(s[2]).toBeCloseTo(Math.SQRT1_2, 5);
  });

  it('puts the ground, the zones and the props in the scene, and says what it left out', () => {
    const world = emptyWorld('Test Yard');
    world.terrain = { kind: 'heightmap', size: [10, 10], friction: 1, rows: 3, cols: 3, heights: new Float32Array(9).fill(0.5) };
    world.materials.push({ id: 'ice', name: 'Ice', friction: 0.05, restitution: 0, color: [0.7, 0.9, 1] });
    world.zones.push({ id: 'z', name: 'Rink', material: 'ice', rect: [-2, -2, 2, 2] });
    world.assets.push({ kind: 'mesh', id: 'crate', name: 'Crate', source: { name: 'Crate.glb', path: null, size: 0 }, data: new Uint8Array() });
    const rover: RobotAsset = { kind: 'robot', id: 'rover', name: 'Rover', format: 'ros', source: { name: 'rover', path: null, size: 0 }, modelName: 'rover', entry: 'urdf/rover.urdf', rootBody: null, usd: null, files: {} };
    world.assets.push(rover);
    world.objects.push(
      { id: 'o1', name: 'Crate 1', asset: 'crate', pose: { xyz: [2, 1, 0.5], rpy: [0, 0, 0] }, scale: 1, physics: { static: true, mass: 1, friction: 0.8, collision: 'mesh' } },
      { id: 'o2', name: 'Lost crate', asset: 'lost', pose: { xyz: [0, 0, 0], rpy: [0, 0, 0] }, scale: 1, physics: { static: true, mass: 1, friction: 0.8, collision: 'mesh' } },
      { id: 'r1', name: 'Rover 1', asset: 'rover', pose: { xyz: [0, 0, 0], rpy: [0, 0, 0] }, scale: 1, physics: { static: false, mass: 1, friction: 0.8, collision: 'mesh' } },
    );
    const resolved: Resolved = { meshes: { crate: { glb: null, data: quad, bounds: boundsOf(quad) } } };
    const bundle = blenderBundle(world, resolved);
    expect(bundle.files.map((f) => f.path)).toEqual(['Test_Yard.glb']);
    expect(bundle.copies).toEqual([]);
    expect(bundle.run).toMatchObject({ program: 'blender', needs: [] });
    const file = bundle.files[0];
    const json = glbJson('bytes' in file ? file.bytes : new Uint8Array()) as { nodes: { name: string; translation?: number[] }[] };
    expect(json.nodes.map((n) => n.name)).toEqual(['Ground', 'Rink', 'Crate 1', 'World']);
    expect(json.nodes[2].translation).toEqual([2, 1, 0.5]);
    // An object whose asset is gone is skipped quietly (the world file reader already said so); robots and lights are notes.
    expect(bundle.notes).toEqual([expect.stringMatching(/Rover 1: robots are left out/), expect.stringMatching(/Lights, sky, fog and wind/)]);
  });
});
