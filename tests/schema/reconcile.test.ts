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

  it('takes an array from storage when storage has an array', () => {
    expect(reconcile({ list: [9, 8] }, defaults()).list).toEqual([9, 8]);
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

  it('gives empty prefs when prefs is missing or not an object', () => {
    expect(reconcileMemory({ name: 'A' }).prefs).toEqual({});
    expect(reconcileMemory({ name: 'A', prefs: [1, 2] }).prefs).toEqual({});
    expect(reconcileMemory({ name: 'A', prefs: 'x' }).prefs).toEqual({});
  });
});
