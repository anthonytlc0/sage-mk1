import { describe, it, expect } from 'vitest';
import { MASTER_COMP, MASTER_REVERB, MIC_COMP, MIC_NS, PAN, TRACK_COUNT } from '../../src/dsp/ranges';
import { Compressor } from '../../src/dsp/compressor';
import { nsThresholdDb } from '../../src/dsp/noiseSuppressor';
import { Reverb } from '../../src/dsp/reverb';
import { panGains } from '../../src/dsp/mixer';
import { MEMORY_PARAMS, SYSTEM_PARAMS } from '../../src/schema/params';
import { SR, inBlocks, linToDb, rms, sine } from './helpers';

/** Looks the definition up straight in the registries (not through the code under test). */
function def(id: string) {
  const d = [...SYSTEM_PARAMS, ...MEMORY_PARAMS].find((p) => p.id === id);
  if (!d) throw new Error(`no such param ${id}`);
  return d;
}

describe('DSP ranges follow the schema', () => {
  it('equal the schema values, so a range change cannot drift silently', () => {
    const pairs: [string, { min: number; max: number }][] = [
      ['input.dynamics.mic1Comp', MIC_COMP],
      ['input.dynamics.mic1Ns', MIC_NS],
      ['master.comp', MASTER_COMP],
      ['master.reverb', MASTER_REVERB],
      ['track.*.pan', PAN],
    ];
    for (const [id, r] of pairs) {
      expect(r.min, `${id} min`).toBe(def(id).min);
      expect(r.max, `${id} max`).toBe(def(id).max);
    }
    expect(TRACK_COUNT).toBe(def('track.*.pan').indices!.length);
  });

  it('the pan law spans exactly the schema pan range', () => {
    expect(panGains(PAN.min)).toEqual([1, 0]);
    expect(panGains(PAN.max)).toEqual([0, 1]);
    const [l, r] = panGains((PAN.min + PAN.max) / 2);
    expect(l).toBeCloseTo(Math.SQRT1_2, 12);
    expect(r).toBeCloseTo(Math.SQRT1_2, 12);
  });

  it('the NS curve ends at its top threshold at the schema maximum', () => {
    expect(nsThresholdDb(MIC_NS.max)).toBeCloseTo(-35, 12);
    expect(nsThresholdDb(MIC_NS.max / 2)).toBeCloseTo(-57.5, 12);
  });

  it('the comp curves reach their heaviest setting at the schema maximum and stop there', () => {
    const reduction = (kind: 'mic' | 'master', depth: number, peakDb: number): number => {
      const c = new Compressor(SR, kind);
      c.setDepth(depth);
      const x = sine(SR, 1000, peakDb);
      const y = x.slice();
      inBlocks(y.length, (o, len) => c.processMono(y.subarray(o, o + len), len));
      return linToDb(rms(y, SR / 2, SR) / rms(x, SR / 2, SR));
    };
    for (const [kind, r] of [['mic', MIC_COMP], ['master', MASTER_COMP]] as const) {
      const top = reduction(kind, r.max, -6);
      expect(top).toBeLessThan(reduction(kind, r.max - 1, -6));
      expect(reduction(kind, r.max + 50, -6)).toBeCloseTo(top, 9);
    }
  });

  it('the reverb depth stops at the schema maximum', () => {
    const tail = (depth: number): number => {
      const rev = new Reverb(SR);
      rev.setDepth(depth);
      const l = new Float32Array(SR), r = new Float32Array(SR);
      l[0] = 1; r[0] = 1;
      inBlocks(SR, (o, len) => rev.process(l.subarray(o, o + len), r.subarray(o, o + len), len));
      return rms(l, 2400, SR);
    };
    expect(tail(MASTER_REVERB.max + 50)).toBe(tail(MASTER_REVERB.max));
    expect(tail(MASTER_REVERB.max)).toBeGreaterThan(tail(MASTER_REVERB.max - 1));
  });
});
