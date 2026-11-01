// A heightmap from an image: a PNG decoded here (8 or 16-bit, grey or colour)
// or any other image the browser can draw, read back as 8-bit luminance. The
// image's top row is +Y, as Gazebo reads its heightmaps and as the writer
// puts them out, so an image exported from here comes back the same way up.
import { resample } from '../io/heightmap';
import { decodeGreyPng, isPng } from '../io/png';
import type { GreyImage } from '../io/png';
import { GRID_MAX, snapGridSize } from '../model/types';

export type { GreyImage };

/** Reads an image file as greys: a PNG through the app's own decoder, anything else through the browser. */
export async function readImage(name: string, bytes: Uint8Array): Promise<GreyImage> {
  if (isPng(bytes)) return decodeGreyPng(bytes);
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') throw new Error(`${name} is not a PNG, and only PNG can be read here.`);
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes as BlobPart]));
  } catch {
    throw new Error(`${name} is not an image this app can read; a greyscale PNG works best.`);
  }
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('The image could not be drawn to read its pixels.');
  ctx.drawImage(bitmap, 0, 0);
  const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  const samples = new Float32Array(bitmap.width * bitmap.height);
  for (let i = 0; i < samples.length; i++) samples[i] = (0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2]) / 255;
  return { width: bitmap.width, height: bitmap.height, depth: 8, samples };
}

export interface ImageFit {
  /** The grid to put the heights on, one of GRID_SIZES. */
  samples: number;
  /** Meters: black and white of the image. */
  lowest: number;
  highest: number;
}

/** The grid size that suits an image: its longer side, snapped, no larger than the working ceiling. */
export const gridFor = (image: GreyImage): number => Math.min(GRID_MAX, snapGridSize(Math.max(image.width, image.height)));

/**
 * The image as heights in meters on an `n` × `n` grid: black is `lowest`,
 * white `highest`, the image's top row the grid's last (+Y). An oblong image
 * is stretched onto the square grid; the terrain's size says what it covers.
 */
export function heightsFromImage(image: GreyImage, fit: ImageFit): Float32Array {
  const { width, height, samples } = image;
  // Flip the rows: the image runs from +Y down, the grid from -Y up.
  const flipped = new Float32Array(width * height);
  for (let y = 0; y < height; y++) flipped.set(samples.subarray(y * width, (y + 1) * width), (height - 1 - y) * width);
  const grid = width === fit.samples && height === fit.samples ? flipped : resample({ rows: height, cols: width, heights: flipped }, fit.samples);
  const span = fit.highest - fit.lowest;
  for (let i = 0; i < grid.length; i++) grid[i] = fit.lowest + grid[i] * span;
  return grid;
}
