// Draws the PlastikWorld brand assets after the Shei Designs design
// system and its product rules (design-reference/PRODUCTS.md): the product
// tile, a green square with the pin-on-a-plot mark in Carbon, its Android and
// macOS variants, and the README banner. Run with `pnpm brand`.
const fs = require('fs');
const path = require('path');
const opentype = require('opentype.js');
const root = path.resolve(__dirname, '..', '..');
const load = (p) => { const b = fs.readFileSync(p); return opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
const F = (name) => path.join(root, 'node_modules/@fontsource', name);
const inter800 = load(F('inter/files/inter-latin-800-normal.woff'));
const inter400 = load(F('inter/files/inter-latin-400-normal.woff'));
const grotesk = load(F('space-grotesk/files/space-grotesk-latin-500-normal.woff'));
const mono = load(F('jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff'));
const CARBON = '#0A0907', TAPE = '#FF6B1A', LINEN = '#E8E4D8', DUST = '#8A8580';
// The product's own colour from the register (the widest free gap on the wheel, between Plot lime and
// Filament teal), and the one shade the mark may add: Carbon with a quarter of the tile in it.
const GREEN = '#19DC5A', SHADE = '#0E3E1C';
const TILE = 'M26 6 H74 A20 20 0 0 1 94 26 V74 A20 20 0 0 1 74 94 H26 A20 20 0 0 1 6 74 V26 A20 20 0 0 1 26 6 Z';

// Path data written out plainly (opentype's own writer drops into shorthand curves and produces NaN now and then).
const n = (v) => (Math.round(v * 100) / 100).toString();
const pathData = (commands) => commands.map((c) => (c.type === 'Z' ? 'Z' : c.type === 'Q' ? `Q${n(c.x1)} ${n(c.y1)} ${n(c.x)} ${n(c.y)}` : c.type === 'C' ? `C${n(c.x1)} ${n(c.y1)} ${n(c.x2)} ${n(c.y2)} ${n(c.x)} ${n(c.y)}` : `${c.type}${n(c.x)} ${n(c.y)}`)).join('');

// Text as a path laid out glyph by glyph (opentype.js cannot shape Inter's
// substitution tables), with the font's own kerning and optional tracking in em.
function text(font, str, x, y, size, opts = {}) {
  const scale = size / font.unitsPerEm;
  const out = new opentype.Path();
  let pen = x;
  let previous = null;
  for (const char of str) {
    const glyph = font.charToGlyph(char);
    if (previous) pen += font.getKerningValue(previous, glyph) * scale;
    const sx = pen, sy = y;
    let lx = 0, ly = 0;
    for (const c of glyph.path.commands) {
      if (c.type === 'Z') out.commands.push({ type: 'Z' });
      else if (c.type === 'Q') out.commands.push({ type: 'Q', x1: sx + (c.x1 ?? lx) * scale, y1: sy - (c.y1 ?? ly) * scale, x: sx + c.x * scale, y: sy - c.y * scale });
      else if (c.type === 'C') out.commands.push({ type: 'C', x1: sx + c.x1 * scale, y1: sy - c.y1 * scale, x2: sx + c.x2 * scale, y2: sy - c.y2 * scale, x: sx + c.x * scale, y: sy - c.y * scale });
      else out.commands.push({ type: c.type, x: sx + c.x * scale, y: sy - c.y * scale });
      if (c.type !== 'Z') (lx = c.x), (ly = c.y);
    }
    pen += glyph.advanceWidth * scale + (opts.tracking ?? 0) * size;
    previous = glyph;
  }
  return { d: pathData(out.commands), width: pen - x, bbox: out.getBoundingBox() };
}

// --- the mark: a placement pin standing on a plot of ground ----------------------------------
// Drawn in the 100 box, filling the 64-unit safe square (18 to 82) top to bottom: the plot is an
// isometric rhombus in the shade (the one plane the mark may add), the pin is Carbon, and the pin's
// eye is the one cutout through which the tile colour shows. Corners rounded a little, as the tile's.
/** A polygon with each corner cut `r` units in along its edges and bridged by a quadratic curve. */
function rounded(points, r) {
  const parts = [];
  const count = points.length;
  for (let i = 0; i < count; i++) {
    const p = points[i], a = points[(i - 1 + count) % count], b = points[(i + 1) % count];
    const toA = [a[0] - p[0], a[1] - p[1]], toB = [b[0] - p[0], b[1] - p[1]];
    const la = Math.hypot(...toA), lb = Math.hypot(...toB);
    const inA = [p[0] + (toA[0] / la) * r, p[1] + (toA[1] / la) * r];
    const inB = [p[0] + (toB[0] / lb) * r, p[1] + (toB[1] / lb) * r];
    parts.push(`${i === 0 ? 'M' : 'L'}${n(inA[0])} ${n(inA[1])}Q${n(p[0])} ${n(p[1])} ${n(inB[0])} ${n(inB[1])}`);
  }
  return parts.join('') + 'Z';
}
const PLOT = rounded([[20, 68], [50, 54], [80, 68], [50, 82]], 3);
// The pin: a head of radius 17 about (50, 35), tangent sides down to a tip at the plot's centre (50, 68), the tip itself rounded.
const PIN = 'M48.45 65.43L35.43 43.76A17 17 0 1 1 64.57 43.76L51.55 65.43Q50 68 48.45 65.43Z' + 'M42 35A8 8 0 1 0 58 35A8 8 0 1 0 42 35Z';
const mark = (height, cx = 50, cy = 50) => {
  const k = (height / 64).toFixed(5);
  return `<g transform="translate(${cx} ${cy}) scale(${k}) translate(-50 -50)"><path d="${PLOT}" fill="${SHADE}"/><path d="${PIN}" fill="${CARBON}" fill-rule="evenodd"/></g>`;
};
const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="${TILE}" fill="${GREEN}"/>${mark(64)}</svg>\n`;
fs.writeFileSync(path.join(root, 'docs/brand/icon.svg'), icon);
fs.writeFileSync(path.join(root, 'public/icon.svg'), icon);
// Android adaptive icon: the mark alone over a full-bleed background; the launcher cuts the shape.
fs.writeFileSync(path.join(root, 'docs/brand/android-fg.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${mark(44)}</svg>\n`);
fs.writeFileSync(path.join(root, 'docs/brand/android-bg.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="${GREEN}"/></svg>\n`);
// macOS wants its icons inset further than the rest (the tile sits in a 100-unit box at 82%).
fs.writeFileSync(path.join(root, 'docs/brand/icon-macos.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><g transform="translate(9 9) scale(0.82)"><path d="${TILE}" fill="${GREEN}"/>${mark(64)}</g></svg>\n`);

// --- the banner: 1280 x 360, Carbon, tile + name + one-liner + mono metadata + Shei Designs ------
const name = text(grotesk, 'PlastikWorld', 328, 172, 68);
const line = text(inter400, 'Build worlds for robot simulation.', 330, 226, 30);
const meta = text(mono, 'linux · windows · macos      gpl-3.0      gazebo sdf · mujoco mjcf · isaac usd', 332, 274, 17);
const shei = text(inter800, 'Shei Designs', 0, 0, 22, { tracking: -0.02 });
const sheiX = 1184 - shei.width - 14;
const sheiPath = text(inter800, 'Shei Designs', sheiX, 318, 22, { tracking: -0.02 });
const banner = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 360" role="img" aria-labelledby="t">
  <title id="t">PlastikWorld: build worlds for robot simulation. A Shei Designs project.</title>
  <rect width="1280" height="360" rx="28" fill="${CARBON}"/>
  <g transform="translate(80 80) scale(2)"><path d="${TILE}" fill="${GREEN}"/>${mark(64)}</g>
  <path d="${name.d}" fill="${LINEN}"/>
  <path d="${line.d}" fill="${LINEN}" opacity="0.86"/>
  <path d="${meta.d}" fill="${DUST}"/>
  <path d="${sheiPath.d}" fill="${LINEN}"/>
  <circle cx="${(sheiX + shei.width + 8).toFixed(1)}" cy="314" r="4" fill="${TAPE}"/>
</svg>
`;
fs.writeFileSync(path.join(root, 'docs/banner.svg'), banner);
console.log('name width', name.width.toFixed(0), 'meta width', meta.width.toFixed(0), 'shei x', sheiX.toFixed(0));
