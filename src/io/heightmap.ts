// Terrain as a grid of heights: sampling it, resizing it for an engine that
// wants a particular size, and making one to start from.
import type { Terrain } from '../model/types';

export type Heightmap = Extract<Terrain, { kind: 'heightmap' }>;

/** The height in meters at (x, y) in the world, bilinear between samples; 0 for a plane or outside the terrain. */
export function heightAt(terrain: Terrain, x: number, y: number): number {
  if (terrain.kind !== 'heightmap') return 0;
  const { rows, cols, size, heights, height } = terrain;
  const u = (x / size[0] + 0.5) * (cols - 1);
  const v = (y / size[1] + 0.5) * (rows - 1);
  if (u < 0 || v < 0 || u > cols - 1 || v > rows - 1) return 0;
  const c0 = Math.min(Math.floor(u), cols - 2), r0 = Math.min(Math.floor(v), rows - 2);
  const fu = u - c0, fv = v - r0;
  const h = (r: number, c: number) => heights[r * cols + c];
  const top = h(r0, c0) * (1 - fu) + h(r0, c0 + 1) * fu;
  const bottom = h(r0 + 1, c0) * (1 - fu) + h(r0 + 1, c0 + 1) * fu;
  return (top * (1 - fv) + bottom * fv) * height;
}

/** The heights resampled onto `n` × `n` samples, bilinear; rows along Y from -Y, columns along X from -X, as stored. */
export function resample(terrain: Heightmap, n: number): number[] {
  const out = new Array<number>(n * n);
  const { rows, cols, heights } = terrain;
  for (let r = 0; r < n; r++) {
    const v = (r / (n - 1)) * (rows - 1);
    const r0 = Math.min(Math.floor(v), rows - 2), fv = v - r0;
    for (let c = 0; c < n; c++) {
      const u = (c / (n - 1)) * (cols - 1);
      const c0 = Math.min(Math.floor(u), cols - 2), fu = u - c0;
      const top = heights[r0 * cols + c0] * (1 - fu) + heights[r0 * cols + c0 + 1] * fu;
      const bottom = heights[(r0 + 1) * cols + c0] * (1 - fu) + heights[(r0 + 1) * cols + c0 + 1] * fu;
      out[r * n + c] = top * (1 - fv) + bottom * fv;
    }
  }
  return out;
}

/** The smallest 2^k + 1 that is at least `n`, the size Gazebo's heightmaps must have. */
export function gazeboSize(n: number): number {
  let size = 3;
  while (size < n) size = (size - 1) * 2 + 1;
  return size;
}

/**
 * A rolling field to start from: smooth bumps from a few sines, flat within
 * `clear` (a fraction of the half-size) of the middle so a robot starts level.
 * Samples in 0..1, row by row.
 */
export function rollingField(rows: number, cols: number, clear = 0.25): number[] {
  const out = new Array<number>(rows * cols);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = (c / (cols - 1)) * 2 - 1;
      const y = (r / (rows - 1)) * 2 - 1;
      const wave = 0.5 + 0.25 * Math.sin(3.1 * x + 0.7) * Math.cos(2.7 * y - 0.4) + 0.15 * Math.sin(6.3 * x - 1.9 * y) + 0.1 * Math.cos(5.1 * y + 2.3 * x);
      const d = Math.hypot(x, y);
      const fade = d < clear ? 0 : d > clear * 2 ? 1 : (d - clear) / clear;
      out[r * cols + c] = Math.min(Math.max(0.5 + (wave - 0.5) * fade, 0), 1);
    }
  }
  return out;
}

export const flatHeights = (rows: number, cols: number): number[] => new Array<number>(rows * cols).fill(0);
