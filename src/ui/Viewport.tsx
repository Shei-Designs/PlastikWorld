// The stage: the three.js viewer, the toolbar over it and the corner view widget.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Light, World } from '../model/types';
import { assetEpoch, loadedAsset, subscribeAssets } from '../state/assets';
import { SNAP_STEPS } from '../state/persist';
import { addZone, beginGesture, beginSculpt, cancelPlacing, deleteSelected, driveTick, duplicateSelected, endGesture, endSculpt, moveBy, placeAt, provideThumbnail, redo, sculptAt, select, setPrefs, setTool, showPanel, stopDrive, undo, useEditor } from '../state/store';
import { readInput, setStick, startListening, stopListening } from '../drive/input';
import { BRUSH_KINDS } from '../terrain/brush';
import { GIZMO_SIZE, Viewer } from '../viewer/Viewer';
import type { ViewItem, ViewPreset, ViewZone, Visual } from '../viewer/Viewer';
import { CloseIcon, DuplicateIcon, FitIcon, GridIcon, MenuIcon, RedoIcon, SlidersIcon, TrashIcon, UndoIcon } from './icons';
import type { PointerEvent as ReactPointerEvent } from 'react';

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
  if (loaded?.kind === 'part') return { kind: 'mesh', key: loaded.key, data: loaded.resolved.data! };
  if (loaded?.kind === 'robot') return { kind: 'robot', key: assetId, parts: loaded.parts };
  void world;
  return { kind: 'missing', key: assetId };
}

function itemsOf(world: World, selection: string[], epoch: number, driven: { id: string; at: World['objects'][number]['pose'] } | null): ViewItem[] {
  void epoch;
  const picked = new Set(selection);
  return [
    ...world.objects.map((o) => ({ id: o.id, name: o.name, pose: driven?.id === o.id ? driven.at : o.pose, scale: o.scale, selected: picked.has(o.id), visual: visualOf(world, o.asset) })),
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
  const tool = useEditor((s) => s.tool);
  const busy = useEditor((s) => s.busy);
  const canUndo = useEditor((s) => s.canUndo);
  const canRedo = useEditor((s) => s.canRedo);
  const epoch = useSyncExternalStore(subscribeAssets, assetEpoch);
  const drive = useEditor((s) => s.drive);
  const driven = useMemo(() => (drive ? { id: drive.id, at: drive.at } : null), [drive?.id, drive?.at]);
  const items = useMemo(() => itemsOf(world, selection, epoch, driven), [world, selection, epoch, driven]);
  const zones = useMemo<ViewZone[]>(() => world.zones.map((zone) => ({ zone, color: world.materials.find((m) => m.id === zone.material)?.color ?? [0.5, 0.5, 0.5], selected: selection.includes(zone.id) })), [world.zones, world.materials, selection]);

  useEffect(() => {
    const v = new Viewer(
      host.current!,
      {
        onSelect: select,
        onGestureStart: beginGesture,
        onMove: moveBy,
        onGestureEnd: endGesture,
        onPlace: placeAt,
        onSculptStart: (point) => beginSculpt(point, (window) => v.refreshHeights(window)),
        onSculpt: sculptAt,
        onSculptEnd: endSculpt,
        onZone: addZone,
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

  useEffect(() => viewerRef.current?.setItems(items, world.terrain, zones), [items, world.terrain, zones]);
  useEffect(() => viewerRef.current?.setOptions({ theme: prefs.theme, grid: prefs.grid, snap: prefs.snap }), [prefs.theme, prefs.grid, prefs.snap]);
  useEffect(() => viewerRef.current?.setPlacing(placing !== null), [placing]);
  useEffect(() => viewerRef.current?.setSculpt(tool?.kind === 'sculpt' ? tool.brush.radius : null), [tool]);
  useEffect(() => viewerRef.current?.setZoneTool(tool?.kind === 'zone'), [tool]);
  useEffect(() => viewerRef.current?.setEnvironment(world.environment), [world.environment]);

  // The drive loop: while driving, every frame reads the input, moves the object and rides the camera along.
  const driving = drive !== null;
  useEffect(() => {
    if (!driving) {
      viewerRef.current?.setTrail(null);
      return;
    }
    startListening();
    let last = performance.now();
    let frame = requestAnimationFrame(function tick(now) {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      driveTick(dt, readInput());
      frame = requestAnimationFrame(tick);
    });
    return () => {
      cancelAnimationFrame(frame);
      stopListening();
    };
  }, [driving]);
  useEffect(() => {
    if (!drive) return;
    viewerRef.current?.follow(drive.at.xyz);
    viewerRef.current?.setTrail(drive.trail);
  }, [drive]);
  // A terrain of another size (real elevation is kilometres across) would leave the camera where it was: refit.
  const [sizeX, sizeY] = world.terrain.size;
  useEffect(() => void viewerRef.current?.fit(), [sizeX, sizeY]);

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
      {empty && !placing && !tool && (
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
      {tool && (
        <div className="stage-hint">
          <span>
            {tool.kind === 'sculpt' ? `${BRUSH_KINDS.find((b) => b.id === tool.brush.kind)?.hint}. Two fingers or the right button turn the camera; [ and ] change the brush size; Esc stops.` : 'Drag a rectangle on the ground to make a surface zone. Esc stops.'}
          </span>
          <button type="button" className="icon-button" aria-label="Stop sculpting" onClick={() => setTool(null)}>
            <CloseIcon />
          </button>
        </div>
      )}
      {busy && (
        <div className="busy">
          <span>{busy}</span>
        </div>
      )}
      {drive && (
        <>
          <div className="stage-hint">
            <span>
              Driving {world.objects.find((o) => o.id === drive.id)?.name}: W A S D or the arrows{drive.spec.model === 'holonomic' ? ', Q and E to strafe' : ''}, Shift to creep, a gamepad, or the stick. {drive.hit ? `Up against ${drive.hit}.` : ''} Esc puts it back; Park keeps it here.
            </span>
            <button type="button" className="chip" onClick={() => stopDrive(true)}>
              Park
            </button>
            <button type="button" className="icon-button" aria-label="Stop driving and put it back" onClick={() => stopDrive(false)}>
              <CloseIcon />
            </button>
          </div>
          <DriveStick />
        </>
      )}
      <div className="readout" ref={readout} hidden />
      <ViewWidget />
    </div>
  );
}

/** An on-screen stick for fingers: drag the knob, forward is up, left is left. */
function DriveStick() {
  const pad = useRef<HTMLDivElement>(null);
  const [knob, setKnob] = useState({ x: 0, y: 0 });
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    const rect = pad.current!.getBoundingClientRect();
    const r = rect.width / 2;
    let dx = (e.clientX - rect.left - r) / r, dy = (e.clientY - rect.top - r) / r;
    const len = Math.hypot(dx, dy);
    if (len > 1) {
      dx /= len;
      dy /= len;
    }
    setKnob({ x: dx, y: dy });
    setStick(-dy, -dx);
  };
  const release = () => {
    setKnob({ x: 0, y: 0 });
    setStick(0, 0);
  };
  return (
    <div
      className="drive-stick"
      ref={pad}
      aria-label="Drive stick"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        move(e);
      }}
      onPointerMove={(e) => {
        if (e.buttons) move(e);
      }}
      onPointerUp={release}
      onPointerCancel={release}
    >
      <div className="knob" style={{ transform: `translate(${knob.x * 40}px, ${knob.y * 40}px)` }} />
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
