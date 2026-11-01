// Bytes as base64 text, for the world file: a world carries its assets (GLBs,
// robot packages) and its terrain heights inside the one JSON file, as a
// PlastikCAD project carries its imports, so that a world is one thing to
// autosave, sync and share. The text of each buffer is kept beside it, since
// autosave writes the whole file a second after every change and the assets
// almost never change.

const cache = new WeakMap<Uint8Array, string>();

/** Base64 of the bytes, chunked so a mesh of several megabytes does not blow the call stack. */
export function toBase64(bytes: Uint8Array): string {
  const known = cache.get(bytes);
  if (known !== undefined) return known;
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step) as unknown as number[]);
  const text = btoa(binary);
  cache.set(bytes, text);
  return text;
}

/** The bytes of base64 text; an empty buffer for text that is not base64. */
export function fromBase64(text: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(text.replace(/\s+/g, ''));
  } catch {
    return new Uint8Array(0);
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  cache.set(bytes, text);
  return bytes;
}

/** Float32 samples as base64, little-endian, for the terrain heights. */
export function floatsToBase64(values: Float32Array): string {
  const bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
  if (!isLittleEndian()) {
    const swapped = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i += 4) for (let k = 0; k < 4; k++) swapped[i + k] = bytes[i + 3 - k];
    return toBase64(swapped);
  }
  return toBase64(bytes);
}

export function floatsFromBase64(text: string, count: number): Float32Array | null {
  const bytes = fromBase64(text);
  if (bytes.length !== count * 4) return null;
  const copy = new Uint8Array(bytes); // aligned, and ours
  if (!isLittleEndian()) for (let i = 0; i < copy.length; i += 4) copy.subarray(i, i + 4).reverse();
  return new Float32Array(copy.buffer);
}

const isLittleEndian = (): boolean => new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
