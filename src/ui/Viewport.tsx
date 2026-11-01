// The stage: the three.js viewer, the toolbar over it and the corner view widget.
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { Light, World } from '../model/types';
import { assetEpoch, loadedAsset, subscribeAssets } from '../state/assets';
import { SNAP_STEPS } from '../state/persist';
import { beginGesture, cancelPlacing, deleteSelected, duplicateSelected, endGesture, moveBy, placeAt, provideThumbnail, redo, select, setPrefs, showPanel, undo, useEditor } from '../state/store';
import { GIZMO_SIZE, Viewer } from '../viewer/Viewer';
import type { ViewItem, ViewPreset, Visual } from '../viewer/Viewer';
import { CloseIcon, DuplicateIcon, FitIcon, GridIcon, MenuIcon, RedoIcon, SlidersIcon, TrashIcon, UndoIcon } from './icons';

const VIEWS: { id: ViewPreset; label: string }[] = [
  { id: 'iso', label: 'Iso' },
  { id: 'top', label: 'Top' },
  { id: 'front', label: 'Front' },
  { id: 'side', label: 'Side' },
];

export const viewerRef: { current: Viewer | null } = { current: null };

function visualOf(world: World, assetId: string): Visual {
  const loaded = loadedAsset(assetId);
  if (loaded?.kind === 'glb') return { kind: 'glb', key: assetId, bytes: loaded.bytes };
  if (loaded?.kind === 'robot') return { kind: 'robot', key: assetId, parts: loaded.parts };
  void world;
  return { kind: 'missing', key: assetId };
}

function itemsOf(world: World, selection: string[], epoch: number): ViewItem[] {
  void epoch;
  const picked = new Set(selection);
  return [
    ...world.objects.map((o) => ({ id: o.id, name: o.name, pose: o.pose, scale: o.scale, selected: picked.has(o.id), visual: visualOf(world, o.asset) })),
    ...world.lights.map((l: Light) => ({ id: l.id, name: l.name, pose: l.pose, scale: 1, selected: picked.has(l.id), visual: { kind: 'light', light: l.kind } as Visual })),
    ...world.spawns.map((s) => ({ id: s.id, name: s.name, pose: s.pose, scale: 1, selected: picked.has(s.id), visual: { kind: 'spawn' } as Visual })),
  ];
}

export function Viewport() {
  const host = useRef<HTMLDivElement>(null);
  const readout = useRef<HTMLDivElement>(null);
  const world = useEditor((s) => s.world);
  const selection = useEditor((s) => s.selection);
  const prefs = useEditor((s) => s.prefs);
  const placing = useEditor((s) => s.placing);
  const busy = useEditor((s) => s.busy);
  const canUndo = useEditor((s) => s.canUndo);
  const canRedo = useEditor((s) => s.canRedo);
  const epoch = useSyncExternalStore(subscribeAssets, assetEpoch);
  const items = useMemo(() => itemsOf(world, selection, epoch), [world, selection, epoch]);

  useEffect(() => {
    const v = new Viewer(
      host.current!,
      {
        onSelect: select,
        onGestureStart: beginGesture,
        onMove: moveBy,
        onGestureEnd: endGesture,
        onPlace: placeAt,
        onReadout: (text, x, y) => {
          const el = readout.current;
          if (!el) return;
          el.hidden = text === null;
          if (text === null) return;
          el.textContent = text;
          const rect = host.current!.getBoundingClientRect();
          el.style.left = `${x - rect.left + 16}px`;
          el.style.top = `${y - rect.top + 16}px`;
        },
      },
      { theme: prefs.theme, grid: prefs.grid, snap: prefs.snap },
    );
    viewerRef.current = v;
    provideThumbnail(() => v.snapshot());
    return () => {
      provideThumbnail(null);
      v.dispose();
      viewerRef.current = null;
    };
    // The viewer is made once; options follow through setOptions below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => viewerRef.current?.setItems(items, world.terrain), [items, world.terrain]);
  useEffect(() => viewerRef.current?.setOptions({ theme: prefs.theme, grid: prefs.grid, snap: prefs.snap }), [prefs.theme, prefs.grid, prefs.snap]);
  useEffect(() => viewerRef.current?.setPlacing(placing !== null), [placing]);

  const placingLabel = placing ? (placing.kind === 'asset' ? world.assets.find((a) => a.id === placing.asset)?.name ?? 'object' : placing.kind === 'light' ? `${placing.light} light` : 'spawn point') : null;
  const empty = world.objects.length === 0 && world.spawns.length === 0;

  return (
    <div className="viewport" ref={host}>
      <div className="toolbar">
        <button type="button" className="chip icon narrow-only" title="World and objects" aria-label="Show the world panel" onClick={() => showPanel('sidebar')}>
          <MenuIcon />
        </button>
        <button type="button" className="chip icon" title="Undo (Ctrl+Z)" aria-label="Undo" disabled={!canUndo} onClick={undo}>
          <UndoIcon />
        </button>
        <button type="button" className="chip icon" title="Redo (Ctrl+Y)" aria-label="Redo" disabled={!canRedo} onClick={redo}>
          <RedoIcon />
        </button>
        <span className="gap" />
        <button type="button" className="chip icon" title="Duplicate (Ctrl+D)" aria-label="Duplicate" disabled={selection.length === 0} onClick={duplicateSelected}>
          <DuplicateIcon />
        </button>
        <button type="button" className="chip icon" title="Delete (Del)" aria-label="Delete" disabled={selection.length === 0} onClick={deleteSelected}>
          <TrashIcon />
        </button>
        <span className="spacer" />
        <button type="button" className={`chip icon${prefs.grid ? ' on' : ''}`} title="Grid" aria-label="Grid" aria-pressed={prefs.grid} onClick={() => setPrefs({ grid: !prefs.grid })}>
          <GridIcon />
        </button>
        <select className="chip" value={prefs.snap} aria-label="Snap step" title="Snap moves to a step" onChange={(e) => setPrefs({ snap: Number(e.target.value) })}>
          {SNAP_STEPS.map((s) => (
            <option key={s} value={s}>
              {s === 0 ? 'Free' : s >= 1 ? `${s} m` : `${s * 100} cm`}
            </option>
          ))}
        </select>
        <button type="button" className="chip icon narrow-only" title="Properties" aria-label="Show the properties panel" onClick={() => showPanel('inspector')}>
          <SlidersIcon />
        </button>
      </div>
      {empty && !placing && (
        <div className="stage-empty">
          <strong>An empty world</strong>
          Import a GLB object or a robot package from PlastikCAD, then drag things into place. Right-drag turns the camera, middle-drag pans, the wheel zooms.
        </div>
      )}
      {placing && (
        <div className="stage-hint">
          <span>Click on the ground to place the {placingLabel}.</span>
          <button type="button" className="icon-button" aria-label="Stop placing" onClick={cancelPlacing}>
            <CloseIcon />
          </button>
        </div>
      )}
      {busy && (
        <div className="busy">
          <span>{busy}</span>
        </div>
      )}
      <div className="readout" ref={readout} hidden />
      <ViewWidget />
    </div>
  );
}

/**
 * The corner widget: the axis triad the viewer draws (it tracks the camera),
 * with the camera presets and fit beneath it. The triad is drawn on the
 * canvas, so the widget tells the viewer where its space is.
 */
function ViewWidget() {
  const space = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = space.current;
    const host = el?.closest('.viewport');
    if (!el || !host) return;
    const place = () => {
      const a = el.getBoundingClientRect();
      const b = host.getBoundingClientRect();
      viewerRef.current?.setTriadOrigin(a.left - b.left, b.bottom - a.bottom);
    };
    place();
    const watch = new ResizeObserver(place);
    watch.observe(el);
    watch.observe(host);
    return () => watch.disconnect();
  }, []);
  return (
    <div className="view-widget">
      <div className="triad-space" ref={space} style={{ width: GIZMO_SIZE, height: GIZMO_SIZE }} />
      <div className="view-row">
        <div className="segmented small" role="group" aria-label="Camera view">
          {VIEWS.map((v) => (
            <button key={v.id} type="button" onClick={() => viewerRef.current?.setView(v.id)}>
              {v.label}
            </button>
          ))}
        </div>
        <button type="button" className="chip icon" title="Fit to view (F)" aria-label="Fit to view" onClick={() => viewerRef.current?.fit()}>
          <FitIcon />
        </button>
      </div>
    </div>
  );
}
