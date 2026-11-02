// Framework-agnostic three.js world view. Scene space is meters, Z up, with
// the ground at z=0. The viewer draws the world it is given and turns pointer
// input into edits (select, move) which it reports through callbacks; it never
// owns the world. The camera, its controls, the corner triad and the touch
// handling are lifted from PlastikCAD's viewer.
import {
  AmbientLight,
  Box3,
  Box3Helper,
  BufferAttribute,
  BufferGeometry,
  BoxGeometry,
  CanvasTexture,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  Group,
  HemisphereLight,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  MOUSE,
  NeutralToneMapping,
  Object3D,
  OrthographicCamera,
  PerspectiveCamera,
  Plane,
  PlaneGeometry,
  PMREMGenerator,
  Quaternion,
  Raycaster,
  RingGeometry,
  Scene,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { WebGLRenderTarget } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { MeshData } from '../io/export';
import { heightAt } from '../io/heightmap';
import { loadGlb, loadObj } from '../io/meshes';
import { quatOf } from '../model/math';
import type { LightKind, Pose, Terrain, Vec3, Zone } from '../model/types';
import { zoneMesh } from '../io/zones';

export type ViewPreset = 'iso' | 'top' | 'front' | 'side';

export interface ViewerOptions {
  theme: 'dark' | 'light';
  grid: boolean;
  /** Grid step that drags snap to, in meters; 0 = free. */
  snap: number;
  interactive: boolean;
}

/** What an item is drawn as. `key` names the loaded asset, shared by every item placed from it. */
export type Visual =
  | { kind: 'glb'; key: string; bytes: Uint8Array }
  | { kind: 'mesh'; key: string; data: MeshData }
  | { kind: 'robot'; key: string; parts: { obj: Uint8Array; mtl: Uint8Array | null; pose: Pose; scale: Vec3 }[] }
  | { kind: 'missing'; key: string }
  | { kind: 'light'; light: LightKind }
  | { kind: 'spawn' };

export interface ViewItem {
  id: string;
  name: string;
  pose: Pose;
  scale: number;
  selected: boolean;
  visual: Visual;
}

export interface ViewerEvents {
  /** A click picked an item (or nothing); `additive` with Shift or Ctrl held. */
  onSelect(id: string | null, additive: boolean): void;
  /** A drag begins; every `onMove` until `onGestureEnd` belongs to one edit. */
  onGestureStart(): void;
  /** How far the dragged item has moved since the gesture began, snapped. */
  onMove(id: string, delta: Vec3): void;
  onGestureEnd(canceled: boolean): void;
  /** Live measurement to show next to the pointer during a drag. */
  onReadout(text: string | null, clientX: number, clientY: number): void;
  /** While placing: a click on the ground, where the new thing goes. */
  onPlace(point: Vec3): void;
  /** Sculpting: a stroke begins on the ground at `point`; `onSculpt` follows at every move with the seconds since the last. */
  onSculptStart(point: Vec3): void;
  onSculpt(point: Vec3, dt: number): void;
  onSculptEnd(canceled: boolean): void;
  /** The zone tool: a rectangle dragged out on the ground, in the terrain's frame. */
  onZone(rect: [number, number, number, number]): void;
}

/** A surface zone as the viewer paints it: the zone, its colour, and whether it is picked. */
export interface ViewZone {
  zone: Zone;
  color: Vec3;
  selected: boolean;
}

const DEFAULTS: ViewerOptions = { theme: 'dark', grid: true, snap: 0.05, interactive: true };

const FOV = 35;
const FIT_MARGIN = 1.25;
const ANIMATION_MS = 250;
const MIN_PHI = 1e-3; // keeps the camera off the Z axis, where "up" is undefined
export const GIZMO_SIZE = 92;
const GIZMO_MARGIN = 8;
const EMPTY_RADIUS = 6;
const DRAG_THRESHOLD = 4; // px
const TOUCH_DRAG_THRESHOLD = 10; // px
const MARKER_SIZE = 0.35; // m

const VIEW_DIRECTIONS: Record<ViewPreset, Vector3> = {
  iso: new Vector3(1, -1.2, 0.9).normalize(),
  top: new Vector3(0, -Math.sin(MIN_PHI), Math.cos(MIN_PHI)),
  front: new Vector3(0, -1, 0),
  side: new Vector3(1, 0, 0),
};

const THEMES = {
  dark: { grid: 0x8a9a86, major: 0.3, minor: 0.1, accent: 0x19dc5a, ground: 0x2a3326, light: 0xffd166, stage: ['#283322', '#0b110a'] },
  light: { grid: 0x5f6b5c, major: 0.34, minor: 0.12, accent: 0x13a844, ground: 0xd9dfd2, light: 0xd98e04, stage: ['#ffffff', '#d1d9cc'] },
};

const AXIS_COLORS = ['#e5484d', '#3fae5a', '#4c8dff'];

interface Pose3 {
  theta: number; // azimuth from +X towards +Y
  phi: number; // angle from +Z
  distance: number;
  target: Vector3;
}

interface Animation {
  start: number;
  duration: number;
  from: Pose3;
  to: Pose3;
}

interface Drawn {
  item: ViewItem;
  /** The item's frame: its pose and scale, with the asset's object inside. */
  root: Group;
  /** The asset the body was cloned from, to tell a changed visual. */
  key: string;
  body: Object3D | null;
  box: Box3Helper | null;
}

type Drag =
  | { mode: 'pending'; id: string; x: number; y: number; plane: Plane; origin: Vector3; vertical: boolean }
  | { mode: 'move'; id: string; plane: Plane; origin: Vector3; vertical: boolean }
  | { mode: 'pending-clear'; x: number; y: number; additive: boolean }
  | { mode: 'place' }
  | { mode: 'sculpt'; last: number }
  | { mode: 'zone'; from: Vector3; to: Vector3 };

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

/** Triangles with vertex colours as a drawable object, flat shaded (the parts are boxes and cylinders). */
function meshObject(data: MeshData): Object3D {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(data.positions, 3));
  geometry.setIndex(new BufferAttribute(data.indices, 1));
  if (data.colors) geometry.setAttribute('color', new BufferAttribute(data.colors, 3));
  geometry.computeVertexNormals();
  const material = new MeshStandardMaterial({ vertexColors: !!data.colors, color: data.colors ? 0xffffff : 0x9a9a9a, roughness: 0.85, metalness: 0, flatShading: true });
  const group = new Group();
  group.add(new Mesh(geometry, material));
  return group;
}
const easeInOut = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const dragThreshold = (event: PointerEvent): number => (event.pointerType === 'touch' ? TOUCH_DRAG_THRESHOLD : DRAG_THRESHOLD);

function gridLines(halfX: number, halfY: number, step: number, skipStep: number): BufferGeometry {
  const pts: number[] = [];
  const nx = Math.round(halfX / step);
  const ny = Math.round(halfY / step);
  for (let i = -nx; i <= nx; i++) {
    if (skipStep && i % Math.round(skipStep / step) === 0) continue;
    const v = i * step;
    pts.push(v, -halfY, 0, v, halfY, 0);
  }
  for (let i = -ny; i <= ny; i++) {
    if (skipStep && i % Math.round(skipStep / step) === 0) continue;
    const v = i * step;
    pts.push(-halfX, v, 0, halfX, v, 0);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pts), 3));
  return g;
}

function canvasTexture(size: number, draw: (g: CanvasRenderingContext2D, size: number) => void): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');
  if (g) draw(g, size);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

function labelTexture(letter: string, color: string): CanvasTexture {
  return canvasTexture(64, (g, size) => {
    g.beginPath();
    g.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2);
    g.fillStyle = color;
    g.fill();
    g.font = 'bold 38px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#ffffff';
    g.fillText(letter, size / 2, size / 2 + 2);
  });
}

/** The pose as a matrix: translation, then roll, pitch, yaw about the fixed axes. */
export function poseMatrix(pose: Pose, scale = 1, out = new Matrix4()): Matrix4 {
  const [w, x, y, z] = quatOf(pose.rpy);
  out.makeRotationFromQuaternion(new Quaternion(x, y, z, w));
  out.scale(new Vector3(scale, scale, scale));
  out.setPosition(pose.xyz[0], pose.xyz[1], pose.xyz[2]);
  return out;
}

/** The marker of a light or a spawn point: a small solid in the theme's colour. */
function markerObject(visual: Extract<Visual, { kind: 'light' | 'spawn' }>, accent: number, light: number): Object3D {
  const group = new Group();
  if (visual.kind === 'spawn') {
    // An arrow along +X, the way a robot placed here faces.
    const material = new MeshBasicMaterial({ color: accent, toneMapped: false });
    const shaft = new Mesh(new CylinderGeometry(0.03, 0.03, MARKER_SIZE, 10), material);
    shaft.rotation.z = -Math.PI / 2;
    shaft.position.x = MARKER_SIZE / 2;
    const head = new Mesh(new ConeGeometry(0.08, 0.16, 14), material);
    head.rotation.z = -Math.PI / 2;
    head.position.x = MARKER_SIZE + 0.08;
    const base = new Mesh(new CylinderGeometry(0.12, 0.12, 0.01, 24), material);
    base.rotation.x = Math.PI / 2;
    group.add(shaft, head, base);
    return group;
  }
  const material = new MeshBasicMaterial({ color: light, toneMapped: false });
  if (visual.light === 'spot') {
    const cone = new Mesh(new ConeGeometry(0.12, 0.25, 16, 1, true), new MeshBasicMaterial({ color: light, toneMapped: false, side: DoubleSide, transparent: true, opacity: 0.8 }));
    cone.rotation.x = Math.PI / 2;
    cone.position.z = -0.125;
    group.add(cone);
  }
  const bulb = new Mesh(new SphereGeometry(visual.light === 'sun' ? 0.14 : 0.08, 16, 12), material);
  group.add(bulb);
  if (visual.light === 'sun') {
    // Rays around the disc, in the plane facing +Z.
    const rays = new Mesh(new CylinderGeometry(0.22, 0.22, 0.01, 8, 1, true), new MeshBasicMaterial({ color: light, toneMapped: false, side: DoubleSide, wireframe: true }));
    rays.rotation.x = Math.PI / 2;
    group.add(rays);
  }
  return group;
}

/** A stand-in for an asset whose file could not be read: a wire box. */
function missingObject(accent: number): Object3D {
  const mesh = new Mesh(new BoxGeometry(0.3, 0.3, 0.3), new MeshBasicMaterial({ color: accent, wireframe: true, toneMapped: false }));
  mesh.position.z = 0.15;
  return mesh;
}

function disposeObject(object: Object3D): void {
  object.traverse((o) => {
    if (o instanceof Mesh || o instanceof LineSegments || o instanceof Sprite) {
      (o as Mesh).geometry?.dispose();
      const material = (o as Mesh).material;
      for (const m of Array.isArray(material) ? material : [material]) m?.dispose();
    }
  });
}

export class Viewer {
  private readonly container: HTMLElement;
  private readonly events: ViewerEvents;
  private options: ViewerOptions;
  private ok = false;
  private disposed = false;
  private raf = 0;
  private width = 0;
  private height = 0;

  private renderer!: WebGLRenderer;
  private scene!: Scene;
  private camera!: PerspectiveCamera;
  private controls!: OrbitControls;
  private resizeObserver!: ResizeObserver;
  private environment!: WebGLRenderTarget;

  private items: ViewItem[] = [];
  private drawn = new Map<string, Drawn>();
  /** Loaded assets by key, shared by the items placed from them; a cloned body each. */
  private assets = new Map<string, { object: Object3D | null; loading: Promise<Object3D> }>();
  private readonly center = new Vector3();
  private radius = EMPTY_RADIUS;
  private reach: [number, number] = [0, 0];

  private gridMajor!: LineSegments<BufferGeometry, LineBasicMaterial>;
  private gridMinor!: LineSegments<BufferGeometry, LineBasicMaterial>;
  private axes!: LineSegments<BufferGeometry, LineBasicMaterial>;
  private gridHalf: [number, number] = [0, 0];
  private gridStep = 0;
  private ground: Mesh<BufferGeometry, MeshStandardMaterial> | null = null;
  private terrain: Terrain | null = null;
  private zones: ViewZone[] = [];
  private zonesKey = '';
  private zoneMeshes: Mesh<BufferGeometry, MeshBasicMaterial>[] = [];
  /** The rectangle being dragged out with the zone tool. */
  private zoneDraft: Mesh<BufferGeometry, MeshBasicMaterial> | null = null;
  private zoneTool = false;
  private terrainKey = '';

  private triadScene!: Scene;
  private triadCamera!: OrthographicCamera;
  private triadOrigin = { x: GIZMO_MARGIN, y: GIZMO_MARGIN };
  private disposables: { dispose(): void }[] = [];

  private readonly raycaster = new Raycaster();
  private readonly pointer = new Vector2();
  private drag: Drag | null = null;
  private dragPointer = -1;
  private placing = false;
  /** The brush radius while sculpting, or null. */
  private sculpting: number | null = null;
  /** The ring showing the brush on the ground. */
  private brushRing: Mesh<RingGeometry, MeshBasicMaterial> | null = null;
  private lastHeights: Float32Array | null = null;
  private lastZoneHeights: Float32Array | null = null;
  private animation: Animation | null = null;
  private fallback: HTMLElement | null = null;

  constructor(container: HTMLElement, events: ViewerEvents, options: Partial<ViewerOptions> = {}) {
    this.container = container;
    this.events = events;
    this.options = { ...DEFAULTS, ...options };
    try {
      this.init();
      this.ok = true;
    } catch (err) {
      console.warn('3D view unavailable:', err);
      this.showFallback();
      return;
    }
    this.onResize();
    this.applyPose(this.poseFor(VIEW_DIRECTIONS.iso));
    this.requestRender();
  }

  /** The world to draw. Cheap to call often: only what changed is touched. */
  setItems(items: ViewItem[], terrain: Terrain, zones: ViewZone[] = []): void {
    this.items = items;
    this.terrain = terrain;
    this.zones = zones;
    if (!this.ok || this.disposed) return;
    this.sync();
    this.syncZones();
    this.requestRender();
  }

  /** The zone tool: a drag on the ground draws a rectangle. */
  setZoneTool(on: boolean): void {
    this.zoneTool = on;
    if (!this.ok) return;
    this.renderer.domElement.style.cursor = on ? 'crosshair' : this.sculpting !== null ? 'crosshair' : this.placing ? 'copy' : '';
  }

  /** The zones painted over the ground: a patch of its cells each, in the material's colour, redrawn when a zone or the heights change. */
  private syncZones(): void {
    const t = this.terrain;
    const key = t ? this.zones.map((z) => `${z.zone.id}:${z.zone.rect.join(',')}:${z.color.join(',')}:${z.selected ? 1 : 0}`).join('|') + `#${this.terrainKey}` : '';
    const heightsChanged = t?.kind === 'heightmap' && t.heights !== this.lastZoneHeights;
    if (key === this.zonesKey && !heightsChanged) return;
    this.zonesKey = key;
    this.lastZoneHeights = t?.kind === 'heightmap' ? t.heights : null;
    for (const m of this.zoneMeshes) {
      this.scene.remove(m);
      m.geometry.dispose();
      m.material.dispose();
    }
    this.zoneMeshes = [];
    if (!t) return;
    for (const { zone, color, selected } of this.zones) {
      const data = zoneMesh(t, zone, 0.03);
      if (!data) continue;
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(data.positions, 3));
      geometry.setIndex(new BufferAttribute(data.indices, 1));
      const material = new MeshBasicMaterial({ color: new Color(color[0], color[1], color[2]), transparent: true, opacity: selected ? 0.75 : 0.5, side: DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
      const mesh = new Mesh(geometry, material);
      mesh.renderOrder = 1;
      this.scene.add(mesh);
      this.zoneMeshes.push(mesh);
    }
  }

  /** The rectangle the zone tool is dragging out, flat at the ground's height under its corners. */
  private drawZoneDraft(from: Vector3, to: Vector3): void {
    if (!this.zoneDraft) {
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(new Float32Array(12), 3));
      geometry.setIndex([0, 1, 2, 0, 2, 3]);
      this.zoneDraft = new Mesh(geometry, new MeshBasicMaterial({ color: THEMES[this.options.theme].accent, transparent: true, opacity: 0.35, side: DoubleSide, depthTest: false }));
      this.zoneDraft.renderOrder = 11;
      this.scene.add(this.zoneDraft);
      this.disposables.push(this.zoneDraft.geometry, this.zoneDraft.material);
    }
    const t = this.terrain;
    const z = (x: number, y: number) => (t ? heightAt(t, x, y) : 0) + 0.05;
    const x0 = Math.min(from.x, to.x), x1 = Math.max(from.x, to.x), y0 = Math.min(from.y, to.y), y1 = Math.max(from.y, to.y);
    const pos = this.zoneDraft.geometry.getAttribute('position') as BufferAttribute;
    pos.setXYZ(0, x0, y0, z(x0, y0));
    pos.setXYZ(1, x1, y0, z(x1, y0));
    pos.setXYZ(2, x1, y1, z(x1, y1));
    pos.setXYZ(3, x0, y1, z(x0, y1));
    pos.needsUpdate = true;
    this.zoneDraft.visible = true;
    this.requestRender();
  }

  setOptions(options: Partial<ViewerOptions>): void {
    this.options = { ...this.options, ...options };
    if (!this.ok || this.disposed) return;
    this.applyOptions();
    this.requestRender();
  }

  setPlacing(placing: boolean): void {
    this.placing = placing;
    if (this.ok) this.renderer.domElement.style.cursor = placing ? 'copy' : '';
  }

  /** Sculpting with a brush of this radius (meters), or not. */
  setSculpt(radius: number | null): void {
    this.sculpting = radius;
    if (!this.ok) return;
    this.renderer.domElement.style.cursor = radius !== null ? 'crosshair' : this.placing ? 'copy' : '';
    if (radius === null && this.brushRing) this.brushRing.visible = false;
    if (radius !== null) this.placeRing(null, radius);
    this.requestRender();
  }

  /**
   * The ground's heights changed in place (a stroke under way): the mesh's
   * vertices in the window are moved, no rebuild. The whole grid when the
   * window is omitted.
   */
  refreshHeights(window?: { r0: number; r1: number; c0: number; c1: number }): void {
    const t = this.terrain;
    if (!this.ground || !t || t.kind !== 'heightmap') return;
    const pos = this.ground.geometry.getAttribute('position') as BufferAttribute;
    const { rows, cols, heights } = t;
    const r0 = window?.r0 ?? 0, r1 = window?.r1 ?? rows - 1, c0 = window?.c0 ?? 0, c1 = window?.c1 ?? cols - 1;
    // A PlaneGeometry's vertices run from +Y down; the grid's rows run from -Y up.
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) pos.setZ((rows - 1 - r) * cols + c, heights[r * cols + c]);
    pos.needsUpdate = true;
    this.ground.geometry.computeBoundingSphere();
    this.requestRender();
  }

  /** The brush ring on the ground at a point (or where it last was). */
  private placeRing(point: Vector3 | null, radius = this.sculpting ?? 1): void {
    if (!this.brushRing) {
      const ring = new Mesh(new RingGeometry(0.92, 1, 64), new MeshBasicMaterial({ color: THEMES[this.options.theme].accent, transparent: true, opacity: 0.85, depthTest: false, side: DoubleSide }));
      ring.renderOrder = 10;
      this.brushRing = ring;
      this.scene.add(ring);
      this.disposables.push(ring.geometry, ring.material);
    }
    const ring = this.brushRing;
    ring.scale.set(radius, radius, 1);
    if (point) ring.position.copy(point).setZ(point.z + 0.02);
    ring.visible = point !== null || ring.visible;
  }

  setTriadOrigin(x: number, y: number): void {
    this.triadOrigin = { x, y };
    this.requestRender();
  }

  setView(preset: ViewPreset): void {
    if (!this.ok || this.disposed) return;
    this.animateTo(this.poseFor(VIEW_DIRECTIONS[preset]));
  }

  /** Frame the selection, or everything when nothing is selected. */
  fit(immediate = false): void {
    if (!this.ok || this.disposed) return;
    const picked = this.items.filter((i) => i.selected);
    const { center, radius } = picked.length ? this.extent(picked) : this.extent(this.items, true);
    const pose = this.currentPose();
    pose.distance = this.fitDistance(radius);
    pose.target.copy(center);
    if (immediate) {
      this.animation = null;
      this.controls.enabled = true;
      this.applyPose(pose);
      this.requestRender();
    } else {
      this.animateTo(pose);
    }
  }

  /** Abandon the drag in progress, if any. Returns whether there was one. */
  cancelGesture(): boolean {
    const drag = this.drag;
    if (!drag) return false;
    this.drag = null;
    this.events.onReadout(null, 0, 0);
    if (drag.mode === 'move') this.events.onGestureEnd(true);
    if (drag.mode === 'sculpt') this.events.onSculptEnd(true);
    if (drag.mode === 'zone' && this.zoneDraft) this.zoneDraft.visible = false;
    this.controls.enabled = true;
    this.requestRender();
    return true;
  }

  dispose(): void {
    this.disposed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.fallback?.remove();
    if (!this.ok) return;
    this.resizeObserver.disconnect();
    this.controls.dispose();
    for (const d of this.drawn.values()) this.discard(d);
    for (const a of this.assets.values()) if (a.object) disposeObject(a.object);
    if (this.ground) disposeObject(this.ground);
    this.gridMajor.geometry.dispose();
    this.gridMinor.geometry.dispose();
    this.axes.geometry.dispose();
    for (const d of this.disposables) d.dispose();
    this.environment.dispose();
    const canvas = this.renderer.domElement;
    canvas.removeEventListener('pointerdown', this.onPointerDown, true);
    canvas.removeEventListener('pointermove', this.onPointerMove);
    canvas.removeEventListener('pointerup', this.onPointerUp);
    canvas.removeEventListener('pointercancel', this.onPointerUp);
    this.renderer.dispose();
    canvas.remove();
  }

  // --- setup ----------------------------------------------------------------

  private init(): void {
    const renderer = new WebGLRenderer({ antialias: true, alpha: true });
    this.renderer = renderer;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.toneMapping = NeutralToneMapping;
    renderer.toneMappingExposure = 1;

    const canvas = renderer.domElement;
    Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', display: 'block', touchAction: 'none' });
    if (getComputedStyle(this.container).position === 'static') this.container.style.position = 'relative';
    this.container.appendChild(canvas);
    canvas.addEventListener('webglcontextlost', (event) => event.preventDefault());
    canvas.addEventListener('webglcontextrestored', this.requestRender);

    const scene = new Scene();
    this.scene = scene;
    const pmrem = new PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    this.environment = pmrem.fromScene(room, 0.04);
    room.dispose();
    pmrem.dispose();
    scene.environment = this.environment.texture;
    scene.environmentIntensity = 0.5;
    // RoomEnvironment is Y-up; turn its ceiling lights towards +Z.
    scene.environmentRotation.set(Math.PI / 2, 0, 0);

    const camera = new PerspectiveCamera(FOV, 1, 0.01, 1000);
    this.camera = camera;
    camera.up.set(0, 0, 1); // must be set before OrbitControls is created
    scene.add(camera);

    scene.add(new AmbientLight(0xffffff, 0.25));
    const fill = new HemisphereLight(0xffffff, 0x444b57, 0.8);
    fill.position.set(0, 0, 1);
    scene.add(fill);
    // The key light rides with the camera (from over the viewer's left shoulder).
    const key = new DirectionalLight(0xffffff, 2);
    key.position.set(-0.6, 0.9, 1);
    camera.add(key);
    camera.add(key.target);

    const lineMaterial = () => new LineBasicMaterial({ transparent: true, depthWrite: false });
    this.gridMajor = new LineSegments(new BufferGeometry(), lineMaterial());
    this.gridMinor = new LineSegments(new BufferGeometry(), lineMaterial());
    const axes = new BufferGeometry();
    axes.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0]), 3));
    const tint = [...new Color(AXIS_COLORS[0]).toArray(), ...new Color(AXIS_COLORS[0]).toArray(), ...new Color(AXIS_COLORS[1]).toArray(), ...new Color(AXIS_COLORS[1]).toArray()];
    axes.setAttribute('color', new BufferAttribute(new Float32Array(tint), 3));
    this.axes = new LineSegments(axes, new LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.75, depthWrite: false }));
    this.gridMajor.renderOrder = this.gridMinor.renderOrder = this.axes.renderOrder = 1;
    scene.add(this.gridMinor, this.gridMajor, this.axes);

    this.initTriad();

    const controls = new OrbitControls(camera, canvas);
    this.controls = controls;
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    controls.rotateSpeed = 0.9;
    // The left button edits; the camera is on the other two (as in Tinkercad and PlastikCAD).
    controls.mouseButtons = { LEFT: -1 as MOUSE, MIDDLE: MOUSE.PAN, RIGHT: MOUSE.ROTATE };
    controls.addEventListener('change', this.requestRender);

    // Captured, so that an edit can start before OrbitControls sees the press: a finger on an
    // object must not also turn the camera, as a finger on empty space does.
    canvas.addEventListener('pointerdown', this.onPointerDown, true);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerUp);

    this.applyOptions();
    this.updateGrid();

    this.resizeObserver = new ResizeObserver(() => this.onResize());
    this.resizeObserver.observe(this.container);
  }

  private initTriad(): void {
    this.triadScene = new Scene();
    const e = 1.5;
    this.triadCamera = new OrthographicCamera(-e, e, e, -e, 0.1, 10);
    const shaft = new CylinderGeometry(0.045, 0.045, 1, 10);
    this.disposables.push(shaft);
    const dirs = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)];
    ['X', 'Y', 'Z'].forEach((label, i) => {
      const color = AXIS_COLORS[i];
      const material = new MeshBasicMaterial({ color, toneMapped: false });
      const mesh = new Mesh(shaft, material);
      mesh.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), dirs[i]);
      mesh.position.copy(dirs[i]).multiplyScalar(0.5);
      const map = labelTexture(label, color);
      const spriteMaterial = new SpriteMaterial({ map, toneMapped: false });
      const sprite = new Sprite(spriteMaterial);
      sprite.scale.setScalar(0.52);
      sprite.position.copy(dirs[i]).multiplyScalar(1.16);
      this.triadScene.add(mesh, sprite);
      this.disposables.push(material, map, spriteMaterial);
    });
  }

  private showFallback(): void {
    const el = document.createElement('div');
    el.className = 'viewer-fallback';
    el.textContent = 'The 3D view needs WebGL, which this window does not provide.';
    this.container.appendChild(el);
    this.fallback = el;
  }

  // --- the scene ------------------------------------------------------------

  private applyOptions(): void {
    const { theme, grid } = this.options;
    const t = THEMES[theme];
    this.gridMajor.material.color.set(t.grid);
    this.gridMajor.material.opacity = t.major;
    this.gridMinor.material.color.set(t.grid);
    this.gridMinor.material.opacity = t.minor;
    this.gridMajor.visible = this.gridMinor.visible = this.axes.visible = grid;
    if (this.ground) this.ground.material.color.set(t.ground);
    for (const d of this.drawn.values()) {
      if (d.box) (d.box.material as LineBasicMaterial).color.set(t.accent);
      // Markers carry the theme colour, so they are remade.
      if (d.item.visual.kind === 'light' || d.item.visual.kind === 'spawn' || d.item.visual.kind === 'missing') d.key = '';
    }
    this.sync();
  }

  private sync(): void {
    const seen = new Set<string>();
    for (const item of this.items) {
      seen.add(item.id);
      let d = this.drawn.get(item.id);
      if (!d) {
        const root = new Group();
        root.userData.itemId = item.id;
        root.matrixAutoUpdate = false;
        this.scene.add(root);
        d = { item, root, key: '', body: null, box: null };
        this.drawn.set(item.id, d);
      }
      d.item = item;
      this.place(d);
      this.body(d);
      this.style(d);
    }
    for (const [id, d] of this.drawn) {
      if (!seen.has(id)) {
        this.discard(d);
        this.drawn.delete(id);
      }
    }
    this.syncTerrain();
    const { center, radius, reach } = this.extent(this.items);
    this.center.copy(center);
    this.radius = radius;
    this.reach = reach;
    this.updateGrid();
  }

  private place(d: Drawn): void {
    poseMatrix(d.item.pose, d.item.scale, d.root.matrix);
    d.root.matrixWorldNeedsUpdate = true;
  }

  /** What the item is drawn as, loaded on demand and shared by key. */
  private body(d: Drawn): void {
    const visual = d.item.visual;
    const t = THEMES[this.options.theme];
    const key = visual.kind === 'light' ? `light:${visual.light}:${this.options.theme}` : visual.kind === 'spawn' ? `spawn:${this.options.theme}` : visual.kind === 'missing' ? `missing:${this.options.theme}` : visual.key;
    if (d.key === key && d.body) return;
    if (d.body) {
      d.root.remove(d.body);
      d.body = null;
    }
    d.key = key;
    if (visual.kind === 'light' || visual.kind === 'spawn') {
      d.body = markerObject(visual, t.accent, t.light);
      d.root.add(d.body);
      return;
    }
    if (visual.kind === 'missing') {
      d.body = missingObject(t.accent);
      d.root.add(d.body);
      return;
    }
    let asset = this.assets.get(key);
    if (!asset) {
      const loading = (visual.kind === 'glb' ? loadGlb(visual.bytes) : visual.kind === 'mesh' ? Promise.resolve(meshObject(visual.data)) : Promise.resolve(this.robotObject(visual.parts))).catch((err) => {
        console.warn(`Could not load ${d.item.name}:`, err);
        return missingObject(t.accent);
      });
      asset = { object: null, loading };
      this.assets.set(key, asset);
      loading.then((object) => {
        if (this.disposed) return;
        asset!.object = object;
        for (const other of this.drawn.values()) if (other.key === key && !other.body) this.body(other);
        this.sync();
        this.requestRender();
      });
    }
    if (asset.object) {
      d.body = asset.object.clone();
      d.root.add(d.body);
    }
  }

  private robotObject(parts: Extract<Visual, { kind: 'robot' }>['parts']): Object3D {
    const group = new Group();
    for (const part of parts) {
      const object = loadObj(part.obj, part.mtl);
      object.applyMatrix4(poseMatrix(part.pose).scale(new Vector3(...part.scale)));
      group.add(object);
    }
    return group;
  }

  private style(d: Drawn): void {
    const t = THEMES[this.options.theme];
    if (d.item.selected) {
      if (!d.box) {
        d.box = new Box3Helper(new Box3(), t.accent);
        d.box.renderOrder = 2;
        this.scene.add(d.box);
      }
      d.root.updateMatrixWorld(true);
      const box = new Box3().setFromObject(d.root);
      if (box.isEmpty()) box.setFromCenterAndSize(new Vector3(...d.item.pose.xyz), new Vector3(0.2, 0.2, 0.2));
      d.box.box.copy(box.expandByScalar(0.02));
      d.box.visible = true;
    } else if (d.box) {
      d.box.visible = false;
    }
  }

  private discard(d: Drawn): void {
    this.scene.remove(d.root);
    if (d.box) {
      this.scene.remove(d.box);
      d.box.geometry.dispose();
      (d.box.material as LineBasicMaterial).dispose();
    }
  }

  private syncTerrain(): void {
    const terrain = this.terrain;
    // Everything but the heights goes in the key; the heights are a buffer of their own, compared by identity.
    const key = terrain ? [terrain.kind, terrain.size.join(','), terrain.kind === 'heightmap' ? `${terrain.rows}x${terrain.cols}` : ''].join('|') : '';
    if (key === this.terrainKey) {
      if (terrain?.kind === 'heightmap' && terrain.heights !== this.lastHeights) {
        this.lastHeights = terrain.heights;
        this.refreshHeights();
      }
      return;
    }
    this.terrainKey = key;
    this.lastHeights = terrain?.kind === 'heightmap' ? terrain.heights : null;
    if (this.ground) {
      this.scene.remove(this.ground);
      disposeObject(this.ground);
      this.ground = null;
    }
    if (!terrain) return;
    const t = THEMES[this.options.theme];
    const material = new MeshStandardMaterial({ color: t.ground, roughness: 0.95, metalness: 0, flatShading: terrain.kind === 'heightmap', side: DoubleSide, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 });
    let geometry: PlaneGeometry;
    if (terrain.kind === 'heightmap') {
      const { rows, cols, heights, size } = terrain;
      geometry = new PlaneGeometry(size[0], size[1], cols - 1, rows - 1);
      const pos = geometry.getAttribute('position') as BufferAttribute;
      for (let v = 0; v < pos.count; v++) {
        // Rows run along Y from -Y in the world; a PlaneGeometry's vertices run from +Y down.
        const j = Math.round((pos.getX(v) / size[0] + 0.5) * (cols - 1));
        const i = Math.round((pos.getY(v) / size[1] + 0.5) * (rows - 1));
        pos.setZ(v, heights[i * cols + j]);
      }
      geometry.computeVertexNormals();
    } else {
      geometry = new PlaneGeometry(terrain.size[0], terrain.size[1]);
    }
    this.ground = new Mesh(geometry, material);
    this.ground.renderOrder = -1;
    this.scene.add(this.ground);
  }

  private extent(items: ViewItem[], withGround = false): { center: Vector3; radius: number; reach: [number, number] } {
    const box = new Box3();
    for (const item of items) {
      const d = this.drawn.get(item.id);
      if (d?.body) {
        d.root.updateMatrixWorld(true);
        box.expandByObject(d.root);
      } else box.expandByPoint(new Vector3(...item.pose.xyz));
    }
    const terrain = this.terrain;
    const reach: [number, number] = [terrain ? terrain.size[0] / 2 : 0, terrain ? terrain.size[1] / 2 : 0];
    if (terrain && withGround) {
      // The ground is part of the world to fit, or a world of one light would be looked at from the light.
      let lo = 0, hi = 0;
      if (terrain.kind === 'heightmap') {
        lo = Infinity;
        hi = -Infinity;
        for (const h of terrain.heights) {
          if (h < lo) lo = h;
          if (h > hi) hi = h;
        }
      }
      box.expandByPoint(new Vector3(-reach[0], -reach[1], lo));
      box.expandByPoint(new Vector3(reach[0], reach[1], hi));
    }
    if (box.isEmpty()) {
      if (terrain) return { center: new Vector3(0, 0, 0), radius: Math.max(Math.hypot(...terrain.size) / 2, 1), reach };
      return { center: new Vector3(0, 0, 0), radius: EMPTY_RADIUS, reach };
    }
    reach[0] = Math.max(reach[0], Math.abs(box.min.x), Math.abs(box.max.x));
    reach[1] = Math.max(reach[1], Math.abs(box.min.y), Math.abs(box.max.y));
    return { center: box.getCenter(new Vector3()), radius: Math.max(box.min.distanceTo(box.max) / 2, 0.5), reach };
  }

  /** The grid on the ground: meters, centred on the origin, growing with the world. */
  private updateGrid(): void {
    const wanted: [number, number] = [Math.max(this.reach[0] * 1.2, 5), Math.max(this.reach[1] * 1.2, 5)];
    const biggest = Math.max(...wanted);
    const major = biggest <= 15 ? 1 : biggest <= 150 ? 10 : 100;
    const half: [number, number] = [Math.ceil(wanted[0] / major) * major, Math.ceil(wanted[1] / major) * major];
    if (half[0] === this.gridHalf[0] && half[1] === this.gridHalf[1] && major === this.gridStep) return;
    this.gridHalf = half;
    this.gridStep = major;
    this.gridMajor.geometry.dispose();
    this.gridMinor.geometry.dispose();
    this.gridMajor.geometry = gridLines(half[0], half[1], major, 0);
    this.gridMinor.geometry = gridLines(half[0], half[1], major / 10, major);
    this.axes.scale.set(half[0], half[1], 1);
  }

  // --- picking and dragging -------------------------------------------------

  private setRay(event: PointerEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
  }

  private pickItem(): { item: ViewItem; point: Vector3 } | null {
    const roots = [...this.drawn.values()].filter((d) => d.body).map((d) => d.root);
    const hits = this.raycaster.intersectObjects(roots, true);
    for (const hit of hits) {
      let o: Object3D | null = hit.object;
      while (o && !o.userData.itemId) o = o.parent;
      if (!o) continue;
      const item = this.items.find((i) => i.id === o!.userData.itemId);
      if (item) return { item, point: hit.point };
    }
    return null;
  }

  /**
   * Where the ray meets the ground: the z = 0 plane, or the terrain, found by
   * marching the ray over the heights (a heightmap of a million triangles is
   * no place for the raycaster) and bisecting the step that crossed it.
   */
  private groundPoint(): Vector3 | null {
    const ray = this.raycaster.ray;
    const t = this.terrain;
    const point = new Vector3();
    if (!t || t.kind !== 'heightmap') return ray.intersectPlane(new Plane(new Vector3(0, 0, 1), 0), point);
    let lo = Infinity, hi = -Infinity;
    for (const h of t.heights) {
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
    const at = (s: number) => point.copy(ray.direction).multiplyScalar(s).add(ray.origin);
    const above = (s: number) => at(s).z - heightAt(t, point.x, point.y) > 0 || Math.abs(point.x) > t.size[0] / 2 || Math.abs(point.y) > t.size[1] / 2;
    // From where the ray passes the highest sample to where it passes the lowest.
    const dz = ray.direction.z;
    if (Math.abs(dz) < 1e-6) return null;
    const start = Math.max(0, (hi + 0.01 - ray.origin.z) / dz), end = (lo - 0.01 - ray.origin.z) / dz;
    if (end <= start) return null;
    const step = Math.max(0.05, Math.min(t.size[0] / (t.cols - 1), t.size[1] / (t.rows - 1)) / 2);
    let s0 = start;
    if (!above(s0)) return ray.intersectPlane(new Plane(new Vector3(0, 0, 1), heightAt(t, at(s0).x, at(s0).y)), point);
    for (let s = start + step; s <= end + step; s += step) {
      if (above(s)) {
        s0 = s;
        continue;
      }
      let a = s0, b = s;
      for (let i = 0; i < 12; i++) {
        const m = (a + b) / 2;
        if (above(m)) a = m;
        else b = m;
      }
      return at((a + b) / 2);
    }
    return null;
  }

  private snap(v: number): number {
    const step = this.options.snap;
    return step > 0 ? Math.round(v / step) * step : v;
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (this.drag) {
      // A second finger during an edit is neither ours nor the camera's.
      if (event.pointerId !== this.dragPointer) event.stopImmediatePropagation();
      return;
    }
    if (event.button !== 0) return;
    this.animation = null;
    this.controls.enabled = true;
    const canvas = this.renderer.domElement;
    this.setRay(event);
    const claim = () => {
      event.stopImmediatePropagation();
      canvas.setPointerCapture(event.pointerId);
      this.dragPointer = event.pointerId;
    };
    if (this.placing) {
      this.drag = { mode: 'place' };
      claim();
      return;
    }
    if (this.zoneTool) {
      const point = this.groundPoint();
      if (!point) return;
      claim();
      this.controls.enabled = false;
      this.drag = { mode: 'zone', from: point.clone(), to: point.clone() };
      this.drawZoneDraft(point, point);
      return;
    }
    if (this.sculpting !== null) {
      // One finger or the left button sculpts; the camera keeps the other buttons and a second finger.
      const point = this.groundPoint();
      if (!point) return;
      claim();
      this.controls.enabled = false;
      this.drag = { mode: 'sculpt', last: event.timeStamp };
      this.placeRing(point);
      this.events.onSculptStart([point.x, point.y, point.z]);
      return;
    }
    if (!this.options.interactive) return;
    const hit = this.pickItem();
    const additive = event.shiftKey || event.ctrlKey || event.metaKey;
    if (!hit) {
      // Empty space: a click clears the selection; a finger turns the camera (OrbitControls takes
      // it from here) unless it lifts without moving.
      this.drag = { mode: 'pending-clear', x: event.clientX, y: event.clientY, additive };
      if (event.pointerType !== 'touch') claim();
      return;
    }
    claim();
    const { item, point } = hit;
    if (additive) {
      this.events.onSelect(item.id, true);
      return;
    }
    if (!item.selected) this.events.onSelect(item.id, false);
    // Alt drags straight up and down, on a vertical plane facing the camera through the hit point.
    const vertical = event.altKey;
    const normal = vertical ? this.camera.getWorldDirection(new Vector3()).setZ(0).normalize() : new Vector3(0, 0, 1);
    if (vertical && normal.lengthSq() === 0) normal.set(0, 1, 0);
    this.drag = { mode: 'pending', id: item.id, x: event.clientX, y: event.clientY, plane: new Plane().setFromNormalAndCoplanarPoint(normal, point), origin: point.clone(), vertical };
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (this.drag && event.pointerId !== this.dragPointer && this.drag.mode !== 'pending-clear') return;
    this.setRay(event);
    const drag = this.drag;
    if (!drag) {
      if (this.sculpting !== null) {
        const point = this.groundPoint();
        if (point) this.placeRing(point);
        else if (this.brushRing) this.brushRing.visible = false;
        this.requestRender();
        return;
      }
      if (event.buttons === 0 && this.options.interactive && !this.placing) this.renderer.domElement.style.cursor = this.pickItem() ? 'move' : '';
      return;
    }
    switch (drag.mode) {
      case 'place':
      case 'pending-clear':
        return;
      case 'zone': {
        const point = this.groundPoint();
        if (!point) return;
        drag.to.copy(point);
        this.drawZoneDraft(drag.from, drag.to);
        this.events.onReadout(`${Math.abs(drag.to.x - drag.from.x).toFixed(2)} × ${Math.abs(drag.to.y - drag.from.y).toFixed(2)} m`, event.clientX, event.clientY);
        return;
      }
      case 'sculpt': {
        const point = this.groundPoint();
        const dt = Math.min(0.1, (event.timeStamp - drag.last) / 1000);
        drag.last = event.timeStamp;
        if (!point) return;
        this.placeRing(point);
        this.events.onSculpt([point.x, point.y, point.z], dt);
        return;
      }
      case 'pending': {
        if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < dragThreshold(event)) return;
        this.drag = { mode: 'move', id: drag.id, plane: drag.plane, origin: drag.origin, vertical: drag.vertical };
        this.controls.enabled = false;
        this.renderer.domElement.style.cursor = 'move';
        this.events.onGestureStart();
        this.moveTo(this.drag, event);
        return;
      }
      case 'move':
        this.moveTo(drag, event);
        return;
    }
  };

  private moveTo(drag: Extract<Drag, { mode: 'move' }>, event: PointerEvent): void {
    const point = new Vector3();
    if (!this.raycaster.ray.intersectPlane(drag.plane, point)) return;
    const item = this.items.find((i) => i.id === drag.id);
    if (!item) return;
    const raw = point.clone().sub(drag.origin);
    if (drag.vertical) raw.setX(0).setY(0);
    else raw.setZ(0);
    // Snap where the item lands, not the delta, so it sits on the grid.
    const delta: Vec3 = [0, 1, 2].map((k) => {
      const axis = k === 0 ? raw.x : k === 1 ? raw.y : raw.z;
      return this.snap(item.pose.xyz[k] + axis) - item.pose.xyz[k];
    }) as Vec3;
    this.events.onMove(drag.id, delta);
    const target = item.pose.xyz.map((v, k) => v + delta[k]);
    this.events.onReadout(drag.vertical ? `z ${target[2].toFixed(3)} m` : `x ${target[0].toFixed(3)}  y ${target[1].toFixed(3)} m`, event.clientX, event.clientY);
  }

  private readonly onPointerUp = (event: PointerEvent): void => {
    const drag = this.drag;
    if (!drag) return;
    if (drag.mode !== 'pending-clear' && event.pointerId !== this.dragPointer) return;
    this.drag = null;
    const canvas = this.renderer.domElement;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    canvas.style.cursor = this.placing ? 'copy' : '';
    this.controls.enabled = true;
    this.events.onReadout(null, 0, 0);
    switch (drag.mode) {
      case 'place':
        if (event.type === 'pointerup') {
          this.setRay(event);
          const point = this.groundPoint();
          if (point) this.events.onPlace([this.snap(point.x), this.snap(point.y), point.z]);
        }
        return;
      case 'pending-clear':
        if (event.type === 'pointerup' && !drag.additive && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < dragThreshold(event)) this.events.onSelect(null, false);
        return;
      case 'pending':
        return;
      case 'move':
        this.events.onGestureEnd(event.type === 'pointercancel');
        return;
      case 'sculpt':
        this.events.onSculptEnd(event.type === 'pointercancel');
        return;
      case 'zone':
        if (this.zoneDraft) this.zoneDraft.visible = false;
        if (event.type === 'pointerup') this.events.onZone([this.snap(drag.from.x), this.snap(drag.from.y), this.snap(drag.to.x), this.snap(drag.to.y)]);
        this.requestRender();
    }
  };

  // --- the camera -------------------------------------------------------------

  private fitDistance(radius = this.radius, aspect = this.width && this.height ? this.width / this.height : 1): number {
    const vHalf = (FOV * Math.PI) / 360;
    const hHalf = Math.atan(Math.tan(vHalf) * aspect);
    return (radius / Math.sin(Math.min(vHalf, hHalf))) * FIT_MARGIN;
  }

  private poseFor(direction: Vector3): Pose3 {
    return { theta: Math.atan2(direction.y, direction.x), phi: Math.acos(clamp(direction.z, -1, 1)), distance: this.fitDistance(), target: this.center.clone() };
  }

  private currentPose(): Pose3 {
    const target = this.controls.target.clone();
    const offset = this.camera.position.clone().sub(target);
    const distance = Math.max(offset.length(), 1e-6);
    return { theta: Math.atan2(offset.y, offset.x), phi: Math.acos(clamp(offset.z / distance, -1, 1)), distance, target };
  }

  private applyPose(pose: Pose3): void {
    const phi = clamp(pose.phi, MIN_PHI, Math.PI - MIN_PHI);
    const s = Math.sin(phi) * pose.distance;
    this.controls.target.copy(pose.target);
    this.camera.position.set(pose.target.x + s * Math.cos(pose.theta), pose.target.y + s * Math.sin(pose.theta), pose.target.z + Math.cos(phi) * pose.distance);
    this.controls.update();
  }

  private animateTo(to: Pose3): void {
    const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      this.animation = null;
      this.controls.enabled = true;
      this.applyPose(to);
    } else {
      this.animation = { start: performance.now(), duration: ANIMATION_MS, from: this.currentPose(), to };
      this.controls.enabled = false;
    }
    this.requestRender();
  }

  private stepAnimation(): void {
    const a = this.animation;
    if (!a) return;
    const t = clamp((performance.now() - a.start) / a.duration, 0, 1);
    const k = easeInOut(t);
    // Take the short way round in azimuth.
    const dTheta = ((((a.to.theta - a.from.theta + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
    this.applyPose({ theta: a.from.theta + dTheta * k, phi: a.from.phi + (a.to.phi - a.from.phi) * k, distance: a.from.distance + (a.to.distance - a.from.distance) * k, target: a.from.target.clone().lerp(a.to.target, k) });
    if (t >= 1) {
      this.animation = null;
      this.controls.enabled = true;
    } else {
      this.requestRender();
    }
  }

  // --- rendering ---------------------------------------------------------------

  private readonly requestRender = (): void => {
    if (!this.ok || this.disposed || this.raf) return;
    this.raf = requestAnimationFrame(this.frameTick);
  };

  private readonly frameTick = (): void => {
    this.raf = 0;
    if (this.disposed) return;
    this.stepAnimation();
    // With damping, update() keeps emitting 'change' (and so re-requesting frames) until the motion settles.
    this.controls.update();
    this.draw();
  };

  private onResize(): void {
    if (!this.ok || this.disposed) return;
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    if (!width || !height) return;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.draw();
  }

  /**
   * A small JPEG of the view, for the worlds browser: drawn afresh without
   * the triad and read back at once, which needs no preserved drawing buffer.
   */
  snapshot(size = 320): string | null {
    const { width, height, renderer, camera } = this;
    if (!width || !height || !this.ok) return null;
    try {
      renderer.setViewport(0, 0, width, height);
      renderer.render(this.scene, camera);
      const canvas = document.createElement('canvas');
      const scale = Math.min(1, size / Math.max(width, height));
      canvas.width = Math.max(1, Math.round(renderer.domElement.width * scale));
      canvas.height = Math.max(1, Math.round(renderer.domElement.height * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(renderer.domElement, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', 0.8);
    } catch {
      return null;
    } finally {
      this.draw();
    }
  }

  private draw(): void {
    const { width, height, renderer, camera } = this;
    if (!width || !height) return;
    // Fit the clip planes around everything visible (the world and the grid).
    const extent = Math.max(Math.hypot(...this.gridHalf), this.center.length() + this.radius);
    const distance = camera.position.distanceTo(this.controls.target) + this.controls.target.length();
    camera.near = Math.max(extent / 5000, (distance - extent) * 0.8, 0.01);
    camera.far = distance + extent * 1.5;
    camera.updateProjectionMatrix();
    renderer.setViewport(0, 0, width, height);
    renderer.render(this.scene, camera);
    // Axes triad in the bottom-left corner, sharing the main camera's orientation.
    renderer.autoClear = false;
    this.triadCamera.quaternion.copy(camera.quaternion);
    this.triadCamera.position.set(0, 0, 1).applyQuaternion(camera.quaternion).multiplyScalar(5);
    renderer.clearDepth();
    renderer.setViewport(this.triadOrigin.x, this.triadOrigin.y, GIZMO_SIZE, GIZMO_SIZE);
    renderer.render(this.triadScene, this.triadCamera);
    renderer.autoClear = true;
    renderer.setViewport(0, 0, width, height);
  }
}
