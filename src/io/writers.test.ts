import { describe, expect, it } from 'vitest';
import { gazeboBundle } from './gazebo';
import { mujocoBundle } from './mjcf';
import { isaacBundle } from './usda';
import type { ExportBundle, Resolved } from './export';
import { emptyWorld } from '../model/types';
import type { World } from '../model/types';

const text = (bundle: ExportBundle, path: string): string => {
  const file = bundle.files.find((f) => f.path === path);
  if (!file || !('text' in file)) throw new Error(`no text file ${path} in ${bundle.files.map((f) => f.path).join(', ')}`);
  return file.text;
};

const cube: Resolved['meshes'][string] = {
  glb: new Uint8Array([103, 108, 84, 70]),
  data: {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6]),
    colors: null,
  },
  bounds: { min: [0, 0, 0], max: [1, 1, 1] },
};

function yard(robotFormat: 'ros' | 'gazebo' | 'mujoco' = 'gazebo'): { world: World; resolved: Resolved } {
  const world = emptyWorld('Test Yard');
  world.assets.push({ kind: 'mesh', id: 'crate', name: 'Crate', source: { name: 'Crate.glb', path: '/tmp/Crate.glb', size: 4 }, data: cube.glb! });
  const entry = robotFormat === 'ros' ? 'urdf/reference_rover.urdf' : robotFormat === 'gazebo' ? 'model.sdf' : 'reference_rover.xml';
  world.assets.push({ kind: 'robot', id: 'rover', name: 'rover', format: robotFormat, source: { name: 'reference_rover', path: '/tmp/reference_rover', size: 0 }, modelName: 'reference_rover', entry, rootBody: 'Body', usd: 'isaac/reference_rover/reference_rover.usda', files: { [entry]: new Uint8Array([60]) } });
  world.objects.push({ id: 'o1', name: 'Crate 1', asset: 'crate', pose: { xyz: [2, 1, 0], rpy: [0, 0, Math.PI / 2] }, scale: 1, physics: { static: true, mass: 1, friction: 0.8, collision: 'mesh' } });
  world.objects.push({ id: 'o2', name: 'Loose crate', asset: 'crate', pose: { xyz: [3, 1, 0.5], rpy: [0, 0, 0] }, scale: 0.5, physics: { static: false, mass: 2.5, friction: 0.7, collision: 'box' } });
  world.objects.push({ id: 'r1', name: 'Rover', asset: 'rover', pose: { xyz: [0, 0, 0.05], rpy: [0, 0, 1] }, scale: 1, physics: { static: false, mass: 1, friction: 0.8, collision: 'mesh' } });
  world.spawns.push({ id: 's1', name: 'Start', pose: { xyz: [0, 0, 0], rpy: [0, 0, 0] } });
  return { world, resolved: { meshes: { crate: cube } } };
}

describe('Gazebo', () => {
  it('writes a world with the ground, the props and an included robot model', () => {
    const { world, resolved } = yard('gazebo');
    const bundle = gazeboBundle(world, resolved);
    expect(bundle.name).toBe('Test_Yard');
    const sdf = text(bundle, 'Test_Yard.sdf');
    expect(sdf).toContain('<world name="Test_Yard">');
    expect(sdf).toContain('<gravity>0 0 -9.81</gravity>');
    expect(sdf).toContain('gz-sim-physics-system');
    expect(sdf).toContain('<plane><normal>0 0 1</normal><size>20 20</size></plane>');
    expect(sdf).toContain('<model name="Crate_1">');
    expect(sdf).toContain('<pose>2 1 0 0 0 1.570796</pose>');
    expect(sdf).toContain('<uri>meshes/Crate.glb</uri>');
    // The loose crate is free, with a mass and a box collision scaled to its size.
    expect(sdf).toMatch(/<model name="Loose_crate">\s*<static>false<\/static>/);
    expect(sdf).toContain('<mass>2.5</mass>');
    expect(sdf).toContain('<box><size>0.5 0.5 0.5</size></box>');
    expect(sdf).toContain('<scale>0.5 0.5 0.5</scale>');
    expect(sdf).toContain('<uri>model://reference_rover</uri>');
    expect(sdf).toContain('<pose>0 0 0.05 0 0 1</pose>');
    expect(bundle.copies).toEqual([{ asset: 'rover', to: 'models/reference_rover' }]);
    expect(bundle.files.filter((f) => f.path === 'meshes/Crate.glb')).toHaveLength(1);
    expect(bundle.notes).toEqual([]);
    expect(bundle.launch).toContain('gz sim');
  });

  it('spawns a ROS package robot from a launch file', () => {
    const { world, resolved } = yard('ros');
    const bundle = gazeboBundle(world, resolved);
    const launch = text(bundle, 'Test_Yard.launch.py');
    expect(launch).toContain("package='ros_gz_sim'");
    expect(launch).toContain("'models/reference_rover', 'urdf/reference_rover.urdf'");
    expect(launch).toContain("'-Y', '1'");
    expect(launch).toContain("DeclareLaunchArgument('headless'");
    expect(launch).toContain("'gz_sim.launch.py'");
    // The package's bridge comes up with the world, so its cmd_vel reaches Gazebo from ROS 2.
    expect(launch).toContain("package='ros_gz_bridge'");
    expect(launch).toContain("os.path.join(here, folder, 'config', 'bridge.yaml')");
    expect(text(bundle, 'Test_Yard.sdf')).not.toContain('<include>');
    expect(bundle.launch).toContain('ros2 launch');
  });

  it('writes a heightmap image of 2^n + 1 pixels for the terrain', () => {
    const { world, resolved } = yard();
    world.terrain = { kind: 'heightmap', size: [10, 10], friction: 1, rows: 5, cols: 5, heights: Float32Array.from({ length: 25 }, (_, i) => (i === 0 ? 0.1 : 0.4)) };
    const bundle = gazeboBundle(world, resolved);
    const png = bundle.files.find((f) => f.path === 'materials/textures/heightmap.png');
    expect(png && 'bytes' in png).toBe(true);
    const view = new DataView((png as { bytes: Uint8Array }).bytes.buffer);
    expect(view.getUint32(16)).toBe(5);
    // Gazebo scales the image by its brightest pixel: the samples go in from black (the lowest, 0.1 m) to
    // white (the highest, 0.4 m), the size's z is the 0.3 m between them, and the heightmap is lifted to 0.1 m.
    expect(text(bundle, 'Test_Yard.sdf')).toContain('<heightmap><uri>materials/textures/heightmap.png</uri><size>10 10 0.3</size><pos>0 0 0</pos>');
    expect(text(bundle, 'Test_Yard.sdf')).toContain('<model name="ground">\n      <static>true</static>\n      <pose>0 0 0.1 0 0 0</pose>');
    expect(bundle.notes).toEqual([]);
  });

  it('lays a surface zone over the ground as a static mesh patch with its own friction', () => {
    const { world, resolved } = yard();
    world.terrain = { kind: 'heightmap', size: [10, 10], friction: 1, rows: 5, cols: 5, heights: new Float32Array(25).fill(0.5) };
    world.materials.push({ id: 'ice', name: 'Ice', friction: 0.05, restitution: 0.02, color: [0.75, 0.88, 0.95] });
    world.zones.push({ id: 'z', name: 'Rink', material: 'ice', rect: [-2.5, -2.5, 2.5, 0] });
    const bundle = gazeboBundle(world, resolved);
    const sdf = text(bundle, 'Test_Yard.sdf');
    expect(sdf).toContain('<model name="Rink">');
    expect(sdf).toContain('<mesh><uri>meshes/Rink.obj</uri></mesh></geometry><surface><friction><ode><mu>0.05</mu>');
    // The patch's cells, a hair over the ground.
    const obj = text(bundle, 'meshes/Rink.obj');
    expect(obj).toContain('v -2.5 -2.5 0.51');
    expect(obj).not.toContain('v 5 ');
    // The loose crate has friction 0.7: DART drops a mesh's friction, so the ice would not slow it, and the note says so.
    expect(bundle.notes).toEqual([expect.stringMatching(/Rink: Gazebo drops the friction set on a mesh/)]);
    // A heightmap's own friction is dropped too, and a loose mesh-collision prop's; a plane's and a box's count.
    // A fixed mesh prop is mentioned only when its friction was set away from the default.
    world.terrain.friction = 0.4;
    world.objects[1].physics.collision = 'mesh';
    world.objects[0].physics.friction = 0.3;
    const more = gazeboBundle(world, resolved).notes;
    expect(more.filter((n) => /Terrain: Gazebo drops the friction set on a heightmap/.test(n))).toHaveLength(1);
    expect(more.filter((n) => /Crate 1, Loose crate: Gazebo drops the friction set on a mesh collision/.test(n))).toHaveLength(1);
    world.terrain.friction = 1;
    world.objects[1].physics.collision = 'box';
    world.objects[0].physics.friction = 0.8;
    // On a plane the zone is a thin box instead.
    world.terrain = { kind: 'plane', size: [10, 10], friction: 1 };
    expect(text(gazeboBundle(world, resolved), 'Test_Yard.sdf')).toContain('<box><size>5 2.5 0.02</size></box>');
  });

  it('writes the sky, the fog and the wind into the scene, and lets the wind at free props', () => {
    const { world, resolved } = yard();
    world.environment = { sky: 'dusk', fog: { color: [0.7, 0.7, 0.75], start: 10, end: 80 }, wind: [8, 0, 0] };
    const sdf = text(gazeboBundle(world, resolved), 'Test_Yard.sdf');
    expect(sdf).toContain('<sky><time>18.5</time></sky><fog><type>linear</type><color>0.7 0.7 0.75 1</color><start>10</start><end>80</end></fog></scene>');
    expect(sdf).toContain('<wind><linear_velocity>8 0 0</linear_velocity></wind>');
    expect(sdf).toContain('gz::sim::systems::WindEffects');
    // The bare-number form of the factor is squared by Gazebo Harmonic; the polynomial form means what it says.
    expect(sdf).toContain('<force_approximation_scaling_factor><k>0.5</k><px>0 0 0 1</px></force_approximation_scaling_factor>');
    // The loose crate feels the wind; the fixed one has no need to.
    expect(sdf.match(/<enable_wind>true<\/enable_wind>/g)).toHaveLength(1);
    world.environment = { sky: 'clear', fog: null, wind: [0, 0, 0] };
    expect(text(gazeboBundle(world, resolved), 'Test_Yard.sdf')).not.toContain('WindEffects');
  });

  it('warns about a moving mesh on a heightmap', () => {
    const { world, resolved } = yard();
    world.terrain = { kind: 'heightmap', size: [10, 10], friction: 1, rows: 3, cols: 3, heights: new Float32Array(9).fill(0.5) };
    world.objects[1].physics = { ...world.objects[1].physics, collision: 'mesh' };
    const bundle = gazeboBundle(world, resolved);
    // Two notes: it may never settle, and as a loose mesh its friction is dropped.
    expect(bundle.notes).toEqual([expect.stringMatching(/Loose crate: Gazebo drops the friction/), expect.stringMatching(/Gazebo may never settle Loose crate/)]);
    expect(text(bundle, 'Test_Yard.sdf')).toContain('<model name="Loose_crate">');
  });

  it('says when a robot cannot go in', () => {
    const { world, resolved } = yard('mujoco');
    const bundle = gazeboBundle(world, resolved);
    expect(bundle.notes[0]).toMatch(/MuJoCo model cannot be placed in a Gazebo world/);
    expect(bundle.copies).toEqual([]);
  });
});

describe('MuJoCo', () => {
  it('writes the props as OBJ bodies and attaches the robot', () => {
    const { world, resolved } = yard('mujoco');
    const bundle = mujocoBundle(world, resolved);
    const xml = text(bundle, 'Test_Yard.xml');
    expect(xml).toContain('<mujoco model="Test_Yard">');
    expect(xml).toContain('<geom name="floor" type="plane" size="10 10 0.1"');
    expect(xml).toContain('<mesh name="Crate" file="Crate.obj"/>');
    expect(xml).toContain('<mesh name="Crate_Loose_crate" file="Crate.obj" scale="0.5 0.5 0.5"/>');
    expect(xml).toMatch(/<body name="Crate_1" pos="2 1 0" quat="0.707107 0 0 0.707107">\s*<geom type="mesh" mesh="Crate" friction="0.8 0.005 0.0001"\/>/);
    expect(xml).toContain('<freejoint name="Loose_crate_free"/>');
    expect(xml).toContain('<geom type="box" pos="0.25 0.25 0.25" size="0.25 0.25 0.25"');
    expect(xml).toContain('mass="2.5"');
    expect(xml).toContain('<model name="reference_rover" file="robots/reference_rover/reference_rover.xml"/>');
    expect(xml).toContain('<attach model="reference_rover" body="Body" prefix="Rover_"/>');
    expect(text(bundle, 'meshes/Crate.obj')).toMatch(/^# Crate/);
    expect(text(bundle, 'meshes/Crate.obj')).toContain('vn 0 0 -1');
    expect(text(bundle, 'meshes/Crate.obj')).toContain('f 1//1 2//2 3//3');
    expect(bundle.copies).toEqual([{ asset: 'rover', to: 'robots/reference_rover' }]);
  });

  it('puts the heights inline as an hfield', () => {
    const { world, resolved } = yard('mujoco');
    world.terrain = { kind: 'heightmap', size: [6, 4], friction: 1, rows: 2, cols: 2, heights: new Float32Array([0, 0.3, 0.15, 0.075]) };
    const xml = text(mujocoBundle(world, resolved), 'Test_Yard.xml');
    // The rows go in +Y first, as MuJoCo reads them.
    expect(xml).toContain('<hfield name="terrain" nrow="2" ncol="2" size="3 2 0.3 0.02" elevation="0.150 0.075  0.000 0.300"/>');
    expect(xml).toContain('<geom name="floor" type="hfield" hfield="terrain" pos="0 0 0"');
  });

  it('lays a surface zone as an hfield of its own with priority over the crate it meets', () => {
    const { world, resolved } = yard('mujoco');
    world.terrain = { kind: 'heightmap', size: [8, 8], friction: 1, rows: 5, cols: 5, heights: Float32Array.from({ length: 25 }, (_, i) => (i % 5) * 0.1) };
    world.materials.push({ id: 'ice', name: 'Ice', friction: 0.05, restitution: 0, color: [0.8, 0.9, 1] });
    world.zones.push({ id: 'z', name: 'Rink', material: 'ice', rect: [0, 0, 4, 4] });
    const xml = text(mujocoBundle(world, resolved), 'Test_Yard.xml');
    // Columns 2..4 and rows 2..4 of the grid: 3 × 3 samples, 4 m across, lifted 2 mm over the lowest of them (0.2 m).
    expect(xml).toContain('<hfield name="Rink" nrow="3" ncol="3" size="2 2 0.2 0.01" elevation="0.200 0.300 0.400  0.200 0.300 0.400  0.200 0.300 0.400"/>');
    expect(xml).toContain('<geom name="Rink" type="hfield" hfield="Rink" pos="2 2 0.202"');
    expect(xml).toContain('priority="1" friction="0.05 0.005 0.0001"');
  });

  it('keeps the heights where the file has them when MuJoCo stretches them to 0..1', () => {
    const { world, resolved } = yard('mujoco');
    world.terrain = { kind: 'heightmap', size: [6, 4], friction: 1, rows: 2, cols: 2, heights: new Float32Array([0.5, 0.5, 1, 1.5]) };
    const xml = text(mujocoBundle(world, resolved), 'Test_Yard.xml');
    // The lowest sample sits at 0.5 m, the span is 1 m.
    expect(xml).toContain('size="3 2 1 0.02"');
    expect(xml).toContain('pos="0 0 0.5"');
  });

  it('gives a loose prop its mass once: the visual mesh weighs nothing beside its collision box', () => {
    const { world, resolved } = yard('mujoco');
    const xml = text(mujocoBundle(world, resolved), 'Test_Yard.xml');
    expect(xml).toContain('contype="0" conaffinity="0" group="2" density="0"/>');
    expect(xml).toContain('rgba="0.6 0.6 0.9 0.3" friction="0.7 0.005 0.0001" mass="2.5"/>');
  });

  it('sets the wind with the air to carry it, and draws the fog and sky', () => {
    const { world, resolved } = yard('mujoco');
    world.environment = { sky: 'night', fog: { color: [0.2, 0.2, 0.25], start: 5, end: 40 }, wind: [0, -6, 0] };
    const xml = text(mujocoBundle(world, resolved), 'Test_Yard.xml');
    expect(xml).toContain('wind="0 -6 0" density="1.2" viscosity="1.8e-5"');
    expect(xml).toContain('<map fogstart="5" fogend="40"/>');
    expect(xml).toContain('fog="0.2 0.2 0.25 1"');
    expect(xml).toContain('<texture type="skybox" builtin="gradient" rgb1="0.03 0.04 0.09"');
    world.environment = { sky: 'clear', fog: null, wind: [0, 0, 0] };
    expect(text(mujocoBundle(world, resolved), 'Test_Yard.xml')).not.toContain('density="1.2"');
  });

  it('leaves out a second model with the same name', () => {
    const { world, resolved } = yard('mujoco');
    world.assets.push({ kind: 'robot', id: 'twin', name: 'twin', format: 'mujoco', source: { name: 'other_rover', path: '/tmp/other_rover', size: 0 }, modelName: 'reference_rover', entry: 'reference_rover.xml', rootBody: 'Body', usd: null, files: { 'reference_rover.xml': new Uint8Array([60]) } });
    world.objects.push({ id: 'r2', name: 'Twin', asset: 'twin', pose: { xyz: [1, 1, 0], rpy: [0, 0, 0] }, scale: 1, physics: { static: false, mass: 1, friction: 0.8, collision: 'mesh' } });
    const bundle = mujocoBundle(world, resolved);
    expect(bundle.notes).toEqual([expect.stringMatching(/Twin: another robot model in this world is also named reference_rover/)]);
    expect(bundle.copies).toEqual([{ asset: 'rover', to: 'robots/reference_rover' }]);
  });

  it('says when a robot is not a MuJoCo model', () => {
    const { world, resolved } = yard('ros');
    const bundle = mujocoBundle(world, resolved);
    expect(bundle.notes[0]).toMatch(/not a MuJoCo model/);
    expect(text(bundle, 'Test_Yard.xml')).not.toContain('<attach');
  });
});

describe('Isaac Sim', () => {
  it('writes a USDA stage with the props and the referenced robot', () => {
    const { world, resolved } = yard('ros');
    const bundle = isaacBundle(world, resolved);
    const usda = text(bundle, 'Test_Yard.usda');
    expect(usda.startsWith('#usda 1.0')).toBe(true);
    expect(usda).toContain('upAxis = "Z"');
    // Without a time-code range Isaac Sim 6 plays a single frame over and over.
    expect(usda).toContain('startTimeCode = 0');
    expect(usda).toContain('endTimeCode = 1000000');
    expect(usda).toContain('float physics:gravityMagnitude = 9.81');
    expect(usda).toContain('def Xform "Crate_1"');
    expect(usda).toContain('double3 xformOp:translate = (2, 1, 0)');
    expect(usda).toContain('double3 xformOp:rotateXYZ = (0, 0, 90)');
    expect(usda).toContain('prepend apiSchemas = ["PhysicsRigidBodyAPI", "PhysicsMassAPI"]');
    // The fixed crate collides as its triangles, the loose one as its box; PhysX cannot move a triangle mesh.
    expect(usda.match(/physics:approximation = "none"/g)).toHaveLength(2);
    expect(usda).toContain('physics:approximation = "boundingCube"');
    expect(usda).toContain('float physics:mass = 2.5');
    expect(usda).toContain('double3 xformOp:scale = (0.5, 0.5, 0.5)');
    expect(usda).toContain('int[] faceVertexIndices = [0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6]');
    expect(usda).toContain('prepend references = @./robots/reference_rover/isaac/reference_rover/reference_rover.usda@');
    expect(usda).toContain('string Physics = "physx"');
    expect(usda).toContain('def DistantLight "Sun"');
    expect(bundle.copies).toEqual([{ asset: 'rover', to: 'robots/reference_rover' }]);
  });

  it('writes the terrain as a mesh grid', () => {
    const { world, resolved } = yard();
    world.terrain = { kind: 'heightmap', size: [2, 2], friction: 1, rows: 2, cols: 2, heights: new Float32Array([0, 0, 0, 1]) };
    const usda = text(isaacBundle(world, resolved), 'Test_Yard.usda');
    expect(usda).toContain('point3f[] points = [(-1, -1, 0), (1, -1, 0), (-1, 1, 0), (1, 1, 1)]');
  });

  it('binds a physics material to the ground and to a subset of its faces per zone', () => {
    const { world, resolved } = yard();
    world.terrain = { kind: 'heightmap', size: [4, 4], friction: 0.7, rows: 3, cols: 3, heights: new Float32Array(9) };
    world.materials.push({ id: 'ice', name: 'Ice', friction: 0.05, restitution: 0.02, color: [0.75, 0.88, 0.95] });
    world.zones.push({ id: 'z', name: 'Rink', material: 'ice', rect: [0, 0, 2, 2] });
    const usda = text(isaacBundle(world, resolved), 'Test_Yard.usda');
    expect(usda).toContain('def Material "Ground"');
    expect(usda).toContain('float physics:dynamicFriction = 0.7');
    expect(usda).toContain('def Material "Ice_ice"');
    expect(usda).toContain('uniform token physxMaterial:frictionCombineMode = "min"');
    expect(usda).toContain('rel material:binding:physics = </World/PhysicsMaterials/Ground>');
    // The zone is a static mesh patch of the ground's cells, 2 mm up, bound to the zone's material.
    expect(usda).toContain('def Xform "Rink"');
    expect(usda).toContain('point3f[] points = [(0, 0, 0.002), (2, 0, 0.002), (0, 2, 0.002), (2, 2, 0.002)]');
    expect(usda).toContain('rel material:binding:physics = </World/PhysicsMaterials/Ice_ice>');
  });

  it('lights the sky with a dome and says what Isaac cannot do about wind and fog', () => {
    const { world, resolved } = yard();
    world.environment = { sky: 'overcast', fog: { color: [0.7, 0.7, 0.75], start: 10, end: 80 }, wind: [8, 0, 0] };
    const bundle = isaacBundle(world, resolved);
    expect(text(bundle, 'Test_Yard.usda')).toContain('def DomeLight "Sky"');
    expect(bundle.notes.filter((n) => /no wind/.test(n))).toHaveLength(1);
    expect(bundle.notes.filter((n) => /Fog in Isaac Sim/.test(n))).toHaveLength(1);
  });

  it('says when a robot carries no USD', () => {
    const { world, resolved } = yard('mujoco');
    world.assets = world.assets.map((a) => (a.kind === 'robot' ? { ...a, usd: null } : a));
    expect(isaacBundle(world, resolved).notes[0]).toMatch(/no USD stage/);
  });
});
