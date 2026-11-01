// Number parsing straight from the bytes of a text file. Mesh files run to
// hundreds of megabytes, more than fits in one JS string, and decoding every
// number through a substring would spend most of the import in the allocator.

const POW10 = [
  1, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15, 1e16, 1e17, 1e18, 1e19, 1e20,
  1e21, 1e22,
];

export const isSpace = (c: number) => c === 32 || (c >= 9 && c <= 13);

const decoder = new TextDecoder();

export class ByteReader {
  pos = 0;

  constructor(
    readonly bytes: Uint8Array,
    public end = bytes.length,
  ) {}

  skipSpace(): void {
    const b = this.bytes;
    while (this.pos < this.end && isSpace(b[this.pos])) this.pos++;
  }

  /** Skips to the next whitespace. */
  skipToken(): void {
    const b = this.bytes;
    while (this.pos < this.end && !isSpace(b[this.pos])) this.pos++;
  }

  /** True (and steps past it) if the bytes at `pos` spell `word`, ignoring case, followed by whitespace or the end. */
  word(word: string): boolean {
    const b = this.bytes;
    const stop = this.pos + word.length;
    if (stop > this.end || (stop < this.end && !isSpace(b[stop]))) return false;
    for (let i = 0; i < word.length; i++) if ((b[this.pos + i] | 0x20) !== word.charCodeAt(i)) return false;
    this.pos = stop;
    return true;
  }

  /**
   * Reads a decimal number ("12", "-1.5", ".5", "1e-3") after optional
   * whitespace. Returns NaN, without moving, if there is none.
   */
  number(): number {
    const b = this.bytes;
    const end = this.end;
    let i = this.pos;
    while (i < end && isSpace(b[i])) i++;
    const start = i;
    let negative = false;
    if (i < end && (b[i] === 45 || b[i] === 43)) {
      negative = b[i] === 45;
      i++;
    }
    let mantissa = 0;
    let significant = 0;
    let digits = 0;
    let exponent = 0;
    for (; i < end; i++) {
      const d = b[i] - 48;
      if (d < 0 || d > 9) break;
      digits++;
      if (significant < 15) {
        mantissa = mantissa * 10 + d;
        if (mantissa !== 0) significant++;
      } else {
        significant++;
        exponent++;
      }
    }
    if (i < end && b[i] === 46) {
      for (i++; i < end; i++) {
        const d = b[i] - 48;
        if (d < 0 || d > 9) break;
        digits++;
        if (significant < 15) {
          mantissa = mantissa * 10 + d;
          exponent--;
          if (mantissa !== 0) significant++;
        } else significant++;
      }
    }
    if (digits === 0) return NaN;
    if (i < end && (b[i] | 0x20) === 101) {
      let j = i + 1;
      let sign = 1;
      if (j < end && (b[j] === 45 || b[j] === 43)) {
        if (b[j] === 45) sign = -1;
        j++;
      }
      let e = 0;
      const first = j;
      for (; j < end; j++) {
        const d = b[j] - 48;
        if (d < 0 || d > 9) break;
        if (e < 10000) e = e * 10 + d;
      }
      // "1e" with no digits is the number 1 followed by something else.
      if (j > first) {
        exponent += sign * e;
        i = j;
      }
    }
    this.pos = i;
    // Up to 15 digits and a power of ten up to 22 are both exact doubles, so
    // one multiplication or division rounds correctly. Anything else takes the slow road.
    if (significant <= 15 && exponent >= -22 && exponent <= 22) {
      const v = exponent < 0 ? mantissa / POW10[-exponent] : mantissa * POW10[exponent];
      return negative ? -v : v;
    }
    return Number(decoder.decode(b.subarray(start, i)));
  }
}
