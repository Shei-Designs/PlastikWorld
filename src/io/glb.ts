// The whole scene as one GLB, for Blender and anything else that reads glTF:
// the ground, the surface zones as coloured patches, and every prop as a mesh
// at its pose. Written by hand rather than through three.js, so that it runs
// in a test and in a worker: a glTF is a JSON header and one binary buffer,
// and a scene of meshes needs nothing more than accessors into that buffer.
// glTF is Y up; the world is Z up, so the scene's root node turns it, the way
// `io/meshes.ts` turns a GLB the other way on load. Robots are left out, with
// a note: their meshes live in their packages, in formats of their own.
import { quatOf } from '../model/math';
import type { Pose, Vec3, World } from '../model/types';
import { assetOf, isProp } from '../model/types';
import type { ExportBundle, MeshData, Resolved } from './export';
import { encodeText, identifier } from './format';
import { groundMesh, placedZones, ZONE_LIFT, zoneMesh } from './zones';

/** One mesh of the scene, placed. */
export interface SceneNode {
  name: string;
  data: MeshData;
  pose: Pose;
  scale: number;
  /** A flat colour (linear RGB) when the mesh has no colours of its own. */
  color: Vec3 | null;
}

const GROUND_COLOR: Vec3 = [0.42, 0.4, 0.36];
const PROP_COLOR: Vec3 = [0.7, 0.7, 0.7];

/** Area-weighted vertex normals, which glTF readers would otherwise make up flat. */
export function normalsOf(data: MeshData): Float32Array {
  const { positions: p, indices } = data;
  const n = new Float32Array(p.length);
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const k of [a, b, c]) {
      n[k] += nx;
      n[k + 1] += ny;
      n[k + 2] += nz;
    }
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]);
    if (l > 1e-12) {
      n[i] /= l;
      n[i + 1] /= l;
      n[i + 2] /= l;
    } else n[i + 2] = 1;
  }
  return n;
}

const FLOAT = 5126, UINT = 5125, ARRAY_BUFFER = 34962, ELEMENT_ARRAY_BUFFER = 34963;

/** The scene as GLB bytes. */
export function encodeGlb(nodes: SceneNode[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const bufferViews: Record<string, unknown>[] = [];
  const accessors: Record<string, unknown>[] = [];
  const materials: Record<string, unknown>[] = [];
  const meshes: Record<string, unknown>[] = [];
  const gltfNodes: Record<string, unknown>[] = [];
  let offset = 0;
  // Every view starts on a 4-byte boundary, as the spec asks; floats and 32-bit indices keep it so by themselves.
  const view = (bytes: Uint8Array, target: number): number => {
    chunks.push(bytes);
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.byteLength, target });
    offset += bytes.byteLength;
    return bufferViews.length - 1;
  };
  const floats = (array: Float32Array, type: 'VEC3', extent: boolean): number => {
    const index = view(new Uint8Array(array.buffer, array.byteOffset, array.byteLength), ARRAY_BUFFER);
    const accessor: Record<string, unknown> = { bufferView: index, componentType: FLOAT, count: array.length / 3, type };
    if (extent) {
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < array.length; i += 3) {
        for (let k = 0; k < 3; k++) {
          if (array[i + k] < min[k]) min[k] = array[i + k];
          if (array[i + k] > max[k]) max[k] = array[i + k];
        }
      }
      accessor.min = array.length ? min : [0, 0, 0];
      accessor.max = array.length ? max : [0, 0, 0];
    }
    accessors.push(accessor);
    return accessors.length - 1;
  };
  for (const node of nodes) {
    const { data } = node;
    // Typed arrays may share a larger buffer (a slice of a file): copy so the view is the array alone.
    const positions = Float32Array.from(data.positions);
    const attributes: Record<string, number> = { POSITION: floats(positions, 'VEC3', true), NORMAL: floats(normalsOf(data), 'VEC3', false) };
    if (data.colors) attributes.COLOR_0 = floats(Float32Array.from(data.colors), 'VEC3', false);
    const indices = Uint32Array.from(data.indices);
    const indexView = view(new Uint8Array(indices.buffer, indices.byteOffset, indices.byteLength), ELEMENT_ARRAY_BUFFER);
    accessors.push({ bufferView: indexView, componentType: UINT, count: indices.length, type: 'SCALAR' });
    const color = data.colors ? [1, 1, 1, 1] : [...(node.color ?? PROP_COLOR), 1];
    materials.push({ name: node.name, pbrMetallicRoughness: { baseColorFactor: color, metallicFactor: 0, roughnessFactor: 0.85 }, doubleSided: true });
    meshes.push({ name: node.name, primitives: [{ attributes, indices: accessors.length - 1, material: materials.length - 1 }] });
    const [w, x, y, z] = quatOf(node.pose.rpy);
    gltfNodes.push({ name: node.name, mesh: meshes.length - 1, translation: node.pose.xyz, rotation: [x, y, z, w], scale: [node.scale, node.scale, node.scale] });
  }
  // The root turns Z up into glTF's Y up: a quarter turn about X, the way back from what the loader does.
  const h = Math.SQRT1_2;
  gltfNodes.push({ name: 'World', rotation: [-h, 0, 0, h], children: nodes.map((_, i) => i) });
  const json: Record<string, unknown> = {
    asset: { version: '2.0', generator: 'PlastikWorld' },
    scene: 0,
    scenes: [{ name: 'Scene', nodes: [gltfNodes.length - 1] }],
    nodes: gltfNodes,
    meshes,
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength: offset }],
  };
  const jsonBytes = encodeText(JSON.stringify(json));
  const jsonPadded = new Uint8Array(Math.ceil(jsonBytes.length / 4) * 4).fill(0x20);
  jsonPadded.set(jsonBytes);
  const binPadded = new Uint8Array(Math.ceil(offset / 4) * 4);
  let at = 0;
  for (const chunk of chunks) {
    binPadded.set(chunk, at);
    at += chunk.byteLength;
  }
  const total = 12 + 8 + jsonPadded.length + 8 + binPadded.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); // 'glTF'
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonPadded.length, true);
  dv.setUint32(16, 0x4e4f534a, true); // 'JSON'
  out.set(jsonPadded, 20);
  const binAt = 20 + jsonPadded.length;
  dv.setUint32(binAt, binPadded.length, true);
  dv.setUint32(binAt + 4, 0x004e4942, true); // 'BIN'
  out.set(binPadded, binAt + 8);
  return out;
}

/** The JSON header of a GLB, for tests and for a reader that wants the structure alone. */
export function glbJson(bytes: Uint8Array): Record<string, unknown> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('Not a GLB');
  const length = dv.getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + length)));
}

const IDENTITY: Pose = { xyz: [0, 0, 0], rpy: [0, 0, 0] };

/** The scene of a world as nodes: the ground, the zones, the props. */
export function sceneNodes(world: World, resolved: Resolved, notes: string[]): SceneNode[] {
  const nodes: SceneNode[] = [{ name: 'Ground', data: groundMesh(world.terrain), pose: IDENTITY, scale: 1, color: GROUND_COLOR }];
  for (const { zone, material } of placedZones(world)) {
    const data = zoneMesh(world.terrain, zone, ZONE_LIFT);
    if (data) nodes.push({ name: zone.name || material.name, data, pose: IDENTITY, scale: 1, color: material.color });
  }
  const robots: string[] = [];
  for (const placed of world.objects) {
    const asset = assetOf(world, placed);
    if (!asset) continue;
    if (!isProp(asset)) {
      robots.push(placed.name);
      continue;
    }
    const data = resolved.meshes[asset.id]?.data;
    if (!data) {
      notes.push(`${placed.name}: its mesh could not be read, so it was left out.`);
      continue;
    }
    nodes.push({ name: placed.name, data, pose: placed.pose, scale: placed.scale, color: null });
  }
  if (robots.length) notes.push(`${robots.join(', ')}: robots are left out of the scene; their meshes are in their packages.`);
  return nodes;
}

/** The export: one GLB of the scene, and how to open it. */
export function blenderBundle(world: World, resolved: Resolved): ExportBundle {
  const name = identifier(world.name, 'world');
  const notes: string[] = [];
  const nodes = sceneNodes(world, resolved, notes);
  const file = `${name}.glb`;
  notes.push('Lights, sky, fog and wind are not carried: Blender has its own.');
  return {
    name,
    files: [{ path: file, bytes: encodeGlb(nodes) }],
    copies: [],
    notes,
    launch: `In Blender: File > Import > glTF 2.0, and pick ${name}/${file}.`,
    // Blender opens with the scene imported; the path is made absolute from the bundle folder the app starts it in.
    run: { program: 'blender', args: ['--python-expr', `import bpy, os; bpy.ops.import_scene.gltf(filepath=os.path.abspath('${file}'))`], needs: [] },
  };
}
