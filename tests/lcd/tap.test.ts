import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fillRect, rect, text } from '../../src/lcd/draw';
import { FONT_LARGE, FONT_MEDIUM } from '../../src/lcd/fonts';
import type { Framebuffer } from '../../src/lcd/framebuffer';
import { TEMPO_SCREEN_MS } from '../../src/lcd/screens/tap';
import { expectScreen } from './fixtures';
import { frame, push, rig, status, turn, turnEv } from './rig';
import { blank, footer, statusRow } from './spec';
import type { Rig } from './rig';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** The TEMPO screen of manual p. 11: a frame, "TEMPO", the tempo in big digits, an underline under the digit turned. */
function tempoScreen(tempo: number, underline: 'units' | 'tenths'): Framebuffer {
  const want = blank();
  statusRow(want, { tempo: tempo.toFixed(1) });
  rect(want, 3, 10, 122, 44);
  for (const [x, y] of [[3, 10], [124, 10], [3, 53], [124, 53]] as const) want.set(x, y, 0);
  text(want, 0, 13, 'TEMPO', FONT_MEDIUM, { align: 'center', width: 128 });
  const [int, dec] = tempo.toFixed(1).split('.') as [string, string];
  const padded = int.padStart(3, ' ');
  [30, 46, 62].forEach((x, i) => {
    if (padded[i] !== ' ') text(want, x, 25, padded[i]!, FONT_LARGE);
  });
  fillRect(want, 79, 46, 3, 3);
  text(want, 84, 25, dec, FONT_LARGE);
  fillRect(want, underline === 'units' ? 62 : 84, 50, 14, 2);
  footer(want, [['MEMORY'], null, null, ['TEMPO']]);
  return want;
}

const tap = (r: Rig, t = 100): void => {
  r.c.handle({ kind: 'press', id: 'tapTempo', t });
  r.c.handle({ kind: 'release', id: 'tapTempo', t: t + 20 });
};

describe('TAP TEMPO screen', () => {
  it('pressing TAP TEMPO shows it as in the manual: TEMPO 120.0 with the units digit underlined', () => {
    const r = rig();
    tap(r);
    expect(r.menu.top.title).toBe('TAP TEMPO');
    expectScreen(frame(r.c), tempoScreen(120, 'units').toAscii());
  });

  it('knob [4] sets the tempo in whole BPM per detent', () => {
    const r = rig();
    tap(r);
    turn(r, 'knob4', 1);
    expect(r.c.session.memory.tempo).toBe(121);
    expect(r.engine.last('tempo')).toEqual({ t: 'tempo', bpm: 121 });
    turn(r, 'knob4', -4);
    expect(r.c.session.memory.tempo).toBe(117);
    expectScreen(frame(r.c), tempoScreen(117, 'units').toAscii());
  });

  it('press and turn knob [4] sets decimals: 0.1 per detent, the tenths digit underlined', () => {
    const r = rig();
    tap(r);
    r.c.handle({ kind: 'press', id: 'knob4', t: 200 }); // the knob is held
    r.menu.onEvent(turnEv('knob4', 3), r.c);
    expect(r.c.session.memory.tempo).toBe(120.3);
    r.menu.onEvent(turnEv('knob4', -5), r.c);
    expect(r.c.session.memory.tempo).toBe(119.8);
    expectScreen(frame(r.c), tempoScreen(119.8, 'tenths').toAscii());
    r.c.handle({ kind: 'release', id: 'knob4', t: 300 });
    expectScreen(frame(r.c), tempoScreen(119.8, 'units').toAscii());
  });

  it('M3: while a track records or overdubs, knob [4] leaves the tempo (and the screen) as it is', () => {
    const r = rig();
    tap(r);
    status(r, { tempo: 120 }, [{ state: 'overdubbing' }]);
    r.engine.reset();
    turn(r, 'knob4', 3);
    expect(r.c.session.memory.tempo).toBe(120);
    expect(r.engine.commands('tempo')).toEqual([]);
    expectScreen(frame(r.c), tempoScreen(120, 'units').toAscii());
  });

  it('keeps to 40.0-300.0', () => {
    const r = rig();
    tap(r);
    turn(r, 'knob4', 500);
    expect(r.c.session.memory.tempo).toBe(300);
    turn(r, 'knob4', -500);
    expect(r.c.session.memory.tempo).toBe(40);
    expectScreen(frame(r.c), tempoScreen(40, 'units').toAscii());
  });

  it('shows a tempo of two digits with the hundreds place blank, the decimal point fixed', () => {
    const r = rig();
    r.c.setParam('tempo', 95.5);
    tap(r);
    expectScreen(frame(r.c), tempoScreen(95.5, 'units').toAscii());
  });

  it('shows the tempo a tap series produces', () => {
    const r = rig();
    tap(r, 1000);
    tap(r, 1500); // 500 ms apart = 120 BPM; a third tap 600 ms later pulls the average
    tap(r, 2100);
    expect(r.c.session.memory.tempo).toBeGreaterThan(100);
    expect(r.c.session.memory.tempo).toBeLessThan(120);
    expectScreen(frame(r.c), tempoScreen(r.c.session.memory.tempo, 'units').toAscii());
  });

  it('the other knobs do nothing here', () => {
    const r = rig();
    tap(r);
    expect(turn(r, 'knob1', 1)).toBe(true);
    expect(turn(r, 'knob2', 1)).toBe(true);
    expect(turn(r, 'knob3', 1)).toBe(true);
    expect(r.c.session.memory.tempo).toBe(120);
    expect(r.c.session.system.master.reverb).toBe(0);
  });

  it('EXIT and ENTER close it', () => {
    const r = rig();
    tap(r);
    push(r, 'exit');
    expect(r.menu.depth).toBe(1);
    tap(r, 5000);
    push(r, 'enter');
    expect(r.menu.depth).toBe(1);
  });

  it('closes by itself after a while with no input; a turn or another tap keeps it open', () => {
    const r = rig();
    tap(r);
    vi.advanceTimersByTime(TEMPO_SCREEN_MS - 100);
    expect(r.menu.depth).toBe(2);
    turn(r, 'knob4', 1);
    vi.advanceTimersByTime(TEMPO_SCREEN_MS - 100);
    expect(r.menu.depth).toBe(2);
    tap(r, 9000);
    vi.advanceTimersByTime(TEMPO_SCREEN_MS - 100);
    expect(r.menu.depth).toBe(2);
    vi.advanceTimersByTime(100);
    expect(r.menu.depth).toBe(1);
  });

  it('closing it leaves a screen that was opened over it alone', () => {
    const r = rig();
    tap(r);
    r.menu.show({ screen: 'write' }, r.c);
    expect(r.menu.depth).toBe(3);
    vi.advanceTimersByTime(TEMPO_SCREEN_MS);
    expect(r.menu.depth).toBe(2);
    expect(r.menu.top.title).toBe('WRITE');
  });

  it('draws over a message too (a message is above every screen)', () => {
    const r = rig();
    tap(r);
    r.c.showMessage('TEMPO TOO FAST', Infinity);
    expect(() => frame(r.c)).not.toThrow();
  });
});

describe('through the real controller (raw turns, press-and-turn from ctx.isHeld)', () => {
  it('knob [4]: 1.0 BPM a detent, 0.1 BPM while the knob is pushed', () => {
    const r = rig();
    tap(r);
    r.c.handle({ kind: 'turn', id: 'knob4', steps: 2, t: 200 });
    expect(r.c.session.memory.tempo).toBe(122);
    r.c.handle({ kind: 'press', id: 'knob4', t: 300 });
    r.c.handle({ kind: 'turn', id: 'knob4', steps: 3, t: 310 });
    expect(r.c.session.memory.tempo).toBe(122.3);
    r.c.handle({ kind: 'release', id: 'knob4', t: 400 }); // turned while held: not a push
    expect(r.menu.depth).toBe(2);
    expect(r.c.session.memory.tempo).toBe(122.3);
  });
});
