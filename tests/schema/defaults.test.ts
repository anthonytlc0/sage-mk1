import { describe, it, expect } from 'vitest';
import { defaultMemory, defaultSystem, MEMORY_PARAMS, SYSTEM_PARAMS, concreteIds } from '../../src/schema/params';
import type { MemorySettings, SystemSettings } from '../../src/schema/types';

describe('defaultMemory', () => {
  it('is an unnamed memory with 5 tracks', () => {
    const m = defaultMemory();
    expect(m.name).toBe('');
    expect(m.track.length).toBe(5);
    expect(m.prefs).toEqual({});
    expect(m.tempo).toBe(120);
  });

  it('matches the snapshot', () => {
    expect(defaultMemory()).toMatchSnapshot();
  });
});

describe('defaultSystem', () => {
  it('matches the snapshot', () => {
    expect(defaultSystem()).toMatchSnapshot();
  });
});

/**
 * The default objects are generated from the registries. These checks make sure the generated shape and the registry
 * agree in both directions: every registered id exists in the default object, and the default object holds nothing
 * that is not registered.
 */
function leafPaths(obj: unknown, known: Set<string>, prefix: string[] = [], out: { visited: Set<string>; stray: string[] } = { visited: new Set(), stray: [] }) {
  const path = prefix.join('.');
  if (path !== '' && known.has(path)) {
    out.visited.add(path);
    return out;
  }
  if (obj !== null && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) leafPaths(v, known, [...prefix, k], out);
  } else {
    out.stray.push(path);
  }
  return out;
}

describe('registry and default objects agree', () => {
  it('memory: every id is present, nothing is unregistered', () => {
    const known = new Set(MEMORY_PARAMS.flatMap((d) => concreteIds(d)));
    const { visited, stray } = leafPaths(defaultMemory(), known);
    // `prefs` is a container for PREFERENCE=MEMORY copies of system groups and starts empty.
    expect(stray).toEqual([]);
    expect([...known].filter((id) => !visited.has(id))).toEqual([]);
  });

  it('system: every id is present, nothing is unregistered', () => {
    const known = new Set(SYSTEM_PARAMS.flatMap((d) => concreteIds(d)));
    const { visited, stray } = leafPaths(defaultSystem(), known);
    expect(stray).toEqual([]);
    expect([...known].filter((id) => !visited.has(id))).toEqual([]);
  });

  it('the typed shapes expose the generated fields (compile-time spot check)', () => {
    const m: MemorySettings = defaultMemory();
    const s: SystemSettings = defaultSystem();
    expect(m.track[0]!.input.INST2R).toBe(true);
    expect(m.rhythm.beat.den).toBe(4);
    expect(s.input.eq.MIC1.loMidFreq).toBe(250);
    expect(s.output.eq.SUB2R.hiCut).toBe('FLAT');
    expect(s.mixer.masterOut).toBe(100);
    expect(s.master.reverb).toBe(0);
    expect(s.ctl.exp.EXP2.func).toBe('TR FX CUR CTL');
    expect(s.assign[3]!.target).toBe('TRK1 REC/PLY');
    expect(s.setup.loopStatusColor.dub).toBe('AMBER');
  });
});
