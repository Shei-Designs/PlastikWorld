import { useEffect } from 'react';
import * as platform from './platform';
import {
  cancelPlacing,
  deleteSelected,
  dismissNotice,
  duplicateSelected,
  getState,
  importObjects,
  importRobot,
  isDirty,
  newWorld,
  nudgeSelected,
  openWorldFile,
  openWorlds,
  receiveFiles,
  redo,
  restoreSession,
  saveAs,
  saveNow,
  select,
  selectAll,
  showAbout,
  showExport,
  titleOf,
  undo,
  useEditor,
} from './state/store';
import { About } from './ui/About';
import { ExportDialog } from './ui/ExportDialog';
import { Inspector } from './ui/Inspector';
import { Sidebar } from './ui/Sidebar';
import { Viewport, viewerRef } from './ui/Viewport';
import { WorldsDialog } from './ui/WorldsDialog';
import { CheckIcon, CloseIcon, WarningIcon } from './ui/icons';

// Inputs that take no typing: clicking one of these must not put the shortcuts to sleep.
const CLICK_INPUTS = new Set(['checkbox', 'radio', 'color', 'button', 'submit', 'reset', 'file']);

const typing = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLInputElement) return !CLICK_INPUTS.has(target.type);
  return target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable;
};

/** Lets a box being typed in commit its value first, so a save takes the number on screen. */
const commitTyping = (): void => {
  const active = document.activeElement;
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement) active.blur();
};

function onKeyDown(e: KeyboardEvent): void {
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;

  // File commands work everywhere, including from inside a text box.
  if (mod && !e.altKey) {
    const command =
      key === 's' ? (e.shiftKey ? saveAs : saveNow) : key === 'o' ? (e.shiftKey ? openWorldFile : openWorlds) : key === 'n' ? newWorld : key === 'i' ? (e.shiftKey ? importRobot : importObjects) : key === 'e' ? () => showExport(true) : null;
    if (command) {
      e.preventDefault();
      commitTyping();
      void command();
      return;
    }
  }
  if (typing(e.target)) return;

  if (key === 'Escape') {
    if (viewerRef.current?.cancelGesture()) return;
    if (getState().placing) cancelPlacing();
    else select(null);
    return;
  }
  if (mod && key === 'z') {
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
    return;
  }
  if (mod && key === 'y') {
    e.preventDefault();
    redo();
    return;
  }
  if (mod && key === 'd') {
    e.preventDefault();
    duplicateSelected();
    return;
  }
  if (mod && key === 'a') {
    e.preventDefault();
    selectAll();
    return;
  }
  if (key === 'Delete' || key === 'Backspace') {
    deleteSelected();
    return;
  }
  if (key === 'f') {
    viewerRef.current?.fit();
    return;
  }
  const step = e.shiftKey ? 1 : getState().prefs.snap || 0.05;
  const nudge = key === 'ArrowLeft' ? [-step, 0, 0] : key === 'ArrowRight' ? [step, 0, 0] : key === 'ArrowUp' ? (mod ? [0, 0, step] : [0, step, 0]) : key === 'ArrowDown' ? (mod ? [0, 0, -step] : [0, -step, 0]) : null;
  if (nudge) {
    e.preventDefault();
    nudgeSelected(nudge as [number, number, number]);
  }
}

function Toast() {
  const notice = useEditor((s) => s.notice);
  if (!notice) return null;
  return (
    <div className="toasts">
      <div className={`toast ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>
        {notice.kind === 'error' ? <WarningIcon /> : notice.kind === 'ok' ? <CheckIcon /> : null}
        <span>{notice.text}</span>
        {notice.action && (
          <button type="button" className="chip" onClick={notice.action.run}>
            {notice.action.label}
          </button>
        )}
        <button type="button" className="icon-button" aria-label="Dismiss" onClick={dismissNotice}>
          <CloseIcon />
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const theme = useEditor((s) => s.prefs.theme);
  const title = useEditor((s) => titleOf(s.world));
  const about = useEditor((s) => s.about);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => platform.setWindowTitle(title), [title]);

  useEffect(() => {
    window.addEventListener('keydown', onKeyDown);
    const stopDrops = platform.onFilesDropped((files) => void receiveFiles(files));
    const stopClose = platform.guardClose(isDirty, saveNow);
    void restoreSession();
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      stopDrops();
      stopClose();
    };
  }, []);

  return (
    <div className="app">
      <Sidebar />
      <main className="stage">
        <Viewport />
      </main>
      <Inspector />
      <Toast />
      <About open={about} onClose={() => showAbout(false)} />
      <ExportDialog />
      <WorldsDialog />
    </div>
  );
}
