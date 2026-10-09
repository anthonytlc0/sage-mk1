import { describe, it, expect } from 'vitest';
import { Biquad } from '../../src/dsp/biquad';
import { SR, linToDb, rms, sine } from './helpers';

function gainDb(setup: (b: Biquad) => void, freq: number): number {
  const b = new Biquad();
  setup(b);
  const x = sine(SR, freq, -20);
  const y = x.slice();
  b.process(y, y.length);
  return linToDb(rms(y, SR / 2, SR) / rms(x, SR / 2, SR));
}

describe('Biquad (RBJ cookbook)', () => {
  it('peaking has exactly its gain at the centre frequency', () => {
    expect(gainDb((b) => b.peaking(SR, 1000, 2, 9), 1000)).toBeCloseTo(9, 1);
    expect(gainDb((b) => b.peaking(SR, 1000, 2, -9), 1000)).toBeCloseTo(-9, 1);
  });
  it('lowpass is -3 dB at the cutoff for Q = 1/sqrt(2) and 12 dB/octave beyond', () => {
    expect(gainDb((b) => b.lowpass(SR, 1000, Math.SQRT1_2), 1000)).toBeCloseTo(-3.01, 1);
    expect(gainDb((b) => b.lowpass(SR, 1000, Math.SQRT1_2), 4000)).toBeLessThan(-23);
  });
  it('highpass mirrors the lowpass', () => {
    expect(gainDb((b) => b.highpass(SR, 1000, Math.SQRT1_2), 1000)).toBeCloseTo(-3.01, 1);
    expect(gainDb((b) => b.highpass(SR, 1000, Math.SQRT1_2), 250)).toBeLessThan(-23);
  });
  it('shelves reach their gain well inside the shelf', () => {
    expect(gainDb((b) => b.lowShelf(SR, 1000, 12), 30)).toBeCloseTo(12, 0);
    expect(gainDb((b) => b.highShelf(SR, 1000, -12), 15000)).toBeCloseTo(-12, 0);
  });
  it('identity() passes samples unchanged', () => {
    const b = new Biquad();
    b.identity();
    const x = sine(256, 440, -6);
    const y = x.slice();
    b.process(y, y.length);
    expect(Array.from(y)).toEqual(Array.from(x));
  });
  it('clamps a corner frequency at or above Nyquist so the filter stays stable', () => {
    const b = new Biquad();
    b.lowpass(SR, 1e6, 0.7);
    const y = new Float32Array(SR).fill(0.5);
    b.process(y, y.length);
    expect(Number.isFinite(y[y.length - 1]!)).toBe(true);
    expect(Math.abs(y[y.length - 1]!)).toBeLessThan(1);
  });
  it('reset() clears the state', () => {
    const b = new Biquad();
    b.lowpass(SR, 500, 0.7);
    b.process(sine(512, 100, -3), 512);
    b.reset();
    const y = new Float32Array(4);
    b.process(y, 4);
    expect(Array.from(y)).toEqual([0, 0, 0, 0]);
  });
});
