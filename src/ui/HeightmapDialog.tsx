// Importing a heightmap image: the image as read, and what it should become:
// the grid, the area it covers and the heights of its black and white.
import { useEffect, useRef, useState } from 'react';
import { GRID_MAX, GRID_SIZES } from '../model/types';
import { applyHeightmap, closeHeightmap, useEditor } from '../state/store';
import { gridFor } from '../terrain/image';
import type { GreyImage } from '../terrain/image';
import { NumberField, SelectField } from './Fields';

/** Draws the greys on a small canvas, the first row at the top as in the file. */
function Preview({ image }: { image: GreyImage }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const scale = Math.max(1, Math.ceil(Math.max(image.width, image.height) / 256));
    const w = Math.max(1, Math.floor(image.width / scale)), h = Math.max(1, Math.floor(image.height / scale));
    el.width = w;
    el.height = h;
    const ctx = el.getContext('2d');
    if (!ctx) return;
    const pixels = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = Math.round(image.samples[y * scale * image.width + x * scale] * 255);
        const i = (y * w + x) * 4;
        pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = v;
        pixels.data[i + 3] = 255;
      }
    }
    ctx.putImageData(pixels, 0, 0);
  }, [image]);
  return <canvas ref={canvas} aria-label="The image as read" />;
}

export function HeightmapDialog() {
  const pending = useEditor((s) => s.heightmapImport);
  const terrain = useEditor((s) => s.world.terrain);
  const dialog = useRef<HTMLDialogElement>(null);
  const [samples, setSamples] = useState(129);
  const [size, setSize] = useState<[number, number]>([20, 20]);
  const [lowest, setLowest] = useState(0);
  const [highest, setHighest] = useState(1);
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (pending && !d.open) {
      // Fresh numbers for a fresh image: the grid its size suits, the terrain's area, a meter of height.
      setSamples(gridFor(pending.image));
      setSize([terrain.size[0], terrain.size[1]]);
      setLowest(0);
      setHighest(1);
      d.showModal();
    } else if (!pending && d.open) d.close();
    // The terrain's size is read once, when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);
  const image = pending?.image;
  return (
    <dialog
      ref={dialog}
      className="sheet"
      aria-label="Import a heightmap image"
      onCancel={(e) => {
        e.preventDefault();
        closeHeightmap();
      }}
      onKeyDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        if (e.target === e.currentTarget) closeHeightmap();
      }}
    >
      {image && (
        <form
          className="sheet-body"
          onSubmit={(e) => {
            e.preventDefault();
            applyHeightmap({ samples, lowest, highest: Math.max(highest, lowest) }, [Math.max(size[0], 0.1), Math.max(size[1], 0.1)]);
          }}
        >
          <h1>Heightmap from {pending.name}</h1>
          <div className="heightmap-preview">
            <Preview image={image} />
            <div>
              <p>
                {image.width} × {image.height} pixels, {image.depth}-bit{image.width !== image.height ? ', stretched onto the square grid' : ''}. Black is the lowest point, white the highest; the top of the image is +Y.
              </p>
              <SelectField label="Samples" value={String(samples)} options={GRID_SIZES.map((n) => ({ id: String(n), label: `${n} × ${n}${n > GRID_MAX ? ' (slow in Isaac Sim)' : ''}` }))} onChange={(v) => setSamples(Number(v))} />
            </div>
          </div>
          <div className="vec3" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <NumberField label="Width (X)" unit="m" value={size[0]} min={0.1} step={1} onChange={(v) => setSize([v, size[1]])} />
            <NumberField label="Depth (Y)" unit="m" value={size[1]} min={0.1} step={1} onChange={(v) => setSize([size[0], v])} />
          </div>
          <div className="vec3" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <NumberField label="Black (lowest)" unit="m" value={lowest} step={0.1} decimals={2} onChange={setLowest} />
            <NumberField label="White (highest)" unit="m" value={highest} step={0.1} decimals={2} onChange={setHighest} />
          </div>
          <div className="sheet-buttons">
            <button type="button" className="chip" onClick={closeHeightmap}>
              Cancel
            </button>
            <button type="submit" className="primary">
              Use as terrain
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}
