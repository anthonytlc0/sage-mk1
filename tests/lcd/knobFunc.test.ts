import { describe, expect, it } from 'vitest';
import { textWidth } from '../../src/lcd/draw';
import { FONT_SMALL } from '../../src/lcd/fonts';
import { knobAction } from '../../src/lcd/knobFunc';
import type { KnobAction } from '../../src/lcd/knobFunc';
import { WrapCache } from '../../src/lcd/wrap';
import { KNOB_FUNCS, findParam } from '../../src/schema/params';
import { MIXER_KEYS } from '../../src/lcd/screens/mixer';
import { push, rig, turn } from './rig';

/** Functions with nothing to act on in phase 1: the effects (phase 2) and the panel mode. */
const unmapped = (label: string): boolean => label === 'OFF' || label === 'MEMORY' || label === 'PANEL MODE' || /^(IN|TR) FX /.test(label);

describe('KNOB FUNC table', () => {
  it('maps every KNOB FUNC the schema offers, except OFF, MEMORY (the memory knob), the effects and PANEL MODE', () => {
    const missing = KNOB_FUNCS.filter((l) => !unmapped(l) && knobAction(l) === null);
    expect(missing).toEqual([]);
    for (const l of KNOB_FUNCS.filter(unmapped)) expect(knobAction(l)).toBeNull();
  });

  it('every parameter it points at exists in the schema', () => {
    const r = rig();
    for (const label of KNOB_FUNCS) {
      const a = knobAction(label);
      if (!a) continue;
      if (a.kind === 'params') {
        const ids = typeof a.ids === 'function' ? a.ids(r.c) : a.ids;
        expect(ids.length, label).toBeGreaterThan(0);
        for (const id of ids) expect(findParam(id), `${label}: ${id}`).toBeDefined();
      } else if (a.kind === 'mute') {
        for (const k of a.keys) expect(MIXER_KEYS, `${label}: ${k}`).toContain(k);
      }
    }
  });

  it('knows what the common ones do', () => {
    const ids = (label: string): readonly string[] => {
      const a = knobAction(label) as Extract<KnobAction, { kind: 'params' }>;
      return typeof a.ids === 'function' ? a.ids(rig().c) : a.ids;
    };
    expect(ids('TRK2 PAN')).toEqual(['track.1.pan']);
    expect(ids('TRK5 LEVEL')).toEqual(['track.4.playLevel']);
    expect(ids('TRK1 FX')).toEqual(['track.0.fx']);
    expect(ids('MFX REVERB')).toEqual(['master.reverb']);
    expect(ids('MFX COMP')).toEqual(['master.comp']);
    expect(ids('MIC1, 2 LEVEL')).toEqual(['mixer.mic1In', 'mixer.mic2In']);
    expect(ids('LOOP LEVEL')).toEqual(['mixer.loopOut']);
    expect(ids('MASTER LEVEL')).toEqual(['mixer.masterOut']);
    expect(ids('MIC1, 2 EQ LO G')).toEqual(['input.eq.MIC1.loGain', 'input.eq.MIC2.loGain']);
    expect(ids('MAIN-L, R EQ HI C')).toEqual(['output.eq.MAINL.hiCut', 'output.eq.MAINR.hiCut']);
    expect(ids('DUB MODE')).toEqual(['track.0.dubMode']);
    expect(ids('CURRENT TRACK')).toEqual(['play.currentTrack']);
    expect((knobAction('MIC1, 2 MUTE') as Extract<KnobAction, { kind: 'mute' }>).keys).toEqual(['mic1In', 'mic2In']);
  });

  it('DUB MODE follows the current track', () => {
    const r = rig();
    r.c.setParam('play.currentTrack', 3);
    const a = knobAction('DUB MODE') as Extract<KnobAction, { kind: 'params' }>;
    expect((a.ids as (c: unknown) => string[])(r.c)).toEqual(['track.3.dubMode']);
  });

  it('every label fits the bottom row in at most two lines of 40 px', () => {
    const cache = new WrapCache(FONT_SMALL, 40, 2, false);
    for (const l of KNOB_FUNCS) {
      const lines = cache.get(l);
      expect(lines.length, l).toBeLessThanOrEqual(2);
      for (const s of lines) expect(textWidth(s, FONT_SMALL), `${l}: ${s}`).toBeLessThanOrEqual(40);
    }
  });
});

describe('knob functions in action (on the play screen)', () => {
  const set = (r: ReturnType<typeof rig>, n: number, label: string): void => r.c.setParam(`setup.knobFunc.${n}`, label);

  it('a numeric function steps its parameter and stops at the ends', () => {
    const r = rig();
    set(r, 0, 'TRK1 PAN');
    turn(r, 'knob1', -70);
    expect(r.c.session.memory.track[0]!.pan).toBe(-50);
  });

  it('a bool function turns ON with a turn up and OFF with a turn down; a push toggles it', () => {
    const r = rig();
    set(r, 1, 'TRK3 REVERSE');
    turn(r, 'knob2', 1);
    expect(r.c.session.memory.track[2]!.reverse).toBe(true);
    turn(r, 'knob2', -1);
    expect(r.c.session.memory.track[2]!.reverse).toBe(false);
    push(r, 'knob2');
    expect(r.c.session.memory.track[2]!.reverse).toBe(true);
  });

  it('a level function that covers two connectors sets both', () => {
    const r = rig();
    set(r, 2, 'SUB1, 2 LEVEL');
    turn(r, 'knob3', -5);
    expect(r.c.session.system.mixer.sub1LOut).toBe(95);
    expect(r.c.session.system.mixer.sub2LOut).toBe(95);
  });

  it('a mute function mutes with a turn up, unmutes with a turn down and toggles on a push', () => {
    const r = rig();
    set(r, 2, 'MIC1, 2 MUTE');
    turn(r, 'knob3', 1);
    expect([...r.menu.muted].sort()).toEqual(['mic1In', 'mic2In']);
    turn(r, 'knob3', -1);
    expect(r.menu.muted.size).toBe(0);
    push(r, 'knob3');
    expect(r.menu.muted.size).toBe(2);
  });

  it('a keyword parameter steps off its keyword (COMP: OFF, 1, 2 ...)', () => {
    const r = rig();
    set(r, 1, 'MFX COMP');
    turn(r, 'knob2', 2);
    expect(r.c.session.system.master.comp).toBe(2);
    turn(r, 'knob2', -5);
    expect(r.c.session.system.master.comp).toBe('OFF');
  });
});
