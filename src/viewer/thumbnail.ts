// A small picture of a mesh for the parts library's cards: one shared
// renderer, an orthographic camera looking down from the front-right, the
// mesh fitted into the frame, drawn into the card's own canvas.
import { AmbientLight, BufferAttribute, BufferGeometry, Color, DirectionalLight, HemisphereLight, Mesh, MeshStandardMaterial, OrthographicCamera, Scene, Sphere, Vector3, WebGLRenderer } from 'three';
import type { MeshData } from '../io/export';

let renderer: WebGLRenderer | null = null;

function shared(): WebGLRenderer | null {
  if (renderer) return renderer;
  try {
    renderer = new WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
  } catch {
    renderer = null;
  }
  return renderer;
}

/** Draws the mesh into `target`, which keeps its own size; does nothing where WebGL is unavailable. */
export function thumbnailOf(data: MeshData, target: HTMLCanvasElement): void {
  const r = shared();
  if (!r) return;
  const { width, height } = target;
  r.setSize(width, height, false);
  const scene = new Scene();
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(data.positions, 3));
  geometry.setIndex(new BufferAttribute(data.indices, 1));
  if (data.colors) geometry.setAttribute('color', new BufferAttribute(data.colors, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  const mesh = new Mesh(geometry, new MeshStandardMaterial({ vertexColors: !!data.colors, color: data.colors ? 0xffffff : 0x9a9a9a, roughness: 0.85, flatShading: true }));
  scene.add(mesh);
  scene.add(new AmbientLight(0xffffff, 0.5));
  scene.add(new HemisphereLight(0xffffff, 0x445544, 0.8));
  const key = new DirectionalLight(0xffffff, 1.6);
  key.position.set(3, -4, 6);
  scene.add(key);
  const sphere = geometry.boundingSphere ?? new Sphere(new Vector3(), 1);
  const radius = Math.max(sphere.radius, 1e-3) * 1.15;
  const aspect = width / height;
  const camera = new OrthographicCamera(-radius * aspect, radius * aspect, radius, -radius, 0.01, radius * 10);
  camera.up.set(0, 0, 1);
  camera.position.copy(sphere.center).add(new Vector3(1, -1.2, 0.9).normalize().multiplyScalar(radius * 4));
  camera.lookAt(sphere.center);
  r.setClearColor(new Color(0, 0, 0), 0);
  r.render(scene, camera);
  const ctx = target.getContext('2d');
  if (ctx) {
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(r.domElement, 0, 0, width, height);
  }
  geometry.dispose();
  mesh.material.dispose();
}
