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
  /** How the robot is driven, as the package says; absent when it says nothing (an arm, a hand-written package). */
  drive?: PackageDrive;
}

/** What a package says about its drive, in the demo drive's terms. */
export interface PackageDrive {
  model: 'differential' | 'ackermann' | 'holonomic';
  /** Top speed, m/s: the wheels' top rate times their radius where the package gives both, else the plugin's own limit. */
  speed: number;
  /** Turn rate, rad/s, or the steering limit, rad, for an Ackermann drive. */
  turn: number;
  wheelbase: number;
  /** Forward in the robot's own frame, as an angle from its +X. */
  forward: number;
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
    const urdf = xmlTree(await files.read(entry));
    return { format: 'ros', modelName, entry, rootBody: null, usd, ...(urdf ? { drive: gzDrive(urdf, 0) } : {}) };
  }
  if (has('model.sdf')) {
    const config = has('model.config') ? xmlTree(await files.read('model.config')) : null;
    const sdf = xmlTree(await files.read('model.sdf'));
    const model = sdf ? childOf(sdf, 'model') : undefined;
    const modelName = (config && childOf(config, 'name')?.text) || model?.attrs.name || 'model';
    // PlastikCAD's Gazebo models keep the design axes, where forward is +Y.
    return { format: 'gazebo', modelName, entry: 'model.sdf', rootBody: null, usd, ...(sdf ? { drive: gzDrive(sdf, Math.PI / 2) } : {}) };
  }
  const xmls = paths.filter((p) => !p.includes('/') && p.endsWith('.xml'));
  for (const p of xmls) {
    const root = xmlTree(await files.read(p));
    if (!root || localName(root.name) !== 'mujoco') continue;
    const body = root ? childOf(root, 'worldbody') : undefined;
    const first = body ? childrenOf(body, 'body')[0] : undefined;
    const drive = has('drive.json') ? mujocoDrive(await text('drive.json'), root) : undefined;
    return { format: 'mujoco', modelName: root.attrs.model || p.replace(/\.xml$/, ''), entry: p, rootBody: first?.attrs.name ?? null, usd, ...(drive ? { drive } : {}) };
  }
  void text;
  return null;
}

/** Every element under `root`, depth first. */
function* walk(root: XmlElement): Generator<XmlElement> {
  yield root;
  for (const c of root.children) yield* walk(c);
}

const numberOf = (element: XmlElement | undefined, name: string): number | null => {
  const v = element && childOf(element, name)?.text;
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * The drive from the Gazebo plugin a URDF (inside `<gazebo>`) or an SDF model
 * carries: gz::sim's DiffDrive, AckermannSteering or MecanumDrive, with the
 * wheel geometry each one is given. `forward` is the robot frame's forward.
 */
export function gzDrive(root: XmlElement, forward: number): PackageDrive | undefined {
  const plugins = [...walk(root)].filter((e) => localName(e.name) === 'plugin');
  const named = (part: string) => plugins.find((p) => (p.attrs.name ?? '').includes(part) || (p.attrs.filename ?? '').includes(part));
  const radiusOf = (plugin: XmlElement) => numberOf(plugin, 'wheel_radius');
  // A wheel joint's velocity limit times the wheel's radius is the speed the package allows; the plugin's own cap wins when given.
  const jointLimit = Math.max(0, ...[...walk(root)].filter((e) => localName(e.name) === 'joint').map((j) => Number(childOf(j, 'limit')?.attrs.velocity ?? childOf(childOf(j, 'axis') ?? j, 'limit')?.children.find((c) => localName(c.name) === 'velocity')?.text ?? NaN)).filter(Number.isFinite));
  const speedOf = (plugin: XmlElement): number => numberOf(plugin, 'max_linear_velocity') ?? (jointLimit > 0 && radiusOf(plugin) ? jointLimit * radiusOf(plugin)! : 1);
  const diff = named('DiffDrive') ?? named('diff-drive');
  if (diff) {
    const speed = speedOf(diff);
    const separation = numberOf(diff, 'wheel_separation') ?? 0.5;
    return { model: 'differential', speed, turn: Math.min(6, (2 * speed) / separation), wheelbase: separation, forward };
  }
  const car = named('AckermannSteering') ?? named('ackermann');
  if (car) return { model: 'ackermann', speed: speedOf(car), turn: numberOf(car, 'steering_limit') ?? 0.5, wheelbase: numberOf(car, 'wheel_base') ?? 0.5, forward };
  const omni = named('MecanumDrive') ?? named('mecanum');
  if (omni) {
    const speed = speedOf(omni);
    return { model: 'holonomic', speed, turn: Math.min(6, (2 * speed) / (numberOf(omni, 'wheel_separation') ?? 0.5)), wheelbase: numberOf(omni, 'wheelbase') ?? 0.5, forward };
  }
  return undefined;
}

/** The drive from the `drive.json` a PlastikCAD MuJoCo package carries, with the top speed from the wheel motors' range. */
export function mujocoDrive(json: string, root: XmlElement): PackageDrive | undefined {
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const model = d.kind === 'ackermann' ? 'ackermann' : d.kind === 'mecanum' ? 'holonomic' : d.kind === 'differential' ? 'differential' : null;
  if (!model) return undefined;
  const n = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  const f = Array.isArray(d.forward) && d.forward.length >= 2 ? Math.atan2(Number(d.forward[1]), Number(d.forward[0])) : Math.PI / 2;
  const radius = n(d.wheelRadius, 0.05);
  // The fastest the motors may turn a wheel, from the actuators' ctrlrange.
  let rate = 0;
  for (const a of [...walk(root)].filter((e) => ['motor', 'velocity', 'general'].includes(localName(e.name)))) {
    const range = (a.attrs.ctrlrange ?? '').split(/\s+/).map(Number);
    if (range.length === 2 && Number.isFinite(range[1])) rate = Math.max(rate, Math.abs(range[1]));
  }
  const speed = rate > 0 ? rate * radius : 1;
  const separation = n(d.wheelSeparation, 0.5);
  if (model === 'ackermann') return { model, speed, turn: n(d.steeringLimit, 0.5), wheelbase: n(d.wheelBase, 0.5), forward: f };
  return { model, speed, turn: Math.min(6, (2 * speed) / separation), wheelbase: n(d.wheelBase, separation), forward: f };
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
