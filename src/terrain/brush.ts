// Sculpting the terrain: brushes that change the heights under a dab, and
// generators that make a whole field from a seed. All pure functions on the
// grid in meters (rows along Y from -Y, columns along X from -X); the viewer
// and the store decide when to call them.
import type { Terrain } from '../model/types';

export type Heightmap = Extract<Terrain, { kind: 'heightmap' }>;

export type BrushKind = 'raise' | 'lower' | 'smooth' | 'flatten' | 'set';

export interface Brush {
  kind: BrushKind;
  /** Meters. */
  radius: number;
  /** Raise and lower: meters per second at the brush's middle. Smooth, flatten and set: how much of the way per second (1 = all of it). */
  strength: number;
  /** The height a `set` brush works toward, meters. */
  target: number;
}

export const DEFAULT_BRUSH: Brush = { kind: 'raise', radius: 2, strength: 1, target: 0 };

export const BRUSH_KINDS: { id: BrushKind; label: string; hint: string }[] = [
  { id: 'raise', label: 'Raise', hint: 'Drag on the ground to raise it' },
  { id: 'lower', label: 'Lower', hint: 'Drag on the ground to lower it' },
  { id: 'smooth', label: 'Smooth', hint: 'Drag over bumps to soften them' },
  { id: 'flatten', label: 'Flatten', hint: 'Drag to level the ground to the height where the stroke began' },
  { id: 'set', label: 'Set height', hint: 'Drag to bring the ground to the set height' },
];

/** The rows and columns a dab touched, inclusive. */
export interface Window {
  r0: number;
  r1: number;
  c0: number;
  c1: number;
}

/** Where a sample sits in the world. */
export const sampleX = (t: Heightmap, c: number): number => (c / (t.cols - 1) - 0.5) * t.size[0];
export const sampleY = (t: Heightmap, r: number): number => (r / (t.rows - 1) - 0.5) * t.size[1];

/** A smooth bump: 1 at the middle, 0 at the edge, no corner in between. */
const falloff = (d: number, radius: number): number => (d >= radius ? 0 : 0.5 + 0.5 * Math.cos((Math.PI * d) / radius));

/**
 * One dab of the brush at (x, y) in the world, lasting `dt` seconds, applied
 * to the heights in place. `level` is the height a flatten stroke works toward
 * (the ground where the stroke began). Returns the window it touched, or
 * null when the brush missed the terrain.
 */
export function dab(terrain: Heightmap, brush: Brush, x: number, y: number, dt: number, level = 0): Window | null {
  const { rows, cols, size, heights } = terrain;
  const sx = size[0] / (cols - 1), sy = size[1] / (rows - 1);
  const c0 = Math.max(0, Math.ceil((x - brush.radius) / sx + (cols - 1) / 2));
  const c1 = Math.min(cols - 1, Math.floor((x + brush.radius) / sx + (cols - 1) / 2));
  const r0 = Math.max(0, Math.ceil((y - brush.radius) / sy + (rows - 1) / 2));
  const r1 = Math.min(rows - 1, Math.floor((y + brush.radius) / sy + (rows - 1) / 2));
  if (c0 > c1 || r0 > r1) return null;
  const step = Math.max(0, dt);
  // Smoothing reads the neighbours as they were before the dab, so the result does not depend on the sweep order.
  const before = brush.kind === 'smooth' ? heights.slice(Math.max(0, (r0 - 1) * cols), Math.min(heights.length, (r1 + 2) * cols)) : null;
  const beforeAt = (r: number, c: number) => before![r * cols + c - Math.max(0, (r0 - 1) * cols)];
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const w = falloff(Math.hypot(sampleX(terrain, c) - x, sampleY(terrain, r) - y), brush.radius);
      if (w === 0) continue;
      const i = r * cols + c;
      switch (brush.kind) {
        case 'raise':
          heights[i] += brush.strength * step * w;
          break;
        case 'lower':
          heights[i] -= brush.strength * step * w;
          break;
        case 'smooth': {
          let sum = 0, n = 0;
          for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
              const rr = r + dr, cc = c + dc;
              if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue;
              sum += beforeAt(rr, cc);
              n++;
            }
          }
          heights[i] += (sum / n - heights[i]) * Math.min(1, brush.strength * step) * w;
          break;
        }
        case 'flatten':
          heights[i] += (level - heights[i]) * Math.min(1, brush.strength * step) * w;
          break;
        case 'set':
          heights[i] += (brush.target - heights[i]) * Math.min(1, brush.strength * step) * w;
          break;
      }
    }
  }
  return { r0, r1, c0, c1 };
}

// --- generators ---------------------------------------------------------------

export type FieldKind = 'rolling' | 'hills' | 'ridged' | 'craters';

export interface FieldSpec {
  kind: FieldKind;
  /** Any integer; the same seed makes the same field on the same grid. */
  seed: number;
  /** Meters from the lowest dip to the highest crest. */
  amplitude: number;
  /** The size of the largest features as a fraction of the terrain's side, 0.1 to 1. */
  feature: number;
  /** Fraction of the half-size kept flat in the middle, so a robot starts level. */
  clear: number;
}

export const DEFAULT_FIELD: FieldSpec = { kind: 'hills', seed: 1, amplitude: 1.5, feature: 0.4, clear: 0.2 };

export const FIELD_KINDS: { id: FieldKind; label: string }[] = [
  { id: 'rolling', label: 'Rolling (a few waves)' },
  { id: 'hills', label: 'Hills (noise)' },
  { id: 'ridged', label: 'Ridges' },
  { id: 'craters', label: 'Craters' },
];

/** A small fast PRNG (mulberry32), so a seed makes the same field everywhere. */
function prng(seed: number): () => number {
  let a = (seed >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Value noise on a lattice of `n` × `n` random values, smoothly interpolated; (u, v) in 0..1 wrap. */
function lattice(seed: number, n: number): (u: number, v: number) => number {
  const rnd = prng(seed);
  const values = Float32Array.from({ length: n * n }, () => rnd());
  const at = (i: number, j: number) => values[(((i % n) + n) % n) * n + (((j % n) + n) % n)];
  const smooth = (t: number) => t * t * (3 - 2 * t);
  return (u, v) => {
    const x = u * n, y = v * n;
    const i = Math.floor(y), j = Math.floor(x);
    const fx = smooth(x - j), fy = smooth(y - i);
    const top = at(i, j) * (1 - fx) + at(i, j + 1) * fx;
    const bottom = at(i + 1, j) * (1 - fx) + at(i + 1, j + 1) * fx;
    return top * (1 - fy) + bottom * fy;
  };
}

/** The rolling field of a few sines, 0..1, as the app always had. */
function rolling(u: number, v: number): number {
  const x = u * 2 - 1, y = v * 2 - 1;
  return Math.min(Math.max(0.5 + 0.25 * Math.sin(3.1 * x + 0.7) * Math.cos(2.7 * y - 0.4) + 0.15 * Math.sin(6.3 * x - 1.9 * y) + 0.1 * Math.cos(5.1 * y + 2.3 * x), 0), 1);
}

/**
 * A field from a seed, in meters, row by row. Four octaves of value noise for
 * hills; the same folded about its middle for ridges; a flat ground with a
 * few bowls for craters. The middle is faded flat within `clear`, and the
 * whole is stretched to span `amplitude`.
 */
export function generateField(rows: number, cols: number, spec: FieldSpec): Float32Array {
  const out = new Float32Array(rows * cols);
  const feature = Math.min(Math.max(spec.feature, 0.05), 1);
  const base = Math.max(2, Math.round(1 / feature));
  const octaves = [0, 1, 2, 3].map((o) => ({ noise: lattice(spec.seed * 7919 + o * 104729, base << o), weight: 1 / (1 << o) }));
  const rnd = prng(spec.seed * 31 + 17);
  const craters = Array.from({ length: 6 }, () => ({ x: rnd() * 1.6 - 0.8, y: rnd() * 1.6 - 0.8, r: 0.12 + rnd() * 0.2, depth: 0.4 + rnd() * 0.6 }));
  const sample = (u: number, v: number): number => {
    switch (spec.kind) {
      case 'rolling':
        return rolling(u, v);
      case 'hills': {
        let sum = 0, norm = 0;
        for (const o of octaves) {
          sum += o.noise(u, v) * o.weight;
          norm += o.weight;
        }
        return sum / norm;
      }
      case 'ridged': {
        let sum = 0, norm = 0;
        for (const o of octaves) {
          sum += (1 - Math.abs(o.noise(u, v) * 2 - 1)) * o.weight;
          norm += o.weight;
        }
        return sum / norm;
      }
      case 'craters': {
        const x = u * 2 - 1, y = v * 2 - 1;
        let h = 1;
        for (const c of craters) {
          const d = Math.hypot(x - c.x, y - c.y) / c.r;
          if (d < 1) h -= c.depth * (0.5 + 0.5 * Math.cos(Math.PI * d));
          else if (d < 1.3) h += c.depth * 0.15 * (0.5 + 0.5 * Math.cos((Math.PI * (d - 1)) / 0.3));
        }
        return h;
      }
    }
  };
  let lo = Infinity, hi = -Infinity;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      out[r * cols + c] = sample(c / (cols - 1), r / (rows - 1));
      // The range of the samples as stored (single precision), so the stretch lands exactly on 0 and the amplitude.
      const h = out[r * cols + c];
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
  }
  const span = hi - lo || 1;
  // The middle fades to the field's mid height, so a robot starts on the level.
  const mid = 0.5;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = (c / (cols - 1)) * 2 - 1, y = (r / (rows - 1)) * 2 - 1;
      const d = Math.hypot(x, y);
      const fade = spec.clear <= 0 ? 1 : d < spec.clear ? 0 : d > spec.clear * 2 ? 1 : (d - spec.clear) / spec.clear;
      const n = (out[r * cols + c] - lo) / span;
      out[r * cols + c] = (mid + (n - mid) * fade) * spec.amplitude;
    }
  }
  return out;
}
