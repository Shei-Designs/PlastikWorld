// Preferences, kept in localStorage. Worlds themselves live in files, not here.
import { FILE_FORMAT } from '../app';
import { newId } from '../model/math';

export type Theme = 'dark' | 'light';
export type Engine = 'gazebo' | 'mujoco' | 'isaac' | 'blender';
export const ENGINES: Engine[] = ['gazebo', 'mujoco', 'isaac', 'blender'];

export interface Prefs {
  theme: Theme;
  grid: boolean;
  /** Grid step that moves snap to, in meters; 0 turns snapping off. */
  snap: number;
  /** The engine the export panel is set to. */
  engine: Engine;
  /** Start the engine on the export (desktop). */
  run: boolean;
  /** The program the app starts an engine with, where the user pointed it elsewhere (a venv's Python); the writer's default otherwise. */
  programs: Partial<Record<Engine, string>>;
  /** The folder worlds are kept in, when the user picked one (desktop app); null for the default. */
  worldsDir: string | null;
  /** The world that was open last (its key in the store), to open it again at start-up. */
  lastWorld: string | null;
  /** This device, for the revision stamps sync reads; made once and kept. */
  device: string;
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
    engine: ENGINES.includes(saved.engine as Engine) ? (saved.engine as Engine) : 'gazebo',
    run: saved.run === true,
    programs: Object.fromEntries(Object.entries(saved.programs ?? {}).filter(([k, v]) => ENGINES.includes(k as Engine) && typeof v === 'string' && v.trim())) as Partial<Record<Engine, string>>,
    worldsDir: typeof saved.worldsDir === 'string' && saved.worldsDir ? saved.worldsDir : null,
    lastWorld: typeof saved.lastWorld === 'string' && saved.lastWorld ? saved.lastWorld : null,
    device: typeof saved.device === 'string' && /^[a-z0-9]{8,32}$/.test(saved.device) ? saved.device : newId(),
  };
}

export function savePrefs(prefs: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Storage full or blocked; preferences just won't persist.
  }
}
