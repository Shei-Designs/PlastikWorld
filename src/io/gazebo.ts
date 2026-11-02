// The world for Gazebo (Harmonic or later, `gz sim`): an SDF world with the
// physics and sensor systems, lights, the ground (a plane or a heightmap
// image), the props as static or free models, and the robots included by
// `model://` URI (a Gazebo model folder) or spawned from a launch file (a ROS 2
// package). The bundle is self-contained: meshes and robot folders go beside
// the world file.
import { gazeboSize, range, resample } from './heightmap';
import { encodeGreyPng } from './png';
import { bundleName, claimFolder, escapeXml, fmt, vec } from './export';
import type { ExportBundle, ExportFile, Resolved } from './export';
import { identifier } from './format';
import { writeObj } from './obj';
import { placedZones, zoneMesh } from './zones';

/**
 * How far a zone sits over the ground in Gazebo: a centimetre, not the
 * writers' usual two millimetres, so that a body on the patch stays clear of
 * the heightmap's contacts under it.
 */
const GAZEBO_ZONE_LIFT = 0.01;
import { assetOf, assetPresent, isProp, skyOf } from '../model/types';
import type { Light, Placed, Pose, RobotAsset, World } from '../model/types';

const poseXml = (pose: Pose): string => `<pose>${vec(pose.xyz)} ${vec(pose.rpy)}</pose>`;

export function surfaceXml(friction: number, restitution = 0): string {
  const bounce = restitution > 0 ? `<bounce><restitution_coefficient>${fmt(restitution, 4)}</restitution_coefficient><threshold>0.01</threshold></bounce>` : '';
  return `<surface><friction><ode><mu>${fmt(friction, 4)}</mu><mu2>${fmt(friction, 4)}</mu2></ode></friction>${bounce}</surface>`;
}

/**
 * A surface zone as a static model laid over the ground: on a heightmap a
 * mesh of the zone's cells (an OBJ beside the world), on a plane a thin box,
 * either a hair above the ground so a body lands on the zone's surface, with
 * the material's friction. Gazebo has one surface per collision, which is why
 * the zone is a collision of its own.
 */
function zoneXml(world: World, index: number, files: ExportFile[]): string | null {
  const { zone, material, rect } = placedZones(world)[index];
  const name = identifier(zone.name || `zone_${index + 1}`, 'zone');
  const colour = `<material><ambient>${vec(material.color, 3)} 1</ambient><diffuse>${vec(material.color, 3)} 1</diffuse></material>`;
  let geometry: string;
  if (world.terrain.kind === 'plane') {
    const [x0, y0, x1, y1] = rect;
    geometry = `<box><size>${fmt(x1 - x0, 4)} ${fmt(y1 - y0, 4)} ${fmt(GAZEBO_ZONE_LIFT * 2, 4)}</size></box>`;
    return [
      `    <model name="${escapeXml(name)}">`,
      '      <static>true</static>',
      `      <pose>${fmt((x0 + x1) / 2, 4)} ${fmt((y0 + y1) / 2, 4)} ${fmt(GAZEBO_ZONE_LIFT, 4)} 0 0 0</pose>`,
      '      <link name="link">',
      `        <collision name="collision"><geometry>${geometry}</geometry>${surfaceXml(material.friction, material.restitution)}</collision>`,
      `        <visual name="visual"><geometry>${geometry}</geometry>${colour}</visual>`,
      '      </link>',
      '    </model>',
    ].join('\n');
  }
  const mesh = zoneMesh(world.terrain, zone, GAZEBO_ZONE_LIFT);
  if (!mesh) return null;
  const file = `meshes/${name}.obj`;
  files.push({ path: file, text: writeObj(zone.name || name, mesh) });
  geometry = `<mesh><uri>${file}</uri></mesh>`;
  return [
    `    <model name="${escapeXml(name)}">`,
    '      <static>true</static>',
    '      <link name="link">',
    `        <collision name="collision"><geometry>${geometry}</geometry>${surfaceXml(material.friction, material.restitution)}</collision>`,
    `        <visual name="visual"><geometry>${geometry}</geometry>${colour}</visual>`,
    '      </link>',
    '    </model>',
  ].join('\n');
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

// Gazebo's WindEffects pushes each link with mass × factor × (wind − its velocity): an approximation that
// moves a heavy crate as readily as a light one. At a factor of 1 a 200 kg crate on friction 0.8 crept a
// meter in the smoke test; at 0.5 the push stays under friction for anything well planted, while a light
// object on a slippery floor still blows away. The factor is written in the plugin's polynomial form
// (k × (px(x) + qy(y) + rz(z)), with px the constant 1) rather than as a bare number: Harmonic reads a
// bare number v as v/3 × (v + v + v), so a bare 0.5 acts as 0.25 and the light crate never moved.
const WIND_FACTOR = 0.5;
const windy = (world: World): boolean => world.environment.wind.some((v) => v !== 0);
const windPlugin = `    <plugin filename="gz-sim-wind-effects-system" name="gz::sim::systems::WindEffects"><force_approximation_scaling_factor><k>${WIND_FACTOR}</k><px>0 0 0 1</px></force_approximation_scaling_factor></plugin>\n`;

/**
 * The scene: the sky by its time of day and cloud cover, the ambient light to
 * suit, linear fog for the cameras, and the wind, which the WindEffects
 * system turns into a force on every link that has wind enabled.
 */
function sceneXml(world: World): string {
  const env = world.environment;
  const sky = skyOf(env.sky);
  const clouds = env.sky === 'overcast' ? '<clouds><speed>0</speed><humidity>1</humidity><mean_size>1</mean_size></clouds>' : env.sky === 'clear' ? '<clouds><speed>0.4</speed><humidity>0.2</humidity><mean_size>0.3</mean_size></clouds>' : '';
  const fog = env.fog ? `<fog><type>linear</type><color>${vec(env.fog.color, 3)} 1</color><start>${fmt(env.fog.start, 3)}</start><end>${fmt(env.fog.end, 3)}</end></fog>` : '';
  const a = sky.ambient;
  const lines = [`    <scene><ambient>${fmt(a, 3)} ${fmt(a, 3)} ${fmt(a, 3)} 1</ambient><background>${vec(sky.color, 3)} 1</background><sky><time>${fmt(sky.hour, 2)}</time>${clouds}</sky>${fog}</scene>`];
  if (windy(world)) lines.push(`    <wind><linear_velocity>${vec(env.wind, 3)}</linear_velocity></wind>`);
  return lines.join('\n');
}

function groundXml(world: World, heightmapFile: string | null, heightmapSpan: number, heightmapBase: number): string {
  const t = world.terrain;
  const geometry =
    t.kind === 'heightmap' && heightmapFile
      ? `<heightmap><uri>${heightmapFile}</uri><size>${fmt(t.size[0], 4)} ${fmt(t.size[1], 4)} ${fmt(heightmapSpan, 4)}</size><pos>0 0 0</pos></heightmap>`
      : `<plane><normal>0 0 1</normal><size>${fmt(t.size[0], 4)} ${fmt(t.size[1], 4)}</size></plane>`;
  // The image's black is the lowest sample, so the whole model is lifted to it: Gazebo pays no heed to a
  // <pos> inside <heightmap> (the smoke test found the ground 8 cm low with the lift there).
  const lift = t.kind === 'heightmap' && heightmapFile && heightmapBase !== 0 ? `      <pose>0 0 ${fmt(heightmapBase, 4)} 0 0 0</pose>\n` : '';
  return [
    '    <model name="ground">',
    '      <static>true</static>',
    ...(lift ? [lift.trimEnd()] : []),
    '      <link name="link">',
    `        <collision name="collision"><geometry>${geometry}</geometry>${surfaceXml(t.friction)}</collision>`,
    `        <visual name="visual"><geometry>${geometry}</geometry><material><ambient>0.8 0.8 0.8 1</ambient><diffuse>0.8 0.8 0.8 1</diffuse></material></visual>`,
    '      </link>',
    '    </model>',
  ].join('\n');
}

function propXml(placed: Placed, resolved: Resolved, meshFile: string, wind = false): string {
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
    // The WindEffects system moves only links that ask for it.
    ...(wind && !placed.physics.static ? ['        <enable_wind>true</enable_wind>'] : []),
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
# package's bridge (config/bridge.yaml) is started with it; controllers from the
# package's own launch file can be added alongside.
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
    nodes = [
        DeclareLaunchArgument('headless', default_value='false', description='Run the Gazebo server without the window'),
        SetEnvironmentVariable('GZ_SIM_RESOURCE_PATH', os.path.join(here, 'models') + os.pathsep + os.environ.get('GZ_SIM_RESOURCE_PATH', '')),
        gz_sim,
${spawns}
    ]
    # A package that carries config/bridge.yaml (PlastikCAD's do) gets its bridge, so cmd_vel, odom and
    # the sensors reach ROS 2 here as they do from the package's own launch file. Two packages bridging
    # the same topics would need namespaces; a world holds one robot per package name.
    for folder in [${robots.map(({ folder }) => `'${folder}'`).join(', ')}]:
        bridge = os.path.join(here, folder, 'config', 'bridge.yaml')
        if os.path.exists(bridge):
            nodes.append(Node(
                package='ros_gz_bridge',
                executable='parameter_bridge',
                name='bridge_' + os.path.basename(folder),
                parameters=[{'config_file': bridge, 'use_sim_time': True}],
                output='screen',
            ))
    return LaunchDescription(nodes)
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
  let heightmapSpan = 0;
  let heightmapBase = 0;
  if (t.kind === 'heightmap') {
    // Gazebo wants a square image of 2^n + 1 pixels, its top row at +Y (the
    // world's grid is one already; resampling only guards a hand-edited file).
    // It scales the image by its own brightest pixel, not by white, so the
    // samples go in stretched from the lowest (black) to the highest (white),
    // the size's z is their span and the heightmap is lifted to the lowest.
    const n = gazeboSize(Math.max(t.rows, t.cols));
    const samples = n === t.rows && n === t.cols ? t.heights : resample(t, n);
    const [lo, hi] = range(samples);
    heightmapBase = lo;
    heightmapSpan = Math.max(hi - lo, 1e-3);
    const flipped = new Array<number>(n * n);
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) flipped[r * n + c] = (samples[(n - 1 - r) * n + c] - lo) / heightmapSpan;
    heightmapFile = 'materials/textures/heightmap.png';
    files.push({ path: heightmapFile, bytes: encodeGreyPng(n, n, flipped) });
  }
  const props: string[] = [];
  const zones = placedZones(world);
  for (let i = 0; i < zones.length; i++) {
    const xml = zoneXml(world, i, files);
    if (xml) props.push(xml);
  }
  // DART, Gazebo's physics, takes the lower of the two frictions that meet, but a friction set on a mesh or a
  // heightmap collision never counts (found by blowing crates about in the smoke container: a 0.8 crate crept on a
  // mesh patch at 0.05 and flew on a plane at 0.05; a mesh crate at 0.05 held on a plane at 1). So on a heightmap
  // the zones, which are meshes there, and the terrain's own friction do nothing, and a mesh-collision prop meets
  // the world with the other body's friction. On a plane the zones are boxes and work; the notes say the rest.
  if (world.terrain.kind === 'heightmap') {
    const free = world.objects.filter((o) => !o.physics.static);
    for (const { zone, material } of zones) {
      if (free.some((o) => Math.abs(o.physics.friction - material.friction) > 1e-6)) notes.push(`${zone.name}: Gazebo drops the friction set on a mesh, and on a heightmap a zone is one, so its ${material.friction} does not act there: a body keeps its own friction on it. Set the object's friction too.`);
    }
    if (Math.abs(world.terrain.friction - 1) > 1e-6) notes.push(`Terrain: Gazebo drops the friction set on a heightmap, so its ${world.terrain.friction} does not act: a body meets the ground with its own friction.`);
  }
  // Only the free ones: whether a loose prop slides is what its friction decides, and nearly every fixed prop is a mesh.
  const meshy = world.objects.filter((o) => !o.physics.static && o.physics.collision === 'mesh' && Math.abs(o.physics.friction - 1) > 1e-6 && assetOf(world, o) && isProp(assetOf(world, o)!));
  if (meshy.length) notes.push(`${meshy.map((o) => o.name).join(', ')}: Gazebo drops the friction set on a mesh collision, so what ${meshy.length === 1 ? 'it touches' : 'they touch'} sets the friction; use a box collision where friction matters.`);
  const robots: { placed: Placed; asset: RobotAsset; folder: string }[] = [];
  const includes: string[] = [];
  const written = new Set<string>();
  for (const placed of world.objects) {
    const asset = assetOf(world, placed);
    if (!asset) continue;
    if (isProp(asset)) {
      const mesh = resolved.meshes[asset.id];
      // A GLB goes out as it came; a library part, which has none, as an OBJ of its triangles.
      const file = `meshes/${identifier(asset.name, 'mesh')}.${mesh?.glb ? 'glb' : 'obj'}`;
      if (!mesh?.glb && !mesh?.data) {
        notes.push(`${placed.name}: its mesh could not be read, so it was left out.`);
        continue;
      }
      if (!written.has(file)) {
        files.push(mesh.glb ? { path: file, bytes: mesh.glb } : { path: file, text: writeObj(asset.name, mesh.data!) });
        written.add(file);
      }
      // DART, Gazebo's physics, cannot settle a moving triangle mesh on a heightmap: it rocks and creeps for good.
      if (!placed.physics.static && placed.physics.collision === 'mesh' && t.kind === 'heightmap') {
        notes.push(`Gazebo may never settle ${placed.name} on the terrain: a moving object that collides with its mesh rocks on a heightmap in Gazebo Harmonic. Set its collision to Box for a stable result.`);
      }
      props.push(propXml(placed, resolved, file, windy(world)));
      continue;
    }
    const folder = `models/${asset.modelName}`;
    if (!assetPresent(asset)) {
      notes.push(`${placed.name}: the robot package's files are not with this world (import it again), so it was left out.`);
      continue;
    }
    if (asset.format === 'mujoco') {
      notes.push(`${placed.name}: a MuJoCo model cannot be placed in a Gazebo world; export the robot from PlastikCAD as a ROS 2 package or a Gazebo model.`);
      continue;
    }
    if (claimFolder(copies, asset.id, folder) === 'taken') {
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
${sceneXml(world)}
    <physics name="default" type="ode"><max_step_size>0.001</max_step_size><real_time_factor>1</real_time_factor></physics>
    <plugin filename="gz-sim-physics-system" name="gz::sim::systems::Physics"/>
    <plugin filename="gz-sim-user-commands-system" name="gz::sim::systems::UserCommands"/>
    <plugin filename="gz-sim-scene-broadcaster-system" name="gz::sim::systems::SceneBroadcaster"/>
    <plugin filename="gz-sim-sensors-system" name="gz::sim::systems::Sensors"><render_engine>ogre2</render_engine></plugin>
    <plugin filename="gz-sim-imu-system" name="gz::sim::systems::Imu"/>
    <plugin filename="gz-sim-contact-system" name="gz::sim::systems::Contact"/>
${windy(world) ? windPlugin : ''}${world.lights.map(lightXml).join('\n')}
${groundXml(world, heightmapFile, heightmapSpan, heightmapBase)}
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
