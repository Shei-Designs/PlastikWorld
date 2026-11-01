import { describe, expect, it } from 'vitest';
import { dab, generateField, sampleX, sampleY } from './brush';
import type { Brush, Heightmap } from './brush';

const flat = (n = 65, size = 20): Heightmap => ({ kind: 'heightmap', size: [size, size], friction: 1, rows: n, cols: n, heights: new Float32Array(n * n) });
const sum = (h: Float32Array) => h.reduce((a, b) => a + b, 0);
const variance = (h: Float32Array) => {
  const mean = sum(h) / h.length;
  return h.reduce((a, b) => a + (b - mean) ** 2, 0) / h.length;
};

describe('brushes', () => {
  it('raise lifts the ground under the brush and nothing outside it', () => {
    const t = flat();
    const brush: Brush = { kind: 'raise', radius: 2, strength: 1, target: 0 };
    // (2.5, -5) is a sample of the 65 grid over 20 m (spacing 0.3125 m).
    const window = dab(t, brush, 2.5, -5, 0.5)!;
    expect(window).toBeTruthy();
    const at = (x: number, y: number) => t.heights[Math.round((y / 20 + 0.5) * 64) * 65 + Math.round((x / 20 + 0.5) * 64)];
    expect(at(2.5, -5)).toBeCloseTo(0.5, 5); // a full dab at the middle
    expect(at(3.75, -5)).toBeGreaterThan(0);
    expect(at(3.75, -5)).toBeLessThan(0.5);
    expect(at(2.5, -2)).toBe(0); // 3 m away: outside
    expect(at(-2.5, -5)).toBe(0);
    // The window names just the rows and columns that could be touched.
    expect(sampleX(t, window.c0)).toBeGreaterThanOrEqual(0.5);
    expect(sampleX(t, window.c1)).toBeLessThanOrEqual(4.5);
    expect(sampleY(t, window.r0)).toBeGreaterThanOrEqual(-7);
    expect(sampleY(t, window.r1)).toBeLessThanOrEqual(-3);
  });

  it('lower is raise the other way, and both respect the terrain edge', () => {
    const t = flat();
    dab(t, { kind: 'lower', radius: 3, strength: 2, target: 0 }, 9.5, 9.5, 1);
    expect(t.heights[65 * 65 - 1]).toBeLessThan(0);
    expect(t.heights[0]).toBe(0);
    expect(dab(t, { kind: 'raise', radius: 1, strength: 1, target: 0 }, 50, 50, 1)).toBeNull();
  });

  it('smooth lowers the variance and keeps the volume', () => {
    const t = flat(33, 10);
    for (let i = 0; i < t.heights.length; i++) t.heights[i] = (i * 7919) % 11 / 10;
    const before = variance(t.heights), volume = sum(t.heights);
    for (let i = 0; i < 10; i++) dab(t, { kind: 'smooth', radius: 8, strength: 1, target: 0 }, 0, 0, 1);
    expect(variance(t.heights)).toBeLessThan(before * 0.5);
    // The mean of a clipped neighbourhood at the edge is not quite volume-preserving; within a percent is.
    expect(Math.abs(sum(t.heights) - volume) / volume).toBeLessThan(0.01);
  });

  it('flatten converges on the level and set on its target', () => {
    const t = flat(33, 10);
    t.heights.fill(2);
    for (let i = 0; i < 20; i++) dab(t, { kind: 'flatten', radius: 2, strength: 1, target: 0 }, 0, 0, 0.5, 0.7);
    expect(t.heights[16 * 33 + 16]).toBeCloseTo(0.7, 2);
    expect(t.heights[0]).toBe(2);
    for (let i = 0; i < 20; i++) dab(t, { kind: 'set', radius: 2, strength: 1, target: -1 }, 0, 0, 0.5);
    expect(t.heights[16 * 33 + 16]).toBeCloseTo(-1, 2);
  });
});

describe('generated fields', () => {
  it('are the same for the same seed, differ for another, and span the amplitude', () => {
    const a = generateField(65, 65, { kind: 'hills', seed: 3, amplitude: 2, feature: 0.3, clear: 0 });
    const b = generateField(65, 65, { kind: 'hills', seed: 3, amplitude: 2, feature: 0.3, clear: 0 });
    const c = generateField(65, 65, { kind: 'hills', seed: 4, amplitude: 2, feature: 0.3, clear: 0 });
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(Array.from(a)).not.toEqual(Array.from(c));
    expect(Math.min(...a)).toBeCloseTo(0, 5);
    expect(Math.max(...a)).toBeCloseTo(2, 5);
  });

  it('keep the middle level when asked, for every kind', () => {
    for (const kind of ['rolling', 'hills', 'ridged', 'craters'] as const) {
      const f = generateField(65, 65, { kind, seed: 9, amplitude: 1, feature: 0.4, clear: 0.2 });
      const mid = f[32 * 65 + 32];
      expect(Math.abs(f[32 * 65 + 34] - mid)).toBeLessThan(1e-6);
      expect(Math.abs(f[30 * 65 + 32] - mid)).toBeLessThan(1e-6);
      expect(f.every((h) => h >= 0 && h <= 1)).toBe(true);
    }
  });
});
