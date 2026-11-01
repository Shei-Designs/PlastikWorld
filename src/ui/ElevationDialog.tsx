// Importing real elevation: the DEM at a glance with the box to take drawn
// on it (drag to draw another), what that box covers on the ground, and how
// it goes onto the grid.
import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { GRID_MAX, GRID_SIZES } from '../model/types';
import { applyElevation, closeElevation, setElevationBox, useEditor } from '../state/store';
import { boxMeters } from '../terrain/elevation';
import type { Dem, DemBox } from '../terrain/elevation';
import { CheckField, NumberField, SelectField } from './Fields';

/** The preview greys drawn to a canvas, the first row at the top as in the file (north up). */
function Picker({ dem, box, onBox }: { dem: Dem; box: DemBox; onBox: (box: DemBox) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const { width, height, samples } = dem.preview;
    el.width = width;
    el.height = height;
    const ctx = el.getContext('2d');
    if (!ctx) return;
    const pixels = ctx.createImageData(width, height);
    for (let i = 0; i < samples.length; i++) {
      const v = Math.round(samples[i] * 255);
      pixels.data[i * 4] = pixels.data[i * 4 + 1] = pixels.data[i * 4 + 2] = v;
      pixels.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(pixels, 0, 0);
  }, [dem]);
  /** A pointer position as a pixel of the DEM. */
  const at = (e: ReactPointerEvent): { x: number; y: number } => {
    const rect = host.current!.getBoundingClientRect();
    return { x: Math.min(dem.width, Math.max(0, ((e.clientX - rect.left) / rect.width) * dem.width)), y: Math.min(dem.height, Math.max(0, ((e.clientY - rect.top) / rect.height) * dem.height)) };
  };
  const place = (from: { x: number; y: number }, to: { x: number; y: number }) => {
    const x0 = Math.floor(Math.min(from.x, to.x)), x1 = Math.ceil(Math.max(from.x, to.x)), y0 = Math.floor(Math.min(from.y, to.y)), y1 = Math.ceil(Math.max(from.y, to.y));
    if (x1 - x0 >= 2 && y1 - y0 >= 2) onBox({ x0, y0, x1, y1 });
  };
  const left = (box.x0 / dem.width) * 100, top = (box.y0 / dem.height) * 100, w = ((box.x1 - box.x0) / dem.width) * 100, h = ((box.y1 - box.y0) / dem.height) * 100;
  return (
    <div
      className="dem-picker"
      ref={host}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        setDragging(at(e));
      }}
      onPointerMove={(e) => {
        if (dragging) place(dragging, at(e));
      }}
      onPointerUp={(e) => {
        if (dragging) place(dragging, at(e));
        setDragging(null);
      }}
      onPointerCancel={() => setDragging(null)}
    >
      <canvas ref={canvas} aria-label="The elevation, north up; drag to choose a box" />
      <div className="box" style={{ left: `${left}%`, top: `${top}%`, width: `${w}%`, height: `${h}%` }} />
    </div>
  );
}

export function ElevationDialog() {
  const pending = useEditor((s) => s.elevationImport);
  const dialog = useRef<HTMLDialogElement>(null);
  const [samples, setSamples] = useState(257);
  const [exaggeration, setExaggeration] = useState(1);
  const [levelLowest, setLevelLowest] = useState(true);
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (pending && !d.open) d.showModal();
    else if (!pending && d.open) d.close();
  }, [pending]);
  const dem = pending?.dem;
  const box = pending?.box;
  const [width, depth] = dem && box ? boxMeters(dem, box) : [0, 0];
  const perSample = dem && box ? Math.max(width, depth) / (samples - 1) : 0;
  const native = dem && box ? Math.max(width / (box.x1 - box.x0), depth / (box.y1 - box.y0)) : 0;
  return (
    <dialog
      ref={dialog}
      className="sheet wide"
      aria-label="Import elevation"
      onCancel={(e) => {
        e.preventDefault();
        closeElevation();
      }}
      onKeyDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        if (e.target === e.currentTarget) closeElevation();
      }}
    >
      {dem && box && (
        <form
          className="sheet-body"
          onSubmit={(e) => {
            e.preventDefault();
            void applyElevation({ samples, exaggeration: Math.max(exaggeration, 0.01), levelLowest });
          }}
        >
          <h1>Elevation from {dem.name}</h1>
          <p>Drag on the picture to choose the box the terrain covers. North is up.</p>
          <Picker dem={dem} box={box} onBox={setElevationBox} />
          <dl className="dem-facts">
            <dt>The whole DEM</dt>
            <dd>
              {dem.width} × {dem.height} samples, {dem.previewRange[0].toFixed(0)} to {dem.previewRange[1].toFixed(0)} m
            </dd>
            <dt>The box covers</dt>
            <dd>
              {width.toFixed(0)} × {depth.toFixed(0)} m, {native.toFixed(1)} m a sample in the DEM
            </dd>
            <dt>On the grid</dt>
            <dd>
              {perSample.toFixed(1)} m a sample{perSample < native * 0.5 ? ' (finer than the DEM: it will look smooth)' : ''}
            </dd>
          </dl>
          <div className="vec3" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <SelectField label="Samples" value={String(samples)} options={GRID_SIZES.map((n) => ({ id: String(n), label: `${n} × ${n}${n > GRID_MAX ? ' (slow in Isaac Sim)' : ''}` }))} onChange={(v) => setSamples(Number(v))} />
            <NumberField label="Heights multiplied by" value={exaggeration} min={0.01} step={0.5} decimals={2} onChange={setExaggeration} />
          </div>
          <CheckField label="Bring the lowest point to z = 0 (otherwise heights stay above sea level)" value={levelLowest} onChange={setLevelLowest} />
          <div className="sheet-buttons">
            <button type="button" className="chip" onClick={closeElevation}>
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
