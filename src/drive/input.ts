// What the driver is doing: the keys held (WASD and the arrows), the first
// gamepad's sticks, and the on-screen stick, folded into one forward, turn
// and strafe. Listening starts and stops with the drive, and while it is on
// the drive's keys do not reach the editor's shortcuts.
import type { DriveInput } from './kinematics';

const held = new Set<string>();
let stick: DriveInput = { forward: 0, turn: 0, strafe: 0 };
let listening = false;

const DRIVE_KEYS = new Set(['w', 'a', 's', 'd', 'q', 'e', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Shift']);

const onKey = (event: KeyboardEvent): void => {
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (!DRIVE_KEYS.has(key)) return;
  const target = event.target as HTMLElement | null;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) return;
  if (event.type === 'keydown') held.add(key);
  else held.delete(key);
  event.preventDefault();
  event.stopImmediatePropagation();
};

const onBlur = (): void => held.clear();

export function startListening(): void {
  if (listening) return;
  listening = true;
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', onKey, true);
  window.addEventListener('blur', onBlur);
}

export function stopListening(): void {
  if (!listening) return;
  listening = false;
  window.removeEventListener('keydown', onKey, true);
  window.removeEventListener('keyup', onKey, true);
  window.removeEventListener('blur', onBlur);
  held.clear();
  stick = { forward: 0, turn: 0, strafe: 0 };
}

/** The on-screen stick's position, each -1..1 (forward up, turn left positive); strafe with a second finger is not offered. */
export function setStick(forward: number, turn: number): void {
  stick = { forward, turn, strafe: 0 };
}

const dead = (v: number): number => (Math.abs(v) < 0.12 ? 0 : v);

/** The input right now: whichever of keys, gamepad and stick is being used, the largest in each axis. */
export function readInput(): DriveInput {
  let forward = 0, turn = 0, strafe = 0;
  if (held.has('w') || held.has('ArrowUp')) forward += 1;
  if (held.has('s') || held.has('ArrowDown')) forward -= 1;
  if (held.has('a') || held.has('ArrowLeft')) turn += 1;
  if (held.has('d') || held.has('ArrowRight')) turn -= 1;
  if (held.has('q')) strafe += 1;
  if (held.has('e')) strafe -= 1;
  if (held.has('Shift')) forward *= 0.4;
  if (typeof navigator !== 'undefined' && navigator.getGamepads) {
    const pad = Array.from(navigator.getGamepads()).find((g) => g && g.connected);
    if (pad) {
      // Left stick drives, right stick turns (a car's wheel), as most robot teleops do; the left stick's X strafes.
      const f = -dead(pad.axes[1] ?? 0), s = -dead(pad.axes[0] ?? 0), t = -dead(pad.axes[2] ?? 0);
      if (Math.abs(f) > Math.abs(forward)) forward = f;
      if (Math.abs(t) > Math.abs(turn)) turn = t;
      if (Math.abs(s) > Math.abs(strafe)) strafe = s;
    }
  }
  if (Math.abs(stick.forward) > Math.abs(forward)) forward = stick.forward;
  if (Math.abs(stick.turn) > Math.abs(turn)) turn = stick.turn;
  return { forward, turn, strafe };
}
