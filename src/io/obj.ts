// A Wavefront OBJ of one mesh, for the engines that read no GLB (MuJoCo) and
// for the ground patches of surface zones. Normals go in with the vertices:
// Gazebo's DART plugin skips a submesh without them and then crashes on the
// empty shape it made, which is how they came to be here.
import type { MeshData } from './export';
import { fmt } from './format';

/** Smooth per-vertex normals: the sum of the normals of the triangles around each vertex, unit length. */
function vertexNormals(data: MeshData): Float32Array {
  const p = data.positions;
  const n = new Float32Array(p.length);
  const f = data.indices;
  for (let i = 0; i < f.length; i += 3) {
    const a = f[i] * 3, b = f[i + 1] * 3, c = f[i + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const k of [a, b, c]) {
      n[k] += nx;
      n[k + 1] += ny;
      n[k + 2] += nz;
    }
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]);
    if (l > 0) {
      n[i] /= l;
      n[i + 1] /= l;
      n[i + 2] /= l;
    } else n[i + 2] = 1;
  }
  return n;
}

export function writeObj(name: string, data: MeshData): string {
  const lines = [`# ${name}: made with PlastikWorld. Units: meters, Z up.`, `o ${name.replace(/\s+/g, '_')}`];
  const p = data.positions;
  const c = data.colors;
  for (let i = 0; i < p.length; i += 3) {
    const xyz = `${fmt(p[i], 6)} ${fmt(p[i + 1], 6)} ${fmt(p[i + 2], 6)}`;
    lines.push(c ? `v ${xyz} ${fmt(c[i], 4)} ${fmt(c[i + 1], 4)} ${fmt(c[i + 2], 4)}` : `v ${xyz}`);
  }
  const n = vertexNormals(data);
  for (let i = 0; i < n.length; i += 3) lines.push(`vn ${fmt(n[i], 4)} ${fmt(n[i + 1], 4)} ${fmt(n[i + 2], 4)}`);
  const f = data.indices;
  for (let i = 0; i < f.length; i += 3) lines.push(`f ${f[i] + 1}//${f[i] + 1} ${f[i + 1] + 1}//${f[i + 1] + 1} ${f[i + 2] + 1}//${f[i + 2] + 1}`);
  return lines.join('\n') + '\n';
}
