// The worlds browser: every world in the store, newest first, with the picture
// it saved, to open or delete; the folder they live in, and a way to bring a
// world file in from elsewhere.
import { useEffect, useRef } from 'react';
import { isDesktop } from '../platform';
import { chooseWorldsFolder, closeWorlds, deleteWorld, linkGoogleDrive, openWorldFile, openWorldKey, unlinkGoogleDrive, useEditor } from '../state/store';
import { cancelLink, syncNow, useSyncStatus } from '../sync/sync';
import { FolderIcon, TrashIcon, WorldIcon } from './icons';

const when = (ms: number): string => (ms ? new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');
const timeOf = (ms: number): string => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/** The Google Drive line: link, or the account and when it last synced. PlastikCAD's projects browser has the same. */
function DriveRow() {
  const sync = useSyncStatus();
  if (!sync.configured) return <span className="clip">Google Drive sync is not set up in this build.</span>;
  if (!isDesktop()) return <span className="clip">Google Drive sync works in the desktop and Android apps.</span>;
  if (!sync.linked) {
    return (
      <>
        <span className="clip">Google Drive: not linked{sync.error ? ` · ${sync.error}` : ''}</span>
        <button type="button" className="chip" title={sync.busy ? 'Gives up the sign-in' : 'Keeps your worlds in step across devices through your Google Drive'} onClick={() => (sync.busy ? cancelLink() : void linkGoogleDrive())}>
          {sync.busy ? 'Cancel sign-in' : 'Link Google Drive…'}
        </button>
      </>
    );
  }
  const state = sync.busy ? 'Syncing…' : sync.offline ? 'Offline' : sync.error ? sync.error : sync.lastSync ? `Synced at ${timeOf(sync.lastSync)}` : 'Not synced yet';
  return (
    <>
      <span className={sync.error && !sync.busy ? 'clip sync-error' : 'clip'}>
        Google Drive: {sync.email ?? 'linked'} · {state}
      </span>
      <button type="button" className="chip" disabled={sync.busy} title="Syncs with Google Drive now" onClick={() => void syncNow()}>
        Sync now
      </button>
      <button type="button" className="chip" disabled={sync.busy} title="Stops syncing with Google Drive" onClick={() => void unlinkGoogleDrive()}>
        Unlink
      </button>
    </>
  );
}

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
        <div className="drive-row">
          <DriveRow />
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
