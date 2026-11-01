// Reading a robot package as PlastikCAD exports it: telling a ROS 2 package
// (URDF) from a Gazebo model folder (model.sdf) and a MuJoCo model (MJCF),
// what the writers need to know about it, and where its visual meshes sit, so
// the viewer can draw it where it is placed.
import { compose, rpyOf } from '../model/math';
import type { Quat } from '../model/math';
import { IDENTITY_POSE } from '../model/types';
import type { Pose, RobotFormat, Vec3 } from '../model/types';
import { decodeText } from '../io/format';
import { childOf, childrenOf, localName, xmlTree } from '../io/xml';
import type { XmlElement } from '../io/xml';

/** What is known about a package before it becomes an asset. */
export interface PackageInfo {
  format: RobotFormat;
  modelName: string;
  entry: string;
  rootBody: string | null;
  usd: string | null;
}

/** A visual mesh of the robot: the file inside the package, where it sits in the robot's frame (at zero joint angles), and its scale. */
export interface RobotVisual {
  file: string;
  pose: Pose;
  scale: Vec3;
}

/** The files of a package, by path relative to its folder, with a way to read one. */
export interface PackageFiles {
  paths: string[];
  read(path: string): Promise<Uint8Array>;
}

const numbers = (text: string | undefined, count: number, fallback: number[]): number[] => {
  const parts = (text ?? '').trim().split(/\s+/).map(Number);
  return parts.length === count && parts.every(Number.isFinite) ? parts : fallback;
};
const vec3 = (text: string | undefined, fallback: Vec3 = [0, 0, 0]): Vec3 => numbers(text, 3, fallback) as Vec3;

/** Looks through a package's files for the one the engine reads, and says what the package is. */
export async function inspectPackage(files: PackageFiles): Promise<PackageInfo | null> {
  const paths = files.paths.map((p) => p.replace(/\\/g, '/'));
  const has = (p: string) => paths.includes(p);
  const text = async (p: string) => decodeText(await files.read(p));
  const usd = paths.find((p) => /^isaac\/[^/]+\/[^/]+\.usda?$/.test(p) && !p.includes('/payloads/')) ?? null;
  if (has('package.xml')) {
    const pkg = xmlTree(await files.read('package.xml'));
    const entry = paths.find((p) => /^urdf\/[^/]+\.urdf$/.test(p)) ?? paths.find((p) => p.endsWith('.urdf'));
    if (!entry) return null;
    const modelName = (pkg && childOf(pkg, 'name')?.text) || entry.replace(/^.*\//, '').replace(/\.urdf$/, '');
    return { format: 'ros', modelName, entry, rootBody: null, usd };
  }
  if (has('model.sdf')) {
    const config = has('model.config') ? xmlTree(await files.read('model.config')) : null;
    const sdf = xmlTree(await files.read('model.sdf'));
    const model = sdf ? childOf(sdf, 'model') : undefined;
    const modelName = (config && childOf(config, 'name')?.text) || model?.attrs.name || 'model';
    return { format: 'gazebo', modelName, entry: 'model.sdf', rootBody: null, usd };
  }
  const xmls = paths.filter((p) => !p.includes('/') && p.endsWith('.xml'));
  for (const p of xmls) {
    const root = xmlTree(await files.read(p));
    if (!root || localName(root.name) !== 'mujoco') continue;
    const body = root ? childOf(root, 'worldbody') : undefined;
    const first = body ? childrenOf(body, 'body')[0] : undefined;
    return { format: 'mujoco', modelName: root.attrs.model || p.replace(/\.xml$/, ''), entry: p, rootBody: first?.attrs.name ?? null, usd };
  }
  void text;
  return null;
}

/** A `package://name/x`, `model://name/x` or plain mesh reference as a path inside the package folder. */
export function meshPath(uri: string): string {
  const m = /^(package|model):\/\/[^/]+\/(.*)$/.exec(uri);
  if (m) return m[2];
  return uri.replace(/^file:\/\//, '').replace(/^\.\//, '');
}

// --- URDF: links joined by joints; a link's frame is its parent's frame times the joint's origin ---

function urdfVisuals(root: XmlElement): RobotVisual[] {
  const joints = childrenOf(root, 'joint').map((j) => {
    const origin = childOf(j, 'origin');
    return { parent: childOf(j, 'parent')?.attrs.link ?? '', child: childOf(j, 'child')?.attrs.link ?? '', pose: { xyz: vec3(origin?.attrs.xyz), rpy: vec3(origin?.attrs.rpy) } };
  });
  const links = childrenOf(root, 'link');
  const children = new Set(joints.map((j) => j.child));
  const roots = links.filter((l) => !children.has(l.attrs.name));
  const poses = new Map<string, Pose>();
  const place = (name: string, pose: Pose) => {
    if (poses.has(name)) return;
    poses.set(name, pose);
    for (const j of joints) if (j.parent === name) place(j.child, compose(pose, j.pose));
  };
  for (const r of roots) place(r.attrs.name, IDENTITY_POSE);
  const out: RobotVisual[] = [];
  for (const link of links) {
    const at = poses.get(link.attrs.name) ?? IDENTITY_POSE;
    for (const visual of childrenOf(link, 'visual')) {
      const mesh = childOf(childOf(visual, 'geometry') ?? visual, 'mesh');
      if (!mesh?.attrs.filename) continue;
      const origin = childOf(visual, 'origin');
      out.push({ file: meshPath(mesh.attrs.filename), pose: compose(at, { xyz: vec3(origin?.attrs.xyz), rpy: vec3(origin?.attrs.rpy) }), scale: vec3(mesh.attrs.scale, [1, 1, 1]) });
    }
  }
  return out;
}

// --- SDF: every link's pose is given in the model's frame ---

const sdfPose = (el: XmlElement | undefined): Pose => {
  const p = numbers(el ? childOf(el, 'pose')?.text : undefined, 6, [0, 0, 0, 0, 0, 0]);
  return { xyz: [p[0], p[1], p[2]], rpy: [p[3], p[4], p[5]] };
};

function sdfVisuals(root: XmlElement): RobotVisual[] {
  const model = childOf(root, 'model') ?? root;
  const out: RobotVisual[] = [];
  for (const link of childrenOf(model, 'link')) {
    const at = sdfPose(link);
    for (const visual of childrenOf(link, 'visual')) {
      const mesh = childOf(childOf(visual, 'geometry') ?? visual, 'mesh');
      const uri = mesh ? childOf(mesh, 'uri')?.text : undefined;
      if (!uri) continue;
      out.push({ file: meshPath(uri), pose: compose(at, sdfPose(visual)), scale: vec3(mesh ? childOf(mesh, 'scale')?.text : undefined, [1, 1, 1]) });
    }
  }
  return out;
}

// --- MJCF: bodies nest, each placed by pos and quat in its parent; geoms name meshes declared under <asset> ---

const mjQuat = (text: string | undefined): Quat => numbers(text, 4, [1, 0, 0, 0]) as Quat;
const mjPose = (el: XmlElement): Pose => ({ xyz: vec3(el.attrs.pos), rpy: el.attrs.quat ? rpyOf(mjQuat(el.attrs.quat)) : el.attrs.euler ? vec3(el.attrs.euler) : [0, 0, 0] });

function mjcfVisuals(root: XmlElement): RobotVisual[] {
  const compiler = childOf(root, 'compiler');
  const meshdir = (compiler?.attrs.meshdir ?? '').replace(/\/$/, '');
  const meshes = new Map<string, { file: string; scale: Vec3 }>();
  const asset = childOf(root, 'asset');
  for (const m of asset ? childrenOf(asset, 'mesh') : []) {
    if (!m.attrs.name || !m.attrs.file) continue;
    meshes.set(m.attrs.name, { file: meshdir ? `${meshdir}/${m.attrs.file}` : m.attrs.file, scale: vec3(m.attrs.scale, [1, 1, 1]) });
  }
  const out: RobotVisual[] = [];
  const walk = (body: XmlElement, at: Pose) => {
    for (const geom of childrenOf(body, 'geom')) {
      if (geom.attrs.type !== 'mesh' || !geom.attrs.mesh) continue;
      // Collision geoms (group 3 in PlastikCAD's models) are not drawn; a geom with no class is a visual.
      if (geom.attrs.class === 'collision') continue;
      const mesh = meshes.get(geom.attrs.mesh);
      if (!mesh) continue;
      out.push({ file: mesh.file, pose: compose(at, mjPose(geom)), scale: mesh.scale });
    }
    for (const child of childrenOf(body, 'body')) walk(child, compose(at, mjPose(child)));
  };
  const worldbody = childOf(root, 'worldbody');
  if (worldbody) walk(worldbody, IDENTITY_POSE);
  return out;
}

/** The visual meshes of a package's entry file, placed in the robot's frame. */
export function visualsOf(format: RobotFormat, entryBytes: Uint8Array): RobotVisual[] {
  const root = xmlTree(entryBytes);
  if (!root) return [];
  if (format === 'ros') return urdfVisuals(root);
  if (format === 'gazebo') return sdfVisuals(root);
  return mjcfVisuals(root);
}
