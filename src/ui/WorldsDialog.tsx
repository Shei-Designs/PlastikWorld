// The worlds browser: every world in the store, newest first, with the picture
// it saved, to open or delete; the folder they live in, and a way to bring a
// world file in from elsewhere.
import { useEffect, useRef } from 'react';
import { chooseWorldsFolder, closeWorlds, deleteWorld, openWorldFile, openWorldKey, useEditor } from '../state/store';
import { FolderIcon, TrashIcon, WorldIcon } from './icons';

const when = (ms: number): string => (ms ? new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');

export function WorldsDialog() {
  const open = useEditor((s) => s.browsing);
  const worlds = useEditor((s) => s.worlds);
  const storage = useEditor((s) => s.storage);
  const current = useEditor((s) => s.key);
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
      className="sheet wide"
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
        <h1>Worlds</h1>
        <p className="clip" title={storage?.location ?? ''}>
          {storage?.location ?? 'Kept by this browser, on this device.'}
        </p>
        <div className="worlds-grid">
          {worlds.map((w) => (
            <div key={w.key} className={`world-card${w.key === current ? ' on' : ''}`} role="button" tabIndex={0} onClick={() => void openWorldKey(w.key)} onKeyDown={(e) => e.key === 'Enter' && void openWorldKey(w.key)}>
              <div className="world-thumb">{w.thumb ? <img src={w.thumb} alt="" /> : <WorldIcon />}</div>
              <div className="row">
                <span className="name clip" title={w.name}>
                  {w.name}
                </span>
                <button
                  type="button"
                  className="icon-button"
                  title="Delete"
                  aria-label={`Delete ${w.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    void deleteWorld(w);
                  }}
                >
                  <TrashIcon />
                </button>
              </div>
              <span className="meta">{when(w.modified)}</span>
            </div>
          ))}
          {worlds.length === 0 && <p>No worlds yet. A world is saved here as you work on it.</p>}
        </div>
        <div className="sheet-buttons">
          {storage && !storage.fixed && (
            <button type="button" className="chip" onClick={() => void chooseWorldsFolder()}>
              <FolderIcon /> Change folder…
            </button>
          )}
          <button type="button" className="chip" onClick={() => void openWorldFile()}>
            Open world file…
          </button>
          <button type="button" className="primary" onClick={closeWorlds}>
            Close
          </button>
        </div>
      </div>
    </dialog>
  );
}
