/**
 * Computer keyboard → ControlEvents. KEYMAP is keyed by KeyboardEvent.code (the physical key), so it does not
 * depend on the keyboard layout. KeyboardInput is the pure logic, testable without a DOM; attachKeyboard wires it to
 * a window.
 */
import type { ButtonId } from '../../shared/ids';
import type { Emit } from './gestures';

/** Keys that are not ControlEvents: Backquote toggles the recorder, `?` toggles the key overlay. */
export type SpecialKey = 'recorder' | 'overlay';

export const KEYMAP: Readonly<Record<string, ButtonId>> = {
  Digit1: 'trk1.track', Digit2: 'trk2.track', Digit3: 'trk3.track', Digit4: 'trk4.track', Digit5: 'trk5.track',
  KeyQ: 'trk1.fx', KeyW: 'trk2.fx', KeyE: 'trk3.fx', KeyR: 'trk4.fx', KeyT: 'trk5.fx',
  KeyA: 'trk1.rec', KeyS: 'trk2.rec', KeyD: 'trk3.rec', KeyF: 'trk4.rec', KeyG: 'trk5.rec',
  KeyZ: 'trk1.stop', KeyX: 'trk2.stop', KeyC: 'trk3.stop', KeyV: 'trk4.stop', KeyB: 'trk5.stop',
  Digit6: 'in.edit', Digit7: 'in.A', Digit8: 'in.B', Digit9: 'in.C', Digit0: 'in.D',
  KeyY: 'tr.edit', KeyU: 'tr.A', KeyI: 'tr.B', KeyO: 'tr.C', KeyP: 'tr.D',
  Space: 'allStartStop', Tab: 'undoRedo', KeyH: 'tapTempo', KeyN: 'rhythmStartStop',
  KeyM: 'menu', KeyL: 'loop', ArrowLeft: 'left', ArrowRight: 'right', Enter: 'enter', Escape: 'exit',
};

/** Shift+N is RHYTHM EDIT. Checked before the KEYMAP lookup, which would give plain N's RHYTHM START/STOP. */
export const SHIFT_KEYMAP: Readonly<Record<string, ButtonId>> = { KeyN: 'rhythmEdit' };

/** What KeyboardInput needs to know about a keydown. */
export interface KeyInfo {
  /** KeyboardEvent.code */
  code: string;
  /** KeyboardEvent.key: the character, for `?` (which sits on different physical keys on different layouts) */
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  repeat: boolean;
  /** Focus is in a text field, so the key belongs to the field. */
  editable: boolean;
}

const own = (map: Readonly<Record<string, ButtonId>>, code: string): ButtonId | undefined =>
  Object.hasOwn(map, code) ? map[code] : undefined;

export class KeyboardInput {
  /** code → the button that key pressed, so the keyup releases what went down even if Shift has changed since */
  private readonly held = new Map<string, ButtonId>();

  constructor(
    private readonly emit: Emit,
    private readonly onSpecialKey?: (k: SpecialKey) => void,
  ) {}

  /** Returns true when the key is ours, so the caller should `preventDefault` it (Tab and Space especially). */
  keyDown(k: KeyInfo, t: number): boolean {
    // Browser shortcuts (Cmd+R, Ctrl+A, ...) and typing into a field are not for us.
    if (k.ctrlKey || k.metaKey || k.altKey || k.editable) return false;

    if (k.code === 'Backquote') {
      if (!k.repeat) this.onSpecialKey?.('recorder');
      return true;
    }
    if (k.key === '?') {
      if (!k.repeat) this.onSpecialKey?.('overlay');
      return true;
    }

    const id = (k.shiftKey ? own(SHIFT_KEYMAP, k.code) : undefined) ?? own(KEYMAP, k.code);
    if (!id) return false;
    if (k.repeat) return true; // claimed (so Space does not scroll) but not a new press

    const stale = this.held.get(k.code);
    if (stale) this.emit({ kind: 'release', id: stale, t }); // a keyup was lost: keep presses and releases paired
    this.held.set(k.code, id);
    this.emit({ kind: 'press', id, t });
    return true;
  }

  /** Returns true when this released one of our keys. */
  keyUp(code: string, key: string, t: number): boolean {
    // macOS never sends the keyup of a key that is let go while Cmd is down, so Cmd coming up frees everything.
    if (key === 'Meta') {
      this.releaseAll(t);
      return false;
    }
    const id = this.held.get(code);
    if (!id) return false;
    this.held.delete(code);
    this.emit({ kind: 'release', id, t });
    return true;
  }

  /** Releases every key still held (window blur, teardown). */
  releaseAll(t: number): void {
    const ids = [...this.held.values()];
    this.held.clear();
    for (const id of ids) this.emit({ kind: 'release', id, t });
  }
}

function isEditable(target: EventTarget | null): boolean {
  const el = target as Element | null;
  if (!el || typeof el.closest !== 'function') return false;
  return el.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') !== null;
}

/**
 * Listens on `win` (capture phase, so nothing in the page can swallow a key first). On `blur` every held key is
 * released, so a key does not stay down when the user tabs away. Returns a detach function, which also releases.
 */
export function attachKeyboard(win: Window, emit: Emit, onSpecialKey?: (k: SpecialKey) => void): () => void {
  const kb = new KeyboardInput(emit, onSpecialKey);
  const onKeyDown = (e: KeyboardEvent): void => {
    const claimed = kb.keyDown(
      {
        code: e.code,
        key: e.key,
        shiftKey: e.shiftKey,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        altKey: e.altKey,
        repeat: e.repeat,
        editable: isEditable(e.target),
      },
      e.timeStamp,
    );
    if (claimed) e.preventDefault();
  };
  const onKeyUp = (e: KeyboardEvent): void => {
    if (kb.keyUp(e.code, e.key, e.timeStamp)) e.preventDefault();
  };
  const onBlur = (e: Event): void => kb.releaseAll(e.timeStamp);

  win.addEventListener('keydown', onKeyDown, true);
  win.addEventListener('keyup', onKeyUp, true);
  win.addEventListener('blur', onBlur);
  return () => {
    win.removeEventListener('keydown', onKeyDown, true);
    win.removeEventListener('keyup', onKeyUp, true);
    win.removeEventListener('blur', onBlur);
    kb.releaseAll(win.performance.now());
  };
}
