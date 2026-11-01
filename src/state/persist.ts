// Preferences, kept in localStorage. Worlds themselves live in files, not here.
import { FILE_FORMAT } from '../app';

export type Theme = 'dark' | 'light';
export type Engine = 'gazebo' | 'mujoco' | 'isaac';

export interface Prefs {
  theme: Theme;
  grid: boolean;
  /** Grid step that moves snap to, in meters; 0 turns snapping off. */
  snap: number;
  /** The engine the export panel is set to. */
  engine: Engine;
  /** The folder worlds are kept in, when the user picked one (desktop app); null for the default. */
  worldsDir: string | null;
  /** The world that was open last, to open it again at start-up. */
  lastWorld: string | null;
}

export const SNAP_STEPS = [0, 0.01, 0.05, 0.1, 0.25, 0.5, 1];

const PREFS_KEY = `${FILE_FORMAT}:prefs:v1`;

export function loadPrefs(): Prefs {
  let saved: Partial<Prefs> = {};
  try {
    saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') ?? {};
  } catch {
    // Corrupt or unavailable storage: start from defaults.
  }
  const prefersLight = typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches;
  return {
    theme: saved.theme === 'light' || saved.theme === 'dark' ? saved.theme : prefersLight ? 'light' : 'dark',
    grid: saved.grid ?? true,
    snap: SNAP_STEPS.includes(saved.snap as number) ? (saved.snap as number) : 0.05,
    engine: saved.engine === 'mujoco' || saved.engine === 'isaac' ? saved.engine : 'gazebo',
    worldsDir: typeof saved.worldsDir === 'string' && saved.worldsDir ? saved.worldsDir : null,
    lastWorld: typeof saved.lastWorld === 'string' && saved.lastWorld ? saved.lastWorld : null,
  };
}

export function savePrefs(prefs: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Storage full or blocked; preferences just won't persist.
  }
}
