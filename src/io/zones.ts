// What the writers share about surface zones: which cells of the grid a zone
// covers, the faces of the ground mesh inside it (Isaac binds a material to
// those), and a patch of the ground over it as a mesh (Gazebo and MuJoCo get
// one collision piece per zone, laid a hair over the ground so a body meets
// the zone's surface first).
import type { Material, Terrain, World, Zone } from '../model/types';
import type { MeshData } from './export';

/** How far a zone's collision piece sits over the ground: below any contact tolerance, above any rounding. */
export const ZONE_LIFT = 0.002;

/** The grid rows and columns a zone covers (inclusive, at least one cell), or null when it lies off the terrain. */
export function zoneCells(terrain: Terrain, zone: Zone): { r0: number; r1: number; c0: number; c1: number } | null {
  if (terrain.kind !== 'heightmap') return null;
  const { rows, cols, size } = terrain;
  const [x0, y0, x1, y1] = zone.rect;
  const sx = size[0] / (cols - 1), sy = size[1] / (rows - 1);
  const c0 = Math.max(0, Math.floor((x0 + size[0] / 2) / sx)), c1 = Math.min(cols - 1, Math.ceil((x1 + size[0] / 2) / sx));
  const r0 = Math.max(0, Math.floor((y0 + size[1] / 2) / sy)), r1 = Math.min(rows - 1, Math.ceil((y1 + size[1] / 2) / sy));
  if (c1 <= c0 || r1 <= r0) return null;
  return { r0, r1, c0, c1 };
}

/** The zone clipped to the terrain, as a rectangle; null when nothing of it lies on the terrain. */
export function zoneRect(terrain: Terrain, zone: Zone): [number, number, number, number] | null {
  const [hx, hy] = [terrain.size[0] / 2, terrain.size[1] / 2];
  const r: [number, number, number, number] = [Math.max(zone.rect[0], -hx), Math.max(zone.rect[1], -hy), Math.min(zone.rect[2], hx), Math.min(zone.rect[3], hy)];
  return r[2] - r[0] > 1e-6 && r[3] - r[1] > 1e-6 ? r : null;
}

/**
 * The faces of the ground mesh (as `groundMesh` in the Isaac writer lays them
 * out: two triangles per cell, cells row by row) whose cell lies in the zone.
 * Kept for a GeomSubset binding, which Isaac Sim 6.2's PhysX crashed on; the
 * writers lay patches instead.
 */
export function zoneFaces(terrain: Terrain, zone: Zone): number[] {
  const cells = zoneCells(terrain, zone);
  if (!cells || terrain.kind !== 'heightmap') return [];
  const out: number[] = [];
  for (let r = cells.r0; r < cells.r1; r++) {
    for (let c = cells.c0; c < cells.c1; c++) {
      const face = (r * (terrain.cols - 1) + c) * 2;
      out.push(face, face + 1);
    }
  }
  return out;
}

/** The ground over the zone as a mesh of its cells, lifted by `lift`; a flat quad on a plane. */
export function zoneMesh(terrain: Terrain, zone: Zone, lift = ZONE_LIFT): MeshData | null {
  const rect = zoneRect(terrain, zone);
  if (!rect) return null;
  if (terrain.kind === 'plane') {
    const [x0, y0, x1, y1] = rect;
    return { positions: new Float32Array([x0, y0, lift, x1, y0, lift, x1, y1, lift, x0, y1, lift]), indices: new Uint32Array([0, 1, 2, 0, 2, 3]), colors: null };
  }
  const cells = zoneCells(terrain, zone);
  if (!cells) return null;
  const { rows, cols, size, heights } = terrain;
  const w = cells.c1 - cells.c0 + 1, h = cells.r1 - cells.r0 + 1;
  const positions = new Float32Array(w * h * 3);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const gr = cells.r0 + r, gc = cells.c0 + c;
      const i = (r * w + c) * 3;
      positions[i] = (gc / (cols - 1) - 0.5) * size[0];
      positions[i + 1] = (gr / (rows - 1) - 0.5) * size[1];
      positions[i + 2] = heights[gr * cols + gc] + lift;
    }
  }
  const indices = new Uint32Array((w - 1) * (h - 1) * 6);
  let k = 0;
  for (let r = 0; r < h - 1; r++) {
    for (let c = 0; c < w - 1; c++) {
      const a = r * w + c, b = a + 1, d = a + w, e = d + 1;
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

/** The zones with a material and something on the terrain, in order, for a writer to lay down. */
export function placedZones(world: World): { zone: Zone; material: Material; rect: [number, number, number, number] }[] {
  const out: { zone: Zone; material: Material; rect: [number, number, number, number] }[] = [];
  for (const zone of world.zones) {
    const material = world.materials.find((m) => m.id === zone.material);
    const rect = zoneRect(world.terrain, zone);
    if (material && rect) out.push({ zone, material, rect });
  }
  return out;
}
