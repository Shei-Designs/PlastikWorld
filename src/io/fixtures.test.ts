/// <reference types="node" />
// The sample worlds every engine writer is run against, and the smoke tests'
// fixtures: with WORLD_FIXTURES_OUT set, the bundles are written there as an
// export would write them (files, plus the robot folders copied in), with a
// `<bundle>.smoke.json` beside each saying what the engine should find once
// the world has settled (tools/*_smoke.* read it). Without it, this only
// checks that the bundles build. The robots come from PlastikCAD's reference
// fixtures (ROBOT_FIXTURES, default ../Quick_CAD/fixtures/out); when those
// are missing the worlds hold props only.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyWorld } from '../model/types';
import type { Asset, Placed, Terrain, Vec3, World } from '../model/types';
import { serializeWorld } from '../model/file';
import { inspectPackage } from '../robot/package';
import type { PackageFiles } from '../robot/package';
import { boundsOf } from './export';
import type { ExportBundle, Resolved, ResolvedMesh } from './export';
import { identifier } from './format';
import { gazeboBundle } from './gazebo';
import { heightAt, rollingField } from './heightmap';
import { mujocoBundle } from './mjcf';
import { isaacBundle } from './usda';

const OUT = process.env.WORLD_FIXTURES_OUT ? resolve(process.env.WORLD_FIXTURES_OUT) : null;
const ROBOTS = resolve(process.env.ROBOT_FIXTURES ?? '../Quick_CAD/fixtures/out');

const CRATE = 0.6; // m, the edge of the crate

/**
 * A crate as PlastikCAD would export it: a GLB in meters, Y up, its base on
 * y = 0, with flat normals and one coloured material. Written by hand here so
 * the fixtures need no three.js; the triangles come back Z up as the loaders
 * in io/meshes.ts would give them.
 */
function crateGlb(edge: number, rgb: Vec3): ResolvedMesh {
  const h = edge / 2;
  const center: Vec3 = [0, h, 0];
  const axis = (i: number): Vec3 => [i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0];
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i < 3; i++) {
    for (const s of [1, -1]) {
      const n = axis(i).map((v) => v * s) as Vec3;
      let u = axis((i + 1) % 3);
      let v = axis((i + 2) % 3);
      if (s < 0) [u, v] = [v, u];
      const base = positions.length / 3;
      for (const [a, b] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ]) {
        positions.push(...center.map((c, k) => c + n[k] * h + u[k] * a * h + v[k] * b * h));
        normals.push(...n);
      }
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  const min = [0, 1, 2].map((k) => Math.min(...positions.filter((_, j) => j % 3 === k)));
  const max = [0, 1, 2].map((k) => Math.max(...positions.filter((_, j) => j % 3 === k)));
  const pos = new Float32Array(positions);
  const nor = new Float32Array(normals);
  const idx = new Uint16Array(indices);
  const bin = new Uint8Array(pos.byteLength + nor.byteLength + idx.byteLength);
  bin.set(new Uint8Array(pos.buffer), 0);
  bin.set(new Uint8Array(nor.buffer), pos.byteLength);
  bin.set(new Uint8Array(idx.buffer), pos.byteLength + nor.byteLength);
  const json = JSON.stringify({
    asset: { version: '2.0', generator: 'PlastikWorld fixtures' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'Crate' }],
    meshes: [{ name: 'Crate', primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
    materials: [{ name: 'Paint', pbrMetallicRoughness: { baseColorFactor: [...rgb, 1], metallicFactor: 0, roughnessFactor: 0.8 } }],
    buffers: [{ byteLength: bin.byteLength }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: pos.byteLength, target: 34962 },
      { buffer: 0, byteOffset: pos.byteLength, byteLength: nor.byteLength, target: 34962 },
      { buffer: 0, byteOffset: pos.byteLength + nor.byteLength, byteLength: idx.byteLength, target: 34963 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: pos.length / 3, type: 'VEC3', min, max },
      { bufferView: 1, componentType: 5126, count: nor.length / 3, type: 'VEC3' },
      { bufferView: 2, componentType: 5123, count: idx.length, type: 'SCALAR' },
    ],
  });
  const pad4 = (n: number) => (4 - (n % 4)) % 4;
  const jsonBytes = new TextEncoder().encode(json);
  const jsonLen = jsonBytes.length + pad4(jsonBytes.length);
  const binLen = bin.byteLength + pad4(bin.byteLength);
  const glb = new Uint8Array(12 + 8 + jsonLen + 8 + binLen);
  const view = new DataView(glb.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, glb.byteLength, true);
  view.setUint32(12, jsonLen, true);
  view.setUint32(16, 0x4e4f534a, true);
  glb.set(jsonBytes, 20);
  glb.fill(0x20, 20 + jsonBytes.length, 20 + jsonLen);
  view.setUint32(20 + jsonLen, binLen, true);
  view.setUint32(24 + jsonLen, 0x004e4942, true);
  glb.set(bin, 28 + jsonLen);
  // Z up for the writers: glTF's (x, y, z) is the world's (x, -z, y).
  const zup = new Float32Array(pos.length);
  for (let i = 0; i < pos.length; i += 3) {
    zup[i] = pos[i];
    zup[i + 1] = -pos[i + 2];
    zup[i + 2] = pos[i + 1];
  }
  const data = { positions: zup, indices: new Uint32Array(indices), colors: null };
  return { glb, data, bounds: boundsOf(data) };
}

/** A folder on disk as inspectPackage reads it. */
function folderFiles(dir: string): PackageFiles {
  const paths: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else paths.push(relative(dir, p).split(sep).join('/'));
    }
  };
  walk(dir);
  return { paths, read: async (p) => new Uint8Array(readFileSync(join(dir, p))) };
}

// The Gazebo model and the ROS package are both named reference_rover, and a
// world's bundle has one folder per name, so each goes in a world of its own.
const ROVERS: { id: string; folder: string; worlds: string[]; place: Vec3; yaw: number }[] = [
  { id: 'rover_sdf', folder: 'sdf/reference_rover', worlds: ['Smoke Hills'], place: [0, 0, 0], yaw: 0 },
  { id: 'rover_ros', folder: 'ros/reference_rover', worlds: ['Smoke Flat'], place: [0, 0, 0], yaw: 1 },
  { id: 'rover_mjcf', folder: 'reference_rover', worlds: ['Smoke Flat', 'Smoke Hills'], place: [0, -4, 0], yaw: -1 },
];

async function robotAssets(): Promise<Asset[]> {
  const assets: Asset[] = [];
  for (const rover of ROVERS) {
    const dir = join(ROBOTS, rover.folder);
    if (!existsSync(dir)) continue;
    const info = await inspectPackage(folderFiles(dir));
    if (!info) throw new Error(`${dir} is not a robot package`);
    assets.push({ kind: 'robot', id: rover.id, name: `Rover ${info.format.toUpperCase()}`, format: info.format, source: { name: rover.folder.split('/').pop()!, path: dir, size: 0 }, modelName: info.modelName, entry: info.entry, rootBody: info.rootBody, usd: info.usd });
  }
  return assets;
}

/**
 * Where to drop the test crate on the hills: a gentle spot whose height differs
 * most from its mirror images, so a heightmap written upside down, mirrored or
 * transposed lands the crate at a visibly wrong height.
 */
function tellingSpot(terrain: Terrain): Vec3 {
  let best: Vec3 = [3, 3, 0];
  let bestScore = -1;
  const reach = Math.min(terrain.size[0], terrain.size[1]) / 2 - 2;
  for (let x = -reach; x <= reach; x += 0.5) {
    for (let y = -reach; y <= reach; y += 0.5) {
      if (Math.hypot(x, y) < 3) continue;
      const h = heightAt(terrain, x, y);
      const slope = Math.max(Math.abs(heightAt(terrain, x + 0.3, y) - heightAt(terrain, x - 0.3, y)), Math.abs(heightAt(terrain, x, y + 0.3) - heightAt(terrain, x, y - 0.3))) / 0.6;
      if (slope > 0.12) continue;
      const score = Math.min(...[heightAt(terrain, x, -y), heightAt(terrain, -x, y), heightAt(terrain, y, x), heightAt(terrain, -x, -y)].map((o) => Math.abs(h - o)));
      if (score > bestScore) {
        bestScore = score;
        best = [x, y, h];
      }
    }
  }
  return best;
}

/**
 * Six spots where the ground height is checked: clear of everything else and
 * nearly level, so a small crate dropped there rests on its base, at heights
 * spread over the terrain's range.
 */
function probeSpots(terrain: Terrain, avoid: Vec3): [number, number][] {
  const candidates: { xy: [number, number]; h: number }[] = [];
  for (let x = -9; x <= 9; x += 0.5) {
    for (let y = -9; y <= 9; y += 0.5) {
      if (Math.hypot(x, y) < 4.5 || Math.hypot(x - avoid[0], y - avoid[1]) < 1.5) continue;
      const slope = Math.max(Math.abs(heightAt(terrain, x + 0.2, y) - heightAt(terrain, x - 0.2, y)), Math.abs(heightAt(terrain, x, y + 0.2) - heightAt(terrain, x, y - 0.2))) / 0.4;
      if (slope < 0.06) candidates.push({ xy: [x, y], h: heightAt(terrain, x, y) });
    }
  }
  candidates.sort((a, b) => a.h - b.h || a.xy[0] - b.xy[0] || a.xy[1] - b.xy[1]);
  const spots: [number, number][] = [];
  for (let i = 0; i < 6 && candidates.length; i++) {
    // Spread over the heights, each at least two meters from the ones before.
    const want = candidates[Math.round((i / 5) * (candidates.length - 1))];
    const pick = [...candidates].sort((a, b) => Math.abs(a.h - want.h) - Math.abs(b.h - want.h)).find((c) => spots.every(([x, y]) => Math.hypot(c.xy[0] - x, c.xy[1] - y) >= 2));
    if (pick) spots.push(pick.xy);
  }
  return spots;
}

const physics = (free: boolean, collision: Placed['physics']['collision'], mass = 1) => ({ static: !free, mass, friction: 0.8, collision });

/** The two worlds: the same yard on flat ground and on rolling hills. */
async function yards(): Promise<{ worlds: World[]; resolved: Resolved }> {
  const robots = await robotAssets();
  const crate = crateGlb(CRATE, [0.76, 0.52, 0.2]);
  const worlds: World[] = [];
  for (const kind of ['plane', 'heightmap'] as const) {
    const world = emptyWorld(kind === 'plane' ? 'Smoke Flat' : 'Smoke Hills');
    if (kind === 'heightmap') world.terrain = { kind, size: [24, 24], friction: 1, rows: 33, cols: 33, height: 1.5, heights: rollingField(33, 33) };
    const ground = (x: number, y: number) => heightAt(world.terrain, x, y);
    const at = (x: number, y: number, lift: number, yaw = 0, roll = 0): Placed['pose'] => ({ xyz: [x, y, ground(x, y) + lift], rpy: [roll, 0, yaw] });
    world.assets.push({ kind: 'mesh', id: 'crate', name: 'Crate', source: { name: 'Crate.glb', path: join(OUT ?? '/tmp', 'Crate.glb'), size: crate.glb!.byteLength } }, ...robots);
    const spot = tellingSpot(world.terrain);
    world.objects.push(
      { id: 'o1', name: 'Fixed crate', asset: 'crate', pose: at(2, 1, 0, 0.5), scale: 1, physics: physics(false, 'mesh') },
      { id: 'o2', name: 'Loose crate', asset: 'crate', pose: at(3, -1, 1), scale: 0.5, physics: physics(true, 'box', 2.5) },
      // On the hills the tumbling crate collides as its box: Gazebo cannot settle a moving triangle mesh on a
      // heightmap, and its writer says so in a note; the flat yard keeps the mesh.
      { id: 'o3', name: 'Tumbling crate', asset: 'crate', pose: at(-2, 1, 1.5, 0.3, 0.4), scale: 1, physics: physics(true, kind === 'plane' ? 'mesh' : 'box', 8) },
      { id: 'o4', name: 'Hill crate', asset: 'crate', pose: at(spot[0], spot[1], 1), scale: 0.5, physics: physics(true, 'box', 2.5) },
      { id: 'o5', name: 'Ghost crate', asset: 'crate', pose: at(-3, -2, 0.2), scale: 1, physics: physics(false, 'none') },
    );
    // Half crates set down just over the probe spots: where each one comes to rest is the engine's ground height
    // there. They start low so they land on their base instead of bouncing off down the hill, and they are no
    // smaller than this because a small box on a heightfield's triangles rocks on an edge for seconds in MuJoCo.
    const probes = probeSpots(world.terrain, spot);
    probes.forEach(([x, y], i) => world.objects.push({ id: `probe${i + 1}`, name: `Probe ${i + 1}`, asset: 'crate', pose: at(x, y, 0.1), scale: 0.5, physics: physics(true, 'box', 1) }));
    for (const rover of ROVERS) {
      if (!robots.some((r) => r.id === rover.id) || !rover.worlds.includes(world.name)) continue;
      world.objects.push({ id: `p_${rover.id}`, name: robots.find((r) => r.id === rover.id)!.name, asset: rover.id, pose: at(rover.place[0], rover.place[1], 0.05, rover.yaw), scale: 1, physics: physics(true, 'mesh') });
    }
    world.spawns.push({ id: 's1', name: 'Start', pose: at(0, 0, 0) });
    worlds.push(world);
  }
  return { worlds, resolved: { meshes: { crate } } };
}

/** What a smoke test should find in the engine once the world has settled. */
function expectations(world: World, bundle: ExportBundle, mainFile: string): object {
  const left = (p: Placed) => bundle.notes.some((n) => n.startsWith(`${p.name}:`));
  const ground = (x: number, y: number) => heightAt(world.terrain, x, y);
  const probes = world.objects.filter((p) => p.name.startsWith('Probe ')).map((p) => ({ xy: [p.pose.xyz[0], p.pose.xyz[1]], ground: ground(p.pose.xyz[0], p.pose.xyz[1]) }));
  return {
    world: world.name,
    file: mainFile,
    terrain: { kind: world.terrain.kind, size: world.terrain.size, height: world.terrain.kind === 'heightmap' ? world.terrain.height : 0 },
    probes,
    objects: world.objects
      .filter((p) => world.assets.find((a) => a.id === p.asset)?.kind === 'mesh')
      .map((p) => ({ id: identifier(p.name, 'prop'), name: p.name, free: !p.physics.static, collision: p.physics.collision, xyz: p.pose.xyz, ground: ground(p.pose.xyz[0], p.pose.xyz[1]), edge: CRATE * p.scale, probe: p.name.startsWith('Probe '), placed: !left(p) })),
    robots: world.objects
      .filter((p) => world.assets.find((a) => a.id === p.asset)?.kind === 'robot')
      .map((p) => {
        const asset = world.assets.find((a) => a.id === p.asset) as Extract<Asset, { kind: 'robot' }>;
        return { id: identifier(p.name, 'robot'), name: p.name, format: asset.format, modelName: asset.modelName, rootBody: asset.rootBody, xyz: p.pose.xyz, ground: ground(p.pose.xyz[0], p.pose.xyz[1]), placed: !left(p) };
      }),
    notes: bundle.notes,
    launch: bundle.launch,
  };
}

function writeBundle(engine: string, bundle: ExportBundle, expected: object): void {
  const dir = join(OUT!, engine, bundle.name);
  rmSync(dir, { recursive: true, force: true });
  for (const file of bundle.files) {
    const path = join(dir, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'text' in file ? file.text : file.bytes);
  }
  for (const copy of bundle.copies) cpSync(copy.from, join(dir, copy.to), { recursive: true });
  writeFileSync(`${dir}.smoke.json`, JSON.stringify(expected, null, 2));
}

const mainFile = (bundle: ExportBundle, ext: string): string => bundle.files.map((f) => f.path).find((p) => !p.includes('/') && p.endsWith(ext))!;

describe('sample worlds', () => {
  it('build for every engine, and are written out for the smoke tests when asked', async () => {
    const { worlds, resolved } = await yards();
    const robots = worlds[0].assets.filter((a) => a.kind === 'robot');
    if (OUT) {
      mkdirSync(join(OUT, 'worlds'), { recursive: true });
      writeFileSync(join(OUT, 'Crate.glb'), resolved.meshes.crate.glb!);
    }
    for (const world of worlds) {
      const gazebo = gazeboBundle(world, resolved);
      const mujoco = mujocoBundle(world, resolved);
      const isaac = isaacBundle(world, resolved);
      // Each engine takes the props and the robots it can read, and says why it left the others out.
      expect(gazebo.notes.filter((n) => !/MuJoCo model cannot/.test(n))).toEqual([]);
      for (const bundle of [gazebo, mujoco, isaac]) expect(bundle.notes.filter((n) => /^Gazebo may never settle/.test(n))).toEqual([]);
      expect(mujoco.notes.filter((n) => !/not a MuJoCo model/.test(n))).toEqual([]);
      expect(isaac.notes.filter((n) => !/no USD stage/.test(n))).toEqual([]);
      if (robots.length === 3) {
        expect(gazebo.copies).toHaveLength(1);
        expect(mujoco.copies).toHaveLength(1);
        // Only the ROS package carries a USD stage.
        expect(isaac.copies).toHaveLength(world.name === 'Smoke Flat' ? 1 : 0);
      }
      if (!OUT) continue;
      writeFileSync(join(OUT, 'worlds', `${gazebo.name}.plastikworld`), serializeWorld(world));
      writeBundle('gazebo', gazebo, expectations(world, gazebo, mainFile(gazebo, '.sdf')));
      writeBundle('mujoco', mujoco, expectations(world, mujoco, mainFile(mujoco, '.xml')));
      writeBundle('isaac', isaac, expectations(world, isaac, mainFile(isaac, '.usda')));
    }
    if (OUT) console.log(`sample worlds written under ${OUT} (${robots.length} robot${robots.length === 1 ? '' : 's'} from ${ROBOTS})`);
  });
});
