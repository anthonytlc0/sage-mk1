import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScreenRequest } from '../../src/control/controller';
import { fillRect, hline, rect, text, textWidth } from '../../src/lcd/draw';
import { FONT_LARGE, FONT_MEDIUM, FONT_SMALL } from '../../src/lcd/fonts';
import { MEMORY_DEBOUNCE_MS, registerScreen } from '../../src/lcd/menu';
import type { Screen } from '../../src/lcd/menu';
import { DISPLAY_MODES } from '../../src/schema/lists';
import { defaultMemory } from '../../src/schema/params';
import { expectScreen } from './fixtures';
import { frame, push, pressEv, rig, sameRegion, status, turn } from './rig';
import { DEFAULT_FOOTER, bigNumber, blank, footer, statusRow } from './spec';
import { take } from '../control/helpers';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/**
 * Memory 01 "BEATBOX 1" at 120.0 on the MEMORY NUMBER play screen, as the Owner's Manual (p. 8) draws it: status
 * icons at the top right (the note and the tempo; no phantom power, no knob lock), the big number, the name under it, and the
 * labels of knobs [1] and [4] along the bottom. Rows are trimmed on the right (blank pixels follow). Generated from the
 * rendering once and checked by eye against the manual's illustration.
 */
const MEMORY_NUMBER_01 = `
    ..............................................................................................#
    ..............................................................................................#.........#....###...###.....###
    ..............................................................................................#........##...#...#.#...#...#...#
    ..............................................................................................#..####...#.......#.#..##...#..##
    ..............................................................................................#.........#......#..#.#.#...#.#.#
    ............................................................................................###..####...#.....#...##..#...##..#
    ...........................................................................................####.........#....#....#...#...#...#
    ...........................................................................................####........###..#####..###..#..###
    ............................................................................................##
    
    ....................................................########..........####
    ..................................................############.......#####
    .................................................##############.....######
    .................................................####......####....#######
    .................................................###........###....#######
    .................................................###........###........###
    .................................................###........###........###
    .................................................###........###........###
    .................................................###........###........###
    .................................................###........###........###
    .................................................###........###........###
    .................................................###........###........###
    .................................................###........###........###
    .................................................###........###........###
    .................................................###........###........###
    .................................................###........###........###
    .................................................###........###........###
    .................................................###........###........###
    .................................................###........###........###
    .................................................###........###........###
    .................................................####......####........###
    .................................................##############....##########
    ..................................................############.....##########
    ....................................................########.......##########
    
    
    ..............................######..#######....#....#######.######...#####..#.....#........##
    ..............................#.....#.#.........#.#......#....#.....#.#.....#.#.....#.......#.#
    ..............................#.....#.#........#...#.....#....#.....#.#.....#..#...#..........#
    ..............................#.....#.#.......#.....#....#....#.....#.#.....#..#...#..........#
    ..............................#.....#.#.......#.....#....#....#.....#.#.....#...#.#...........#
    ..............................######..#####...#.....#....#....######..#.....#....#............#
    ..............................#.....#.#.......#######....#....#.....#.#.....#...#.#...........#
    ..............................#.....#.#.......#.....#....#....#.....#.#.....#..#...#..........#
    ..............................#.....#.#.......#.....#....#....#.....#.#.....#..#...#..........#
    ..............................#.....#.#.......#.....#....#....#.....#.#.....#.#.....#.........#
    ..............................######..#######.#.....#....#....######...#####..#.....#.......#####
    
    
    ..............................................................................................................#...#.#####.#...#
    ..............................................................................................................##.##.#.....#...#
    ..............................................................................................................#.#.#.#......#.#
    ..............................................................................................................#.#.#.####....#
    ..............................................................................................................#...#.#......#.#
    ..............................................................................................................#...#.#.....#...#
    ..............................................................................................................#...#.#.....#...#
    
    .#...#.#####.#...#..###..####..#...#........................................................####..#####.#...#.#####.####..####
    .##.##.#.....##.##.#...#.#...#.#...#........................................................#...#.#.....#...#.#.....#...#.#...#
    .#.#.#.#.....#.#.#.#...#.#...#..#.#.........................................................#...#.#.....#...#.#.....#...#.#...#
    .#.#.#.####..#.#.#.#...#.####....#..........................................................####..####..#...#.####..####..####
    .#...#.#.....#...#.#...#.#.#.....#..........................................................#.#...#.....#...#.#.....#.#...#...#
    .#...#.#.....#...#.#...#.#..#....#..........................................................#..#..#......#.#..#.....#..#..#...#
    .#...#.#####.#...#..###..#...#...#..........................................................#...#.#####...#...#####.#...#.####
  `;

async function loadMemory(r: ReturnType<typeof rig>, slot: number, name: string, tempo = 120): Promise<void> {
  const mem = defaultMemory();
  mem.name = name;
  mem.tempo = tempo;
  r.stores.memories.slots.set(slot, { settings: mem, tracks: [take(1), null, null, null, null] });
  await r.c.selectMemory(slot);
}

describe('the MEMORY NUMBER play screen', () => {
  it('matches the drawn fixture for memory 01 "BEATBOX 1" at tempo 120.0', async () => {
    const r = rig();
    await loadMemory(r, 1, 'BEATBOX 1');
    status(r);
    expectScreen(frame(r.c), MEMORY_NUMBER_01);
  });

  it('shows memory 01 "BEATBOX 1" at tempo 120.0 as in the manual (p. 8)', async () => {
    const r = rig();
    await loadMemory(r, 1, 'BEATBOX 1');
    status(r);
    const want = blank();
    statusRow(want);
    bigNumber(want, '01');
    text(want, 0, 36, 'BEATBOX 1', FONT_MEDIUM, { align: 'center', width: 128 });
    footer(want, DEFAULT_FOOTER);
    expectScreen(frame(r.c), want.toAscii());
  });

  it('is drawn before any status has arrived (idle screen)', () => {
    const r = rig();
    const want = blank();
    statusRow(want);
    bigNumber(want, '01');
    footer(want, DEFAULT_FOOTER);
    expectScreen(frame(r.c), want.toAscii());
  });

  it('shows the tempo rounded to 0.1, whatever the engine derived', () => {
    const r = rig();
    status(r, { tempo: 117.38491 });
    const want = blank();
    statusRow(want, { tempo: '117.4' });
    bigNumber(want, '01');
    footer(want, DEFAULT_FOOTER);
    expectScreen(frame(r.c), want.toAscii());
  });

  it('shows the phantom power and knob lock icons only while they are on', () => {
    const r = rig();
    r.c.setParam('input.phantom.*', true, 0);
    r.menu.knobLock = true;
    let want = blank();
    statusRow(want, { p1: true, lock: true });
    bigNumber(want, '01');
    footer(want, DEFAULT_FOOTER);
    expectScreen(frame(r.c), want.toAscii());

    r.c.session.system.input.phantom.MIC2 = true;
    r.c.session.system.input.phantom.MIC1 = false;
    r.menu.knobLock = false;
    want = blank();
    statusRow(want, { p2: true });
    bigNumber(want, '01');
    footer(want, DEFAULT_FOOTER);
    expectScreen(frame(r.c), want.toAscii());
  });
});

describe('play screen switching', () => {
  it('◀ ▶ cycle through all 7 screens in order, and wrap', () => {
    const r = rig();
    expect(r.menu.top.title).toBe('MEMORY NUMBER');
    const seen: string[] = [r.menu.top.title];
    for (let i = 0; i < 6; i++) {
      expect(push(r, 'right')).toBe(true);
      seen.push(r.menu.top.title);
    }
    expect(seen).toEqual([...DISPLAY_MODES]);
    push(r, 'right');
    expect(r.menu.top.title).toBe('MEMORY NUMBER');
    push(r, 'left');
    expect(r.menu.top.title).toBe('TRACK FX');
    for (let i = 0; i < 6; i++) push(r, 'left');
    expect(r.menu.top.title).toBe('MEMORY NUMBER');
  });

  it('every screen draws, with and without an engine status', () => {
    const r = rig();
    for (const withStatus of [false, true]) {
      if (withStatus) status(r, {}, [{ state: 'playing', position: 0.3, peak: 0.5, lengthFrames: 48000 }]);
      for (let i = 0; i < DISPLAY_MODES.length; i++) {
        expect(() => frame(r.c, i * 16)).not.toThrow();
        push(r, 'right');
      }
    }
  });

  it('the start screen comes from SETUP DISPLAY MODE', () => {
    const r = rig();
    r.c.session.system.setup.displayMode = 'LOOP LEVEL';
    frame(r.c);
    expect(r.menu.top.title).toBe('LOOP LEVEL');
  });

  it('showStartScreen returns to the play screen named by DISPLAY MODE', () => {
    const r = rig();
    push(r, 'right');
    push(r, 'enter');
    expect(r.menu.depth).toBe(2);
    r.c.session.system.setup.displayMode = 'TRACK FX';
    r.menu.showStartScreen();
    frame(r.c);
    expect(r.menu.depth).toBe(1);
    expect(r.menu.top.title).toBe('TRACK FX');
  });
});

describe('MIXER from the play screen and back', () => {
  it('ENTER opens MIXER page 1; EXIT returns to the play screen it came from', () => {
    const r = rig();
    push(r, 'right');
    push(r, 'right');
    expect(r.menu.top.title).toBe('LOOP TRACKS');
    push(r, 'enter');
    expect(r.menu.top.title).toBe('MIXER');
    expect(r.menu.depth).toBe(2);
    push(r, 'exit');
    expect(r.menu.depth).toBe(1);
    expect(r.menu.top.title).toBe('LOOP TRACKS');
  });

  it('EXIT on the play screen does nothing', () => {
    const r = rig();
    push(r, 'exit');
    expect(r.menu.depth).toBe(1);
  });

  it('turning knob [1] changes mixer.mic1In by 1; pushing it toggles the mute', () => {
    const muted: [string, boolean][] = [];
    const r = rig({ onMute: (key, on) => muted.push([key, on]) });
    push(r, 'enter');
    turn(r, 'knob1', 1);
    expect(r.c.session.system.mixer.mic1In).toBe(101);
    expect(r.engine.last('settings')!.system.mixer.mic1In).toBe(101);
    turn(r, 'knob1', -3);
    expect(r.c.session.system.mixer.mic1In).toBe(98);

    push(r, 'knob1');
    expect(r.menu.muted.has('mic1In')).toBe(true);
    expect(muted).toEqual([['mic1In', true]]);
    push(r, 'knob1');
    expect(r.menu.muted.has('mic1In')).toBe(false);
    expect(muted).toEqual([['mic1In', true], ['mic1In', false]]);
  });
});

describe('messages', () => {
  it('a message is drawn over any screen and disappears after its ms', () => {
    const r = rig();
    const base = frame(r.c, 0);
    r.c.showMessage('NOT EMPTY', 500);
    const shown = frame(r.c, 16);

    const want = blank();
    statusRow(want);
    bigNumber(want, '01');
    footer(want, DEFAULT_FOOTER);
    const w = textWidth('NOT EMPTY', FONT_MEDIUM) + 12;
    const x = Math.floor((128 - w) / 2);
    fillRect(want, x, 21, w, 21, 0);
    rect(want, x, 21, w, 21);
    for (const [cx, cy] of [[x, 21], [x + w - 1, 21], [x, 41], [x + w - 1, 41]] as const) want.set(cx, cy, 0);
    text(want, x + 6, 26, 'NOT EMPTY', FONT_MEDIUM);
    expectScreen(shown, want.toAscii());

    vi.advanceTimersByTime(499);
    expect(sameRegion(frame(r.c, 32), shown, 0, 0, 128, 64)).toBe(true);
    vi.advanceTimersByTime(1);
    expectScreen(frame(r.c, 48), base.toAscii());
  });

  it('a long message wraps onto two lines', () => {
    const r = rig();
    r.c.showMessage('UNSUPPORTED FILE', 500);
    const shown = frame(r.c);
    const want = blank();
    statusRow(want);
    bigNumber(want, '01');
    footer(want, DEFAULT_FOOTER);
    const w = textWidth('UNSUPPORTED', FONT_MEDIUM) + 12;
    const x = Math.floor((128 - w) / 2);
    const h = 11 + 12 + 10;
    const y = Math.floor((64 - h) / 2);
    fillRect(want, x, y, w, h, 0);
    rect(want, x, y, w, h);
    for (const [cx, cy] of [[x, y], [x + w - 1, y], [x, y + h - 1], [x + w - 1, y + h - 1]] as const) want.set(cx, cy, 0);
    text(want, x, y + 5, 'UNSUPPORTED', FONT_MEDIUM, { align: 'center', width: w });
    text(want, x, y + 17, 'FILE', FONT_MEDIUM, { align: 'center', width: w });
    expectScreen(shown, want.toAscii());
  });

  it('shows on the MIXER too', () => {
    const r = rig();
    push(r, 'enter');
    const plain = frame(r.c);
    r.c.showMessage('STOP LOOPER', Infinity);
    expect(sameRegion(frame(r.c), plain, 0, 0, 128, 64)).toBe(false);
    r.c.clearMessage();
    expect(sameRegion(frame(r.c), plain, 0, 0, 128, 64)).toBe(true);
  });
});

describe('show(): every screen request the controller makes', () => {
  const cases: [ScreenRequest, string][] = [
    [{ screen: 'write' }, 'WRITE'],
    [{ screen: 'track', track: 0 }, 'TRACK1'],
    [{ screen: 'track', track: 4 }, 'TRACK5'],
    [{ screen: 'fxEdit', side: 'in', slot: 'A' }, 'INPUT FX A'],
    [{ screen: 'fxEdit', side: 'tr', slot: 'D' }, 'TRACK FX D'],
    [{ screen: 'bankSelect', side: 'in' }, 'INPUT FX BANK'],
    [{ screen: 'bankSelect', side: 'tr' }, 'TRACK FX BANK'],
  ];

  it.each(cases)('%j opens a placeholder titled %s that pops on EXIT', (req, title) => {
    const r = rig();
    r.menu.show(req, r.c);
    expect(r.menu.depth).toBe(2);
    expect(r.menu.top.title).toBe(title);
    expect(frame(r.c).get(0, 8)).toBe(1); // the title underline
    push(r, 'exit');
    expect(r.menu.depth).toBe(1);
    expect(r.menu.top.title).toBe('MEMORY NUMBER');
  });

  it('the placeholder is exactly the title, an underline and "--"', () => {
    const r = rig();
    r.menu.show({ screen: 'write' }, r.c);
    const want = blank();
    text(want, 1, 0, 'WRITE', FONT_SMALL);
    hline(want, 0, 8, 128);
    text(want, 0, 26, '--', FONT_MEDIUM, { align: 'center', width: 128 });
    expectScreen(frame(r.c), want.toAscii());
  });

  it('a request for the same kind replaces the screen instead of stacking (TRACK EDIT on another track)', () => {
    const r = rig();
    r.menu.show({ screen: 'track', track: 1 }, r.c);
    r.menu.show({ screen: 'track', track: 2 }, r.c);
    expect(r.menu.depth).toBe(2);
    expect(r.menu.top.title).toBe('TRACK3');
  });

  it('the controller reaches show() through its chords and long-presses', () => {
    const r = rig();
    r.c.handle({ kind: 'press', id: 'exit', t: 0 });
    r.c.handle({ kind: 'press', id: 'enter', t: 10 });
    expect(r.menu.top.title).toBe('WRITE');
    r.c.handle({ kind: 'release', id: 'enter', t: 20 });
    r.c.handle({ kind: 'release', id: 'exit', t: 30 });
    push(r, 'exit');
    expect(r.menu.depth).toBe(1);
    r.c.handle({ kind: 'press', id: 'trk3.track', t: 40 });
    r.c.handle({ kind: 'release', id: 'trk3.track', t: 50 });
    expect(r.menu.top.title).toBe('TRACK3');
    expect(r.c.session.memory.play.currentTrack).toBe(2);
  });

  it('tapTempo opens the TEMPO screen once, however often it is requested', () => {
    const r = rig();
    r.menu.show({ screen: 'tapTempo' }, r.c);
    r.menu.show({ screen: 'tapTempo' }, r.c);
    expect(r.menu.depth).toBe(2);
    expect(r.menu.top.title).toBe('TAP TEMPO');
  });

  it('MENU, LOOP and RHYTHM EDIT open their screens from the play screen', () => {
    const r = rig();
    push(r, 'menu');
    expect(r.menu.top.title).toBe('MENU');
    push(r, 'exit');
    push(r, 'loop');
    expect(r.menu.top.title).toBe('LOOP');
    push(r, 'exit');
    push(r, 'rhythmEdit');
    expect(r.menu.top.title).toBe('RHYTHM');
    push(r, 'exit');
    expect(r.menu.depth).toBe(1);
  });
});

describe('registerScreen: later tasks plug their real screens in', () => {
  it('a registered factory replaces the placeholder and receives the request', () => {
    const r = rig();
    const seen: ScreenRequest[] = [];
    let popped = false;
    const real: Screen = {
      title: 'REAL TRACK',
      render: (fb) => fb.set(5, 5),
      onEvent: (e) => (e.kind === 'press' && e.id === 'exit' ? 'pop' : 'unhandled'),
      dispose: () => {
        popped = true;
      },
    };
    const unregister = registerScreen('track', (req) => {
      seen.push(req);
      return real;
    });
    try {
      r.menu.show({ screen: 'track', track: 3 }, r.c);
      expect(r.menu.top).toBe(real);
      expect(seen).toEqual([{ screen: 'track', track: 3 }]);
      expect(frame(r.c).get(5, 5)).toBe(1);
      push(r, 'exit');
      expect(popped).toBe(true);
      expect(r.menu.depth).toBe(1);
    } finally {
      unregister();
    }
    r.menu.show({ screen: 'track', track: 3 }, r.c);
    expect(r.menu.top.title).toBe('TRACK4'); // the placeholder is back
  });

  it('a screen can push another screen and pop itself through its results', () => {
    const r = rig();
    const child: Screen = { title: 'CHILD', render: () => {}, onEvent: (e) => (e.kind === 'press' && e.id === 'exit' ? 'pop' : 'handled') };
    const parent: Screen = { title: 'PARENT', render: () => {}, onEvent: (e) => (e.kind === 'press' && e.id === 'enter' ? { push: child } : 'unhandled') };
    r.menu.push(parent);
    push(r, 'enter');
    expect(r.menu.top.title).toBe('CHILD');
    push(r, 'exit');
    expect(r.menu.top.title).toBe('PARENT');
  });

  it('unregistering restores the placeholder for MENU as well', () => {
    const r = rig();
    const unregister = registerScreen('menu', () => ({ title: 'THE MENU', render: () => {}, onEvent: () => 'unhandled' }));
    push(r, 'menu');
    expect(r.menu.top.title).toBe('THE MENU');
    push(r, 'exit');
    unregister();
    push(r, 'menu');
    expect(r.menu.top.title).toBe('MENU');
  });
});

describe('knob [1] = MEMORY', () => {
  it('turning several detents quickly loads only the final slot, 150 ms after the last turn', async () => {
    const r = rig();
    const select = vi.spyOn(r.c, 'selectMemory');
    turn(r, 'knob1', 1);
    vi.advanceTimersByTime(100);
    turn(r, 'knob1', 1);
    vi.advanceTimersByTime(100);
    turn(r, 'knob1', 1);
    vi.advanceTimersByTime(MEMORY_DEBOUNCE_MS - 1);
    expect(select).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(select).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledWith(4);
    await vi.advanceTimersByTimeAsync(0);
    expect(r.c.session.slot).toBe(4);
  });

  it('the debounce is 150 ms', () => {
    expect(MEMORY_DEBOUNCE_MS).toBe(150);
  });

  it('shows the slot being turned to at once, with the old name blanked until it has loaded', async () => {
    const r = rig();
    await loadMemory(r, 1, 'OLD NAME');
    turn(r, 'knob1', 2);
    const want = blank();
    statusRow(want);
    text(want, Math.floor((128 - textWidth('03', FONT_LARGE)) / 2), 10, '03', FONT_LARGE);
    footer(want, DEFAULT_FOOTER);
    expectScreen(frame(r.c), want.toAscii());
    await vi.advanceTimersByTimeAsync(MEMORY_DEBOUNCE_MS);
    expect(r.c.session.slot).toBe(3);
  });

  it('wraps 99 -> 1 and 1 -> 99', async () => {
    const r = rig();
    turn(r, 'knob1', -1);
    await vi.advanceTimersByTimeAsync(MEMORY_DEBOUNCE_MS);
    expect(r.c.session.slot).toBe(99);
    turn(r, 'knob1', 1);
    await vi.advanceTimersByTimeAsync(MEMORY_DEBOUNCE_MS);
    expect(r.c.session.slot).toBe(1);
  });

  it('stays inside SETUP MEMORY EXT MIN..MAX', async () => {
    const r = rig();
    r.c.session.system.setup.memoryExt = { min: 5, max: 8 };
    r.c.session.slot = 8;
    turn(r, 'knob1', 1);
    await vi.advanceTimersByTimeAsync(MEMORY_DEBOUNCE_MS);
    expect(r.c.session.slot).toBe(5);
  });

  it('does not reload when the turns end on the slot already loaded (unsaved edits are kept)', async () => {
    const r = rig();
    r.c.setParam('name', 'EDITED');
    const select = vi.spyOn(r.c, 'selectMemory');
    turn(r, 'knob1', 3);
    turn(r, 'knob1', -3);
    await vi.advanceTimersByTimeAsync(MEMORY_DEBOUNCE_MS);
    expect(select).not.toHaveBeenCalled();
    expect(r.c.session.memory.name).toBe('EDITED');
  });

  it('turns during a load build on the slot being loaded; the last load wins', async () => {
    const r = rig();
    turn(r, 'knob1', 1);
    await vi.advanceTimersByTimeAsync(MEMORY_DEBOUNCE_MS);
    turn(r, 'knob1', 1);
    await vi.advanceTimersByTimeAsync(MEMORY_DEBOUNCE_MS);
    expect(r.c.session.slot).toBe(3);
  });

  it('a failing load shows an error message and goes back to the loaded slot', async () => {
    const r = rig();
    vi.spyOn(r.c, 'selectMemory').mockRejectedValue(new Error('disk'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    turn(r, 'knob1', 1);
    await vi.advanceTimersByTimeAsync(MEMORY_DEBOUNCE_MS);
    expect(r.c.message).toBe('DATA READ ERR');
    err.mockRestore();
    const want = blank();
    statusRow(want);
    bigNumber(want, '01');
    footer(want, DEFAULT_FOOTER);
    r.c.clearMessage();
    expectScreen(frame(r.c), want.toAscii());
  });
});

describe('knob functions on the play screens (KNOB FUNC 1-4)', () => {
  it('knob [4] defaults to MFX REVERB and turns master.reverb', () => {
    const r = rig();
    turn(r, 'knob4', 3);
    expect(r.c.session.system.master.reverb).toBe(3);
    expect(r.engine.last('settings')!.system.master.reverb).toBe(3);
  });

  it('a held knob turns coarse, x10', () => {
    const r = rig();
    r.c.handle({ kind: 'press', id: 'knob4', t: 0 });
    r.menu.onEvent({ kind: 'turn', id: 'knob4', steps: 1, t: 1 }, r.c);
    expect(r.c.session.system.master.reverb).toBe(10);
  });

  it('shows the value in place of the label for a moment after a turn', () => {
    const r = rig();
    turn(r, 'knob4', 5, 1000);
    const flash = frame(r.c, 1100);
    const want = blank();
    statusRow(want);
    bigNumber(want, '01');
    footer(want, [['MEMORY'], null, null, ['MFX', '5']]);
    expectScreen(flash, want.toAscii());
    const later = frame(r.c, 1000 + 1500 + 1);
    const idle = blank();
    statusRow(idle);
    bigNumber(idle, '01');
    footer(idle, DEFAULT_FOOTER);
    expectScreen(later, idle.toAscii());
  });

  it('follows the KNOB FUNC settings: labels and actions', () => {
    const r = rig();
    r.c.setParam('setup.knobFunc.1', 'TRK2 PAN');
    r.c.setParam('setup.knobFunc.2', 'DISPLAY MODE');
    turn(r, 'knob2', -4);
    expect(r.c.session.memory.track[1]!.pan).toBe(-4);
    turn(r, 'knob3', 1);
    expect(r.menu.top.title).toBe('TRACK STATUS');
    const want = blank();
    statusRow(want);
    // TRACK STATUS draws its own body; only the footer is checked here
    const fb = frame(r.c, 5000);
    footer(want, [['MEMORY'], ['TRK2', 'PAN'], ['DISPLAY', 'MODE'], ['MFX', 'REVERB']]);
    expect(sameRegion(fb, want, 0, 49, 128, 15)).toBe(true);
  });

  it('knob lock ignores the knobs on a play screen', () => {
    const r = rig();
    r.menu.knobLock = true;
    turn(r, 'knob4', 3);
    expect(r.c.session.system.master.reverb).toBe(0);
  });

  it('a function with nothing to do yet (OFF, effects) swallows the turn', () => {
    const r = rig();
    expect(turn(r, 'knob2', 1)).toBe(true);
    expect(r.engine.sent).toEqual([]);
  });
});

describe('the menu engine', () => {
  it('offers events to the top screen first, then falls back to the global handling', () => {
    const r = rig();
    expect(r.menu.onEvent(pressEv('in.A'), r.c)).toBe(false);
  });

  it('never pops the play screen', () => {
    const r = rig();
    r.menu.pop();
    expect(r.menu.depth).toBe(1);
  });
});
