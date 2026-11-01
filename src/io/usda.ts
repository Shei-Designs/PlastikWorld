// The stage for Isaac Sim: a USDA text file (USD's own text form, which needs
// no USD library to write) with a physics scene, the ground as a collision
// mesh, the lights, the props as meshes with collision and, for free objects,
// rigid bodies, and each robot referenced from the USD stage its PlastikCAD
// package carries (Isaac's URDF importer wrote it).
import { degrees } from '../model/math';
import { assetOf } from '../model/types';
import type { Light, Placed, Pose, Terrain, Vec3, World } from '../model/types';
import { bundleName, claimFolder, fmt } from './export';
import type { ExportBundle, ExportFile, MeshData, Resolved } from './export';
import { identifier } from './format';

const tuple = (v: Vec3, decimals = 6): string => `(${v.map((x) => fmt(x, decimals)).join(', ')})`;

/** The xformOps of a pose: translate, then rotate X, Y, Z in degrees (the same rotation as roll, pitch, yaw about the fixed axes). */
function xform(pose: Pose, scale = 1, indent = '    '): string {
  const ops = ['"xformOp:translate"', '"xformOp:rotateXYZ"', ...(scale !== 1 ? ['"xformOp:scale"'] : [])];
  return [
    `${indent}double3 xformOp:translate = ${tuple(pose.xyz)}`,
    `${indent}double3 xformOp:rotateXYZ = ${tuple(pose.rpy.map(degrees) as Vec3, 4)}`,
    ...(scale !== 1 ? [`${indent}double3 xformOp:scale = ${tuple([scale, scale, scale])}`] : []),
    `${indent}uniform token[] xformOpOrder = [${ops.join(', ')}]`,
  ].join('\n');
}

/** PhysX simulates a triangle mesh only when it stands still; a free body collides as its convex hull, or as its box when asked. */
type Approximation = 'none' | 'convexHull' | 'boundingCube';

function meshPrim(name: string, data: MeshData, collision: Approximation | null, indent: string): string {
  const points: string[] = [];
  for (let i = 0; i < data.positions.length; i += 3) points.push(tuple([data.positions[i], data.positions[i + 1], data.positions[i + 2]]));
  const counts = new Array(data.indices.length / 3).fill('3').join(', ');
  const lines = [
    `${indent}def Mesh "${name}"${collision ? ' (\n' + indent + '    prepend apiSchemas = ["PhysicsCollisionAPI", "PhysicsMeshCollisionAPI"]\n' + indent + ')' : ''}`,
    `${indent}{`,
    `${indent}    int[] faceVertexCounts = [${counts}]`,
    `${indent}    int[] faceVertexIndices = [${Array.from(data.indices).join(', ')}]`,
    `${indent}    point3f[] points = [${points.join(', ')}]`,
    `${indent}    uniform token subdivisionScheme = "none"`,
  ];
  if (data.colors) {
    const colors: string[] = [];
    for (let i = 0; i < data.colors.length; i += 3) colors.push(tuple([data.colors[i], data.colors[i + 1], data.colors[i + 2]], 4));
    lines.push(`${indent}    color3f[] primvars:displayColor = [${colors.join(', ')}] (\n${indent}        interpolation = "vertex"\n${indent}    )`);
  }
  if (collision) lines.push(`${indent}    uniform token physics:approximation = "${collision}"`);
  lines.push(`${indent}}`);
  return lines.join('\n');
}

/** The ground as a mesh: one quad for a plane, a grid for a heightmap. */
function groundMesh(terrain: Terrain): MeshData {
  const [sx, sy] = terrain.size;
  if (terrain.kind === 'plane') {
    return {
      positions: new Float32Array([-sx / 2, -sy / 2, 0, sx / 2, -sy / 2, 0, sx / 2, sy / 2, 0, -sx / 2, sy / 2, 0]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
      colors: null,
    };
  }
  const { rows, cols, heights, height } = terrain;
  const positions = new Float32Array(rows * cols * 3);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = (r * cols + c) * 3;
      positions[i] = (c / (cols - 1) - 0.5) * sx;
      positions[i + 1] = (r / (rows - 1) - 0.5) * sy;
      positions[i + 2] = heights[r * cols + c] * height;
    }
  }
  const indices = new Uint32Array((rows - 1) * (cols - 1) * 6);
  let k = 0;
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c, b = a + 1, d = a + cols, e = d + 1;
      indices[k++] = a;
      indices[k++] = b;
      indices[k++] = e;
      indices[k++] = a;
      indices[k++] = e;
      indices[k++] = d;
    }
  }
  return { positions, indices, colors: null };
}

function lightPrim(light: Light): string {
  const name = identifier(light.name, 'light');
  const color = tuple(light.color, 4);
  if (light.kind === 'sun') {
    // A distant light shines down its -Z; turn that onto the sun's direction.
    const d = light.direction;
    const yaw = Math.atan2(d[1], d[0]);
    const pitch = Math.atan2(Math.hypot(d[0], d[1]), -d[2]);
    return [
      `    def DistantLight "${name}"`,
      '    {',
      `        float inputs:intensity = ${fmt(light.intensity * 1000, 3)}`,
      `        color3f inputs:color = ${color}`,
      `        float inputs:angle = 1`,
      `        double3 xformOp:rotateXYZ = (0, ${fmt(degrees(pitch), 4)}, ${fmt(degrees(yaw), 4)})`,
      `        uniform token[] xformOpOrder = ["xformOp:rotateXYZ"]`,
      '    }',
    ].join('\n');
  }
  const kind = light.kind === 'spot' ? 'SphereLight' : 'SphereLight';
  const shaping = light.kind === 'spot' ? [`        float shaping:cone:angle = ${fmt(degrees(light.cone), 3)}`, `        float shaping:cone:softness = 0.2`] : [];
  return [
    `    def ${kind} "${name}"${light.kind === 'spot' ? ' (\n        prepend apiSchemas = ["ShapingAPI"]\n    )' : ''}`,
    '    {',
    `        float inputs:intensity = ${fmt(light.intensity * 30000, 3)}`,
    `        color3f inputs:color = ${color}`,
    `        float inputs:radius = 0.1`,
    ...shaping,
    xform(light.pose, 1, '        '),
    '    }',
  ].join('\n');
}

function propPrim(placed: Placed, data: MeshData): string {
  const name = identifier(placed.name, 'prop');
  const schemas = placed.physics.static ? [] : ['PhysicsRigidBodyAPI', 'PhysicsMassAPI'];
  const header = schemas.length ? `    def Xform "${name}" (\n        prepend apiSchemas = [${schemas.map((s) => `"${s}"`).join(', ')}]\n    )` : `    def Xform "${name}"`;
  return [
    header,
    '    {',
    xform(placed.pose, placed.scale, '        '),
    ...(placed.physics.static ? [] : [`        float physics:mass = ${fmt(placed.physics.mass, 6)}`]),
    meshPrim('mesh', data, placed.physics.collision === 'none' ? null : placed.physics.collision === 'box' ? 'boundingCube' : placed.physics.static ? 'none' : 'convexHull', '        '),
    '    }',
  ].join('\n');
}

export function isaacBundle(world: World, resolved: Resolved): ExportBundle {
  const name = bundleName(world);
  const stageName = identifier(world.name, 'world');
  const files: ExportFile[] = [];
  const notes: string[] = [];
  const copies: ExportBundle['copies'] = [];
  const prims: string[] = [];
  for (const placed of world.objects) {
    const asset = assetOf(world, placed);
    if (!asset) continue;
    if (asset.kind === 'mesh') {
      const mesh = resolved.meshes[asset.id];
      if (!mesh?.data || mesh.data.indices.length === 0) {
        notes.push(`${placed.name}: its mesh could not be read as triangles, so it was left out.`);
        continue;
      }
      prims.push(propPrim(placed, mesh.data));
      continue;
    }
    if (!asset.usd) {
      notes.push(`${placed.name}: the robot package carries no USD stage; import the robot's URDF with Isaac's importer and reference the result here.`);
      continue;
    }
    if (!asset.source.path) {
      notes.push(`${placed.name}: the robot package has no folder on disk to copy, so it was left out.`);
      continue;
    }
    const folder = `robots/${asset.modelName}`;
    if (claimFolder(copies, asset.source.path, folder) === 'taken') {
      notes.push(`${placed.name}: another robot package in this world is also named ${asset.modelName}, so it was left out; rename one in PlastikCAD.`);
      continue;
    }
    // The URDF importer's stages carry a Physics variant set with no selection
    // authored, and USD would pick the first name in dictionary order (mujoco):
    // the physx variant, the PhysX settings over the UsdPhysics articulation, is
    // asked for by name. A stage without the set ignores the selection.
    prims.push(
      [
        `    def Xform "${identifier(placed.name, 'robot')}" (`,
        `        prepend references = @./${folder}/${asset.usd}@`,
        '        variants = {',
        '            string Physics = "physx"',
        '        }',
        '    )',
        '    {',
        xform(placed.pose, 1, '        '),
        '    }',
      ].join('\n'),
    );
  }
  const g = world.gravity;
  const magnitude = Math.hypot(...g);
  const direction: Vec3 = magnitude > 0 ? (g.map((v) => v / magnitude) as Vec3) : [0, 0, -1];
  // The time-code range matters: Isaac Sim 6 loops a stage without one over a
  // single frame when Play is pressed, so nothing ever moves. The values are
  // the ones Isaac's own URDF importer authors.
  const usda = `#usda 1.0
(
    defaultPrim = "World"
    doc = "Made with PlastikWorld. Units: meters, kilograms, radians."
    endTimeCode = 1000000
    metersPerUnit = 1
    startTimeCode = 0
    timeCodesPerSecond = 60
    upAxis = "Z"
)

def Xform "World"
{
    def PhysicsScene "physicsScene"
    {
        vector3f physics:gravityDirection = ${tuple(direction, 4)}
        float physics:gravityMagnitude = ${fmt(magnitude, 4)}
    }

    def Xform "Ground"
    {
${meshPrim('mesh', groundMesh(world.terrain), 'none', '        ')}
    }

${world.lights.map(lightPrim).join('\n\n')}

${prims.join('\n\n')}
}
`;
  const file = `${stageName}.usda`;
  files.push({ path: file, text: usda });
  return { name, files, copies, notes, launch: `Open ${name}/${file} in Isaac Sim (File > Open), or reference it from a stage.` };
}
