// A Wavefront OBJ of one mesh, for the engines that read no GLB (MuJoCo).
import type { MeshData } from './export';
import { fmt } from './format';

export function writeObj(name: string, data: MeshData): string {
  const lines = [`# ${name}: made with PlastikWorld. Units: meters, Z up.`, `o ${name.replace(/\s+/g, '_')}`];
  const p = data.positions;
  const c = data.colors;
  for (let i = 0; i < p.length; i += 3) {
    const xyz = `${fmt(p[i], 6)} ${fmt(p[i + 1], 6)} ${fmt(p[i + 2], 6)}`;
    lines.push(c ? `v ${xyz} ${fmt(c[i], 4)} ${fmt(c[i + 1], 4)} ${fmt(c[i + 2], 4)}` : `v ${xyz}`);
  }
  const f = data.indices;
  for (let i = 0; i < f.length; i += 3) lines.push(`f ${f[i] + 1} ${f[i + 1] + 1} ${f[i + 2] + 1}`);
  return lines.join('\n') + '\n';
}
