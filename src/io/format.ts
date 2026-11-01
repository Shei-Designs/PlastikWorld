/** Fixed-point number with trailing zeros trimmed ("12.5", "-0.333333", "0"). */
export function fmt(v: number, decimals = 6): string {
  let s = v.toFixed(decimals);
  if (s.includes('.') && !s.includes('e')) s = s.replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
}

export const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const encodeText = (s: string): Uint8Array => new TextEncoder().encode(s);
export const decodeText = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/** A name an engine accepts as an identifier: letters, digits and underscores, starting with a letter. */
export function identifier(name: string, fallback = 'item'): string {
  const cleaned = name.normalize('NFKD').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  const id = cleaned || fallback;
  return /^[A-Za-z]/.test(id) ? id : `${fallback}_${id}`;
}
