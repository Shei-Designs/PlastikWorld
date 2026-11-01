// PNG, written and read: a 16-bit greyscale image is what Gazebo reads terrain
// from, and what a user brings a heightmap in as (8 or 16-bit, grey or colour).
import { unzlibSync, zlibSync } from 'fflate';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A PNG chunk: length, type, data, CRC. */
export function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * Encodes `rows` × `cols` samples in 0..1 as a 16-bit greyscale PNG, the first
 * row at the top of the image.
 */
export function encodeGreyPng(cols: number, rows: number, samples: ArrayLike<number>): Uint8Array {
  const stride = cols * 2;
  const raw = new Uint8Array(rows * (stride + 1));
  for (let r = 0; r < rows; r++) {
    const at = r * (stride + 1);
    raw[at] = 0; // filter: none
    for (let c = 0; c < cols; c++) {
      const v = Math.round(Math.min(Math.max(samples[r * cols + c], 0), 1) * 65535);
      raw[at + 1 + c * 2] = v >> 8;
      raw[at + 2 + c * 2] = v & 0xff;
    }
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, cols);
  view.setUint32(4, rows);
  header[8] = 16; // bit depth
  header[9] = 0; // greyscale
  header[10] = 0; // deflate
  header[11] = 0; // filter method
  header[12] = 0; // no interlace
  return pngOf([chunk('IHDR', header), chunk('IDAT', zlibSync(raw, { level: 6 })), chunk('IEND', new Uint8Array(0))]);
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/** A PNG file from its chunks. */
export function pngOf(chunks: Uint8Array[]): Uint8Array {
  const parts = [new Uint8Array(SIGNATURE), ...chunks];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export const isPng = (bytes: Uint8Array): boolean => bytes.length > 8 && SIGNATURE.every((b, i) => bytes[i] === b);

/** A decoded image as heights want it: one value per pixel in 0..1 (grey, or the luminance of a colour), the first row at the top. */
export interface GreyImage {
  width: number;
  height: number;
  /** The bit depth it was stored with, so the UI can say how fine the steps are. */
  depth: number;
  samples: Float32Array;
}

/**
 * Reads a PNG as greys: greyscale, greyscale with alpha, RGB, RGBA and
 * palette images, 8 or 16 bits (1, 2 and 4 too), not interlaced. Throws with a
 * readable message for anything else.
 */
export function decodeGreyPng(bytes: Uint8Array): GreyImage {
  if (!isPng(bytes)) throw new Error('This is not a PNG image.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let width = 0, height = 0, depth = 0, colour = 0, interlace = 0;
  let palette: Uint8Array | null = null;
  const data: Uint8Array[] = [];
  while (at + 8 <= bytes.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      depth = bytes[at + 16];
      colour = bytes[at + 17];
      interlace = bytes[at + 20];
    } else if (type === 'PLTE') palette = body;
    else if (type === 'IDAT') data.push(body);
    else if (type === 'IEND') break;
    at += 12 + length;
  }
  if (!width || !height) throw new Error('The PNG has no image header.');
  if (interlace) throw new Error('Interlaced PNGs are not supported; save the image without interlacing.');
  const channels = colour === 0 ? 1 : colour === 2 ? 3 : colour === 3 ? 1 : colour === 4 ? 2 : colour === 6 ? 4 : 0;
  if (!channels || (colour === 3 && !palette)) throw new Error(`Unsupported PNG colour type ${colour}.`);
  if (![1, 2, 4, 8, 16].includes(depth)) throw new Error(`Unsupported PNG bit depth ${depth}.`);
  const joined = new Uint8Array(data.reduce((n, d) => n + d.length, 0));
  let o = 0;
  for (const d of data) {
    joined.set(d, o);
    o += d.length;
  }
  let raw: Uint8Array;
  try {
    raw = unzlibSync(joined);
  } catch {
    throw new Error('The PNG image data could not be decompressed.');
  }
  const bitsPerPixel = depth * channels;
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const bpp = Math.max(1, Math.ceil(bitsPerPixel / 8));
  if (raw.length < height * (stride + 1)) throw new Error('The PNG image data is shorter than its size says.');
  // Unfilter row by row (filters 0 to 4 of the PNG spec), in place.
  const rows = new Uint8Array(height * stride);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = rows.subarray(y * stride, (y + 1) * stride);
    line.set(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let add = 0;
      if (filter === 1) add = a;
      else if (filter === 2) add = b;
      else if (filter === 3) add = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new Error(`Unsupported PNG filter ${filter}.`);
      line[i] = (line[i] + add) & 0xff;
    }
    prev = line;
  }
  const samples = new Float32Array(width * height);
  const max = (1 << depth) - 1;
  const sampleAt = (line: Uint8Array, index: number): number => {
    // The `index`th value of `depth` bits in the row.
    if (depth === 16) return (line[index * 2] << 8) | line[index * 2 + 1];
    if (depth === 8) return line[index];
    const bit = index * depth;
    return (line[bit >> 3] >> (8 - depth - (bit & 7))) & max;
  };
  for (let y = 0; y < height; y++) {
    const line = rows.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < width; x++) {
      let v: number;
      if (colour === 3) {
        const i = sampleAt(line, x) * 3;
        v = (0.2126 * palette![i] + 0.7152 * palette![i + 1] + 0.0722 * palette![i + 2]) / 255;
      } else if (channels >= 3) {
        v = (0.2126 * sampleAt(line, x * channels) + 0.7152 * sampleAt(line, x * channels + 1) + 0.0722 * sampleAt(line, x * channels + 2)) / max;
      } else {
        v = sampleAt(line, x * channels) / max;
      }
      samples[y * width + x] = v;
    }
  }
  return { width, height, depth: colour === 3 ? 8 : depth, samples };
}
