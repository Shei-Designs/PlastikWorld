import { describe, expect, it } from 'vitest';
import { zlibSync } from 'fflate';
import { chunk, decodeGreyPng, encodeGreyPng, pngOf } from '../io/png';
import { gazeboBundle } from '../io/gazebo';
import { range } from '../io/heightmap';
import { emptyWorld } from '../model/types';
import { generateField } from './brush';
import { gridFor, heightsFromImage } from './image';

/** An 8-bit RGB PNG of `width` × `height`, each row filtered the way asked, so the unfiltering is exercised. */
function rgbPng(width: number, height: number, pixel: (x: number, y: number) => [number, number, number], filters: number[]): Uint8Array {
  const stride = width * 3;
  const raw = new Uint8Array(height * (stride + 1));
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const line = new Uint8Array(stride);
    for (let x = 0; x < width; x++) line.set(pixel(x, y), x * 3);
    const filter = filters[y % filters.length];
    raw[y * (stride + 1)] = filter;
    for (let i = 0; i < stride; i++) {
      const a = i >= 3 ? line[i - 3] : 0, b = prev[i], c = i >= 3 ? prev[i - 3] : 0;
      let sub = 0;
      if (filter === 1) sub = a;
      else if (filter === 2) sub = b;
      else if (filter === 3) sub = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        sub = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      raw[y * (stride + 1) + 1 + i] = (line[i] - sub) & 0xff;
    }
    prev = line;
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8;
  header[9] = 2; // RGB
  return pngOf([chunk('IHDR', header), chunk('IDAT', zlibSync(raw)), chunk('IEND', new Uint8Array(0))]);
}

describe('reading PNGs', () => {
  it('reads back what the writer wrote, 16 bits deep', () => {
    const png = encodeGreyPng(3, 2, [0, 0.5, 1, 1, 0.25, 0]);
    const image = decodeGreyPng(png);
    expect([image.width, image.height, image.depth]).toEqual([3, 2, 16]);
    expect(Array.from(image.samples).map((v) => Math.round(v * 1000) / 1000)).toEqual([0, 0.5, 1, 1, 0.25, 0]);
  });

  it('reads an 8-bit colour image as luminance through every filter', () => {
    const png = rgbPng(7, 5, (x, y) => [x * 30, y * 50, 200 - x * 10], [0, 1, 2, 3, 4]);
    const image = decodeGreyPng(png);
    expect(image.depth).toBe(8);
    const expected = (x: number, y: number) => (0.2126 * (x * 30) + 0.7152 * (y * 50) + 0.0722 * (200 - x * 10)) / 255;
    for (let y = 0; y < 5; y++) for (let x = 0; x < 7; x++) expect(image.samples[y * 7 + x]).toBeCloseTo(expected(x, y), 5);
  });

  it('refuses what is not a PNG', () => {
    expect(() => decodeGreyPng(new Uint8Array([1, 2, 3]))).toThrow(/not a PNG/);
  });
});

describe('heights from an image', () => {
  it('puts the image the right way up on the grid, black to lowest and white to highest', () => {
    // Two rows: white on top (+Y), black below.
    const image = { width: 2, height: 2, depth: 8, samples: new Float32Array([1, 1, 0, 0]) };
    const heights = heightsFromImage(image, { samples: 65, lowest: -1, highest: 3 });
    expect(heights).toHaveLength(65 * 65);
    expect(heights[0]).toBeCloseTo(-1); // -Y row: the image's bottom
    expect(heights[64 * 65]).toBeCloseTo(3); // +Y row: the image's top
    expect(heights[32 * 65 + 10]).toBeCloseTo(1);
  });

  it('round-trips the heightmap Gazebo gets, within a 16-bit step', () => {
    const world = emptyWorld('Round trip');
    const heights = generateField(129, 129, { kind: 'hills', seed: 5, amplitude: 2, feature: 0.3, clear: 0 });
    world.terrain = { kind: 'heightmap', size: [30, 30], friction: 1, rows: 129, cols: 129, heights };
    const bundle = gazeboBundle(world, { meshes: {} });
    const png = bundle.files.find((f) => f.path.endsWith('heightmap.png'))!;
    const image = decodeGreyPng((png as { bytes: Uint8Array }).bytes);
    expect(gridFor(image)).toBe(129);
    const [lo, hi] = range(heights);
    const back = heightsFromImage(image, { samples: 129, lowest: lo, highest: hi });
    let worst = 0;
    for (let i = 0; i < back.length; i++) worst = Math.max(worst, Math.abs(back[i] - heights[i]));
    expect(worst).toBeLessThan((hi - lo) / 65535 + 1e-5);
  });

  it('caps a huge image at the working ceiling', () => {
    expect(gridFor({ width: 4000, height: 4000, depth: 8, samples: new Float32Array(0) })).toBe(1025);
  });
});
