import { describe, it, expect } from 'vitest';
import { MasterFx } from '../../src/dsp/master';
import { defaultSystem } from '../../src/schema/params';
import type { SystemSettings } from '../../src/schema/types';
import { SR, allFinite, linToDb, noise, rms, sine } from './helpers';

const BLOCK = 128;

function run(edit: ((s: SystemSettings) => void) | undefined, l: Float32Array, r: Float32Array) {
  const sys = defaultSystem();
  edit?.(sys);
  const fx = new MasterFx(SR);
  fx.configure(sys);
  const L = l.slice(), R = r.slice();
  for (let o = 0; o < L.length; o += BLOCK) {
    const n = Math.min(BLOCK, L.length - o);
    fx.process(L.subarray(o, o + n), R.subarray(o, o + n), n);
  }
  return { L, R };
}

describe('MasterFx', () => {
  it('is a bit-exact passthrough with the default settings', () => {
    const l = noise(4096, -12, 1), r = noise(4096, -12, 2);
    const { L, R } = run(undefined, l, r);
    expect(Array.from(L)).toEqual(Array.from(l));
    expect(Array.from(R)).toEqual(Array.from(r));
  });

  it('MASTER OUT scales both channels by v/100', () => {
    const l = sine(SR / 4, 440, -20), r = sine(SR / 4, 330, -20);
    const dbl = run((s) => { s.mixer.masterOut = 200; }, l, r);
    expect(rms(dbl.L, 4800, 12000) / rms(l, 4800, 12000)).toBeCloseTo(2, 4);
    expect(rms(dbl.R, 4800, 12000) / rms(r, 4800, 12000)).toBeCloseTo(2, 4);
    const zero = run((s) => { s.mixer.masterOut = 0; }, l, r);
    expect(rms(zero.L)).toBe(0);
  });

  it('MAIN-L OUT / MAIN-R OUT trim each side', () => {
    const l = sine(SR / 4, 440, -20), r = l.slice();
    const { L, R } = run((s) => { s.mixer.mainLOut = 50; s.mixer.mainROut = 200; }, l, r);
    expect(rms(L, 4800, 12000) / rms(l, 4800, 12000)).toBeCloseTo(0.5, 4);
    expect(rms(R, 4800, 12000) / rms(r, 4800, 12000)).toBeCloseTo(2, 4);
  });

  it('COMP 40 reduces a loud sine more than COMP 1', () => {
    const x = sine(SR, 1000, -3);
    const g = (depth: number): number => {
      const { L } = run((s) => { s.master.comp = depth; }, x, x);
      return linToDb(rms(L, SR / 2, SR) / rms(x, SR / 2, SR));
    };
    expect(g(40)).toBeLessThan(g(1));
    expect(g(40)).toBeLessThan(-3);
  });

  it('REVERB leaves a tail after a click; REVERB 0 does not', () => {
    const click = new Float32Array(SR); click[0] = 1;
    const wet = run((s) => { s.master.reverb = 25; }, click, click);
    expect(rms(wet.L, 4800, 24000)).toBeGreaterThan(1e-3);
    const dry = run(undefined, click, click);
    expect(rms(dry.L, 4800, 24000)).toBe(0);
  });

  it('applies the OUTPUT EQ (MAIN-L) to the left channel', () => {
    const x = sine(SR, 50, -20);
    const { L } = run((s) => { const e = s.output.eq.MAINL; e.sw = true; e.loGain = 12; }, x, x);
    const g = linToDb(rms(L, SR / 2, SR) / rms(x, SR / 2, SR));
    expect(g).toBeGreaterThan(11);
    expect(g).toBeLessThan(13);
  });

  it('with MAIN STEREO LINK on, the right side follows the left EQ; with it off, it uses MAIN-R', () => {
    const x = sine(SR, 50, -20);
    const edit = (link: boolean) => (s: SystemSettings): void => {
      s.output.stereoLink.MAIN = link;
      const e = s.output.eq.MAINL; e.sw = true; e.loGain = 12;
    };
    const linked = run(edit(true), x, x);
    const unlinked = run(edit(false), x, x);
    expect(linToDb(rms(linked.R, SR / 2, SR) / rms(x, SR / 2, SR))).toBeGreaterThan(11);
    expect(Math.abs(linToDb(rms(unlinked.R, SR / 2, SR) / rms(x, SR / 2, SR)))).toBeLessThan(0.1);
  });

  it('MASTER FX INSERT = OFF bypasses COMP and REVERB', () => {
    const x = sine(SR, 1000, -3);
    const { L } = run((s) => { s.master.comp = 40; s.master.reverb = 40; s.master.insert = 'OFF'; }, x, x);
    expect(Array.from(L)).toEqual(Array.from(x));
  });

  it('returns finite values for a 1e-30 input', () => {
    const x = new Float32Array(SR).fill(1e-30);
    const { L, R } = run((s) => {
      s.master.comp = 40; s.master.reverb = 40;
      const e = s.output.eq.MAINL; e.sw = true; e.loGain = 12; e.hiGain = 12; e.loCut = 100;
    }, x, x);
    expect(allFinite(L) && allFinite(R)).toBe(true);
  });

  it('survives a non-finite sample without poisoning later output', () => {
    const l = sine(4096, 440, -6), r = l.slice();
    l[50] = NaN; r[60] = Infinity;
    const { L, R } = run((s) => { s.master.comp = 20; s.master.reverb = 20; }, l, r);
    expect(allFinite(L) && allFinite(R)).toBe(true);
  });
});
