// The worlds browser (desktop): the worlds in the worlds folder, to open or delete.
import { useEffect, useRef } from 'react';
import { chooseWorldsFolder, closeWorlds, deleteWorldFile, openWorldFile, openWorldPath, useEditor } from '../state/store';
import { FolderIcon, TrashIcon, WorldIcon } from './icons';

const when = (ms: number): string => (ms ? new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');

export function WorldsDialog() {
  const open = useEditor((s) => s.browsing);
  const worlds = useEditor((s) => s.worlds);
  const location = useEditor((s) => s.storage?.location ?? null);
  const current = useEditor((s) => s.path);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={dialog}
      className="sheet"
      aria-label="Open a world"
      onCancel={(e) => {
        e.preventDefault();
        closeWorlds();
      }}
      onKeyDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        if (e.target === e.currentTarget) closeWorlds();
      }}
    >
      <div className="sheet-body">
        <h1>Open a world</h1>
        <p className="clip" title={location ?? ''}>
          {location}
        </p>
        <div className="world-list">
          {worlds.map((w) => (
            <div key={w.path} className="world-row">
              <button type="button" className={`tree-item${w.path === current ? ' on' : ''}`} onClick={() => void openWorldPath(w.path)}>
                <WorldIcon />
                <span className="clip">{w.name.replace(/\.plastikworld$/i, '')}</span>
                <span className="meta">{when(w.modified)}</span>
              </button>
              <button type="button" className="icon-button" title="Delete" aria-label={`Delete ${w.name}`} onClick={() => void deleteWorldFile(w)}>
                <TrashIcon />
              </button>
            </div>
          ))}
          {worlds.length === 0 && <p>No worlds in this folder yet. Save one with Ctrl+S.</p>}
        </div>
        <div className="sheet-buttons">
          <button type="button" className="chip" onClick={() => void chooseWorldsFolder()}>
            <FolderIcon /> Change folder…
          </button>
          <button type="button" className="chip" onClick={() => void openWorldFile()}>
            Browse for a file…
          </button>
          <button type="button" className="primary" onClick={closeWorlds}>
            Close
          </button>
        </div>
      </div>
    </dialog>
  );
}
