import { describe, it, expect } from 'vitest';
import {
  MEMORY_PARAMS, SYSTEM_PARAMS, defaultMemory, defaultSystem, getParam, setParam, findParam,
  PANEL_FUNCTIONS, CTL_FUNCTIONS, EXP_FUNCTIONS, KNOB_FUNCS, ASSIGN_SOURCES, ASSIGN_TARGETS,
  RHYTHM_GENRES, RHYTHM_KITS, GUIDE_PATTERNS, FACTORY_RESET_TARGETS, concreteIds,
} from '../../src/schema/params';
import { NOTE_VALUES, BEAT_VALUES } from '../../src/schema/types';
import type { ParamDef, MemorySettings, SystemSettings } from '../../src/schema/types';

const ALL: ParamDef[] = [...MEMORY_PARAMS, ...SYSTEM_PARAMS];
function get(id: string): ParamDef {
  const d = ALL.find((p) => p.id === id);
  if (!d) throw new Error(`no param ${id}`);
  return d;
}
const idsUnder = (prefix: string) => ALL.filter((p) => p.id.startsWith(prefix));

describe('values from the Parameter Guide', () => {
  it('PLAY LEVEL is 0..200, default 100', () => {
    const d = get('track.*.playLevel');
    expect({ min: d.min, max: d.max, default: d.default }).toEqual({ min: 0, max: 200, default: 100 });
  });

  it('PAN displays L50 / CENTER / R50 and L1 for -1', () => {
    const d = get('track.*.pan');
    expect([d.display(-50), d.display(0), d.display(50), d.display(-1)]).toEqual(['L50', 'CENTER', 'R50', 'L1']);
    expect(d.default).toBe(0);
  });

  it('AUTO REC SENS is 1..100, default 50', () => {
    const d = get('rec.autoRecSens');
    expect({ min: d.min, max: d.max, default: d.default }).toEqual({ min: 1, max: 100, default: 50 });
  });

  it('LOOP LENGTH accepts AUTO and 1..25362', () => {
    const d = get('play.loopLength');
    expect(d.default).toBe('AUTO');
    expect(d.values).toContain('AUTO');
    expect({ min: d.min, max: d.max }).toEqual({ min: 1, max: 25362 });
    const m = defaultMemory();
    expect(setParam(m, 'play.loopLength', 'AUTO')).toBe('AUTO');
    expect(setParam(m, 'play.loopLength', 8)).toBe(8);
    expect(getParam(m, 'play.loopLength')).toBe(8);
    expect(setParam(m, 'play.loopLength', 99999)).toBe(25362);
    expect(setParam(m, 'play.loopLength', 0)).toBe(1);
    expect(() => setParam(m, 'play.loopLength', 'MANUAL')).toThrow();
  });

  it('FADE TIME defaults to 2 measures; accepts notes and 1..64 measures', () => {
    expect(get('play.fadeIn').default).toEqual({ measures: 2 });
    expect(get('play.fadeOut').default).toEqual({ measures: 2 });
    const m = defaultMemory();
    expect(setParam(m, 'play.fadeIn', { note: '1/8' })).toEqual({ note: '1/8' });
    expect(setParam(m, 'play.fadeIn', { measures: 500 })).toEqual({ measures: 64 });
    expect(setParam(m, 'play.fadeOut', { measures: 0 })).toEqual({ measures: 1 });
    expect(() => setParam(m, 'play.fadeIn', { note: '1/3' })).toThrow();
    expect(() => setParam(m, 'play.fadeIn', 'AUTO')).toThrow();
    expect(get('play.fadeIn').display({ measures: 2 })).toBe('2MEAS');
    expect(get('play.fadeIn').display({ note: '1/8' })).toBe('1/8');
  });

  it('MEASURE: AUTO | FREE | note | measures, default FREE', () => {
    const d = get('track.*.measure');
    expect(d.default).toBe('FREE');
    expect(d.values).toEqual(['AUTO', 'FREE']);
    const m = defaultMemory();
    expect(setParam(m, 'track.*.measure', 'AUTO', 1)).toBe('AUTO');
    expect(setParam(m, 'track.*.measure', { note: '1/4' }, 1)).toEqual({ note: '1/4' });
    expect(m.track[1]!.measure).toEqual({ note: '1/4' });
    expect(m.track[0]!.measure).toBe('FREE');
  });

  it('NOTE_VALUES transcribes the guide symbols (16th, 8th, quarter, half), shortest to longest', () => {
    expect(NOTE_VALUES).toEqual(['1/16', '1/8', '1/4', '1/2']);
    expect(NOTE_VALUES).toContain('1/8');
  });

  it('TEMPO is 40..300 with step 0.1', () => {
    const d = get('tempo');
    expect({ min: d.min, max: d.max, step: d.step }).toEqual({ min: 40, max: 300, step: 0.1 });
    const m = defaultMemory();
    expect(setParam(m, 'tempo', 120.04)).toBe(120);
    expect(setParam(m, 'tempo', 120.06)).toBe(120.1);
    expect(setParam(m, 'tempo', 5)).toBe(40);
    expect(setParam(m, 'tempo', 1000)).toBe(300);
    expect(d.display(120)).toBe('120.0');
  });

  it('INPUT EQ: LO MID FREQ defaults 250 Hz, HI MID FREQ 800 Hz', () => {
    expect(get('input.eq.*.loMidFreq').default).toBe(250);
    expect(get('input.eq.*.hiMidFreq').default).toBe(800);
    expect(get('output.eq.*.loMidFreq').default).toBe(250);
    expect(get('output.eq.*.hiMidFreq').default).toBe(800);
    const f = get('input.eq.*.loMidFreq');
    expect({ min: f.min, max: f.max }).toEqual({ min: 20, max: 10000 });
    expect(f.display(250)).toBe('250Hz');
    expect(f.display(1250)).toBe('1.25kHz');
    const s = defaultSystem();
    expect(getParam(s, 'input.eq.*.loMidFreq', 'MIC1')).toBe(250);
    expect(getParam(s, 'input.eq.MIC2.hiMidFreq')).toBe(800);
    // frequencies snap to the nearest step of the series
    expect(setParam(s, 'input.eq.*.loMidFreq', 260, 'MIC1')).toBe(250);
    expect(setParam(s, 'input.eq.*.loMidFreq', 1, 'MIC1')).toBe(20);
    expect(setParam(s, 'input.eq.*.loMidFreq', 99999, 'MIC1')).toBe(10000);
  });

  it('INPUT EQ: other defaults', () => {
    const want: Record<string, unknown> = {
      sw: false, loGain: 0, hiGain: 0, loMidQ: 0.5, loMidGain: 0, hiMidQ: 0.5, hiMidGain: 0, level: 0, loCut: 'FLAT', hiCut: 'FLAT',
    };
    for (const [k, v] of Object.entries(want)) expect(get(`input.eq.*.${k}`).default).toEqual(v);
    expect(get('input.eq.*.loGain')).toMatchObject({ min: -20, max: 20 });
    expect(get('input.eq.*.loCut').values).toEqual(['FLAT']);
    expect(get('input.eq.*.hiCut').choices!.at(-1)).toBe('FLAT');
    expect(get('input.eq.*.hiCut').choices![0]).toBe(630);
  });

  it('MASTER FX: COMP is OFF or 1..40, REVERB is 0..40', () => {
    const c = get('master.comp');
    expect(c.values).toEqual(['OFF']);
    expect({ min: c.min, max: c.max, default: c.default }).toEqual({ min: 1, max: 40, default: 'OFF' });
    const r = get('master.reverb');
    expect({ min: r.min, max: r.max, default: r.default }).toEqual({ min: 0, max: 40, default: 0 });
    const s = defaultSystem();
    expect(setParam(s, 'master.comp', 99)).toBe(40);
    expect(setParam(s, 'master.comp', 'OFF')).toBe('OFF');
    expect(setParam(s, 'master.reverb', -3)).toBe(0);
    expect(get('master.insert').default).toBe('MAIN-L');
  });

  it('MIXER: every level is 0..200, default 100', () => {
    const mixer = idsUnder('mixer.');
    expect(mixer.length).toBe(16);
    for (const d of mixer) expect({ id: d.id, min: d.min, max: d.max, default: d.default }).toEqual({ id: d.id, min: 0, max: 200, default: 100 });
    expect(get('mixer.mic1In').label).toBe('MIC 1 IN');
  });

  it('SETUP: CONTRAST is 1..10, default 5; guide defaults', () => {
    const d = get('setup.contrast');
    expect({ min: d.min, max: d.max, default: d.default }).toEqual({ min: 1, max: 10, default: 5 });
    expect(get('setup.displayMode').default).toBe('MEMORY NUMBER');
    expect(get('setup.displayMode').values).toHaveLength(7);
    expect(get('setup.indicator').default).toBe('STATUS');
    expect(get('setup.fxKnobMode').default).toBe('IMMEDIATE');
    expect(get('setup.autoOff').default).toBe(true);
    expect([get('setup.memoryExt.min').default, get('setup.memoryExt.max').default]).toEqual([1, 99]);
    expect([0, 1, 2, 3].map((i) => get(`setup.knobFunc.${i}`).default)).toEqual(['MEMORY', 'OFF', 'OFF', 'MFX REVERB']);
    expect(['rec', 'play', 'dub', 'stop', 'blank'].map((k) => get(`setup.loopStatusColor.${k}`).default)).toEqual(['RED', 'GREEN', 'AMBER', 'OFF', 'OFF']);
    expect(get('setup.loopStatusColor.rec').values).toEqual(['OFF', 'RED', 'GREEN', 'AMBER', 'BLUE', 'PURPLE', 'CYAN', 'WHITE']);
  });

  it('TRACK / REC / PLAY defaults (bold in the guide)', () => {
    const m = defaultMemory();
    expect(m.track).toHaveLength(5);
    for (const t of m.track) {
      expect(t).toEqual({
        reverse: false, oneShot: false, pan: 0, playLevel: 100, startMode: 'IMMEDIATE', stopMode: 'IMMEDIATE', dubMode: 'OVERDUB',
        fx: true, playMode: 'MULTI', measure: 'FREE', loopSyncSw: true, loopSyncMode: 'IMMEDIATE',
        tempoSyncSw: true, tempoSyncMode: 'XFADE', tempoSyncSpeed: 'NORMAL', bounceIn: false,
        input: { MIC1: true, MIC2: true, INST1L: true, INST1R: true, INST2L: true, INST2R: true, RHYTHM: true },
      });
    }
    expect(m.rec).toEqual({ recAction: 'REC->PLAY', quantize: 'MEASURE', autoRecSw: false, autoRecSens: 50, bounceSw: false, bounceTrack: [true, true, true, true, true] });
    expect(m.play).toEqual({
      sTrkChange: 'IMMEDIATE', currentTrack: 0, fadeIn: { measures: 2 }, fadeOut: { measures: 2 },
      allStartTrk: [true, true, true, true, true], allStopTrk: [true, true, true, true, true],
      loopLength: 'AUTO', speedChange: 'IMMEDIATE', syncAdjust: 'MEASURE',
    });
  });

  it('RHYTHM defaults and lists', () => {
    const m = defaultMemory();
    expect(m.rhythm).toMatchObject({
      genre: 'GUIDE', variation: 'A', kit: 'STUDIO', beat: { num: 4, den: 4 }, startTrig: 'LOOP START', stopTrig: 'LOOP STOP',
      introRec: false, introPlay: false, ending: false, fill: true, varChange: 'MEASURE',
    });
    expect(get('rhythm.genre').values).toEqual(['GUIDE']);
    expect(RHYTHM_GENRES).toHaveLength(21);
    expect(RHYTHM_GENRES).toContain('GUIDE');
    expect(RHYTHM_GENRES[0]).toBe('ACOUSTIC');
    expect(RHYTHM_GENRES.at(-1)).toBe('USER');
    expect(RHYTHM_KITS).toHaveLength(16);
    expect(BEAT_VALUES).toEqual(['2/4', '3/4', '4/4', '5/4', '6/4', '7/4', '5/8', '6/8', '7/8', '8/8', '9/8', '10/8', '11/8', '12/8', '13/8', '14/8', '15/8']);
    expect(GUIDE_PATTERNS.map((p) => p.pattern)).toContain(m.rhythm.pattern);
    expect(GUIDE_PATTERNS.find((p) => p.pattern === '7/8')!.beat).toEqual({ num: 7, den: 8 });
    expect(get('rhythm.beat').display({ num: 7, den: 8 })).toBe('7/8');
    expect(setParam(m, 'rhythm.beat', '5/8')).toEqual({ num: 5, den: 8 });
    expect(setParam(m, 'rhythm.beat', { num: 3, den: 4 })).toEqual({ num: 3, den: 4 });
    expect(() => setParam(m, 'rhythm.beat', { num: 8, den: 4 })).toThrow();
  });

  it('NAME is text up to NAME_LEN characters, default empty', () => {
    const d = get('name');
    expect(d.default).toBe('');
    expect(d.max).toBe(12);
    const m = defaultMemory();
    expect(setParam(m, 'name', 'BEATBOX 1 EXTRA LONG')).toBe('BEATBOX 1 EX');
    expect(() => setParam(m, 'name', 5)).toThrow();
  });
});

describe('app additions and the deliberate default deviation', () => {
  it('INPUT THRU defaults OFF (deviation from the guide)', () => {
    expect(get('output.routing.inputThru').default).toBe(false);
    expect(defaultSystem().output.routing.inputThru).toBe(false);
  });

  it('SETUP LATENCY: int frames, default -1 (uncalibrated)', () => {
    const d = get('setup.latency');
    expect(d).toMatchObject({ kind: 'int', default: -1, min: -1, scope: 'system', phase: 1, label: 'LATENCY' });
    expect(setParam(defaultSystem(), 'setup.latency', -50)).toBe(-1);
    expect(setParam(defaultSystem(), 'setup.latency', 2112.4)).toBe(2112);
  });

  it('SETUP MIC PROCESS: bool, default OFF', () => {
    const d = get('setup.micProcess');
    expect(d).toMatchObject({ kind: 'bool', default: false, scope: 'system', phase: 1, label: 'MIC PROCESS' });
    expect(d.display(false)).toBe('OFF');
    expect(d.display(true)).toBe('ON');
    expect(d.hidden).toBeFalsy();
  });

  it('SETUP CALIB PROMPTED: hidden bool flag, default false', () => {
    const d = get('setup.calibPrompted');
    expect(d).toMatchObject({ kind: 'bool', default: false, scope: 'system', phase: 1, label: 'CALIB PROMPTED', hidden: true });
    expect(SYSTEM_PARAMS.filter((p) => p.hidden).map((p) => p.id)).toEqual(['setup.calibPrompted']);
  });
});

describe('registry hygiene', () => {
  it('every label is non-empty uppercase', () => {
    for (const d of ALL) {
      expect(d.label, d.id).not.toBe('');
      expect(d.label, d.id).toBe(d.label.toUpperCase());
    }
  });

  it('no duplicate ids (including expanded wildcard ids)', () => {
    const ids = ALL.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    const concrete = ALL.flatMap((p) => concreteIds(p));
    expect(new Set(concrete).size).toBe(concrete.length);
  });

  it('wildcard ids carry exactly one * and a matching indices list', () => {
    for (const d of ALL) {
      const stars = d.id.split('.').filter((s) => s === '*').length;
      expect(stars, d.id).toBeLessThanOrEqual(1);
      if (stars === 1) expect(d.indices?.length, d.id).toBeGreaterThan(0);
      else expect(d.indices, d.id).toBeUndefined();
    }
  });

  it('scope: memory registry holds memory/track, system registry holds system', () => {
    for (const d of MEMORY_PARAMS) expect(['memory', 'track']).toContain(d.scope);
    for (const d of SYSTEM_PARAMS) expect(d.scope).toBe('system');
    for (const d of ALL) expect(d.scope === 'track', d.id).toBe(d.id.startsWith('track.*.'));
  });

  it('every param carries a section and a phase 1..4', () => {
    for (const d of ALL) {
      expect(d.section, d.id).toBeTruthy();
      expect([1, 2, 3, 4]).toContain(d.phase);
    }
  });

  it('control/connectivity groups are phase 4 (stored, inert in phase 1)', () => {
    for (const d of ALL.filter((p) => /^(assign|midi|usb)\./.test(p.id) || /^ctl\.(footswitch|exp)\./.test(p.id))) {
      expect(d.phase, d.id).toBe(4);
    }
  });

  it('defaults are valid for their own definition and survive a set/get round trip', () => {
    const mem = defaultMemory();
    const sys = defaultSystem();
    for (const d of ALL) {
      const obj = d.scope === 'system' ? sys : mem;
      const indices = d.indices ?? [undefined];
      for (const idx of indices) {
        const got = getParam(obj, d.id, idx);
        expect(got, `${d.id}[${idx}]`).toEqual(d.default);
        expect(setParam(obj, d.id, got, idx), `${d.id}[${idx}]`).toEqual(d.default);
        expect(typeof d.display(got), d.id).toBe('string');
      }
    }
  });

  it('every concrete id resolves to the same definition as its wildcard id', () => {
    for (const d of ALL) {
      for (const cid of concreteIds(d)) expect(findParam(cid)?.def, cid).toBe(d);
    }
  });
});

describe('getParam / setParam', () => {
  it('per-track params take the track index', () => {
    const m = defaultMemory();
    expect(setParam(m, 'track.*.playLevel', 150, 2)).toBe(150);
    expect(getParam(m, 'track.*.playLevel', 2)).toBe(150);
    expect(m.track[2]!.playLevel).toBe(150);
    expect(m.track[1]!.playLevel).toBe(100);
    expect(getParam(m, 'track.2.playLevel')).toBe(150); // concrete id form
    setParam(m, 'track.3.pan', -20);
    expect(m.track[3]!.pan).toBe(-20);
    expect(setParam(m, 'track.*.input.MIC1', false, 4)).toBe(false);
    expect(m.track[4]!.input.MIC1).toBe(false);
  });

  it('clamps and rounds numbers', () => {
    const m = defaultMemory();
    expect(setParam(m, 'track.*.playLevel', 999, 0)).toBe(200);
    expect(setParam(m, 'track.*.playLevel', -5, 0)).toBe(0);
    expect(setParam(m, 'track.*.pan', 60, 0)).toBe(50);
    expect(setParam(m, 'track.*.pan', -50.4, 0)).toBe(-50);
    expect(setParam(m, 'track.*.pan', 12.6, 0)).toBe(13);
    expect(setParam(m, 'rec.autoRecSens', 0)).toBe(1);
    expect(setParam(m, 'play.currentTrack', 7)).toBe(4);
    expect(() => setParam(m, 'track.*.pan', Number.NaN, 0)).toThrow();
  });

  it('validates enums and booleans', () => {
    const m = defaultMemory();
    expect(setParam(m, 'track.*.stopMode', 'LOOP', 0)).toBe('LOOP');
    expect(() => setParam(m, 'track.*.stopMode', 'SLOW', 0)).toThrow(RangeError);
    expect(() => setParam(m, 'track.*.reverse', 'yes', 0)).toThrow(TypeError);
    expect(() => setParam(m, 'rec.recAction', 'REC->UNDO')).toThrow();
    expect(m.track[0]!.stopMode).toBe('LOOP');
  });

  it('system params with channel / jack / destination indices', () => {
    const s: SystemSettings = defaultSystem();
    expect(setParam(s, 'input.eq.*.loGain', 99, 'INST2R')).toBe(20);
    expect(s.input.eq.INST2R.loGain).toBe(20);
    expect(s.input.eq.MIC1.loGain).toBe(0);
    expect(setParam(s, 'input.eq.*.loGain', -3, 1)).toBe(-3); // numeric index = position in the channel list
    expect(s.input.eq.MIC2.loGain).toBe(-3);
    expect(setParam(s, 'output.routing.track.MAINL.*', false, 2)).toBe(false);
    expect(s.output.routing.track.MAINL[2]).toBe(false);
    expect(s.output.routing.track.MAINL[1]).toBe(true);
    expect(setParam(s, 'output.routing.inputRhythm.PHONES.*', false, 'RHYTHM')).toBe(false);
    expect(s.output.routing.inputRhythm.PHONES.RHYTHM).toBe(false);
    expect(setParam(s, 'input.eq.*.loCut', 'FLAT', 'MIC1')).toBe('FLAT');
    expect(setParam(s, 'input.eq.*.loCut', 90, 'MIC1')).toBe(80);
    expect(setParam(s, 'input.eq.*.hiCut', 'FLAT', 'MIC1')).toBe('FLAT');
    expect(setParam(s, 'input.eq.*.hiCut', 100, 'MIC1')).toBe(630);
    expect(() => setParam(s, 'input.eq.*.loCut', 'OFF', 'MIC1')).toThrow();
    expect(setParam(s, 'assign.*.sourceActHi', 200, 15)).toBe(127);
    expect(s.assign[15]!.sourceActHi).toBe(127);
    expect(s.assign).toHaveLength(16);
  });

  it('rejects unknown ids, missing or bad indices, and ids absent from the object', () => {
    const m = defaultMemory();
    const s = defaultSystem();
    expect(() => getParam(m, 'nope.nothing')).toThrow(/unknown parameter/);
    expect(() => getParam(m, 'track.*.pan')).toThrow(/index/);
    expect(() => getParam(m, 'track.*.pan', 5)).toThrow(RangeError);
    expect(() => getParam(s, 'input.eq.*.loGain', 'NOPE')).toThrow(RangeError);
    expect(() => getParam(m, 'mixer.mic1In')).toThrow();
    expect(() => getParam(s, 'tempo')).toThrow();
    expect(() => setParam(m, 'track.9.pan', 0)).toThrow();
  });

  it('returns live values (no copies) for reads', () => {
    const m = defaultMemory();
    expect(getParam(m, 'play.fadeIn')).toBe(m.play.fadeIn);
  });
});

describe('defaults are fresh objects', () => {
  it('defaultMemory() and defaultSystem() never share references', () => {
    const a = defaultMemory();
    const b = defaultMemory();
    (a.play.fadeIn as { measures: number }).measures = 9;
    a.track[0]!.input.MIC1 = false;
    expect(b.play.fadeIn).toEqual({ measures: 2 });
    expect(b.track[0]!.input.MIC1).toBe(true);
    expect(a.track[0]).not.toBe(a.track[1]);
    const s1 = defaultSystem();
    const s2 = defaultSystem();
    s1.output.routing.track.MAINL[0] = false;
    expect(s2.output.routing.track.MAINL[0]).toBe(true);
    expect(s1.output.routing.track.MAINL).not.toBe(s1.output.routing.track.MAINR);
  });

  it('every ParamDef.default is cloned, so mutating a default object cannot corrupt the registry', () => {
    const m: MemorySettings = defaultMemory();
    (m.play.fadeIn as { measures: number }).measures = 50;
    expect(get('play.fadeIn').default).toEqual({ measures: 2 });
  });
});

describe('function lists (PANEL / CTL / EXP / KNOB FUNC / ASSIGN)', () => {
  it('PANEL_FUNCTIONS: the PANEL PLAY/UNDO value list, 101 entries with push/hold/click', () => {
    expect(PANEL_FUNCTIONS).toHaveLength(101);
    expect(new Set(PANEL_FUNCTIONS.map((f) => f.id)).size).toBe(101);
    expect(PANEL_FUNCTIONS[0]).toMatchObject({ id: 'OFF', label: 'OFF', push: '---' });
    const by = (id: string) => PANEL_FUNCTIONS.find((f) => f.id === id)!;
    expect(by('TRK3 CLEAR')).toMatchObject({ label: 'TRK3 CLEAR', push: 'CLEAR', track: 2 });
    expect(by('TRK1 MARK BACK2')).toMatchObject({ push: 'MARK BACK', hold: 'REC BACK', track: 0 });
    expect(by('TRK5 MARK SET2')).toMatchObject({ push: 'MARK SET', hold: 'MARK CLEAR', track: 4 });
    expect(by('TRK2 TRACK FX')).toMatchObject({ push: 'FX ON/OFF' });
    expect(by('CUR.TRK INC')).toMatchObject({ push: 'INC', hold: 'INC', current: true });
    expect(by('CUR.TRK DEC')).toMatchObject({ push: 'DEC', hold: 'INC' });
    expect(by('CUR.TRK TRACK EDIT').track).toBeUndefined();
    expect(by('TEMPO UP').push).toBe('TEMPO DOUBLE');
    expect(by('TEMPO DOWN').push).toBe('TEMPO HALF');
    expect(by('LED').push).toBe('TOGGLE COLOR');
    expect(PANEL_FUNCTIONS.filter((f) => f.click !== undefined)).toHaveLength(0);
  });

  it('PANEL PLAY / UNDO default functions come from the Owner\'s Manual and exist in the list', () => {
    const s = defaultSystem();
    const ids = new Set(PANEL_FUNCTIONS.map((f) => f.id));
    for (let i = 0; i < 5; i++) {
      expect(s.ctl.panelPlay.track[i]).toBe(`TRK${i + 1} TRACK EDIT`);
      expect(s.ctl.panelPlay.fx[i]).toBe(`TRK${i + 1} TRACK FX`);
      expect(s.ctl.panelUndo.track[i]).toBe(`TRK${i + 1} MARK SET1`);
      expect(s.ctl.panelUndo.fx[i]).toBe(`TRK${i + 1} MARK CLEAR`);
      for (const v of [s.ctl.panelPlay.track[i], s.ctl.panelPlay.fx[i], s.ctl.panelUndo.track[i], s.ctl.panelUndo.fx[i]]) expect(ids.has(v!)).toBe(true);
    }
    expect(get('ctl.panelPlay.track.0').values).toEqual(PANEL_FUNCTIONS.map((f) => f.id));
    expect(() => setParam(s, 'ctl.panelPlay.fx.0', 'TRK1 REC/PLAY1')).toThrow(); // footswitch-only function
    expect(setParam(s, 'ctl.panelPlay.fx.0', 'TRK1 CLEAR')).toBe('TRK1 CLEAR');
  });

  it('CTL_FUNCTIONS: footswitch list, 208 entries', () => {
    expect(CTL_FUNCTIONS).toHaveLength(208);
    expect(new Set(CTL_FUNCTIONS.map((f) => f.id)).size).toBe(208);
    const by = (id: string) => CTL_FUNCTIONS.find((f) => f.id === id)!;
    expect(by('TRK1 REC/PLAY3')).toMatchObject({ push: 'REC/PLAY', hold: 'UNDO (PLAY)', click: 'STOP' });
    expect(by('TRK1 REC/PLAY4')).toMatchObject({ hold: 'UNDO, CLEAR', click: 'STOP' });
    expect(by('CUR.TRK STOP3')).toMatchObject({ push: 'STOP', hold: 'CLEAR', click: 'TAP TEMPO' });
    expect(by('ALL START/STOP4').push).toBe('IMM ALL ST/STOP');
    expect(by('MEMORY INC2')).toMatchObject({ push: 'INC', hold: 'DEC' });
    expect(by('TAP TEMPO')).toMatchObject({ push: 'TAP TEMPO', hold: 'TEMPO REVERT' });
    expect(by('INPUT FX C').push).toBe('FX ON/OFF');
    expect(by('CUR.TRK NUM').push).toBe('---');
    expect(get('ctl.footswitch.*').values).toEqual(CTL_FUNCTIONS.map((f) => f.id));
    expect(get('ctl.footswitch.*').default).toBe('OFF');
    expect(get('ctl.footswitch.*').indices).toEqual(['CTL1', 'CTL2', 'CTL3', 'CTL4']);
  });

  it('EXP: function list and defaults (EXP1 IN FX CUR CTL, EXP2 TR FX CUR CTL), MIN/MAX 0..255', () => {
    expect(EXP_FUNCTIONS).toHaveLength(27);
    expect(get('ctl.exp.EXP1.func').default).toBe('IN FX CUR CTL');
    expect(get('ctl.exp.EXP2.func').default).toBe('TR FX CUR CTL');
    for (const e of ['EXP1', 'EXP2']) {
      expect(get(`ctl.exp.${e}.func`).values).toEqual(EXP_FUNCTIONS);
      expect(get(`ctl.exp.${e}.min`)).toMatchObject({ min: 0, max: 255 });
      expect(get(`ctl.exp.${e}.max`)).toMatchObject({ min: 0, max: 255 });
    }
  });

  it('CTL FUNC PREFERENCE defaults', () => {
    const p = defaultSystem().ctl.preference;
    expect(p).toEqual({ modePlay: 'SYSTEM', modeUndo: 'SYSTEM', quickClear: false, allClear: false, footswitch: 'SYSTEM', exp: 'SYSTEM' });
  });

  it('KNOB FUNC list: 213 entries, defaults valid', () => {
    expect(KNOB_FUNCS).toHaveLength(213);
    expect(new Set(KNOB_FUNCS).size).toBe(213);
    expect(KNOB_FUNCS.slice(0, 4)).toEqual(['OFF', 'MEMORY', 'TRK1 REVERSE', 'TRK2 REVERSE']);
    expect(KNOB_FUNCS).toContain('MIC1, 2 EQ SW');
    expect(KNOB_FUNCS).toContain('SUB2-L, R EQ HI C');
    expect(KNOB_FUNCS.at(-1)).toBe('INDICATOR');
    for (const f of ['MFX REVERB', 'IN FX B PRM3', 'TR FX D SW MODE']) expect(KNOB_FUNCS).toContain(f);
    expect(get('setup.knobFunc.3').values).toBe(KNOB_FUNCS);
  });

  it('ASSIGN source and target lists', () => {
    expect(ASSIGN_SOURCES).toHaveLength(100);
    expect(new Set(ASSIGN_SOURCES).size).toBe(100);
    expect(ASSIGN_SOURCES).toContain('TRK4 FX (UND)');
    expect(ASSIGN_SOURCES).toContain('MIDI CC#01');
    expect(ASSIGN_SOURCES).toContain('MIDI CC#95');
    expect(ASSIGN_SOURCES).not.toContain('MIDI CC#32');
    expect(ASSIGN_TARGETS).toHaveLength(511);
    expect(new Set(ASSIGN_TARGETS).size).toBe(511);
    expect(ASSIGN_TARGETS).toContain('TRK5 M.BACK');
    expect(ASSIGN_TARGETS).toContain('CUR.TRK NUM');
    expect(ASSIGN_TARGETS).toContain('IN FX AA S.MAX');
    expect(ASSIGN_TARGETS).toContain('T FX D PRM4');
    expect(ASSIGN_TARGETS).toContain('MIDI CC#127');
    expect(ASSIGN_TARGETS).not.toContain('MIDI CC#32');
    const a = defaultSystem().assign;
    expect(a[0]).toEqual({
      sw: false, source: 'TRK1 REC/DB', sourceMode: 'MOMENT', sourceActLo: 0, sourceActHi: 127, target: 'TRK1 REC/PLY', targetMin: 0, targetMax: 127,
    });
    expect(get('assign.*.source').values).toBe(ASSIGN_SOURCES);
    expect(get('assign.*.target').values).toBe(ASSIGN_TARGETS);
  });

  it('FACTORY RESET is an action, not a param', () => {
    expect(FACTORY_RESET_TARGETS).toEqual(['MEMORY', 'SYSTEM', 'MEM+SYS']);
    expect(ALL.some((p) => /factory/i.test(p.id))).toBe(false);
  });
});

describe('system defaults from the guide', () => {
  it('INPUT / OUTPUT / USB / MIDI', () => {
    const s = defaultSystem();
    expect(s.input.phantom).toEqual({ MIC1: false, MIC2: false });
    expect(s.input.instGain).toEqual({ INST1: 'INST', INST2: 'INST' });
    expect(s.input.stereoLink).toEqual({ MIC: false, INST1: true, INST2: true });
    expect(s.input.preference).toEqual({ MIC: 'SYSTEM', INST1: 'SYSTEM', INST2: 'SYSTEM' });
    expect(s.input.dynamics).toEqual({ mic1Comp: 'OFF', mic1Ns: 40, mic2Comp: 'OFF', mic2Ns: 40, inst1Ns: 40, inst2Ns: 40 });
    expect(s.output.knob).toBe('ALL');
    expect(s.output.stereoLink).toEqual({ MAIN: true, SUB1: true, SUB2: true });
    expect(s.output.preference).toEqual({ MAIN: 'SYSTEM', SUB1: 'SYSTEM', SUB2: 'SYSTEM', PHONES: 'SYSTEM', RHYTHM: 'SYSTEM', MFX: 'SYSTEM' });
    expect(Object.keys(s.output.routing.track)).toEqual(['MAINL', 'MAINR', 'SUB1L', 'SUB1R', 'SUB2L', 'SUB2R', 'PHONES']);
    for (const jack of Object.values(s.output.routing.track)) expect(jack).toEqual([true, true, true, true, true]);
    for (const dest of Object.values(s.output.routing.inputRhythm)) {
      expect(dest).toEqual({ MIC1: true, MIC2: true, INST1L: true, INST1R: true, INST2L: true, INST2R: true, RHYTHM: true });
    }
    expect(s.output.routing).toMatchObject({ phonesRhythm: false, rhythmOut: 'OUTPUT', phonesOut: 'MAIN-L, R', phonesMonitor: true });
    expect(s.usb).toEqual({ storage: 'OFF', audioMode: 'GENERIC', audioRouting: 'LINE OUT', inputLevel: 100, outputLevel: 100 });
    expect(s.midi).toEqual({
      rxCh: { ctl: 1, rhythm: 10, voice: 1 }, txCh: 'RX CTL',
      sync: { clock: 'AUTO', out: true, start: 'ALL' }, pcOut: true, thru: 'OFF',
    });
  });

  it('SETUP knobs, colours and app additions', () => {
    const s = defaultSystem();
    expect(s.setup).toEqual({
      contrast: 5, displayMode: 'MEMORY NUMBER', indicator: 'STATUS', fxKnobMode: 'IMMEDIATE', autoOff: true,
      memoryExt: { min: 1, max: 99 }, knobFunc: ['MEMORY', 'OFF', 'OFF', 'MFX REVERB'],
      loopStatusColor: { rec: 'RED', play: 'GREEN', dub: 'AMBER', stop: 'OFF', blank: 'OFF' },
      latency: -1, micProcess: false, calibPrompted: false,
    });
  });
});
