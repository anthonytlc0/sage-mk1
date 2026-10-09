import { describe, it, expect } from 'vitest';
import { NoiseSuppressor } from '../../src/dsp/noiseSuppressor';
import { SR, allFinite, inBlocks, linToDb, noise, rms, sine } from './helpers';

function run(ns: number, x: Float32Array): Float32Array {
  const p = new NoiseSuppressor(SR);
  p.setAmount(ns);
  const y = x.slice();
  inBlocks(y.length, (o, len) => p.process(y.subarray(o, o + len), len));
  return y;
}

describe('NoiseSuppressor', () => {
  it('NS 100 attenuates -70 dBFS noise by more than 20 dB', () => {
    const x = noise(SR * 2, -70);
    const y = run(100, x);
    const att = linToDb(rms(x, SR, SR * 2) / rms(y, SR, SR * 2));
    expect(att).toBeGreaterThan(20);
  });

  it('suppresses harder as NS rises', () => {
    const x = noise(SR * 2, -60);
    const a40 = linToDb(rms(x, SR, SR * 2) / rms(run(40, x), SR, SR * 2));
    const a100 = linToDb(rms(x, SR, SR * 2) / rms(run(100, x), SR, SR * 2));
    expect(a100).toBeGreaterThan(a40);
  });

  it('passes a signal well above the threshold untouched (within 0.5 dB)', () => {
    const x = sine(SR, 440, -12);
    const y = run(100, x);
    expect(Math.abs(linToDb(rms(y, SR / 2, SR) / rms(x, SR / 2, SR)))).toBeLessThan(0.5);
  });

  it('NS 0 is a bit-exact passthrough', () => {
    const x = noise(2048, -70);
    expect(Array.from(run(0, x))).toEqual(Array.from(x));
  });

  it('opens within a few milliseconds when a signal starts', () => {
    const quiet = noise(SR, -80);
    const burst = sine(SR / 10, 1000, -10);
    const x = new Float32Array(quiet.length + burst.length);
    x.set(quiet); x.set(burst, quiet.length);
    const y = run(100, x);
    const lastMs = Math.round(SR * 0.01);
    const from = x.length - lastMs;
    expect(linToDb(rms(y, from, x.length) / rms(x, from, x.length))).toBeGreaterThan(-1);
  });

  it('NS 0 after a gated stretch re-opens smoothly and then is bit-exact', () => {
    const p = new NoiseSuppressor(SR);
    p.setAmount(100);
    const hush = noise(SR, -80);
    inBlocks(hush.length, (o, len) => p.process(hush.subarray(o, o + len), len));
    p.setAmount(0);
    const x = noise(SR, -40, 4);
    const y = x.slice();
    inBlocks(y.length, (o, len) => p.process(y.subarray(o, o + len), len));
    expect(Array.from(y.subarray(SR / 2))).toEqual(Array.from(x.subarray(SR / 2)));
  });

  it('returns finite values for a 1e-30 input', () => {
    expect(allFinite(run(100, new Float32Array(SR).fill(1e-30)))).toBe(true);
  });
});
