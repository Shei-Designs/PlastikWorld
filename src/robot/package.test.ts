import { describe, expect, it } from 'vitest';
import { encodeText } from '../io/format';
import { gzDrive, inspectPackage, meshPath, mujocoDrive, visualsOf } from './package';
import { xmlTree } from '../io/xml';
import type { PackageFiles } from './package';

const files = (entries: Record<string, string>): PackageFiles => ({
  paths: Object.keys(entries),
  read: async (path) => {
    if (!(path in entries)) throw new Error(`no ${path}`);
    return encodeText(entries[path]);
  },
});

const URDF = `<?xml version="1.0"?>
<robot name="Reference_rover">
  <link name="base_footprint"/>
  <link name="Body">
    <visual><geometry><mesh filename="package://reference_rover/meshes/visual/Body.obj"/></geometry></visual>
  </link>
  <link name="Wheel">
    <visual><origin xyz="0 0 0.1" rpy="0 0 0"/><geometry><mesh filename="package://reference_rover/meshes/visual/Wheel.obj" scale="2 2 2"/></geometry></visual>
  </link>
  <joint name="root" type="fixed"><parent link="base_footprint"/><child link="Body"/><origin xyz="0 0 0.05" rpy="0 0 0"/></joint>
  <joint name="axle" type="continuous"><parent link="Body"/><child link="Wheel"/><origin xyz="1 0 0" rpy="0 0 1.570796"/></joint>
</robot>`;

const SDF = `<?xml version="1.0"?>
<sdf version="1.11">
<model name="Reference_quadruped">
  <link name="Body"><pose>0 0 0.1 0 0 0</pose><visual name="v"><geometry><mesh><uri>model://reference_quadruped/meshes/visual/Body.obj</uri></mesh></geometry></visual></link>
  <link name="Leg"><pose>0.5 0 0 0 0 0</pose><visual name="v"><pose>0 0 -0.1 0 0 0</pose><geometry><mesh><uri>model://reference_quadruped/meshes/visual/Leg.obj</uri></mesh></geometry></visual></link>
</model>
</sdf>`;

const MJCF = `<mujoco model="reference_arm">
  <compiler angle="radian" meshdir="meshes"/>
  <asset>
    <mesh name="Base" file="visual/Base.obj"/>
    <mesh name="Arm" file="visual/Arm.obj" scale="1 1 1"/>
  </asset>
  <worldbody>
    <light pos="0 0 3"/>
    <geom name="floor" type="plane" size="5 5 0.1"/>
    <body name="Base_plate" pos="0 0 0.02">
      <geom type="mesh" mesh="Base" class="visual"/>
      <geom type="box" size="0.1 0.1 0.1" class="collision"/>
      <body name="Arm" pos="0 0 0.2" quat="0.707107 0 0 0.707107">
        <geom type="mesh" mesh="Arm" class="visual" pos="0.1 0 0"/>
      </body>
    </body>
  </worldbody>
</mujoco>`;

describe('inspecting a package', () => {
  it('knows a ROS 2 package by its package.xml and URDF, with the USD it carries', async () => {
    const info = await inspectPackage(files({ 'package.xml': '<package format="3"><name>reference_rover</name></package>', 'urdf/reference_rover.urdf': URDF, 'urdf/reference_rover.urdf.xacro': '', 'isaac/reference_rover/reference_rover.usda': '#usda 1.0', 'isaac/reference_rover/payloads/robot.usda': '#usda 1.0' }));
    expect(info).toEqual({ format: 'ros', modelName: 'reference_rover', entry: 'urdf/reference_rover.urdf', rootBody: null, usd: 'isaac/reference_rover/reference_rover.usda' });
  });

  it('knows a Gazebo model folder by its model.sdf', async () => {
    const info = await inspectPackage(files({ 'model.config': '<model><name>reference_quadruped</name></model>', 'model.sdf': SDF }));
    expect(info).toEqual({ format: 'gazebo', modelName: 'reference_quadruped', entry: 'model.sdf', rootBody: null, usd: null });
  });

  it('knows a MuJoCo model by its root element and finds the body to attach', async () => {
    const info = await inspectPackage(files({ 'reference_arm.xml': MJCF, 'drive.py': '', 'README.md': '' }));
    expect(info).toEqual({ format: 'mujoco', modelName: 'reference_arm', entry: 'reference_arm.xml', rootBody: 'Base_plate', usd: null });
  });

  it('is null for a folder that is none of these', async () => {
    expect(await inspectPackage(files({ 'notes.txt': 'hello', 'scene.xml': '<scene/>' }))).toBeNull();
  });
});

describe('visual meshes', () => {
  it('places URDF visuals through the joint chain', () => {
    const visuals = visualsOf('ros', encodeText(URDF));
    expect(visuals).toHaveLength(2);
    expect(visuals[0].file).toBe('meshes/visual/Body.obj');
    expect(visuals[0].pose.xyz).toEqual([0, 0, 0.05]);
    const wheel = visuals[1];
    expect(wheel.file).toBe('meshes/visual/Wheel.obj');
    expect(wheel.scale).toEqual([2, 2, 2]);
    expect(wheel.pose.xyz.map((v) => Number(v.toFixed(6)))).toEqual([1, 0, 0.15]);
    expect(wheel.pose.rpy[2]).toBeCloseTo(1.570796);
  });

  it('places SDF visuals from the link poses in the model frame', () => {
    const visuals = visualsOf('gazebo', encodeText(SDF));
    expect(visuals.map((v) => v.file)).toEqual(['meshes/visual/Body.obj', 'meshes/visual/Leg.obj']);
    expect(visuals[0].pose.xyz).toEqual([0, 0, 0.1]);
    expect(visuals[1].pose.xyz.map((v) => Number(v.toFixed(6)))).toEqual([0.5, 0, -0.1]);
  });

  it('walks nested MJCF bodies, resolves mesh files through meshdir and skips collision geoms', () => {
    const visuals = visualsOf('mujoco', encodeText(MJCF));
    expect(visuals.map((v) => v.file)).toEqual(['meshes/visual/Base.obj', 'meshes/visual/Arm.obj']);
    expect(visuals[0].pose.xyz).toEqual([0, 0, 0.02]);
    const arm = visuals[1];
    // The arm body is yawed 90°, so its geom's +0.1 along X lands at +0.1 along Y.
    expect(arm.pose.xyz.map((v) => Number(v.toFixed(5)) + 0)).toEqual([0, 0.1, 0.22]);
    expect(arm.pose.rpy[2]).toBeCloseTo(Math.PI / 2, 4);
  });

  it('turns package and model URIs into paths inside the folder', () => {
    expect(meshPath('package://reference_rover/meshes/visual/Body.obj')).toBe('meshes/visual/Body.obj');
    expect(meshPath('model://quadruped/meshes/visual/Leg.obj')).toBe('meshes/visual/Leg.obj');
    expect(meshPath('./meshes/x.obj')).toBe('meshes/x.obj');
    expect(meshPath('file:///abs/x.obj')).toBe('/abs/x.obj');
  });
});

describe('the drive a package says it has', () => {
  it('reads a DiffDrive plugin in a URDF: speed from the wheel joints and radius, forward +X', () => {
    const urdf = xmlTree(
      encodeText(`<robot name="r">
  <joint name="wl" type="continuous"><parent link="b"/><child link="l"/><limit velocity="20" effort="1"/></joint>
  <joint name="wr" type="continuous"><parent link="b"/><child link="r"/><limit velocity="20" effort="1"/></joint>
  <gazebo><plugin filename="gz-sim-diff-drive-system" name="gz::sim::systems::DiffDrive">
    <left_joint>wl</left_joint><right_joint>wr</right_joint><wheel_separation>0.4</wheel_separation><wheel_radius>0.05</wheel_radius>
  </plugin></gazebo>
</robot>`),
    )!;
    const d = gzDrive(urdf, 0)!;
    expect(d.model).toBe('differential');
    expect(d.speed).toBeCloseTo(1); // 20 rad/s × 0.05 m
    expect(d.turn).toBeCloseTo(5); // 2 v / separation
    expect(d.forward).toBe(0);
  });

  it('reads an AckermannSteering plugin in an SDF, forward +Y as PlastikCAD models face', () => {
    const sdf = xmlTree(encodeText(`<sdf version="1.11"><model name="car"><plugin filename="gz-sim-ackermann-steering-system" name="gz::sim::systems::AckermannSteering"><steering_limit>0.6</steering_limit><wheel_base>1.2</wheel_base><max_linear_velocity>3</max_linear_velocity></plugin></model></sdf>`))!;
    const d = gzDrive(sdf, Math.PI / 2)!;
    expect(d).toMatchObject({ model: 'ackermann', speed: 3, turn: 0.6, wheelbase: 1.2, forward: Math.PI / 2 });
    expect(gzDrive(xmlTree(encodeText('<robot name="arm"/>'))!, 0)).toBeUndefined();
  });

  it('reads drive.json beside a MuJoCo model, with the top speed from the motors and forward from the file', () => {
    const root = xmlTree(encodeText('<mujoco model="rover"><actuator><velocity name="a" joint="j" ctrlrange="-20 20"/></actuator></mujoco>'))!;
    const d = mujocoDrive('{"kind":"differential","forward":[0,1,0],"wheelRadius":0.02,"wheelSeparation":0.092}', root)!;
    expect(d.model).toBe('differential');
    expect(d.speed).toBeCloseTo(0.4);
    expect(d.forward).toBeCloseTo(Math.PI / 2);
    expect(mujocoDrive('{"kind":"mecanum","forward":[1,0,0],"wheelRadius":0.05,"wheelSeparation":0.4,"wheelBase":0.5}', root)).toMatchObject({ model: 'holonomic', wheelbase: 0.5, forward: 0 });
    expect(mujocoDrive('not json', root)).toBeUndefined();
  });
});
