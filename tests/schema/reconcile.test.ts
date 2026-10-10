import { describe, it, expect } from 'vitest';
import { reconcile, reconcileMemory, reconcileSystem, defaultMemory, defaultSystem } from '../../src/schema/params';
import type { MemorySettings, SystemSettings } from '../../src/schema/types';

describe('reconcile (generic rules)', () => {
  const defaults = () => ({ a: 1, s: 'x', b: true, group: { n: 5, deep: { flag: false } }, list: [1, 2, 3] });

  it('returns the defaults when nothing is stored', () => {
    expect(reconcile(undefined, defaults())).toEqual(defaults());
    expect(reconcile(null, defaults())).toEqual(defaults());
    expect(reconcile('garbage', defaults())).toEqual(defaults());
  });

  it('completes a stored object that is missing a group and a leaf', () => {
    const stored = { a: 7, group: { deep: { flag: true } } }; // no s, no b, no list, no group.n
    expect(reconcile(stored, defaults())).toEqual({
      a: 7, s: 'x', b: true, group: { n: 5, deep: { flag: true } }, list: [1, 2, 3],
    });
  });

  it('falls back to the default for a wrong-typed leaf', () => {
    const stored = { a: '7', s: 3, b: 'yes', group: { n: null, deep: { flag: 1 } } };
    expect(reconcile(stored, defaults())).toEqual(defaults());
  });

  it('falls back to the default for a non-finite number', () => {
    expect(reconcile({ a: NaN }, defaults()).a).toBe(1);
    expect(reconcile({ a: Infinity }, defaults()).a).toBe(1);
  });

  it('falls back to the default where an object or array is expected and something else is stored', () => {
    expect(reconcile({ group: 5, list: 'abc' }, defaults())).toEqual(defaults());
    expect(reconcile({ group: [1], list: { 0: 1 } }, defaults())).toEqual(defaults());
  });

  it('drops keys the defaults do not contain, at every depth', () => {
    const stored = { a: 2, extra: 1, group: { n: 6, ghost: true, deep: { flag: true, more: 1 } } };
    const out = reconcile(stored, defaults());
    expect(out).toEqual({ a: 2, s: 'x', b: true, group: { n: 6, deep: { flag: true } }, list: [1, 2, 3] });
    expect(Object.keys(out)).not.toContain('extra');
  });

  it('does not let a stored __proto__ key pollute anything', () => {
    const stored = JSON.parse('{"a": 2, "__proto__": {"polluted": true}}');
    const out = reconcile(stored, defaults()) as Record<string, unknown>;
    expect(out.a).toBe(2);
    expect(out.polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('takes the elements of a stored array, completing a short one from the defaults', () => {
    expect(reconcile({ list: [9, 8] }, defaults()).list).toEqual([9, 8, 3]);
    expect(reconcile({ list: [9, 8, 7] }, defaults()).list).toEqual([9, 8, 7]);
  });

  it('reconciles the object elements of a stored array against the default element', () => {
    const d = { rows: [{ on: false, level: 1 }, { on: false, level: 1 }] };
    const out = reconcile({ rows: [{ on: true }, { level: 'loud', old: 1 }] }, d);
    expect(out.rows).toEqual([{ on: true, level: 1 }, { on: false, level: 1 }]);
  });

  it('lets options.accept decide a path: true takes the stored value, false the default, undefined the rules', () => {
    const d = { v: 'OFF', w: 'OFF', x: 5 };
    const out = reconcile({ v: 12, w: 12, x: 'five' }, d, {
      accept: (path) => (path[0] === 'v' ? true : path[0] === 'w' ? false : undefined),
    });
    expect(out).toEqual({ v: 12, w: 'OFF', x: 5 });
  });

  it('lets options.accept return the value to use ({ value }), so the hook can hand back a corrected value', () => {
    const d = { v: 'OFF', w: 'OFF', list: [1, 2] };
    const seen: string[] = [];
    const out = reconcile({ v: 12, w: 99, list: [5, 6] }, d, {
      accept: (path) => {
        seen.push(path.join('.'));
        return path[0] === 'v' ? { value: 7 } : path[0] === 'w' ? { value: 'FLAT' } : undefined;
      },
    });
    expect(out).toEqual({ v: 7, w: 'FLAT', list: [5, 6] });
    expect(seen).toContain('list.1'); // array elements are offered to the hook too
  });
});

describe('reconcile (arrays)', () => {
  it('validates each element of a primitive array against the default element, falling back per element', () => {
    const d = { flags: [true, false, true], names: ['a', 'b'], levels: [10, 20, 30] };
    const out = reconcile({ flags: [false, 'x', 1], names: [3, 'z'], levels: [5, NaN, 'hi'] }, d);
    expect(out).toEqual({ flags: [false, false, true], names: ['a', 'z'], levels: [5, 20, 30] });
  });

  it('forces a primitive array to the length of the default array: pads from the defaults, truncates extras', () => {
    const d = { flags: [true, false, true, false, true] };
    expect(reconcile({ flags: [false] }, d).flags).toEqual([false, false, true, false, true]);
    expect(reconcile({ flags: [] }, d).flags).toEqual([true, false, true, false, true]);
    expect(reconcile({ flags: [false, false, false, false, false, true, true, true] }, d).flags).toHaveLength(5);
    expect(reconcile({ flags: [false, false, false, false, false, true, true, true] }, d).flags).toEqual([false, false, false, false, false]);
  });

  it('treats a hole or an undefined element as missing', () => {
    // eslint-disable-next-line no-sparse-arrays
    expect(reconcile({ list: [9, , undefined] }, { list: [1, 2, 3] }).list).toEqual([9, 2, 3]);
  });

  it('forces an array of objects to the default length too (extra rows dropped, missing rows defaulted)', () => {
    const d = { rows: [{ on: false, level: 1 }, { on: false, level: 2 }, { on: true, level: 3 }] };
    const long = reconcile({ rows: [{ on: true }, {}, {}, { on: true, level: 9 }, { on: true }] }, d);
    expect(long.rows).toHaveLength(3);
    expect(long.rows).toEqual([{ on: true, level: 1 }, { on: false, level: 2 }, { on: true, level: 3 }]);
    const short = reconcile({ rows: [{ level: 8 }] }, d);
    expect(short.rows).toEqual([{ on: false, level: 8 }, { on: false, level: 2 }, { on: true, level: 3 }]);
  });

  it('replaces a non-object row of an object array with the default row', () => {
    const d = { rows: [{ on: false }, { on: true }] };
    expect(reconcile({ rows: [null, 'row'] }, d).rows).toEqual([{ on: false }, { on: true }]);
  });
});

describe('reconcileSystem', () => {
  it('returns the defaults when nothing is stored', () => {
    expect(reconcileSystem(undefined)).toEqual(defaultSystem());
  });

  it('completes a stored system that lacks a whole group and a leaf', () => {
    const stored = defaultSystem() as unknown as Record<string, unknown>;
    delete stored.midi;
    delete (stored.setup as Record<string, unknown>).contrast;
    (stored.setup as Record<string, unknown>).autoOff = true; // a changed value must survive
    const out = reconcileSystem(stored);
    expect(out.midi).toEqual(defaultSystem().midi);
    expect(out.setup.contrast).toBe(defaultSystem().setup.contrast);
    expect(out.setup.autoOff).toBe(true);
  });

  it('falls back for a wrong-typed leaf and drops an unknown key', () => {
    const stored = defaultSystem() as unknown as Record<string, Record<string, unknown>>;
    stored.setup.contrast = 'high';
    stored.setup.futureThing = 1;
    stored.futureGroup = { a: 1 };
    const out = reconcileSystem(stored) as unknown as Record<string, Record<string, unknown>>;
    expect(out.setup.contrast).toBe(defaultSystem().setup.contrast);
    expect('futureThing' in out.setup).toBe(false);
    expect('futureGroup' in out).toBe(false);
  });

  it('keeps legitimate values whose type differs from the default (keyword defaults holding a number)', () => {
    const stored = defaultSystem();
    stored.input.dynamics.mic1Comp = 40;
    stored.input.eq.MIC1.loCut = 80;
    stored.output.eq.MAINL.hiCut = 8000;
    stored.master.comp = 25;
    stored.midi.txCh = 7;
    const out = reconcileSystem(stored);
    expect(out.input.dynamics.mic1Comp).toBe(40);
    expect(out.input.eq.MIC1.loCut).toBe(80);
    expect(out.output.eq.MAINL.hiCut).toBe(8000);
    expect(out.master.comp).toBe(25);
    expect(out.midi.txCh).toBe(7);
  });

  it('replaces an invalid keyword or a wrong type in such a param with the default', () => {
    const stored = defaultSystem() as unknown as { master: { comp: unknown }; midi: { txCh: unknown } };
    stored.master.comp = 'LOUD';
    stored.midi.txCh = true;
    const out = reconcileSystem(stored);
    expect(out.master.comp).toBe('OFF');
    expect(out.midi.txCh).toBe('RX CTL');
  });

  it('does not alias or mutate the stored object', () => {
    const stored = defaultSystem();
    const before = JSON.stringify(stored);
    const out = reconcileSystem(stored);
    expect(JSON.stringify(stored)).toBe(before);
    expect(out).not.toBe(stored);
  });

  it('leaves a valid, fully populated system unchanged (the defaults are a fixed point)', () => {
    expect(reconcileSystem(defaultSystem())).toEqual(defaultSystem());
  });

  it('clamps out-of-range numbers instead of keeping the raw value', () => {
    const stored = defaultSystem() as unknown as Record<string, Record<string, unknown>>;
    stored.master!.comp = 5000;          // keyword-or-number param, range 1..40
    stored.master!.reverb = -3;          // plain int, range 0..40
    stored.setup!.contrast = 99;         // plain int, range 1..10
    stored.setup!.latency = 1e12;        // plain int, range -1..192000
    const out = reconcileSystem(stored);
    expect(out.master.comp).toBe(40);
    expect(out.master.reverb).toBe(0);
    expect(out.setup.contrast).toBe(10);
    expect(out.setup.latency).toBe(192000);
  });

  it('replaces an enum value the schema does not list with the default', () => {
    const stored = defaultSystem() as unknown as { master: { insert: unknown } };
    stored.master.insert = 'MAIN-X';
    expect(reconcileSystem(stored).master.insert).toBe(defaultSystem().master.insert);
  });

  it('forces the ASSIGN list to 16 entries and completes each entry', () => {
    const stored = defaultSystem() as unknown as { assign: Record<string, unknown>[] };
    stored.assign = [{ sw: true, targetMax: 7 }, ...Array.from({ length: 30 }, () => ({ sw: true }))];
    const out = reconcileSystem(stored);
    expect(out.assign).toHaveLength(16);
    expect(out.assign[0]!.sw).toBe(true);
    expect(out.assign[0]!.targetMax).toBe(7);
    expect(out.assign[0]!.source).toBe(defaultSystem().assign[0]!.source);
    const few = reconcileSystem({ ...defaultSystem(), assign: [{ sw: true }] });
    expect(few.assign).toHaveLength(16);
    expect(few.assign[0]!.sw).toBe(true);
    expect(few.assign[15]).toEqual(defaultSystem().assign[15]);
  });

  it('pads, truncates and element-checks the primitive arrays (routing, panel functions, knob functions)', () => {
    const stored = defaultSystem() as unknown as {
      output: { routing: { track: { MAINL: unknown[] } } };
      ctl: { panelPlay: { track: unknown[] } };
      setup: { knobFunc: unknown[] };
    };
    stored.output.routing.track.MAINL = [!defaultSystem().output.routing.track.MAINL[0], 'yes'];
    stored.ctl.panelPlay.track = ['NOT A FUNCTION', ...Array(10).fill('x')];
    stored.setup.knobFunc = [];
    const out = reconcileSystem(stored);
    const d = defaultSystem();
    expect(out.output.routing.track.MAINL).toEqual([!d.output.routing.track.MAINL[0], ...d.output.routing.track.MAINL.slice(1)]);
    expect(out.ctl.panelPlay.track).toEqual(d.ctl.panelPlay.track);
    expect(out.ctl.panelPlay.track).toHaveLength(5);
    expect(out.setup.knobFunc).toEqual(d.setup.knobFunc);
  });
});

describe('reconcileMemory', () => {
  it('returns the defaults when nothing is stored', () => {
    expect(reconcileMemory(undefined)).toEqual(defaultMemory());
  });

  it('completes a minimal stored memory', () => {
    const out = reconcileMemory({ name: 'OLD', tempo: 99 });
    const expected = defaultMemory();
    expected.name = 'OLD';
    expected.tempo = 99;
    expect(out).toEqual(expected);
  });

  it('completes the fields of each stored track and keeps the track count', () => {
    const stored = defaultMemory() as unknown as { track: Record<string, unknown>[] };
    delete stored.track[2]!.pan;
    stored.track[3]!.playLevel = 150;
    stored.track[4]!.reverse = 'yes';
    const out = reconcileMemory(stored);
    expect(out.track).toHaveLength(5);
    expect(out.track[2]!.pan).toBe(defaultMemory().track[2]!.pan);
    expect(out.track[3]!.playLevel).toBe(150);
    expect(out.track[4]!.reverse).toBe(false);
  });

  it('keeps MEASURE, FADE TIME and LOOP LENGTH values whose type differs from the default', () => {
    const stored = defaultMemory();
    stored.track[1]!.measure = { note: '1/4' };
    stored.track[2]!.measure = { measures: 6 };
    stored.track[3]!.measure = 'AUTO';
    stored.play.fadeIn = { note: '1/8' };
    stored.play.fadeOut = { measures: 16 };
    stored.play.loopLength = 12;
    const out = reconcileMemory(stored);
    expect(out.track[1]!.measure).toEqual({ note: '1/4' });
    expect(out.track[2]!.measure).toEqual({ measures: 6 });
    expect(out.track[3]!.measure).toBe('AUTO');
    expect(out.play.fadeIn).toEqual({ note: '1/8' });
    expect(out.play.fadeOut).toEqual({ measures: 16 });
    expect(out.play.loopLength).toBe(12);
  });

  it('replaces an invalid MEASURE with the default', () => {
    const stored = defaultMemory() as unknown as { track: { measure: unknown }[] };
    stored.track[0]!.measure = { note: '1/3' };
    stored.track[1]!.measure = 7;
    const out = reconcileMemory(stored);
    expect(out.track[0]!.measure).toBe('FREE');
    expect(out.track[1]!.measure).toBe('FREE');
  });

  it('keeps stored prefs groups (reconciled against the system group) and drops unknown ones', () => {
    const sys = defaultSystem();
    sys.master.comp = 30;
    const mixerPartial = { mic1In: 77 } as unknown as SystemSettings['mixer'];
    const stored = { ...defaultMemory(), prefs: { master: sys.master, mixer: mixerPartial, ghost: { a: 1 } } } as unknown as MemorySettings;
    const out = reconcileMemory(stored);
    expect(Object.keys(out.prefs).sort()).toEqual(['master', 'mixer']);
    expect(out.prefs.master!.comp).toBe(30);
    expect(out.prefs.mixer).toEqual({ ...defaultSystem().mixer, mic1In: 77 });
  });

  it('leaves a valid, fully populated memory unchanged (the defaults are a fixed point)', () => {
    expect(reconcileMemory(defaultMemory())).toEqual(defaultMemory());
  });

  it('clamps out-of-range numbers in memory settings', () => {
    const stored = defaultMemory();
    stored.tempo = 1e9;
    stored.track[0]!.pan = 9999;
    stored.track[1]!.playLevel = -40;
    stored.rec.autoRecSens = 0;
    stored.play.currentTrack = 12;
    const out = reconcileMemory(stored);
    expect(out.tempo).toBe(300);
    expect(out.track[0]!.pan).toBe(50);
    expect(out.track[1]!.playLevel).toBe(0);
    expect(out.rec.autoRecSens).toBe(1);
    expect(out.play.currentTrack).toBe(4);
  });

  it('truncates an over-long name and replaces an unknown enum value', () => {
    const stored = defaultMemory() as unknown as { name: string; rec: { quantize: unknown } };
    stored.name = 'A VERY LONG MEMORY NAME INDEED';
    stored.rec.quantize = 'WHENEVER';
    const out = reconcileMemory(stored);
    expect(out.name).toBe('A VERY LONG ');
    expect(out.rec.quantize).toBe(defaultMemory().rec.quantize);
  });

  it('clamps MEASURE, FADE TIME and LOOP LENGTH numbers and drops extra keys inside { measures } / { note }', () => {
    const stored = defaultMemory() as unknown as { track: { measure: unknown }[]; play: Record<string, unknown> };
    stored.track[0]!.measure = { measures: 1000, junk: 1, __proto__: { x: 1 } };
    stored.track[1]!.measure = { note: '1/4', measures: 3, junk: 'x' };
    stored.track[2]!.measure = { measures: -4 };
    stored.track[3]!.measure = { measures: 2.6 };
    stored.play.fadeIn = { measures: 99, extra: true };
    stored.play.fadeOut = { note: '1/8', extra: true };
    stored.play.loopLength = 99999999;
    const out = reconcileMemory(stored);
    expect(out.track[0]!.measure).toEqual({ measures: 64 });
    expect(Object.keys(out.track[0]!.measure as object)).toEqual(['measures']);
    expect(out.track[1]!.measure).toEqual({ note: '1/4' });
    expect(out.track[2]!.measure).toEqual({ measures: 1 });
    expect(out.track[3]!.measure).toEqual({ measures: 3 });
    expect(out.play.fadeIn).toEqual({ measures: 64 });
    expect(out.play.fadeOut).toEqual({ note: '1/8' });
    expect(out.play.loopLength).toBe(25362);
  });

  it('cleans the beat object', () => {
    const stored = defaultMemory() as unknown as { rhythm: { beat: unknown } };
    stored.rhythm.beat = { num: 7, den: 8, extra: 1 };
    expect(reconcileMemory(stored).rhythm.beat).toEqual({ num: 7, den: 8 });
    stored.rhythm.beat = { num: 4, den: 3 };
    expect(reconcileMemory(stored).rhythm.beat).toEqual({ num: 4, den: 4 });
  });

  it('always yields exactly 5 tracks: extra tracks are dropped, missing ones defaulted', () => {
    const base = defaultMemory();
    const eight = { ...base, track: Array.from({ length: 8 }, (_, i) => ({ ...base.track[i % 5]!, pan: i })) };
    const long = reconcileMemory(eight);
    expect(long.track).toHaveLength(5);
    expect(long.track.map((t) => t.pan)).toEqual([0, 1, 2, 3, 4]);

    const two = reconcileMemory({ ...base, track: [{ pan: 10 }, { pan: -10 }] });
    expect(two.track).toHaveLength(5);
    expect(two.track[0]!.pan).toBe(10);
    expect(two.track[1]!.pan).toBe(-10);
    expect(two.track[2]).toEqual(base.track[2]);
    expect(two.track[4]).toEqual(base.track[4]);

    expect(reconcileMemory({ ...base, track: [] }).track).toEqual(base.track);
  });

  it('checks each element of the boolean track arrays and forces them to 5', () => {
    const stored = defaultMemory() as unknown as { rec: { bounceTrack: unknown[] }; play: { allStartTrk: unknown[]; allStopTrk: unknown[] } };
    stored.rec.bounceTrack = [false, 'maybe', 0, null, true, true, true];
    stored.play.allStartTrk = [false];
    stored.play.allStopTrk = [];
    const out = reconcileMemory(stored);
    const d = defaultMemory();
    expect(out.rec.bounceTrack).toEqual([false, d.rec.bounceTrack[1], d.rec.bounceTrack[2], d.rec.bounceTrack[3], true]);
    expect(out.play.allStartTrk).toEqual([false, ...d.play.allStartTrk.slice(1)]);
    expect(out.play.allStopTrk).toEqual(d.play.allStopTrk);
  });

  it('gives empty prefs when prefs is missing or not an object', () => {
    expect(reconcileMemory({ name: 'A' }).prefs).toEqual({});
    expect(reconcileMemory({ name: 'A', prefs: [1, 2] }).prefs).toEqual({});
    expect(reconcileMemory({ name: 'A', prefs: 'x' }).prefs).toEqual({});
  });
});
