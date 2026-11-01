// A 16-bit greyscale PNG, for the heightmap image Gazebo reads terrain from.
import { zlibSync } from 'fflate';

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

function chunk(type: string, data: Uint8Array): Uint8Array {
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
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [signature, chunk('IHDR', header), chunk('IDAT', zlibSync(raw, { level: 6 })), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
