import { describe, it, expect } from 'vitest';
import { defaultMemory } from '../../src/schema/params';
import type { TrackAudio } from '../../src/shared/protocol';
import { packMemory, unpackMemory } from '../../src/storage/memoryFile';

function tone(n: number, freq: number, sr: number, amp: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr);
  return out;
}

/** Frequency from the rising zero crossings (linearly interpolated) between the first and the last one. */
function estimateHz(x: Float32Array, sr: number): number {
  const crossings: number[] = [];
  for (let i = 1; i < x.length; i++) {
    if (x[i - 1]! < 0 && x[i]! >= 0) crossings.push(i - 1 + -x[i - 1]! / (x[i]! - x[i - 1]!));
  }
  const cycles = crossings.length - 1;
  return (cycles * sr) / (crossings[crossings.length - 1]! - crossings[0]!);
}

function rms(x: Float32Array, from: number, to: number): number {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i]! * x[i]!;
  return Math.sqrt(s / (to - from));
}

describe('unpackMemory at a different sample rate', () => {
  const n = 48000; // one second
  const src: TrackAudio = { L: tone(n, 1000, 48000, 0.5), R: tone(n, 1000, 48000, 0.25), sampleRate: 48000, recordedTempo: 123.4, measures: 8 };
  const bytes = packMemory(defaultMemory(), [src]);

  it('48000 -> 44100 scales the length by 44100/48000 (+-2), keeps a 1 kHz tone at 1 kHz, keeps tempo and measures', () => {
    const t = unpackMemory(bytes, 44100).tracks[0]!;
    expect(Math.abs(t.L.length - Math.round((n * 44100) / 48000))).toBeLessThanOrEqual(2);
    expect(t.R.length).toBe(t.L.length);
    expect(t.sampleRate).toBe(44100);
    expect(t.recordedTempo).toBe(123.4);
    expect(t.measures).toBe(8);
    expect(estimateHz(t.L, 44100)).toBeCloseTo(1000, 0);
    expect(estimateHz(t.R, 44100)).toBeCloseTo(1000, 0);
    // amplitude survives (skip the edges where the kernel sees the zero padding)
    expect(rms(t.L, 2000, t.L.length - 2000)).toBeCloseTo(0.5 / Math.SQRT2, 2);
    expect(rms(t.R, 2000, t.R.length - 2000)).toBeCloseTo(0.25 / Math.SQRT2, 2);
  });

  it('44100 -> 48000 stretches the length the other way and keeps the pitch', () => {
    const file = packMemory(defaultMemory(), [{ ...src, L: tone(44100, 1000, 44100, 0.5), R: tone(44100, 1000, 44100, 0.5), sampleRate: 44100 }]);
    const t = unpackMemory(file, 48000).tracks[0]!;
    expect(Math.abs(t.L.length - 48000)).toBeLessThanOrEqual(2);
    expect(t.sampleRate).toBe(48000);
    expect(estimateHz(t.L, 48000)).toBeCloseTo(1000, 0);
  });

  it('does not touch the samples when the rates are equal', () => {
    const t = unpackMemory(bytes, 48000).tracks[0]!;
    expect(t.L.length).toBe(n);
    expect(Array.from(t.L.subarray(0, 64))).toEqual(Array.from(src.L.subarray(0, 64)));
  });

  it('resamples every track of the file', () => {
    const two = packMemory(defaultMemory(), [src, null, null, null, { ...src, recordedTempo: 90, measures: null }]);
    const out = unpackMemory(two, 44100);
    expect(out.tracks[0]!.sampleRate).toBe(44100);
    expect(out.tracks[4]!.sampleRate).toBe(44100);
    expect(out.tracks[4]!.recordedTempo).toBe(90);
    expect(out.tracks[4]!.measures).toBeNull();
    expect(out.tracks[4]!.L.length).toBe(out.tracks[0]!.L.length);
  });
});
