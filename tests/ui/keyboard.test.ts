import { describe, expect, it } from 'vitest';
import { KEYMAP, KeyboardInput, attachKeyboard, type KeyInfo, type SpecialKey } from '../../src/ui/input/keyboard';
import { ALL_BUTTON_IDS } from '../../src/ui/panelLayout';
import type { ButtonId, ControlEvent } from '../../src/shared/ids';

/** The spec table, written out independently of the implementation. */
const SPEC: Record<string, ButtonId> = {
  Digit1: 'trk1.track', Digit2: 'trk2.track', Digit3: 'trk3.track', Digit4: 'trk4.track', Digit5: 'trk5.track',
  KeyQ: 'trk1.fx', KeyW: 'trk2.fx', KeyE: 'trk3.fx', KeyR: 'trk4.fx', KeyT: 'trk5.fx',
  KeyA: 'trk1.rec', KeyS: 'trk2.rec', KeyD: 'trk3.rec', KeyF: 'trk4.rec', KeyG: 'trk5.rec',
  KeyZ: 'trk1.stop', KeyX: 'trk2.stop', KeyC: 'trk3.stop', KeyV: 'trk4.stop', KeyB: 'trk5.stop',
  Digit6: 'in.edit', Digit7: 'in.A', Digit8: 'in.B', Digit9: 'in.C', Digit0: 'in.D',
  KeyY: 'tr.edit', KeyU: 'tr.A', KeyI: 'tr.B', KeyO: 'tr.C', KeyP: 'tr.D',
  Space: 'allStartStop', Tab: 'undoRedo', KeyH: 'tapTempo', KeyN: 'rhythmStartStop',
  KeyM: 'menu', KeyL: 'loop', ArrowLeft: 'left', ArrowRight: 'right', Enter: 'enter', Escape: 'exit',
};

describe('KEYMAP', () => {
  it('is exactly the spec table (KeyboardEvent.code, so layout-independent)', () => {
    expect({ ...KEYMAP }).toEqual(SPEC);
  });

  it('only maps to real buttons, each from one key, and never to the encoders', () => {
    const ids = Object.values(KEYMAP);
    for (const id of ids) expect(ALL_BUTTON_IDS).toContain(id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.some((id) => id.startsWith('knob'))).toBe(false);
  });

  it('leaves Backquote and ? to the recorder and the overlay, and rhythmEdit to Shift+N', () => {
    expect(KEYMAP.Backquote).toBeUndefined();
    expect(KEYMAP.Slash).toBeUndefined();
    expect(Object.values(KEYMAP)).not.toContain('rhythmEdit');
  });
});

function rig() {
  const out: ControlEvent[] = [];
  const special: SpecialKey[] = [];
  const kb = new KeyboardInput((e) => void out.push(e), (k) => void special.push(k));
  return { out, special, kb };
}

const key = (code: string, extra: Partial<KeyInfo> = {}): KeyInfo => ({
  code,
  key: code.replace(/^Key/, '').toLowerCase(),
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  repeat: false,
  editable: false,
  ...extra,
});

describe('KeyboardInput', () => {
  it('presses on keydown and releases on keyup, with the event times', () => {
    const { kb, out } = rig();
    expect(kb.keyDown(key('KeyA'), 100)).toBe(true);
    expect(kb.keyUp('KeyA', 'a', 180)).toBe(true);
    expect(out).toEqual([
      { kind: 'press', id: 'trk1.rec', t: 100 },
      { kind: 'release', id: 'trk1.rec', t: 180 },
    ]);
  });

  it('ignores auto-repeat but still claims the key (so Tab and Space never scroll or move focus)', () => {
    const { kb, out } = rig();
    kb.keyDown(key('Space'), 0);
    expect(kb.keyDown(key('Space', { repeat: true }), 500)).toBe(true);
    expect(kb.keyDown(key('Space', { repeat: true }), 530)).toBe(true);
    expect(out).toEqual([{ kind: 'press', id: 'allStartStop', t: 0 }]);
  });

  it('prevents default for every mapped key, and for none of the others', () => {
    const { kb } = rig();
    for (const code of Object.keys(SPEC)) expect(kb.keyDown(key(code), 0)).toBe(true);
    expect(kb.keyDown(key('KeyJ'), 0)).toBe(false);
    expect(kb.keyDown(key('F5', { key: 'F5' }), 0)).toBe(false);
    expect(kb.keyUp('KeyJ', 'j', 1)).toBe(false);
  });

  it('Shift+N is RHYTHM EDIT, plain N is RHYTHM START/STOP', () => {
    const { kb, out } = rig();
    kb.keyDown(key('KeyN', { shiftKey: true }), 1);
    kb.keyUp('KeyN', 'N', 2);
    kb.keyDown(key('KeyN'), 3);
    kb.keyUp('KeyN', 'n', 4);
    expect(out.map((e) => `${e.kind}:${'id' in e ? e.id : ''}`)).toEqual([
      'press:rhythmEdit',
      'release:rhythmEdit',
      'press:rhythmStartStop',
      'release:rhythmStartStop',
    ]);
  });

  it('releases what was pressed even if Shift came up first', () => {
    const { kb, out } = rig();
    kb.keyDown(key('KeyN', { shiftKey: true }), 1);
    kb.keyUp('KeyN', 'n', 2); // the keyup no longer has shiftKey: must still release rhythmEdit
    expect(out[1]).toEqual({ kind: 'release', id: 'rhythmEdit', t: 2 });
  });

  it('other shifted keys press their usual button', () => {
    const { kb, out } = rig();
    kb.keyDown(key('KeyA', { shiftKey: true, key: 'A' }), 1);
    expect(out).toEqual([{ kind: 'press', id: 'trk1.rec', t: 1 }]);
  });

  it('holds several keys at once, released independently', () => {
    const { kb, out } = rig();
    kb.keyDown(key('Escape'), 1);
    kb.keyDown(key('Enter'), 2);
    kb.keyUp('Escape', 'Escape', 3);
    kb.keyUp('Enter', 'Enter', 4);
    expect(out.map((e) => `${e.kind}:${'id' in e ? e.id : ''}`)).toEqual([
      'press:exit',
      'press:enter',
      'release:exit',
      'release:enter',
    ]);
  });

  it('leaves browser shortcuts alone (Ctrl, Cmd, Alt)', () => {
    const { kb, out } = rig();
    expect(kb.keyDown(key('KeyR', { metaKey: true }), 1)).toBe(false);
    expect(kb.keyDown(key('KeyA', { ctrlKey: true }), 2)).toBe(false);
    expect(kb.keyDown(key('KeyL', { altKey: true }), 3)).toBe(false);
    expect(out).toEqual([]);
  });

  it('ignores keys while focus is in a text field, and does not claim them', () => {
    const { kb, out, special } = rig();
    expect(kb.keyDown(key('KeyA', { editable: true }), 1)).toBe(false);
    expect(kb.keyDown(key('Space', { editable: true }), 2)).toBe(false);
    expect(kb.keyDown(key('Backquote', { editable: true }), 3)).toBe(false);
    expect(out).toEqual([]);
    expect(special).toEqual([]);
  });

  it('still releases a key that went down before focus moved into a field', () => {
    const { kb, out } = rig();
    kb.keyDown(key('KeyA'), 1);
    expect(kb.keyUp('KeyA', 'a', 2)).toBe(true);
    expect(out.map((e) => e.kind)).toEqual(['press', 'release']);
  });

  it('releaseAll (window blur) releases every held key once, and the later keyups add nothing', () => {
    const { kb, out } = rig();
    kb.keyDown(key('KeyA'), 1);
    kb.keyDown(key('KeyS'), 2);
    kb.keyDown(key('KeyN', { shiftKey: true }), 3);
    kb.releaseAll(50);
    expect(out.slice(3)).toEqual([
      { kind: 'release', id: 'trk1.rec', t: 50 },
      { kind: 'release', id: 'trk2.rec', t: 50 },
      { kind: 'release', id: 'rhythmEdit', t: 50 },
    ]);
    kb.keyUp('KeyA', 'a', 60);
    kb.releaseAll(70);
    expect(out).toHaveLength(6);
  });

  it('releases everything when the Meta key comes up (macOS swallows those keyups)', () => {
    const { kb, out } = rig();
    kb.keyDown(key('KeyA'), 1);
    kb.keyUp('Meta', 'Meta', 9);
    expect(out[1]).toEqual({ kind: 'release', id: 'trk1.rec', t: 9 });
  });

  it('a fresh keydown for a key still marked down (lost keyup) releases first, so presses stay paired', () => {
    const { kb, out } = rig();
    kb.keyDown(key('KeyA'), 1);
    kb.keyDown(key('KeyA'), 5);
    expect(out.map((e) => `${e.kind}@${e.t}`)).toEqual(['press@1', 'release@5', 'press@5']);
  });

  it('Backquote and ? are special keys, never ControlEvents, and do not repeat', () => {
    const { kb, out, special } = rig();
    expect(kb.keyDown(key('Backquote', { key: '`' }), 1)).toBe(true);
    expect(kb.keyDown(key('Backquote', { key: '`', repeat: true }), 2)).toBe(true);
    expect(kb.keyDown(key('Slash', { key: '?', shiftKey: true }), 3)).toBe(true);
    expect(kb.keyDown(key('Slash', { key: '?', shiftKey: true, repeat: true }), 4)).toBe(true);
    expect(out).toEqual([]);
    expect(special).toEqual(['recorder', 'overlay']);
  });

  it('a plain / is not the overlay key', () => {
    const { kb, special } = rig();
    expect(kb.keyDown(key('Slash', { key: '/' }), 1)).toBe(false);
    expect(special).toEqual([]);
  });

  it('works without an onSpecialKey handler', () => {
    const out: ControlEvent[] = [];
    const kb = new KeyboardInput((e) => void out.push(e));
    expect(kb.keyDown(key('Backquote', { key: '`' }), 1)).toBe(true);
    expect(out).toEqual([]);
  });
});

/**
 * A stand-in window for attachKeyboard: it keeps every listener whatever its phase, and `fire` calls the listeners for
 * a type with an event whose `target` the test chooses. A capture-phase window listener would also be called for the
 * blur of an element (blur does not bubble, but every event passes the window while capturing), so the guard must
 * look at the target.
 */
function fakeWindow() {
  const listeners = new Map<string, Set<(e: Event) => void>>();
  const win = {
    addEventListener(type: string, fn: (e: Event) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener(type: string, fn: (e: Event) => void) {
      listeners.get(type)?.delete(fn);
    },
    performance: { now: () => 1000 },
  };
  const fire = (type: string, init: Record<string, unknown>): void => {
    const e = { type, timeStamp: 0, preventDefault() {}, ...init } as unknown as Event;
    for (const fn of [...(listeners.get(type) ?? [])]) fn(e);
  };
  return { win: win as unknown as Window, fire };
}

describe('attachKeyboard', () => {
  const keydown = (code: string, key: string, target: unknown, timeStamp: number) => ({
    code, key, target, timeStamp, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, repeat: false,
  });

  it('releases held keys when the window itself loses focus, not when an element in the page does (blur of a field)', () => {
    const { win, fire } = fakeWindow();
    const out: ControlEvent[] = [];
    const detach = attachKeyboard(win, (e) => void out.push(e));
    const field = { closest: () => null }; // an element in the page (not a text field, so the key is ours)
    fire('keydown', keydown('KeyA', 'a', field, 10));
    expect(out).toEqual([{ kind: 'press', id: 'trk1.rec', t: 10 }]);

    fire('blur', { target: field, timeStamp: 20 }); // an element lost focus: the key is still down
    expect(out).toHaveLength(1);

    fire('blur', { target: win, timeStamp: 30 }); // the window lost focus (the user switched away)
    expect(out).toEqual([
      { kind: 'press', id: 'trk1.rec', t: 10 },
      { kind: 'release', id: 'trk1.rec', t: 30 },
    ]);
    detach();
    expect(out).toHaveLength(2);
  });
});
