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

  it('speech in several windows (headphones on: no click reaches the mic) gives null', () => {
    // The reviewer's probe: background noise, then talking from 1.2 s to 3.9 s, syllables of random length and pitch.
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const r = rng(100 + seed);
      const capture = noise(LENGTH, 0.001, seed);
      let t = Math.round(1.2 * SR);
      const end = Math.round(3.9 * SR);
      while (t < end) {
        const len = Math.round((0.08 + r() * 0.22) * SR);
        const f0 = 110 + r() * 140;
        const amp = 0.05 + r() * 0.25;
        for (let k = 0; k < len && t + k < end; k++) {
          const env = Math.sin((Math.PI * k) / len);
          let v = 0;
          for (let h = 1; h <= 5; h++) v += Math.sin((2 * Math.PI * f0 * h * k) / SR) / h;
          capture[t + k]! += amp * env * v;
        }
        t += len + Math.round((0.03 + r() * 0.12) * SR);
      }
      expect(computeLatency(capture, CLICKS, SR), `seed ${seed}`).toBeNull();
    }
  });

  it('a very reverberant room (RT60 1.5 s) gives the right delay or null, never a wrong value', () => {
    for (const [delay, seed] of [[600, 1], [600, 2], [1500, 3], [300, 4]] as const) {
      const r = rng(seed);
      const capture = noise(LENGTH, 0.0005, seed + 50);
      const rt60 = 1.5 * SR; // frames to fall 60 dB
      for (const c of CLICKS) {
        const at = c + delay;
        addClick(capture, at, 0.3);
        // the room's diffuse tail: noise decaying 60 dB over 1.5 s, running on into the following clicks' windows
        for (let k = 1; at + k < LENGTH; k++) capture[at + k]! += 0.08 * (r() * 2 - 1) * Math.pow(10, (-3 * k) / rt60);
      }
      const got = computeLatency(capture, CLICKS, SR);
      if (got !== null) expect(Math.abs(got - delay), `delay ${delay}`).toBeLessThanOrEqual(2);
    }
  });

  it('detections scattered by more than 1 ms around their median do not count', () => {
    const capture = new Float32Array(LENGTH);
    const scattered = [1000, 1100, 1200, 1300, 1400, 1500, 1600, 1700];
    CLICKS.forEach((c, i) => {
      capture[c + scattered[i]!] = 0.5;
    });
    expect(computeLatency(capture, CLICKS, SR)).toBeNull();
    // five within +-48 frames (1 ms) of the median count; the three strays are left out of the result
    const mixed = new Float32Array(LENGTH);
    [1234, 1240, 1230, 1236, 1250, 9000, 30, 15000].forEach((d, i) => {
      mixed[CLICKS[i]! + d] = 0.5;
    });
    expect(computeLatency(mixed, CLICKS, SR)).toBe(1236);
  });

  it('needs at least 10 ms of lead-in before the first click for the noise floor', () => {
    const at = (first: number) => CLICKS.map((c, i) => first + i * SR * 0.5);
    for (const first of [0, Math.round(0.009 * SR)]) {
      const capture = new Float32Array(LENGTH);
      for (const c of at(first)) addClick(capture, c + 480);
      expect(computeLatency(capture, at(first), SR), `first click at ${first}`).toBeNull();
    }
    const ok = new Float32Array(LENGTH);
    const first = Math.round(0.01 * SR);
    for (const c of at(first)) addClick(ok, c + 480);
    expect(computeLatency(ok, at(first), SR)).toBe(480);
  });

  it('gives null for no clicks or a capture that ends before them', () => {
    expect(computeLatency(new Float32Array(LENGTH), [], SR)).toBeNull();
    expect(computeLatency(new Float32Array(100), CLICKS, SR)).toBeNull();
  });
});
