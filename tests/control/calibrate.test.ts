import { describe, expect, it } from 'vitest';
import { MIN_DETECTED, ONSET_FACTOR, computeLatency } from '../../src/control/calibrate';

const SR = 48000;
/** Eight clicks 500 ms apart after a 500 ms lead-in, as the engine plays them. */
const CLICKS = Array.from({ length: 8 }, (_, i) => Math.round((i + 1) * 0.5 * SR));
const LENGTH = Math.round(4.5 * SR);

/** A deterministic PRNG (mulberry32), so the noise is the same on every run. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform noise of peak `amp` (its RMS is amp / sqrt(3), so 6x the RMS is never reached by the noise itself). */
function noise(n: number, amp: number, seed = 1): Float32Array {
  const r = rng(seed);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (r() * 2 - 1) * amp;
  return out;
}

/** Adds a 20 ms decaying burst (cosine phase: its first sample is the peak) at `at`. */
function addClick(buf: Float32Array, at: number, gain = 0.3): void {
  const len = Math.round(0.02 * SR);
  for (let k = 0; k < len && at + k < buf.length; k++) {
    buf[at + k]! += gain * Math.cos((2 * Math.PI * 1000 * k) / SR) * Math.exp(-k / (0.004 * SR));
  }
}

describe('computeLatency', () => {
  it('finds clicks delayed by 1234 frames (each jittered by up to 3) as 1234 +- 3, in noise', () => {
    const r = rng(7);
    const capture = noise(LENGTH, 0.002);
    for (const c of CLICKS) addClick(capture, c + 1234 + Math.round(r() * 6 - 3));
    const got = computeLatency(capture, CLICKS, SR);
    expect(got).not.toBeNull();
    expect(Math.abs(got! - 1234)).toBeLessThanOrEqual(3);
  });

  it('is exact without jitter, and the median ignores a few outliers', () => {
    const capture = noise(LENGTH, 0.001, 3);
    CLICKS.forEach((c, i) => addClick(capture, c + (i < 2 ? 9000 : 1234)));
    expect(computeLatency(capture, CLICKS, SR)).toBe(1234);
  });

  it('works on digital silence (no noise at all)', () => {
    const capture = new Float32Array(LENGTH);
    for (const c of CLICKS) addClick(capture, c + 480);
    expect(computeLatency(capture, CLICKS, SR)).toBe(480);
  });

  it('noise only gives null', () => {
    expect(computeLatency(noise(LENGTH, 0.01, 5), CLICKS, SR)).toBeNull();
    expect(computeLatency(new Float32Array(LENGTH), CLICKS, SR)).toBeNull();
  });

  it(`gives null when fewer than ${MIN_DETECTED} of the 8 clicks are heard`, () => {
    const four = noise(LENGTH, 0.001, 9);
    for (const c of CLICKS.slice(0, 4)) addClick(four, c + 1000);
    expect(computeLatency(four, CLICKS, SR)).toBeNull();
    const five = noise(LENGTH, 0.001, 9);
    for (const c of CLICKS.slice(0, 5)) addClick(five, c + 1000);
    expect(computeLatency(five, CLICKS, SR)).toBe(1000);
  });

  it(`a click is heard at the first sample over ${ONSET_FACTOR}x the noise RMS (measured before the first click)`, () => {
    const amp = 0.01; // uniform noise: RMS = amp / sqrt(3)
    const capture = noise(LENGTH, amp, 11);
    const threshold = (ONSET_FACTOR * amp) / Math.sqrt(3);
    for (const c of CLICKS) {
      capture[c + 700] = threshold * 0.9; // under the threshold: not the onset
      capture[c + 701] = threshold * 1.2;
    }
    expect(computeLatency(capture, CLICKS, SR)).toBe(701);
  });

  it('each click is looked for from its own frame up to the next click', () => {
    const capture = new Float32Array(LENGTH);
    // Short responses arriving just before the following click: 23990 frames is inside the 24000-frame window.
    for (const c of CLICKS) capture[c + 23990] = 0.5;
    expect(computeLatency(capture, CLICKS, SR)).toBe(23990);
    // A response before its click's frame belongs to no window.
    const early = new Float32Array(LENGTH);
    for (const c of CLICKS) early[c - 5] = 0.5;
    early.fill(0, 0, CLICKS[0]!); // keep the lead-in silent
    expect(computeLatency(early, CLICKS, SR)).toBe(23995);
  });

  it('gives null for no clicks or a capture that ends before them', () => {
    expect(computeLatency(new Float32Array(LENGTH), [], SR)).toBeNull();
    expect(computeLatency(new Float32Array(100), CLICKS, SR)).toBeNull();
  });
});
