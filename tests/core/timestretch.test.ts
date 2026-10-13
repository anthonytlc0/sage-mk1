/**
 * The interpolating reader and the XFADE stretcher on their own, against takes built from arrays (sr 48000, so a
 * 1 kHz sine is exactly 48 frames a cycle and the stretcher's 60 ms grain is 2880 frames).
 */
import { describe, expect, it } from 'vitest';
import { AudioTake, ChunkPool } from '../../src/core/chunks';
import { readInterpolated } from '../../src/core/resampleRead';
import { XfadeStretcher } from '../../src/core/timestretch';

const SR = 48000;
const pool = new ChunkPool(SR, 64 * 1024 * 1024);

/** A take holding `fn(frame)` on both channels for `n` frames. */
function takeOf(n: number, fn: (f: number) => number): AudioTake {
  const L = new Float32Array(n);
  for (let i = 0; i < n; i++) L[i] = fn(i);
  return AudioTake.fromArrays(pool, L, L.slice())!;
}

const sine = (hz: number, amp = 1) => (f: number): number => amp * Math.sin((2 * Math.PI * hz * f) / SR);

/** Positive-going zero crossings in `x[from, from + n)`. */
function crossings(x: Float32Array, from: number, n: number): number {
  let c = 0;
  for (let i = from + 1; i < from + n; i++) if (x[i - 1] < 0 && x[i] >= 0) c++;
  return c;
}

/** Render `n` frames in 256-frame steps, as a track does. */
function stretch(s: XfadeStretcher, take: AudioTake, rate: number, n: number): Float32Array {
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i += 256) s.render(take, rate, Math.min(256, n - i), L, R, i);
  return L;
}

/** RMS of `x` over consecutive `win`-frame windows in `[from, to)`. */
function windowRms(x: Float32Array, from: number, to: number, win: number): number[] {
  const out: number[] = [];
  for (let a = from; a + win <= to; a += win) {
    let s = 0;
    for (let i = a; i < a + win; i++) s += x[i] * x[i];
    out.push(Math.sqrt(s / win));
  }
  return out;
}

describe('readInterpolated (4-point cubic Hermite)', () => {
  it('returns the stored sample exactly at whole positions', () => {
    const take = takeOf(1000, sine(440));
    const L = new Float32Array(1);
    const R = new Float32Array(1);
    const direct = new Float32Array(1000);
    take.read(0, direct, new Float32Array(1000), 0, 1000);
    for (const p of [0, 1, 255, 500, 998, 999]) {
      readInterpolated(take, p, L, R, 0);
      expect(L[0]).toBe(direct[p]);
      expect(R[0]).toBe(direct[p]);
    }
  });

  it('reproduces a straight line between samples', () => {
    const take = takeOf(1000, (f) => f * 0.5);
    const L = new Float32Array(1);
    const R = new Float32Array(1);
    for (const p of [10.25, 100.5, 500.75, 997.125]) {
      readInterpolated(take, p, L, R, 0);
      expect(L[0]).toBeCloseTo(p * 0.5, 4);
    }
  });

  it('is circular: positions past the end (or below 0) read the loop start (or end)', () => {
    const take = takeOf(1000, (f) => f);
    const a = new Float32Array(2);
    const b = new Float32Array(2);
    readInterpolated(take, 1000 + 20.5, a, b, 0);
    readInterpolated(take, 20.5, a, b, 1);
    expect(a[0]).toBe(a[1]);
    readInterpolated(take, -3, a, b, 0);
    expect(a[0]).toBe(997);
  });

  it('crosses chunk boundaries (one chunk is one second)', () => {
    const take = takeOf(3 * SR, (f) => f);
    const L = new Float32Array(1);
    const R = new Float32Array(1);
    readInterpolated(take, SR - 0.5, L, R, 0);
    expect(L[0]).toBeCloseTo(SR - 0.5, 3);
    readInterpolated(take, 2 * SR - 1.75, L, R, 0);
    expect(L[0]).toBeCloseTo(2 * SR - 1.75, 3);
  });

  it('interpolates a sine closely between its samples', () => {
    const take = takeOf(SR, sine(1000));
    const L = new Float32Array(1);
    const R = new Float32Array(1);
    let worst = 0;
    for (let p = 100.37; p < 2000; p += 3.11) {
      readInterpolated(take, p, L, R, 0);
      worst = Math.max(worst, Math.abs(L[0] - sine(1000)(p)));
    }
    expect(worst).toBeLessThan(2e-3);
  });

  it('reads silence from an empty take', () => {
    const take = new AudioTake(pool);
    const L = new Float32Array([9]);
    const R = new Float32Array([9]);
    readInterpolated(take, 3.5, L, R, 0);
    expect(L[0]).toBe(0);
    expect(R[0]).toBe(0);
  });
});

describe('XfadeStretcher', () => {
  it('moves its source position at the rate: reset sets it, render advances it by rate x n', () => {
    const take = takeOf(2 * SR, sine(1000));
    const s = new XfadeStretcher(SR);
    s.reset(1234);
    expect(s.position).toBe(1234);
    stretch(s, take, 0.5, 1000);
    expect(s.position).toBeCloseTo(1234 + 500, 9);
    stretch(s, take, 2, 1000);
    expect(s.position).toBeCloseTo(1234 + 500 + 2000, 9);
    stretch(s, take, -1.5, 1000); // reverse
    expect(s.position).toBeCloseTo(1234 + 500 + 2000 - 1500, 9);
  });

  it('starts exactly where a plain read would: the first frame after reset is the sample at the position', () => {
    const take = takeOf(2 * SR, sine(1000));
    for (const pos of [5000, 5000.5]) {
      const s = new XfadeStretcher(SR);
      s.reset(pos);
      const L = new Float32Array(1);
      s.render(take, 0.5, 1, L, new Float32Array(1), 0);
      const want = new Float32Array(1);
      readInterpolated(take, pos, want, new Float32Array(1), 0);
      expect(L[0]).toBeCloseTo(want[0], 6);
    }
  });

  it.each([0.5, 0.75, 1.5, 2, -0.5])('keeps the pitch at rate %f (1 kHz in, 1 kHz out, within 2%)', (rate) => {
    const take = takeOf(4 * SR, sine(1000));
    const s = new XfadeStretcher(SR);
    s.reset(rate > 0 ? 0 : 3 * SR);
    const out = stretch(s, take, rate, SR);
    const hz = crossings(out, SR / 4, SR / 2) / 0.5;
    expect(hz).toBeGreaterThan(980);
    expect(hz).toBeLessThan(1020);
  });

  it('holds the level when the two heads read correlated audio (rate near 1: no 3 dB swell at each crossfade)', () => {
    // 100 Hz at rate 0.95: the heads sit 72 frames (54 degrees) apart, so a plain equal-power crossfade would swell by
    // about 2 dB at every crossover.
    const take = takeOf(4 * SR, sine(100, 0.5));
    for (const rate of [0.95, 0.999, 1.05]) {
      const s = new XfadeStretcher(SR);
      s.reset(SR);
      const out = stretch(s, take, rate, SR);
      const rms = windowRms(out, 4800, SR, 480); // one 100 Hz cycle per window
      const ref = 0.5 / Math.SQRT2;
      for (const v of rms) {
        expect(20 * Math.log10(v / ref)).toBeGreaterThan(-1);
        expect(20 * Math.log10(v / ref)).toBeLessThan(1);
      }
    }
  });

  it('holds the level on uncorrelated audio (equal-power crossfades)', () => {
    let seed = 12345;
    const noise = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff - 0.5;
    };
    const take = takeOf(4 * SR, () => noise());
    const s = new XfadeStretcher(SR);
    s.reset(0);
    const out = stretch(s, take, 0.5, 2 * SR);
    const rms = windowRms(out, 0, 2 * SR, 4800);
    const ref = Math.sqrt(1 / 12) * 1; // uniform noise in [-0.5, 0.5)
    for (const v of rms) {
      expect(20 * Math.log10(v / ref)).toBeGreaterThan(-1.5);
      expect(20 * Math.log10(v / ref)).toBeLessThan(1.5);
    }
  });

  it('keeps the audio in time: a burst at source position P comes out centred on output frame P / rate', () => {
    // A head seeded at the source position (rather than ahead of or behind it) would read it (1 - rate) * 1440 frames
    // off at its window's peak: 1440 output frames early at 0.5x, 480 late at 1.5x.
    const P = 48000;
    const take = takeOf(4 * SR, (f) => (f >= P && f < P + 96 ? Math.sin((2 * Math.PI * 1000 * f) / SR) : 0));
    const centroidError = (rate: number, start: number): number => {
      const s = new XfadeStretcher(SR);
      s.reset(start);
      const n = Math.ceil((2 * P) / rate);
      const out = stretch(s, take, rate, n);
      let e = 0;
      let et = 0;
      for (let i = 0; i < n; i++) {
        e += out[i] * out[i];
        et += i * out[i] * out[i];
      }
      return et / e - (P + 48 - start) / rate; // the burst's own centre is P + 48
    };
    // Below 1x both heads read the burst, either side of their peaks.
    for (const start of [0, 1000, 2000]) expect(Math.abs(centroidError(0.5, start))).toBeLessThan(50);
    // Above 1x one head catches it wherever its window happens to be (jitter up to G / (2 * rate)); on average over
    // the grain's phase it is on time.
    let sum = 0;
    for (let start = 0; start < 2880; start += 240) sum += centroidError(1.5, start);
    expect(Math.abs(sum / 12)).toBeLessThan(60);
  });

  it('peek renders what render would, without moving anything', () => {
    const take = takeOf(2 * SR, sine(1000));
    const s = new XfadeStretcher(SR);
    s.reset(3000);
    stretch(s, take, 0.7, 5000);
    const pos = s.position;
    const a = new Float32Array(240);
    const b = new Float32Array(240);
    s.peek(take, 0.7, 240, a, new Float32Array(240), 0);
    expect(s.position).toBe(pos);
    s.peek(take, 0.7, 240, b, new Float32Array(240), 0);
    expect(b).toEqual(a);
    const c = new Float32Array(240);
    s.render(take, 0.7, 240, c, new Float32Array(240), 0);
    expect(c).toEqual(a);
  });

  it('shift moves the source and both heads together, so the output is unchanged', () => {
    const take = takeOf(SR, sine(1000));
    const a = new XfadeStretcher(SR);
    const b = new XfadeStretcher(SR);
    a.reset(1000);
    b.reset(1000);
    stretch(a, take, 0.6, 7000);
    stretch(b, take, 0.6, 7000);
    b.shift(-SR); // one loop length: every read lands on the same sample
    expect(b.position).toBeCloseTo(a.position - SR, 9);
    const ya = stretch(a, take, 0.6, 3000);
    const yb = stretch(b, take, 0.6, 3000);
    for (let i = 0; i < 3000; i++) expect(yb[i]).toBeCloseTo(ya[i], 6); // the fractions differ by float rounding only
  });
});
