// Export: pick the engine, see what will be written, write it.
import { useEffect, useRef, useState } from 'react';
import type { ExportBundle } from '../io/export';
import type { Engine } from '../state/persist';
import { buildBundle, exportWorld, setPrefs, showExport, useEditor } from '../state/store';

const ENGINES: { id: Engine; label: string; note: string }[] = [
  { id: 'gazebo', label: 'Gazebo', note: 'An SDF world with the physics and sensor systems, the ground, the props as models, and the robots included or spawned from a ROS 2 launch file.' },
  { id: 'mujoco', label: 'MuJoCo', note: 'An MJCF with the ground as a plane or hfield, the props as mesh bodies (OBJ), and each robot attached from its own model file.' },
  { id: 'isaac', label: 'Isaac Sim', note: 'A USDA stage with a physics scene, the ground and props as collision meshes, lights, and each robot referenced from the USD its package carries.' },
];

export function ExportDialog() {
  const open = useEditor((s) => s.exporting);
  const engine = useEditor((s) => s.prefs.engine);
  const world = useEditor((s) => s.world);
  const busy = useEditor((s) => s.busy);
  const dialog = useRef<HTMLDialogElement>(null);
  const [preview, setPreview] = useState<ExportBundle | null>(null);
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    let live = true;
    setPreview(null);
    buildBundle(engine).then((bundle) => live && setPreview(bundle), console.warn);
    return () => {
      live = false;
    };
  }, [open, engine, world]);
  const chosen = ENGINES.find((e) => e.id === engine)!;
  return (
    <dialog
      ref={dialog}
      className="sheet"
      aria-label="Export world"
      onCancel={(e) => {
        e.preventDefault();
        showExport(false);
      }}
      onKeyDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        if (e.target === e.currentTarget) showExport(false);
      }}
    >
      <div className="sheet-body">
        <h1>Export {world.name}</h1>
        <div className="segmented" role="group" aria-label="Engine">
          {ENGINES.map((e) => (
            <button key={e.id} type="button" className={engine === e.id ? 'on' : ''} onClick={() => setPrefs({ engine: e.id })}>
              {e.label}
            </button>
          ))}
        </div>
        <p>{chosen.note}</p>
        {preview && (
          <>
            <ul className="file-list">
              {preview.files.map((f) => (
                <li key={f.path}>
                  {preview.name}/{f.path}
                </li>
              ))}
              {preview.copies.map((c) => (
                <li key={c.to}>
                  {preview.name}/{c.to}/ (copied from {c.from})
                </li>
              ))}
            </ul>
            {preview.notes.map((n) => (
              <p key={n} className="note">
                {n}
              </p>
            ))}
            <div className="launch">{preview.launch}</div>
          </>
        )}
        <div className="sheet-buttons">
          <button type="button" className="chip" onClick={() => showExport(false)}>
            Cancel
          </button>
          <button type="button" className="primary" disabled={!preview || busy !== null} onClick={() => void exportWorld(engine)}>
            Export…
          </button>
        </div>
      </div>
    </dialog>
  );
}
