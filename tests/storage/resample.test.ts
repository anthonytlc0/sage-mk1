import { describe, it, expect } from 'vitest';
import { StreamingResampler } from '../../src/storage/resample';

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function sine(n: number, freq: number, sr: number, amp = 0.5): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr);
  return out;
}

function cat(parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function resampleAll(inRate: number, outRate: number, L: Float32Array, R: Float32Array): [Float32Array, Float32Array] {
  const rs = new StreamingResampler(inRate, outRate, 2);
  const [a, b] = rs.push(L, R);
  const [fa, fb] = rs.flush();
  return [cat([a, fa]), cat([b, fb])];
}

function rms(x: Float32Array, from: number, to: number): number {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return Math.sqrt(s / (to - from));
}

/** Frequency from positive-going zero crossings with linear interpolation. */
function estimateFreq(x: Float32Array, sr: number, from: number, to: number): number {
  const times: number[] = [];
  for (let i = from + 1; i < to; i++) {
    if (x[i - 1] < 0 && x[i] >= 0) times.push(i - 1 + -x[i - 1] / (x[i] - x[i - 1]));
  }
  return ((times.length - 1) / (times[times.length - 1] - times[0])) * sr;
}

describe('StreamingResampler', () => {
  it('48000 -> 44100: length, 1 kHz frequency and amplitude are preserved', () => {
    const n = 48000;
    const x = sine(n, 1000, 48000);
    const [L, R] = resampleAll(48000, 44100, x, x);
    const expected = Math.round((n * 44100) / 48000);
    expect(Math.abs(L.length - expected)).toBeLessThanOrEqual(2);
    expect(R.length).toBe(L.length);
    const f = estimateFreq(L, 44100, 100, L.length - 100);
    expect(Math.abs(f - 1000) / 1000).toBeLessThan(0.005);
    let peak = 0;
    for (let i = 100; i < L.length - 100; i++) peak = Math.max(peak, Math.abs(L[i]));
    expect(peak).toBeGreaterThan(0.5 * 0.99);
    expect(peak).toBeLessThan(0.5 * 1.01);
  });

  it('48000 -> 44100: a 23 kHz tone (aliasing) is attenuated by more than 60 dB', () => {
    const n = 48000;
    const x = sine(n, 23000, 48000, 0.8);
    const [L] = resampleAll(48000, 44100, x, x);
    const inRms = rms(x, 0, n);
    const outRms = rms(L, 200, L.length - 200);
    const attenuationDb = 20 * Math.log10(inRms / outRms);
    expect(attenuationDb).toBeGreaterThan(60);
  });

  it('keeps the passband flat: 10 kHz and 18 kHz tones lose < 0.1 dB', () => {
    for (const f of [10000, 18000]) {
      const x = sine(48000, f, 48000, 0.5);
      const [L] = resampleAll(48000, 44100, x, x);
      const ratio = rms(L, 200, L.length - 200) / rms(x, 0, x.length);
      expect(Math.abs(20 * Math.log10(ratio))).toBeLessThan(0.1);
    }
  });

  it('has unity DC gain', () => {
    const x = new Float32Array(4000).fill(0.7);
    const [L] = resampleAll(48000, 44100, x, x);
    for (let i = 100; i < L.length - 100; i++) expect(Math.abs(L[i] - 0.7)).toBeLessThan(1e-4);
  });

  it('44100 -> 48000 upsamples with the right length and frequency', () => {
    const n = 44100;
    const x = sine(n, 1000, 44100);
    const [L] = resampleAll(44100, 48000, x, x);
    expect(Math.abs(L.length - Math.round((n * 48000) / 44100))).toBeLessThanOrEqual(2);
    const f = estimateFreq(L, 48000, 100, L.length - 100);
    expect(Math.abs(f - 1000) / 1000).toBeLessThan(0.005);
  });

  it('emits exactly the outputs that fall inside the input, for common rate pairs', () => {
    for (const [inRate, outRate] of [[48000, 44100], [96000, 44100], [44100, 48000], [22050, 44100]] as const) {
      const n = inRate; // one second
      const x = sine(n, 1000, inRate);
      const [L] = resampleAll(inRate, outRate, x, x);
      expect(L.length).toBe(Math.ceil((n * outRate) / inRate));
      const ratio = rms(L, 300, L.length - 300) / rms(x, 0, n);
      expect(Math.abs(ratio - 1)).toBeLessThan(1e-3);
    }
  });

  it('processes the two channels independently', () => {
    const n = 6000;
    const a = sine(n, 700, 48000, 0.4);
    const b = sine(n, 3100, 48000, 0.2);
    const [L, R] = resampleAll(48000, 44100, a, b);
    const [L2] = resampleAll(48000, 44100, a, new Float32Array(n));
    const [, R2] = resampleAll(48000, 44100, new Float32Array(n), b);
    expect(L).toEqual(L2);
    expect(R).toEqual(R2);
  });

  it('pushing in 7 random-sized blocks equals a single push (+-1e-6)', () => {
    const rnd = lcg(42);
    const n = 20000;
    const L = new Float32Array(n);
    const R = new Float32Array(n);
    for (let i = 0; i < n; i++) { L[i] = rnd() * 2 - 1; R[i] = 0.5 * Math.sin(i * 0.37) + (rnd() - 0.5) * 0.2; }
    const [refL, refR] = resampleAll(48000, 44100, L, R);

    const cuts = Array.from({ length: 6 }, () => Math.floor(rnd() * n)).sort((p, q) => p - q);
    const bounds = [0, ...cuts, n];
    expect(bounds.length - 1).toBe(7);
    const rs = new StreamingResampler(48000, 44100, 2);
    const outL: Float32Array[] = [];
    const outR: Float32Array[] = [];
    for (let k = 0; k < 7; k++) {
      const [a, b] = rs.push(L.subarray(bounds[k], bounds[k + 1]), R.subarray(bounds[k], bounds[k + 1]));
      outL.push(a); outR.push(b);
    }
    const [fa, fb] = rs.flush();
    outL.push(fa); outR.push(fb);
    const gotL = cat(outL);
    const gotR = cat(outR);
    expect(gotL.length).toBe(refL.length);
    expect(gotR.length).toBe(refR.length);
    for (let i = 0; i < refL.length; i++) {
      expect(Math.abs(gotL[i] - refL[i])).toBeLessThanOrEqual(1e-6);
      expect(Math.abs(gotR[i] - refR[i])).toBeLessThanOrEqual(1e-6);
    }
  });

  it('tiny and empty blocks (shorter than the kernel) give the same output', () => {
    const n = 700;
    const x = sine(n, 2500, 48000, 0.6);
    const [refL] = resampleAll(48000, 44100, x, x);
    const rs = new StreamingResampler(48000, 44100, 2);
    const parts: Float32Array[] = [];
    for (let i = 0; i < n; i++) {
      parts.push(rs.push(x.subarray(i, i + 1), x.subarray(i, i + 1))[0]);
      if (i % 50 === 0) parts.push(rs.push(new Float32Array(0), new Float32Array(0))[0]);
    }
    parts.push(rs.flush()[0]);
    const got = cat(parts);
    expect(got.length).toBe(refL.length);
    for (let i = 0; i < got.length; i++) expect(Math.abs(got[i] - refL[i])).toBeLessThanOrEqual(1e-6);
  });

  it('is a passthrough when the rates are equal', () => {
    const rnd = lcg(3);
    const L = Float32Array.from({ length: 1000 }, () => rnd() - 0.5);
    const R = Float32Array.from({ length: 1000 }, () => rnd() - 0.5);
    const rs = new StreamingResampler(44100, 44100, 2);
    const [a, b] = rs.push(L, R);
    expect(a).toEqual(L);
    expect(b).toEqual(R);
    expect(a).not.toBe(L); // a copy, not an alias of the caller's buffer
    const [fa, fb] = rs.flush();
    expect(fa.length).toBe(0);
    expect(fb.length).toBe(0);
  });

  it('flush on an empty stream returns empty arrays and can be reused afterwards', () => {
    const rs = new StreamingResampler(48000, 44100, 2);
    const [a, b] = rs.flush();
    expect(a.length).toBe(0);
    expect(b.length).toBe(0);
    const x = sine(3000, 1000, 48000);
    const first = cat([rs.push(x, x)[0], rs.flush()[0]]);
    const second = cat([rs.push(x, x)[0], rs.flush()[0]]); // flush resets stream state
    expect(second).toEqual(first);
  });

  it('rejects mismatched channel lengths and invalid rates', () => {
    const rs = new StreamingResampler(48000, 44100, 2);
    expect(() => rs.push(new Float32Array(3), new Float32Array(4))).toThrow();
    expect(() => new StreamingResampler(0, 44100, 2)).toThrow();
    expect(() => new StreamingResampler(48000, NaN, 2)).toThrow();
  });
});
