// The world for MuJoCo: an MJCF with the ground as a plane or an hfield (the
// heights inline), the props as static or free bodies with mesh geoms (an OBJ
// each, since MuJoCo reads no GLB), and each robot brought in by attaching its
// own model file, so its actuators and sensors come along and its floor does not.
import { quatOf } from '../model/math';
import { assetOf, assetPresent } from '../model/types';
import type { Light, World } from '../model/types';
import { bundleName, claimFolder, escapeXml, fmt, vec } from './export';
import type { ExportBundle, ExportFile, Resolved } from './export';
import { identifier } from './format';
import { range } from './heightmap';
import { ZONE_LIFT, placedZones, zoneCells } from './zones';
import { writeObj } from './obj';

const TIMESTEP = 0.002;

const quat = (rpy: [number, number, number]): string => quatOf(rpy).map((x) => fmt(x, 6)).join(' ');
const frictionAttr = (f: number): string => `friction="${fmt(f, 4)} 0.005 0.0001"`;

function lightXml(light: Light): string {
  const c = light.color.map((v) => fmt(v * light.intensity, 4)).join(' ');
  if (light.kind === 'sun') return `    <light name="${escapeXml(identifier(light.name, 'light'))}" directional="true" pos="${vec(light.pose.xyz)}" dir="${vec(light.direction)}" diffuse="${c}" castshadow="${light.castShadows}"/>`;
  // MuJoCo's lights point along `dir`; a point light here is a wide spot straight down, a spot keeps its cone.
  const cutoff = light.kind === 'spot' ? fmt((light.cone * 180) / Math.PI, 3) : '90';
  return `    <light name="${escapeXml(identifier(light.name, 'light'))}" pos="${vec(light.pose.xyz)}" dir="0 0 -1" diffuse="${c}" cutoff="${cutoff}" castshadow="${light.castShadows}"/>`;
}

export function mujocoBundle(world: World, resolved: Resolved): ExportBundle {
  const name = bundleName(world);
  const modelName = identifier(world.name, 'world');
  const files: ExportFile[] = [];
  const notes: string[] = [];
  const copies: ExportBundle['copies'] = [];
  const assets: string[] = [];
  const bodies: string[] = [];
  const t = world.terrain;
  const half = [t.size[0] / 2, t.size[1] / 2];
  if (t.kind === 'heightmap') {
    // MuJoCo reads the first row as +Y (an image's top row) where the world stores
    // -Y first, and it stretches the samples to 0..1 before scaling them by the
    // z size, so the rows are flipped and the geom is lifted to the lowest sample
    // with the z size cut to the span, which keeps every height where the file has it.
    const [lo, hi] = range(t.heights);
    const span = Math.max(hi - lo, 1e-3);
    const rows: string[] = [];
    for (let r = t.rows - 1; r >= 0; r--) rows.push(Array.from(t.heights.subarray(r * t.cols, (r + 1) * t.cols), (v) => v.toFixed(3)).join(' '));
    assets.push(`    <hfield name="terrain" nrow="${t.rows}" ncol="${t.cols}" size="${fmt(half[0], 4)} ${fmt(half[1], 4)} ${fmt(span, 4)} 0.02" elevation="${rows.join('  ')}"/>`);
    bodies.push(`    <geom name="floor" type="hfield" hfield="terrain" pos="0 0 ${fmt(lo, 4)}" material="floor" ${frictionAttr(t.friction)}/>`);
  } else {
    bodies.push(`    <geom name="floor" type="plane" size="${fmt(half[0], 4)} ${fmt(half[1], 4)} 0.1" material="floor" ${frictionAttr(t.friction)}/>`);
  }
  // Surface zones: MuJoCo has one friction per geom, so each zone is a geom laid a hair over the ground.
  placedZones(world).forEach(({ zone, material, rect }, index) => {
    const zoneName = identifier(zone.name || `zone_${index + 1}`, 'zone');
    const rgba = `${vec(material.color, 3)} 0.9`;
    if (t.kind === 'plane') {
      const [x0, y0, x1, y1] = rect;
      // priority: MuJoCo takes the friction of the geom with the higher priority (the larger of the two otherwise), so the zone's surface counts.
      bodies.push(`    <geom name="${zoneName}" type="box" pos="${fmt((x0 + x1) / 2, 4)} ${fmt((y0 + y1) / 2, 4)} ${fmt(ZONE_LIFT, 4)}" size="${fmt((x1 - x0) / 2, 4)} ${fmt((y1 - y0) / 2, 4)} ${fmt(ZONE_LIFT, 4)}" rgba="${rgba}" priority="1" ${frictionAttr(material.friction)}/>`);
      return;
    }
    const cells = zoneCells(t, zone);
    if (!cells) return;
    const w = cells.c1 - cells.c0 + 1, h = cells.r1 - cells.r0 + 1;
    const sx = t.size[0] / (t.cols - 1), sy = t.size[1] / (t.rows - 1);
    let lo = Infinity, hi = -Infinity;
    for (let r = cells.r0; r <= cells.r1; r++) for (let c = cells.c0; c <= cells.c1; c++) {
      const v = t.heights[r * t.cols + c];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    const span = Math.max(hi - lo, 1e-3);
    const rows: string[] = [];
    for (let r = cells.r1; r >= cells.r0; r--) rows.push(Array.from(t.heights.subarray(r * t.cols + cells.c0, r * t.cols + cells.c1 + 1), (v) => v.toFixed(3)).join(' '));
    const cx = ((cells.c0 + cells.c1) / 2 / (t.cols - 1) - 0.5) * t.size[0], cy = ((cells.r0 + cells.r1) / 2 / (t.rows - 1) - 0.5) * t.size[1];
    assets.push(`    <hfield name="${zoneName}" nrow="${h}" ncol="${w}" size="${fmt((sx * (w - 1)) / 2, 4)} ${fmt((sy * (h - 1)) / 2, 4)} ${fmt(span, 4)} 0.01" elevation="${rows.join('  ')}"/>`);
    bodies.push(`    <geom name="${zoneName}" type="hfield" hfield="${zoneName}" pos="${fmt(cx, 4)} ${fmt(cy, 4)} ${fmt(lo + ZONE_LIFT, 4)}" rgba="${rgba}" priority="1" ${frictionAttr(material.friction)}/>`);
  });
  const written = new Map<string, string>();
  for (const placed of world.objects) {
    const asset = assetOf(world, placed);
    if (!asset) continue;
    const bodyName = identifier(placed.name, 'prop');
    if (asset.kind === 'mesh') {
      const mesh = resolved.meshes[asset.id];
      if (!mesh?.data || mesh.data.indices.length === 0) {
        notes.push(`${placed.name}: its mesh could not be read as triangles, so it was left out.`);
        continue;
      }
      let meshName = written.get(asset.id);
      if (!meshName) {
        meshName = identifier(asset.name, 'mesh');
        written.set(asset.id, meshName);
        files.push({ path: `meshes/${meshName}.obj`, text: writeObj(asset.name, mesh.data) });
        assets.push(`    <mesh name="${meshName}" file="${meshName}.obj"/>`);
      }
      const scale = placed.scale !== 1 ? ` scale="${fmt(placed.scale, 6)} ${fmt(placed.scale, 6)} ${fmt(placed.scale, 6)}"` : '';
      if (scale) {
        // A scaled copy is its own mesh asset.
        const scaled = `${meshName}_${bodyName}`;
        assets.push(`    <mesh name="${scaled}" file="${meshName}.obj"${scale}/>`);
        meshName = scaled;
      }
      const center = mesh.bounds.min.map((lo, i) => ((lo + mesh.bounds.max[i]) / 2) * placed.scale);
      const size = mesh.bounds.max.map((hi, i) => Math.max(((hi - mesh.bounds.min[i]) / 2) * placed.scale, 1e-4));
      const mass = placed.physics.static ? '' : ` mass="${fmt(placed.physics.mass, 6)}"`;
      const lines = [`    <body name="${escapeXml(bodyName)}" pos="${vec(placed.pose.xyz)}" quat="${quat(placed.pose.rpy)}">`];
      if (!placed.physics.static) lines.push(`      <freejoint name="${escapeXml(bodyName)}_free"/>`);
      if (placed.physics.collision === 'mesh') lines.push(`      <geom type="mesh" mesh="${meshName}" ${frictionAttr(placed.physics.friction)}${mass}/>`);
      else {
        lines.push(`      <geom type="mesh" mesh="${meshName}" contype="0" conaffinity="0" group="2"${placed.physics.collision === 'none' ? mass : ''}/>`);
        if (placed.physics.collision === 'box') lines.push(`      <geom type="box" pos="${center.map((v) => fmt(v, 6)).join(' ')}" size="${size.map((v) => fmt(v, 6)).join(' ')}" group="3" rgba="0.6 0.6 0.9 0.3" ${frictionAttr(placed.physics.friction)}${mass}/>`);
      }
      lines.push('    </body>');
      bodies.push(lines.join('\n'));
      continue;
    }
    if (asset.format !== 'mujoco') {
      notes.push(`${placed.name}: not a MuJoCo model; export the robot from PlastikCAD as a MuJoCo model to place it here.`);
      continue;
    }
    if (!assetPresent(asset)) {
      notes.push(`${placed.name}: the robot model's files are not with this world (import it again), so it was left out.`);
      continue;
    }
    if (!asset.rootBody) {
      notes.push(`${placed.name}: the model has no body under <worldbody> to attach, so it was left out.`);
      continue;
    }
    const folder = `robots/${asset.modelName}`;
    if (claimFolder(copies, asset.id, folder) === 'taken') {
      notes.push(`${placed.name}: another robot model in this world is also named ${asset.modelName}, so it was left out; rename one in PlastikCAD.`);
      continue;
    }
    const model = identifier(asset.modelName, 'robot');
    if (!assets.some((a) => a.includes(`<model name="${model}"`))) assets.push(`    <model name="${model}" file="${folder}/${asset.entry}"/>`);
    bodies.push(`    <frame name="${escapeXml(bodyName)}_spawn" pos="${vec(placed.pose.xyz)}" quat="${quat(placed.pose.rpy)}"><attach model="${model}" body="${escapeXml(asset.rootBody)}" prefix="${escapeXml(bodyName)}_"/></frame>`);
  }
  const xml = [
    '<!-- Made with PlastikWorld. Units: meters, kilograms, radians. -->',
    `<mujoco model="${escapeXml(modelName)}">`,
    '  <compiler angle="radian" meshdir="meshes" autolimits="true"/>',
    `  <option timestep="${TIMESTEP}" gravity="${vec(world.gravity)}" integrator="implicitfast"/>`,
    '  <asset>',
    '    <texture name="grid" type="2d" builtin="checker" rgb1="0.2 0.3 0.4" rgb2="0.1 0.15 0.2" width="300" height="300"/>',
    '    <material name="floor" texture="grid" texrepeat="8 8" reflectance="0.1"/>',
    ...assets,
    '  </asset>',
    '  <worldbody>',
    ...world.lights.map(lightXml),
    ...bodies,
    '  </worldbody>',
    '</mujoco>',
    '',
  ].join('\n');
  const file = `${modelName}.xml`;
  files.push({ path: file, text: xml });
  files.push({ path: 'run.sh', text: `#!/bin/sh\n# Opens the world in MuJoCo's viewer (pip install mujoco).\ncd "$(dirname "$0")"\npython3 -m mujoco.viewer --mjcf "${file}"\n` });
  return { name, files, copies, notes, launch: `cd ${name} && python3 -m mujoco.viewer --mjcf ${file}` };
}
