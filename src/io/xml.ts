import { ByteReader, isSpace } from './scan';

const LT = 60;
const GT = 62;
const SLASH = 47;
const QUOTE = 34;
const APOSTROPHE = 39;

const decoder = new TextDecoder();

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

const decodeEntities = (s: string) =>
  s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, name: string) => {
    if (name[0] !== '#') return Object.prototype.hasOwnProperty.call(ENTITIES, name) ? ENTITIES[name] : whole;
    const code = name[1] === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });

/**
 * Forward-only scanner over the element tags of a UTF-8 XML document: enough
 * to read 3MF and SVG, without a DOM (there is none in a worker or in node)
 * and without turning a model of several hundred megabytes into a string.
 * Text, comments, CDATA, processing instructions and the DOCTYPE are skipped.
 * It does not check that the document is well formed.
 */
export class XmlScanner {
  /** Byte range of the current tag's name (prefix included). */
  nameStart = 0;
  nameEnd = 0;
  /** Byte range of the current tag's attributes. */
  attrStart = 0;
  attrEnd = 0;
  /** `</name>` */
  closing = false;
  /** `<name/>` */
  selfClosing = false;
  private pos = 0;
  private reader: ByteReader;

  constructor(readonly bytes: Uint8Array) {
    this.reader = new ByteReader(bytes);
  }

  /** Moves to the next tag; false at the end of the document. */
  next(): boolean {
    const b = this.bytes;
    const n = b.length;
    for (;;) {
      let i = b.indexOf(LT, this.pos);
      if (i < 0 || i + 1 >= n) {
        this.pos = n;
        return false;
      }
      const c = b[i + 1];
      if (c === 33) {
        // "<!--", "<![CDATA[" or "<!DOCTYPE"
        if (b[i + 2] === 45 && b[i + 3] === 45) this.pos = this.after(i + 4, '-->');
        else if (b[i + 2] === 91) this.pos = this.after(i + 3, ']]>');
        else this.pos = this.afterDoctype(i + 2);
        continue;
      }
      if (c === 63) {
        this.pos = this.after(i + 2, '?>');
        continue;
      }
      this.closing = c === SLASH;
      i += this.closing ? 2 : 1;
      this.nameStart = i;
      while (i < n && b[i] !== GT && b[i] !== SLASH && !isSpace(b[i])) i++;
      this.nameEnd = i;
      if (i === this.nameStart) {
        // A stray "<" in text.
        this.pos = i;
        continue;
      }
      // A ">" inside a quoted attribute value does not end the tag.
      let quote = 0;
      for (; i < n; i++) {
        const ch = b[i];
        if (quote) {
          if (ch === quote) quote = 0;
        } else if (ch === QUOTE || ch === APOSTROPHE) quote = ch;
        else if (ch === GT) break;
      }
      this.selfClosing = i > this.nameEnd && b[i - 1] === SLASH;
      this.attrStart = this.nameEnd;
      this.attrEnd = this.selfClosing ? i - 1 : i;
      this.pos = Math.min(n, i + 1);
      return true;
    }
  }

  /** Whether the current tag's name is exactly `name` (ASCII). */
  is(name: string): boolean {
    if (this.nameEnd - this.nameStart !== name.length) return false;
    for (let i = 0; i < name.length; i++) if (this.bytes[this.nameStart + i] !== name.charCodeAt(i)) return false;
    return true;
  }

  /** Whether the current tag's name is `name` (ASCII) under any namespace prefix: `m:color` and `color` alike. */
  localIs(name: string): boolean {
    let start = this.nameStart;
    for (let i = start; i < this.nameEnd; i++) if (this.bytes[i] === 58) start = i + 1;
    if (this.nameEnd - start !== name.length) return false;
    for (let i = 0; i < name.length; i++) if (this.bytes[start + i] !== name.charCodeAt(i)) return false;
    return true;
  }

  name(): string {
    return decoder.decode(this.bytes.subarray(this.nameStart, this.nameEnd));
  }

  /** The current tag's attributes, by name as written (prefix included). */
  attrs(): Record<string, string> {
    const out: Record<string, string> = {};
    const text = decoder.decode(this.bytes.subarray(this.attrStart, this.attrEnd));
    const re = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const value = m[2] ?? m[3];
      out[m[1]] = value.includes('&') ? decodeEntities(value) : value;
    }
    return out;
  }

  /**
   * Reads numeric attributes with names of up to three letters without decoding
   * the tag, for the elements a mesh has millions of. `out[i]` receives the
   * attribute whose name has the character codes `keys[i]` (first | second << 8 | third << 16),
   * or NaN if it is missing.
   */
  numbers(keys: number[], out: Float64Array): void {
    const b = this.bytes;
    const end = this.attrEnd;
    const reader = this.reader;
    reader.end = end;
    out.fill(NaN);
    let i = this.attrStart;
    while (i < end) {
      while (i < end && isSpace(b[i])) i++;
      const start = i;
      while (i < end && b[i] !== 61 && !isSpace(b[i])) i++;
      const length = i - start;
      while (i < end && b[i] !== QUOTE && b[i] !== APOSTROPHE) i++;
      if (i >= end) break;
      const quote = b[i++];
      if (length >= 1 && length <= 3) {
        const k = keys.indexOf(length === 1 ? b[start] : length === 2 ? b[start] | (b[start + 1] << 8) : b[start] | (b[start + 1] << 8) | (b[start + 2] << 16));
        if (k >= 0) {
          reader.pos = i;
          out[k] = reader.number();
        }
      }
      while (i < end && b[i] !== quote) i++;
      i++;
    }
  }

  /** Position just past the next occurrence of `marker` (ASCII) at or after `from`, or the end. */
  private after(from: number, marker: string): number {
    const b = this.bytes;
    const first = marker.charCodeAt(0);
    for (let i = b.indexOf(first, from); i >= 0; i = b.indexOf(first, i + 1)) {
      let k = 1;
      while (k < marker.length && b[i + k] === marker.charCodeAt(k)) k++;
      if (k === marker.length) return i + k;
    }
    return b.length;
  }

  /** A DOCTYPE may carry an internal subset in brackets, with declarations (and so ">") of its own. */
  private afterDoctype(from: number): number {
    const b = this.bytes;
    let depth = 0;
    let quote = 0;
    for (let i = from; i < b.length; i++) {
      const ch = b[i];
      if (quote) {
        if (ch === quote) quote = 0;
      } else if (ch === QUOTE || ch === APOSTROPHE) quote = ch;
      else if (ch === 91) depth++;
      else if (ch === 93) depth--;
      else if (ch === GT && depth <= 0) return i + 1;
    }
    return b.length;
  }
}

/** An element of a small XML document read whole: its name as written, attributes, children, and the text directly inside it, trimmed. */
export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  text: string;
}

const textOf = (bytes: Uint8Array): string => {
  const raw = decoder.decode(bytes).replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  return raw.includes('&') ? decodeEntities(raw) : raw;
};

/**
 * The whole document as a tree, for the small files (a URDF, an SDF) whose
 * text content matters as much as their tags. Null when the document has no
 * element. Mismatched closing tags are taken as closing the open element.
 */
export function xmlTree(bytes: Uint8Array): XmlElement | null {
  const scanner = new XmlScanner(bytes);
  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;
  let textFrom = 0;
  while (scanner.next()) {
    const tagStart = scanner.nameStart - (scanner.closing ? 2 : 1);
    const top = stack[stack.length - 1];
    if (top && tagStart > textFrom) top.text += textOf(bytes.subarray(textFrom, tagStart));
    textFrom = scanner.attrEnd + (scanner.selfClosing ? 2 : 1);
    if (scanner.closing) {
      const closed = stack.pop();
      if (closed) closed.text = closed.text.trim();
      continue;
    }
    const element: XmlElement = { name: scanner.name(), attrs: scanner.attrs(), children: [], text: '' };
    if (top) top.children.push(element);
    else root ??= element;
    if (!scanner.selfClosing) stack.push(element);
  }
  for (const open of stack) open.text = open.text.trim();
  return root;
}

/** The local part of an element's name: `xacro:property` → `property`. */
export const localName = (name: string): string => name.slice(name.indexOf(':') + 1);
/** The first child element with this local name. */
export const childOf = (element: XmlElement, name: string): XmlElement | undefined => element.children.find((c) => localName(c.name) === name);
/** Every child element with this local name. */
export const childrenOf = (element: XmlElement, name: string): XmlElement[] => element.children.filter((c) => localName(c.name) === name);
