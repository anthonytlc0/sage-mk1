import { describe, it, expect } from 'vitest';
import { Compressor } from '../../src/dsp/compressor';
import { SR, allFinite, fill, inBlocks, linToDb, noise, rms, sine } from './helpers';

/** RMS change in dB of a steady sine through the compressor, measured after it has settled. */
function reductionDb(kind: 'mic' | 'master', depth: 'OFF' | number, peakDb = -6): number {
  const c = new Compressor(SR, kind);
  c.setDepth(depth);
  const x = sine(SR, 1000, peakDb);
  const y = x.slice();
  inBlocks(y.length, (o, len) => c.processMono(y.subarray(o, o + len), len));
  return linToDb(rms(y, SR / 2, SR) / rms(x, SR / 2, SR));
}

describe('Compressor', () => {
  it('reduces a -6 dBFS sine more at depth 100 than at depth 1', () => {
    const light = reductionDb('mic', 1);
    const heavy = reductionDb('mic', 100);
    expect(heavy).toBeLessThan(light);
    expect(heavy).toBeLessThan(-6);
  });

  it('master depth 40 reduces more than depth 1', () => {
    expect(reductionDb('master', 40)).toBeLessThan(reductionDb('master', 1));
    expect(reductionDb('master', 40)).toBeLessThan(-3);
  });

  it('gets monotonically heavier as the depth rises', () => {
    let prev = 1;
    for (const d of [1, 20, 50, 100]) {
      const r = reductionDb('mic', d);
      expect(r).toBeLessThanOrEqual(prev + 1e-9);
      prev = r;
    }
  });

  it('leaves a signal far below the threshold alone', () => {
    expect(Math.abs(reductionDb('mic', 1, -50))).toBeLessThan(0.1);
  });

  it('OFF is a bit-exact passthrough', () => {
    const c = new Compressor(SR, 'mic');
    c.setDepth('OFF');
    const x = noise(1024, -10);
    const y = x.slice();
    c.processMono(y, y.length);
    expect(Array.from(y)).toEqual(Array.from(x));
  });

  it('recovers after a loud burst (release)', () => {
    const c = new Compressor(SR, 'mic');
    c.setDepth(100);
    const burst = sine(SR / 2, 1000, -3);
    const quiet = sine(SR * 2, 1000, -40);
    const all = new Float32Array(burst.length + quiet.length);
    all.set(burst); all.set(quiet, burst.length);
    const ref = all.slice();
    inBlocks(all.length, (o, len) => c.processMono(all.subarray(o, o + len), len));
    const from = burst.length + SR * 1.5, to = all.length;
    const rec = linToDb(rms(all, from, to) / rms(ref, from, to));
    expect(Math.abs(rec)).toBeLessThan(1.5);
  });

  it('flushes its release tail: after a burst and a long silence the bypass is bit-exact again', () => {
    const c = new Compressor(SR, 'mic');
    c.setDepth(100);
    const burst = sine(SR / 2, 1000, -3);
    inBlocks(burst.length, (o, len) => c.processMono(burst.subarray(o, o + len), len));
    const silence = new Float32Array(SR * 8);
    inBlocks(silence.length, (o, len) => c.processMono(silence.subarray(o, o + len), len));
    c.setDepth('OFF');
    const x = noise(256, -20, 9);
    const y = x.slice();
    c.processMono(y, y.length);
    expect(Array.from(y)).toEqual(Array.from(x));
  });

  it('stereo processing applies the same gain to both channels (linked detector)', () => {
    const c = new Compressor(SR, 'master');
    c.setDepth(40);
    const l = sine(SR, 1000, -3);
    const r = fill(SR, 0.001);
    const l0 = l.slice(), r0 = r.slice();
    inBlocks(SR, (o, len) => c.processStereo(l.subarray(o, o + len), r.subarray(o, o + len), len));
    const gl = rms(l, SR / 2, SR) / rms(l0, SR / 2, SR);
    const gr = rms(r, SR / 2, SR) / rms(r0, SR / 2, SR);
    expect(gl).toBeLessThan(0.9);
    expect(gr).toBeCloseTo(gl, 3);
  });

  it('returns finite values for a 1e-30 input', () => {
    const c = new Compressor(SR, 'mic');
    c.setDepth(100);
    const y = new Float32Array(SR).fill(1e-30);
    c.processMono(y, y.length);
    expect(allFinite(y)).toBe(true);
    const m = new Compressor(SR, 'master');
    m.setDepth(40);
    const l = new Float32Array(SR).fill(1e-30), r = l.slice();
    m.processStereo(l, r, l.length);
    expect(allFinite(l) && allFinite(r)).toBe(true);
  });
});
