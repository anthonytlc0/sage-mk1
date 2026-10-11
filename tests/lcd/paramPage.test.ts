import { describe, expect, it } from 'vitest';
import { text } from '../../src/lcd/draw';
import { FONT_SMALL } from '../../src/lcd/fonts';
import { paramFraction, paramPage, stepParam } from '../../src/lcd/screens/paramPage';
import { findParam } from '../../src/schema/params';
import { blank, ARROW_L, ARROW_R } from './spec';
import { frame, push, rig, sameRegion, turn, turnEv } from './rig';

const def = (id: string) => findParam(id)!.def;

describe('stepParam', () => {
  it('bool: a turn up is ON and a turn down is OFF', () => {
    const d = def('track.*.reverse');
    expect(stepParam(d, false, 1)).toBe(true);
    expect(stepParam(d, true, 1)).toBe(true);
    expect(stepParam(d, true, -1)).toBe(false);
  });

  it('int: steps by one and stops at the ends', () => {
    const d = def('track.*.pan');
    expect(stepParam(d, 0, -1)).toBe(-1);
    expect(stepParam(d, 0, 10)).toBe(10);
    expect(stepParam(d, -50, -1)).toBe(-50);
    expect(stepParam(d, 49, 5)).toBe(50);
  });

  it('float with a step (tempo, 0.1)', () => {
    const d = def('tempo');
    expect(stepParam(d, 120, 1)).toBe(120.1);
    expect(stepParam(d, 120, -3)).toBe(119.7);
    expect(stepParam(d, 299.9, 5)).toBe(300);
    expect(stepParam(d, 40, -1)).toBe(40);
  });

  it('a keyword before the numbers (COMP: OFF, 1..40)', () => {
    const d = def('master.comp');
    expect(stepParam(d, 'OFF', 1)).toBe(1);
    expect(stepParam(d, 'OFF', -1)).toBe('OFF');
    expect(stepParam(d, 1, -1)).toBe('OFF');
    expect(stepParam(d, 40, 1)).toBe(40);
  });

  it('a series (choices) with keywords at either end', () => {
    const lo = def('input.eq.*.loCut');
    expect(stepParam(lo, 'FLAT', 1)).toBe(20);
    expect(stepParam(lo, 20, -1)).toBe('FLAT');
    const hi = def('input.eq.*.hiCut');
    expect(stepParam(hi, 12500, 1)).toBe('FLAT');
    expect(stepParam(hi, 'FLAT', 1)).toBe('FLAT');
  });

  it('enum: moves along the values and stops at the ends', () => {
    const d = def('track.*.dubMode');
    expect(stepParam(d, 'OVERDUB', 1)).toBe('REPLACE1');
    expect(stepParam(d, 'OVERDUB', -1)).toBe('OVERDUB');
    expect(stepParam(d, 'REPLACE1', 5)).toBe('REPLACE2');
  });

  it('note: keywords, then note lengths, then measures', () => {
    const m = def('track.*.measure');
    expect(stepParam(m, 'AUTO', -1)).toBe('AUTO');
    expect(stepParam(m, 'AUTO', 1)).toBe('FREE');
    expect(stepParam(m, 'FREE', 1)).toEqual({ note: '1/16' });
    expect(stepParam(m, { note: '1/2' }, 1)).toEqual({ measures: 1 });
    expect(stepParam(m, { measures: 64 }, 1)).toEqual({ measures: 64 });
    const f = def('play.fadeIn');
    expect(stepParam(f, { measures: 2 }, -2)).toEqual({ note: '1/2' });
    expect(stepParam(f, { note: '1/16' }, -1)).toEqual({ note: '1/16' });
  });

  it('beat: steps through the guide values by label', () => {
    const d = def('rhythm.beat');
    expect(stepParam(d, { num: 4, den: 4 }, 1)).toBe('5/4');
    expect(stepParam(d, { num: 4, den: 4 }, -2)).toBe('2/4');
  });

  it('text is left alone', () => {
    expect(stepParam(def('name'), 'ABC', 1)).toBe('ABC');
  });
});

describe('paramFraction (the dial angle)', () => {
  it('maps a value onto 0..1 of its range or list', () => {
    expect(paramFraction(def('track.*.pan'), -50)).toBe(0);
    expect(paramFraction(def('track.*.pan'), 0)).toBe(0.5);
    expect(paramFraction(def('track.*.pan'), 50)).toBe(1);
    expect(paramFraction(def('track.*.dubMode'), 'REPLACE1')).toBe(0.5);
    expect(paramFraction(def('master.comp'), 'OFF')).toBe(0);
    expect(paramFraction(def('track.*.measure'), { note: '1/8' })).toBeGreaterThan(0);
  });
});

describe('paramPage', () => {
  const pan = def('track.*.pan');

  it('shows CENTER for a pan of 0 and L1 after a turn of -1 (value text from ParamDef.display)', () => {
    const r = rig();
    r.menu.push(paramPage('TRACK1', [pan], { index: 0 }));
    const at0 = frame(r.c);
    const want = blank();
    text(want, 0, 11, 'CENTER', FONT_SMALL); // wider than its column: left-aligned in column 1
    expect(sameRegion(at0, want, 0, 11, 64, 7)).toBe(true);

    expect(turn(r, 'knob1', -1)).toBe(true);
    expect(r.c.session.memory.track[0]!.pan).toBe(-1);
    const wantL1 = blank();
    text(wantL1, 0, 11, 'L1', FONT_SMALL, { align: 'center', width: 32 });
    expect(sameRegion(frame(r.c), wantL1, 0, 11, 64, 7)).toBe(true);
  });

  it('writes through the controller, so the engine is sent the settings', () => {
    const r = rig();
    r.menu.push(paramPage('TRACK3', [pan], { index: 2 }));
    turn(r, 'knob1', 4);
    expect(r.c.session.memory.track[2]!.pan).toBe(4);
    expect(r.engine.last('settings')!.memory.track[2]!.pan).toBe(4);
  });

  it('a knob that is held turns coarse: x10', () => {
    const r = rig();
    r.menu.push(paramPage('TRACK1', [pan], { index: 0 }));
    r.c.handle({ kind: 'press', id: 'knob1', t: 0 }); // held, as when the finger stays on the knob
    r.menu.onEvent(turnEv('knob1', 1), r.c);
    expect(r.c.session.memory.track[0]!.pan).toBe(10);
    r.menu.onEvent(turnEv('knob1', -2), r.c);
    expect(r.c.session.memory.track[0]!.pan).toBe(-10);
  });

  it('knob push toggles a bool and does nothing to a number', () => {
    const r = rig();
    r.menu.push(paramPage('TRACK1', [pan, def('track.*.reverse')], { index: 0 }));
    push(r, 'knob2');
    expect(r.c.session.memory.track[0]!.reverse).toBe(true);
    push(r, 'knob2');
    expect(r.c.session.memory.track[0]!.reverse).toBe(false);
    push(r, 'knob1');
    expect(r.c.session.memory.track[0]!.pan).toBe(0);
  });

  it('a knob without a parameter does nothing', () => {
    const r = rig();
    r.menu.push(paramPage('TRACK1', [pan], { index: 0 }));
    expect(turn(r, 'knob4', 1)).toBe(true);
    expect(r.engine.sent).toEqual([]);
  });

  it('pages by four with the arrows; the arrows show which neighbours exist', () => {
    const r = rig();
    const ids = ['track.*.reverse', 'track.*.oneShot', 'track.*.pan', 'track.*.playLevel', 'track.*.startMode'];
    r.menu.push(paramPage('TRACK1', ids.map(def), { index: 0 }));
    const p1 = frame(r.c);
    const want1 = blank();
    want1.blit(ARROW_R, 122, 2);
    expect(sameRegion(p1, want1, 112, 0, 16, 8)).toBe(true);

    expect(push(r, 'right')).toBe(true);
    const p2 = frame(r.c);
    const want2 = blank();
    want2.blit(ARROW_L, 116, 2);
    expect(sameRegion(p2, want2, 112, 0, 16, 8)).toBe(true);
    turn(r, 'knob1', 1); // the fifth parameter is on the second page's first knob
    expect(r.c.session.memory.track[0]!.startMode).toBe('FADE');

    expect(push(r, 'right')).toBe(true); // already on the last page: stays
    push(r, 'left');
    turn(r, 'knob1', 1);
    expect(r.c.session.memory.track[0]!.reverse).toBe(true);
  });

  it('draws the title with its underline', () => {
    const r = rig();
    r.menu.push(paramPage('TRACK1', [pan], { index: 0 }));
    const want = blank();
    text(want, 1, 0, 'TRACK1', FONT_SMALL);
    for (let x = 0; x < 128; x++) want.set(x, 8);
    expect(sameRegion(frame(r.c), want, 0, 0, 112, 9)).toBe(true);
  });

  it('EXIT pops to the play screen', () => {
    const r = rig();
    r.menu.push(paramPage('TRACK1', [pan], { index: 0 }));
    expect(r.menu.depth).toBe(2);
    push(r, 'exit');
    expect(r.menu.depth).toBe(1);
  });
});

describe('paramPage through the real controller', () => {
  it('a turn is raw detents; a pushed knob turns x10; a push without a turn toggles', () => {
    const r = rig();
    r.menu.push(paramPage('TRACK1', [def('track.*.pan'), def('track.*.reverse')], { index: 0 }));
    r.c.handle({ kind: 'turn', id: 'knob1', steps: 2, t: 0 });
    expect(r.c.session.memory.track[0]!.pan).toBe(2);
    r.c.handle({ kind: 'press', id: 'knob1', t: 10 });
    r.c.handle({ kind: 'turn', id: 'knob1', steps: 2, t: 20 });
    expect(r.c.session.memory.track[0]!.pan).toBe(22);
    r.c.handle({ kind: 'release', id: 'knob1', t: 30 });
    r.c.handle({ kind: 'press', id: 'knob2', t: 100 });
    r.c.handle({ kind: 'release', id: 'knob2', t: 110 });
    expect(r.c.session.memory.track[0]!.reverse).toBe(true);
  });
});
