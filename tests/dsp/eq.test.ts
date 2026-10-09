import { describe, it, expect } from 'vitest';
import { ParametricEq } from '../../src/dsp/eq';
import { defaultSystem } from '../../src/schema/params';
import type { EqSettings } from '../../src/schema/types';
import { SR, linToDb, rms, sine, inBlocks, allFinite, noise } from './helpers';

const flat = (): EqSettings => ({ ...defaultSystem().input.eq.MIC1 });

/** Gain in dB of the EQ at `freq`, measured on the second half of a one-second sine. */
function gainDb(eq: EqSettings, freq: number): number {
  const proc = new ParametricEq(SR);
  proc.configure(eq);
  const x = sine(SR, freq, -20);
  const y = x.slice();
  inBlocks(y.length, (o, len) => proc.process(y.subarray(o, o + len), len));
  return linToDb(rms(y, SR / 2, SR) / rms(x, SR / 2, SR));
}

describe('ParametricEq', () => {
  it('LO GAIN +12 dB raises a 50 Hz sine by about 12 dB', () => {
    const g = gainDb({ ...flat(), sw: true, loGain: 12 }, 50);
    expect(g).toBeGreaterThan(11);
    expect(g).toBeLessThan(13);
  });

  it('LO GAIN leaves the mids alone', () => {
    expect(Math.abs(gainDb({ ...flat(), sw: true, loGain: 12 }, 1000))).toBeLessThan(0.5);
  });

  it('HIGH GAIN -12 dB lowers a 10 kHz sine and leaves 200 Hz alone', () => {
    const e = { ...flat(), sw: true, hiGain: -12 };
    expect(gainDb(e, 10000)).toBeLessThan(-10);
    expect(Math.abs(gainDb(e, 200))).toBeLessThan(0.5);
  });

  it('LO MID peaks by its gain at its centre frequency', () => {
    const g = gainDb({ ...flat(), sw: true, loMidFreq: 1000, loMidQ: 1, loMidGain: 10 }, 1000);
    expect(g).toBeGreaterThan(9.5);
    expect(g).toBeLessThan(10.5);
  });

  it('HI MID cuts by its gain at its centre frequency', () => {
    const g = gainDb({ ...flat(), sw: true, hiMidFreq: 3150, hiMidQ: 2, hiMidGain: -8 }, 3150);
    expect(g).toBeGreaterThan(-8.5);
    expect(g).toBeLessThan(-7.5);
  });

  it('LEVEL adds a flat gain in dB', () => {
    const g = gainDb({ ...flat(), sw: true, level: 6 }, 1000);
    expect(g).toBeGreaterThan(5.9);
    expect(g).toBeLessThan(6.1);
  });

  it('LO CUT removes the lows (two octaves below the cut is ~24 dB down) and keeps the mids', () => {
    const e = { ...flat(), sw: true, loCut: 200 };
    expect(gainDb(e, 50)).toBeLessThan(-20);
    expect(Math.abs(gainDb(e, 1000))).toBeLessThan(0.5);
  });

  it('HI CUT removes the highs and keeps the mids', () => {
    const e = { ...flat(), sw: true, hiCut: 2000 };
    expect(gainDb(e, 8000)).toBeLessThan(-20);
    expect(Math.abs(gainDb(e, 500))).toBeLessThan(0.5);
  });

  it('is flat with SW on and every gain at 0 / cuts FLAT', () => {
    for (const f of [50, 500, 5000]) expect(Math.abs(gainDb({ ...flat(), sw: true }, f))).toBeLessThan(0.01);
  });

  it('is a bit-exact passthrough with SW off, whatever the gains say', () => {
    const proc = new ParametricEq(SR);
    proc.configure({ ...flat(), sw: false, loGain: 20, hiGain: -20, level: 20, loCut: 800, hiCut: 630 });
    const x = noise(1024, -20);
    const y = x.slice();
    proc.process(y, y.length);
    expect(Array.from(y)).toEqual(Array.from(x));
  });

  it('returns finite values for a 1e-30 input', () => {
    const proc = new ParametricEq(SR);
    proc.configure({ ...flat(), sw: true, loGain: 12, hiGain: 12, loMidGain: 12, hiMidGain: 12, loCut: 100, hiCut: 8000 });
    const y = new Float32Array(4800).fill(1e-30);
    proc.process(y, y.length);
    expect(allFinite(y)).toBe(true);
  });

  it('flushes its filter state to exactly zero after an impulse (no denormal tail)', () => {
    const proc = new ParametricEq(SR);
    proc.configure({ ...flat(), sw: true, loGain: 12, loCut: 20 });
    const y = new Float32Array(SR * 12);
    y[0] = 1;
    proc.process(y, y.length);
    expect(y[y.length - 1]).toBe(0);
    expect(y[y.length - 2]).toBe(0);
  });
});
