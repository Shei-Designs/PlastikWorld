import { describe, expect, it } from 'vitest';
import { boundsOf } from '../io/export';
import type { MeshData } from '../io/export';
import { PARTS, buildPart, partById, settle } from './library';

/** The signed volume of a closed mesh, from its triangles (positive when they face out). */
function volume(data: MeshData): number {
  const p = data.positions, f = data.indices;
  let v = 0;
  for (let i = 0; i < f.length; i += 3) {
    const a = f[i] * 3, b = f[i + 1] * 3, c = f[i + 2] * 3;
    v += (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) / 6;
  }
  return v;
}

describe('the parts library', () => {
  it('builds every part at its defaults: finite, coloured, closed pieces facing out, standing on z = 0', () => {
    for (const def of PARTS) {
      const { pieces, merged } = buildPart(def, {});
      expect(pieces.length, def.id).toBeGreaterThan(0);
      expect(merged.indices.length % 3, def.id).toBe(0);
      expect(Array.from(merged.positions).every(Number.isFinite), def.id).toBe(true);
      expect(merged.colors?.length, def.id).toBe(merged.positions.length);
      for (const piece of pieces) expect(volume(piece), `${def.id} piece`).toBeGreaterThan(0);
      const b = boundsOf(merged);
      expect(b.min[2], def.id).toBeGreaterThanOrEqual(-1e-6);
      expect(b.min[2], def.id).toBeLessThan(0.2);
      expect(b.max[2], def.id).toBeGreaterThan(0.02);
    }
  });

  it('takes its numbers from the parameters, clamped to the spec', () => {
    const wall = partById('wall')!;
    expect(settle(wall, { length: 10, height: 999, bogus: 3 })).toMatchObject({ length: 10, height: 20, thickness: 0.2 });
    const { merged } = buildPart(wall, { length: 10, height: 3, thickness: 0.3 });
    const b = boundsOf(merged);
    [-5, -0.15, 0].forEach((v, i) => expect(b.min[i]).toBeCloseTo(v, 5));
    [5, 0.15, 3].forEach((v, i) => expect(b.max[i]).toBeCloseTo(v, 5));
  });

  it('cuts a doorway as two jambs and a lintel, and a room keeps its floor and four walls as pieces', () => {
    const wall = buildPart(partById('wall')!, { length: 6, height: 2.4, door: 1, doorHeight: 2 });
    expect(wall.pieces).toHaveLength(3);
    // Nothing of the wall stands in the doorway below the lintel.
    const inDoor = wall.pieces.filter((p) => boundsOf(p).min[0] < 0.4 && boundsOf(p).max[0] > -0.4 && boundsOf(p).min[2] < 1.9);
    expect(inDoor).toHaveLength(0);
    const room = buildPart(partById('room')!, { width: 5, depth: 4, height: 2.6, door: 1.2, floor: 0.05 });
    // A slab (half a meter past the walls), three whole walls, and the +X wall as two jambs and a lintel.
    expect(room.pieces).toHaveLength(1 + 3 + 3);
    const b = boundsOf(room.merged);
    expect(b.min[0]).toBeCloseTo(-3.15);
    expect(b.max[0]).toBeCloseTo(3.15);
    expect(b.max[2]).toBeCloseTo(2.65);
  });

  it('makes stairs that rise step by step and a different rock for another seed', () => {
    const stairs = buildPart(partById('stairs')!, { steps: 4, rise: 0.2, run: 0.3, width: 1 });
    expect(stairs.pieces).toHaveLength(4);
    [1.2, 0.5, 0.8].forEach((v, i) => expect(boundsOf(stairs.merged).max[i]).toBeCloseTo(v, 5));
    const a = buildPart(partById('rock')!, { seed: 1 }).merged, b = buildPart(partById('rock')!, { seed: 2 }).merged;
    expect(Array.from(a.positions)).not.toEqual(Array.from(b.positions));
  });
});
