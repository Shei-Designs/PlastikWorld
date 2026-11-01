// The world for Gazebo (Harmonic or later, `gz sim`): an SDF world with the
// physics and sensor systems, lights, the ground (a plane or a heightmap
// image), the props as static or free models, and the robots included by
// `model://` URI (a Gazebo model folder) or spawned from a launch file (a ROS 2
// package). The bundle is self-contained: meshes and robot folders go beside
// the world file.
import { gazeboSize, resample } from './heightmap';
import { encodeGreyPng } from './png';
import { bundleName, claimFolder, escapeXml, fmt, vec } from './export';
import type { ExportBundle, ExportFile, Resolved } from './export';
import { identifier } from './format';
import { assetOf } from '../model/types';
import type { Light, Placed, Pose, RobotAsset, World } from '../model/types';

const poseXml = (pose: Pose): string => `<pose>${vec(pose.xyz)} ${vec(pose.rpy)}</pose>`;

export function surfaceXml(friction: number): string {
  return `<surface><friction><ode><mu>${fmt(friction, 4)}</mu><mu2>${fmt(friction, 4)}</mu2></ode></friction></surface>`;
}

function lightXml(light: Light): string {
  const type = light.kind === 'sun' ? 'directional' : light.kind;
  const c = light.color.map((v) => fmt(v * light.intensity, 4)).join(' ');
  const lines = [
    `    <light type="${type}" name="${escapeXml(identifier(light.name, 'light'))}">`,
    `      <cast_shadows>${light.castShadows}</cast_shadows>`,
    `      ${poseXml(light.pose)}`,
    `      <diffuse>${c} 1</diffuse>`,
    `      <specular>0.2 0.2 0.2 1</specular>`,
  ];
  if (light.kind === 'sun') lines.push(`      <direction>${vec(light.direction)}</direction>`);
  else {
    lines.push(`      <attenuation><range>20</range><constant>0.5</constant><linear>0.01</linear><quadratic>0.001</quadratic></attenuation>`);
    if (light.kind === 'spot') lines.push(`      <direction>0 0 -1</direction>`, `      <spot><inner_angle>${fmt(light.cone * 0.8, 4)}</inner_angle><outer_angle>${fmt(light.cone, 4)}</outer_angle><falloff>1</falloff></spot>`);
  }
  lines.push('    </light>');
  return lines.join('\n');
}

function groundXml(world: World, heightmapFile: string | null, heightmapScale: number): string {
  const t = world.terrain;
  const geometry =
    t.kind === 'heightmap' && heightmapFile
      ? `<heightmap><uri>${heightmapFile}</uri><size>${fmt(t.size[0], 4)} ${fmt(t.size[1], 4)} ${fmt(Math.max(heightmapScale, 1e-3), 4)}</size><pos>0 0 0</pos></heightmap>`
      : `<plane><normal>0 0 1</normal><size>${fmt(t.size[0], 4)} ${fmt(t.size[1], 4)}</size></plane>`;
  return [
    '    <model name="ground">',
    '      <static>true</static>',
    '      <link name="link">',
    `        <collision name="collision"><geometry>${geometry}</geometry>${surfaceXml(t.friction)}</collision>`,
    `        <visual name="visual"><geometry>${geometry}</geometry><material><ambient>0.8 0.8 0.8 1</ambient><diffuse>0.8 0.8 0.8 1</diffuse></material></visual>`,
    '      </link>',
    '    </model>',
  ].join('\n');
}

function propXml(placed: Placed, resolved: Resolved, meshFile: string): string {
  const name = identifier(placed.name, 'prop');
  const mesh = resolved.meshes[placed.asset];
  const scale = placed.scale !== 1 ? `<scale>${fmt(placed.scale, 6)} ${fmt(placed.scale, 6)} ${fmt(placed.scale, 6)}</scale>` : '';
  const visual = `<mesh><uri>${meshFile}</uri>${scale}</mesh>`;
  // A moving body collides as its convex hull (SDF 1.11; a Harmonic built before
  // the element only warns and keeps the triangles, which take longer to settle).
  const collider = placed.physics.static ? visual : `<mesh><uri>${meshFile}</uri>${scale}<optimization>convex_hull</optimization></mesh>`;
  const box = mesh ? { center: mesh.bounds.min.map((lo, i) => ((lo + mesh.bounds.max[i]) / 2) * placed.scale), size: mesh.bounds.max.map((hi, i) => Math.max((hi - mesh.bounds.min[i]) * placed.scale, 1e-4)) } : null;
  const collision =
    placed.physics.collision === 'none'
      ? ''
      : placed.physics.collision === 'box' && box
        ? `        <collision name="collision"><pose>${box.center.map((v) => fmt(v, 6)).join(' ')} 0 0 0</pose><geometry><box><size>${box.size.map((v) => fmt(v, 6)).join(' ')}</size></box></geometry>${surfaceXml(placed.physics.friction)}</collision>\n`
        : `        <collision name="collision"><geometry>${collider}</geometry>${surfaceXml(placed.physics.friction)}</collision>\n`;
  const inertial =
    !placed.physics.static && box
      ? `        <inertial><mass>${fmt(placed.physics.mass, 6)}</mass><pose>${box.center.map((v) => fmt(v, 6)).join(' ')} 0 0 0</pose><inertia>${boxInertia(placed.physics.mass, box.size as [number, number, number])}</inertia></inertial>\n`
      : '';
  return [
    `    <model name="${escapeXml(name)}">`,
    `      <static>${placed.physics.static}</static>`,
    `      ${poseXml(placed.pose)}`,
    '      <link name="link">',
    inertial + collision + `        <visual name="visual"><geometry>${visual}</geometry></visual>`,
    '      </link>',
    '    </model>',
  ].join('\n');
}

/** The inertia of a solid box about its centre, as SDF wants it. */
function boxInertia(mass: number, [x, y, z]: [number, number, number]): string {
  const k = mass / 12;
  return `<ixx>${fmt(k * (y * y + z * z), 9)}</ixx><ixy>0</ixy><ixz>0</ixz><iyy>${fmt(k * (x * x + z * z), 9)}</iyy><iyz>0</iyz><izz>${fmt(k * (x * x + y * y), 9)}</izz>`;
}

/**
 * The ROS 2 launch file that starts Gazebo with the world and spawns each robot
 * from its ROS package at its pose. Shaped like the gazebo.launch.py PlastikCAD
 * writes into each package: ros_gz_sim's own launch file starts the simulator,
 * and headless:=true runs the server alone, as on a machine without a display.
 */
function launchPy(worldFile: string, robots: { placed: Placed; asset: RobotAsset; folder: string }[]): string {
  const spawns = robots
    .map(
      ({ placed, asset, folder }) => `        Node(
            package='ros_gz_sim',
            executable='create',
            name='spawn_${identifier(placed.name, 'robot')}',
            arguments=[
                '-name', '${identifier(placed.name, 'robot')}',
                '-file', os.path.join(here, '${folder}', '${asset.entry}'),
                '-x', '${fmt(placed.pose.xyz[0])}', '-y', '${fmt(placed.pose.xyz[1])}', '-z', '${fmt(placed.pose.xyz[2])}',
                '-R', '${fmt(placed.pose.rpy[0])}', '-P', '${fmt(placed.pose.rpy[1])}', '-Y', '${fmt(placed.pose.rpy[2])}',
            ],
            output='screen',
        ),`,
    )
    .join('\n');
  return `# Made with PlastikWorld: starts Gazebo with the world and spawns each robot
# from its ROS 2 package at its place, with ros_gz_sim installed:
#   ros2 launch ${worldFile.replace(/\.sdf$/, '')}.launch.py
# On a machine without a display, headless:=true runs the server alone. Each robot
# package's own launch file (bridge, controllers) can be added alongside.
import os
from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, IncludeLaunchDescription, SetEnvironmentVariable
from launch.launch_description_sources import PythonLaunchDescriptionSource
from launch.substitutions import LaunchConfiguration, PythonExpression
from launch_ros.actions import Node

here = os.path.dirname(os.path.abspath(__file__))


def generate_launch_description():
    headless = LaunchConfiguration('headless')
    gz_sim = IncludeLaunchDescription(
        PythonLaunchDescriptionSource(os.path.join(get_package_share_directory('ros_gz_sim'), 'launch', 'gz_sim.launch.py')),
        launch_arguments={'gz_args': [PythonExpression(["'-r -s --headless-rendering' if '", headless, "' == 'true' else '-r'"]), ' ', os.path.join(here, '${worldFile}')]}.items(),
    )
    return LaunchDescription([
        DeclareLaunchArgument('headless', default_value='false', description='Run the Gazebo server without the window'),
        SetEnvironmentVariable('GZ_SIM_RESOURCE_PATH', os.path.join(here, 'models') + os.pathsep + os.environ.get('GZ_SIM_RESOURCE_PATH', '')),
        gz_sim,
${spawns}
    ])
`;
}

/** The whole export: the SDF world, its heightmap image, the meshes, the robot folders to copy, and how to launch it. */
export function gazeboBundle(world: World, resolved: Resolved): ExportBundle {
  const name = bundleName(world);
  const worldName = identifier(world.name, 'world');
  const files: ExportFile[] = [];
  const notes: string[] = [];
  const copies: ExportBundle['copies'] = [];
  const t = world.terrain;
  let heightmapFile: string | null = null;
  let heightmapScale = t.kind === 'heightmap' ? t.height : 0;
  if (t.kind === 'heightmap') {
    // Gazebo wants a square image of 2^n + 1 pixels, its top row at +Y. It
    // scales the image by its own brightest pixel, not by white, so the samples
    // are stretched to full range here and the size's z is the top sample's height.
    const n = gazeboSize(Math.max(t.rows, t.cols));
    const samples = resample(t, n);
    const top = Math.max(...samples, 1e-6);
    heightmapScale = top * t.height;
    const flipped = new Array<number>(n * n);
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) flipped[r * n + c] = samples[(n - 1 - r) * n + c] / top;
    heightmapFile = 'materials/textures/heightmap.png';
    files.push({ path: heightmapFile, bytes: encodeGreyPng(n, n, flipped) });
  }
  const props: string[] = [];
  const robots: { placed: Placed; asset: RobotAsset; folder: string }[] = [];
  const includes: string[] = [];
  const written = new Set<string>();
  for (const placed of world.objects) {
    const asset = assetOf(world, placed);
    if (!asset) continue;
    if (asset.kind === 'mesh') {
      const mesh = resolved.meshes[asset.id];
      const file = `meshes/${identifier(asset.name, 'mesh')}.glb`;
      if (!mesh?.glb) {
        notes.push(`${placed.name}: its GLB could not be read, so it was left out.`);
        continue;
      }
      if (!written.has(file)) {
        files.push({ path: file, bytes: mesh.glb });
        written.add(file);
      }
      // DART, Gazebo's physics, cannot settle a moving triangle mesh on a heightmap: it rocks and creeps for good.
      if (!placed.physics.static && placed.physics.collision === 'mesh' && t.kind === 'heightmap') {
        notes.push(`Gazebo may never settle ${placed.name} on the terrain: a moving object that collides with its mesh rocks on a heightmap in Gazebo Harmonic. Set its collision to Box for a stable result.`);
      }
      props.push(propXml(placed, resolved, file));
      continue;
    }
    const folder = `models/${asset.modelName}`;
    if (!asset.source.path) {
      notes.push(`${placed.name}: the robot package has no folder on disk to copy, so it was left out.`);
      continue;
    }
    if (asset.format === 'mujoco') {
      notes.push(`${placed.name}: a MuJoCo model cannot be placed in a Gazebo world; export the robot from PlastikCAD as a ROS 2 package or a Gazebo model.`);
      continue;
    }
    if (claimFolder(copies, asset.source.path, folder) === 'taken') {
      notes.push(`${placed.name}: another robot package in this world is also named ${asset.modelName}, so it was left out; rename one in PlastikCAD.`);
      continue;
    }
    if (asset.format === 'gazebo') {
      includes.push(`    <include>\n      <uri>model://${escapeXml(asset.modelName)}</uri>\n      <name>${escapeXml(identifier(placed.name, 'robot'))}</name>\n      ${poseXml(placed.pose)}\n    </include>`);
    } else {
      robots.push({ placed, asset, folder });
    }
  }
  const sdf = `<?xml version="1.0"?>
<!-- Made with PlastikWorld. Units: meters, kilograms, radians. -->
<sdf version="1.11">
  <world name="${escapeXml(worldName)}">
    <gravity>${vec(world.gravity)}</gravity>
    <physics name="default" type="ode"><max_step_size>0.001</max_step_size><real_time_factor>1</real_time_factor></physics>
    <plugin filename="gz-sim-physics-system" name="gz::sim::systems::Physics"/>
    <plugin filename="gz-sim-user-commands-system" name="gz::sim::systems::UserCommands"/>
    <plugin filename="gz-sim-scene-broadcaster-system" name="gz::sim::systems::SceneBroadcaster"/>
    <plugin filename="gz-sim-sensors-system" name="gz::sim::systems::Sensors"><render_engine>ogre2</render_engine></plugin>
    <plugin filename="gz-sim-imu-system" name="gz::sim::systems::Imu"/>
    <plugin filename="gz-sim-contact-system" name="gz::sim::systems::Contact"/>
${world.lights.map(lightXml).join('\n')}
${groundXml(world, heightmapFile, heightmapScale)}
${[...props, ...includes].join('\n')}
  </world>
</sdf>
`;
  const worldFile = `${worldName}.sdf`;
  files.push({ path: worldFile, text: sdf });
  if (robots.length) files.push({ path: `${worldName}.launch.py`, text: launchPy(worldFile, robots) });
  files.push({
    path: 'run.sh',
    text: `#!/bin/sh\n# Runs the world in Gazebo. Meshes are found beside the world file, robots under models/.\ncd "$(dirname "$0")"\nGZ_SIM_RESOURCE_PATH="$PWD/models:$GZ_SIM_RESOURCE_PATH" gz sim -r "${worldFile}"\n`,
  });
  const launch = robots.length ? `cd ${name} && ros2 launch ${worldName}.launch.py` : `cd ${name} && GZ_SIM_RESOURCE_PATH=$PWD/models gz sim -r ${worldFile}`;
  return { name, files, copies, notes, launch };
}
