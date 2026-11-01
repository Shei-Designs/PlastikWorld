// Loading the meshes the world refers to, for the viewer and for the writers
// that need triangles: a GLB from PlastikCAD (meters, Y up, as glTF wants,
// turned Z up here), and the OBJ visual meshes of a robot package. three.js
// does the parsing, so this runs in the webview only, never in a test.
import { Color, Group, Matrix4, Mesh, Object3D } from 'three';
import type { BufferGeometry, Material } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import type { MeshData } from './export';
import { decodeText } from './format';

/** glTF is Y up; the world is Z up. */
export const Y_UP_TO_Z_UP = new Matrix4().makeRotationX(Math.PI / 2);

/** A GLB as a three.js object, Z up, in meters. */
export async function loadGlb(bytes: Uint8Array): Promise<Group> {
  const loader = new GLTFLoader();
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const gltf = await loader.parseAsync(buffer, '');
  const group = new Group();
  group.add(gltf.scene);
  gltf.scene.applyMatrix4(Y_UP_TO_Z_UP);
  return group;
}

/** An OBJ (with its MTL beside it, when given) as a three.js object; the robot packages write them Z up, in meters. */
export function loadObj(objBytes: Uint8Array, mtlBytes: Uint8Array | null): Group {
  const loader = new OBJLoader();
  if (mtlBytes) {
    const materials = new MTLLoader().parse(decodeText(mtlBytes), '');
    materials.preload();
    loader.setMaterials(materials);
  }
  return loader.parse(decodeText(objBytes));
}

const baseColor = (material: Material | Material[] | undefined): Color | null => {
  const m = Array.isArray(material) ? material[0] : material;
  return m && 'color' in m && m.color instanceof Color ? m.color : null;
};

/** Every mesh of an object, flattened into one set of triangles in the object's frame. */
export function meshDataOf(object: Object3D): MeshData {
  object.updateMatrixWorld(true);
  const positions: number[] = [];
  const indices: number[] = [];
  const colors: number[] = [];
  let colored = false;
  object.traverse((o) => {
    if (!(o instanceof Mesh)) return;
    const geometry = o.geometry as BufferGeometry;
    const position = geometry.getAttribute('position');
    if (!position) return;
    const base = positions.length / 3;
    const matrix = o.matrixWorld;
    const v = [0, 0, 0];
    for (let i = 0; i < position.count; i++) {
      v[0] = position.getX(i);
      v[1] = position.getY(i);
      v[2] = position.getZ(i);
      const e = matrix.elements;
      positions.push(e[0] * v[0] + e[4] * v[1] + e[8] * v[2] + e[12], e[1] * v[0] + e[5] * v[1] + e[9] * v[2] + e[13], e[2] * v[0] + e[6] * v[1] + e[10] * v[2] + e[14]);
    }
    const color = geometry.getAttribute('color');
    const flat = baseColor(o.material);
    for (let i = 0; i < position.count; i++) {
      if (color) {
        colors.push(color.getX(i), color.getY(i), color.getZ(i));
        colored = true;
      } else if (flat) {
        colors.push(flat.r, flat.g, flat.b);
        colored = true;
      } else colors.push(0.7, 0.7, 0.7);
    }
    const index = geometry.getIndex();
    if (index) for (let i = 0; i < index.count; i++) indices.push(base + index.getX(i));
    else for (let i = 0; i < position.count; i++) indices.push(base + i);
  });
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices), colors: colored ? Float32Array.from(colors) : null };
}
