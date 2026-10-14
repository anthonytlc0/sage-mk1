import { afterEach, describe, expect, it, vi } from 'vitest';
import { cycleLength, lengthAfterRate, renderMix } from '../../src/core/render';
import { RATE_MAX } from '../../src/core/track';
import { defaultMemory } from '../../src/schema/memory';
import { defaultSystem } from '../../src/schema/system';
import type { MemorySettings, SystemSettings, TrackSettings } from '../../src/schema/types';
import type { TrackAudio } from '../../src/shared/protocol';
import { XF } from './harness';

const SR = 1000;
const CAP = 10 * 60 * SR;

function audio(frames: number, f: (k: number) => number, recordedTempo = 120, measures: number | null = null): TrackAudio {
  const L = new Float32Array(frames);
  const R = new Float32Array(frames);
  for (let k = 0; k < frames; k++) L[k] = R[k] = f(k);
  return { L, R, sampleRate: SR, recordedTempo, measures };
}

function settings(edit?: (m: MemorySettings, s: SystemSettings) => void): { memory: MemorySettings; system: SystemSettings } {
  const memory = defaultMemory();
  const system = defaultSystem();
  edit?.(memory, system);
  return { memory, system };
}

type Slot = TrackAudio | null;

/** renderMix at sr 1000 with every given track playing at fader 1, unless `playing`/`gains` say otherwise. */
function mix(tracks: Slot[], edit?: (m: MemorySettings, s: SystemSettings) => void, playing?: boolean[], gains?: number[]) {
  const all: Slot[] = [0, 1, 2, 3, 4].map((i) => tracks[i] ?? null);
  const { memory, system } = settings(edit);
  return renderMix(memory, system, all, playing ?? all.map((t) => t !== null), gains ?? [1, 1, 1, 1, 1], SR);
}

function crossings(x: Float32Array, from: number, to: number): number {
  let c = 0;
  for (let i = from + 1; i < to; i++) if ((x[i - 1] < 0) !== (x[i] < 0)) c++;
  return c;
}

const track = (edit: (t: TrackSettings) => void, i = 0) => (m: MemorySettings): void => edit(m.track[i]);

describe('renderMix: one full cycle', () => {
  it('tracks of 2000 and 3000 frames render 6000 frames (their least common multiple)', () => {
    const { L, R } = mix([audio(2000, () => 0.25), audio(3000, () => 0.125)]);
    expect(L.length).toBe(6000);
    expect(R.length).toBe(6000);
  });

  it('lengths whose least common multiple is past 10 minutes render the longest track', () => {
    const { L } = mix([audio(1009, () => 0.1), audio(997, () => 0.1)]); // lcm 1005973 > 600000
    expect(L.length).toBe(1009);
    expect(cycleLength([1009, 997], CAP)).toBe(1009);
    expect(cycleLength([2000, 3000], CAP)).toBe(6000);
    expect(cycleLength([1000, 1000, 250], CAP)).toBe(1000);
    expect(cycleLength([CAP + 5], CAP)).toBe(CAP); // never more than the cap
  });

  it('all playing tracks start together at frame 0 and are summed (after the 5 ms start ramp)', () => {
    const { L, R } = mix([audio(2000, (k) => k / 10000), audio(3000, (k) => -k / 20000)]);
    for (let f = XF; f < 6000; f += 101) {
      expect(L[f]).toBeCloseTo((f % 2000) / 10000 - (f % 3000) / 20000, 6);
      expect(R[f]).toBeCloseTo(L[f], 9);
    }
    expect(Math.abs(L[0])).toBeLessThan(1e-9); // the ramp starts from silence, as a start does live
  });

  it('only the playing tracks sound, each at its fader gain', () => {
    const a = audio(1000, () => 0.5);
    const b = audio(1000, () => 0.25);
    expect(mix([a, b], undefined, [true, false, false, false, false]).L[500]).toBeCloseTo(0.5, 6);
    expect(mix([a, b], undefined, undefined, [0.5, 0, 1, 1, 1]).L[500]).toBeCloseTo(0.25, 6);
    expect(mix([a, b], undefined, undefined, [1, 0.5, 1, 1, 1]).L[500]).toBeCloseTo(0.625, 6);
  });

  it('nothing playing renders nothing', () => {
    const r = mix([audio(1000, () => 0.5)], undefined, [false, false, false, false, false]);
    expect(r.L.length).toBe(0);
    expect(r.R.length).toBe(0);
    expect(mix([]).L.length).toBe(0);
  });

  it('applies PLAY LEVEL, PAN and LOOP OUT as the live mix does, and no MASTER FX (LOOP MIX applies that itself)', () => {
    const t = audio(1000, () => 0.5);
    const panned = mix([t], track((s) => {
      s.playLevel = 50;
      s.pan = 50;
    }));
    expect(panned.L[500]).toBeCloseTo(0, 6);
    expect(panned.R[500]).toBeCloseTo(0.25, 6);
    expect(mix([t], (_m, s) => {
      s.mixer.loopOut = 50;
    }).L[500]).toBeCloseTo(0.25, 6);
    const wet = mix([t], (_m, s) => {
      s.master.reverb = 100;
      s.master.comp = 100;
    });
    for (let f = XF; f < 1000; f += 37) expect(wet.L[f]).toBeCloseTo(0.5, 6);
  });

  it('REVERSE plays backwards and 1SHOT once', () => {
    const rev = mix([audio(1000, (k) => k / 1000)], track((s) => {
      s.reverse = true;
    }));
    expect(rev.L[100]).toBeCloseTo(899 / 1000, 6);
    const once = mix([audio(1000, () => 0.5), audio(3000, () => 0)], track((s) => {
      s.oneShot = true;
    }));
    expect(once.L.length).toBe(3000);
    expect(once.L[500]).toBeCloseTo(0.5, 6);
    expect(once.L.subarray(1000 + XF).every((v) => v === 0)).toBe(true);
  });
});

describe('renderMix: tempo sync, as live', () => {
  it('a loop recorded at 60 BPM plays at the memory tempo 120 at twice the speed: half the length (PITCH reads faster)', () => {
    const t = audio(2000, (k) => k / 10000, 60);
    expect(lengthAfterRate(2000, 2)).toBe(1000);
    const r = mix([t], (m) => {
      m.track[0].tempoSyncMode = 'PITCH';
    });
    expect(r.L.length).toBe(1000);
    for (let f = XF; f < 1000; f += 53) expect(r.L[f]).toBeCloseTo((2 * f) / 10000, 5);
  });

  it('XFADE keeps the pitch where PITCH raises it', () => {
    // At 8 kHz, so the stretcher's 60 ms grains hold several periods of a 200 Hz sine. 2 s of it, recorded at 60 BPM.
    const sr = 8000;
    const L = new Float32Array(2 * sr);
    for (let k = 0; k < L.length; k++) L[k] = 0.5 * Math.sin((2 * Math.PI * 200 * k) / sr);
    const sine: TrackAudio = { L, R: L, sampleRate: sr, recordedTempo: 60, measures: null };
    const render = (mode: 'PITCH' | 'XFADE') => {
      const { memory, system } = settings((m) => {
        m.track[0].tempoSyncMode = mode;
      });
      return renderMix(memory, system, [sine, null, null, null, null], [true, false, false, false, false], [1, 1, 1, 1, 1], sr);
    };
    const pitch = render('PITCH');
    const xfade = render('XFADE');
    expect(pitch.L.length).toBe(sr);
    expect(xfade.L.length).toBe(sr);
    // Over 0.8 s: 400 Hz at double speed (640 sign changes); 200 Hz kept (about 320).
    const from = sr / 10;
    const to = sr - sr / 10;
    expect(Math.abs(crossings(pitch.L, from, to) - 640)).toBeLessThanOrEqual(4);
    expect(Math.abs(crossings(xfade.L, from, to) - 320)).toBeLessThanOrEqual(16);
  });

  it('a rate past the limits is clamped as live (RATE_MAX): 40 -> 300 BPM plays at 4x', () => {
    const r = mix([audio(4000, () => 0.25, 40)], (m) => {
      m.tempo = 300;
    });
    expect(r.L.length).toBe(4000 / RATE_MAX);
  });

  it('TEMPO SYNC SW off plays the loop at its own tempo; SPEED doubles it', () => {
    const t = audio(2000, () => 0.25, 60);
    expect(mix([t], track((s) => {
      s.tempoSyncSw = false;
    })).L.length).toBe(2000);
    expect(mix([t], track((s) => {
      s.tempoSyncSw = false;
      s.tempoSyncSpeed = 'DOUBLE';
    })).L.length).toBe(1000);
  });

  it('a synced loop at the tempo it derived plays sample for sample, though the memory keeps that tempo only to 0.1 BPM (R31)', () => {
    // 8 measures of 4/4 in 14948 frames: 128.4453 BPM, which the memory stores as 128.4.
    const T = 14948;
    const bpm = (8 * 4 * 60 * SR) / T;
    const t = audio(T, (k) => Math.sin(k / 7) * 0.5, bpm, 8);
    const r = mix([t], (m) => {
      m.tempo = 128.4;
    });
    expect(r.L.length).toBe(T);
    for (let f = XF; f < T; f += 113) expect(r.L[f]).toBe(t.L[f]);
  });
});

describe('renderMix: memory', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads the tracks in place: it allocates its output and little else', () => {
    const N = 300000; // 5 minutes at 1 kHz
    const a = audio(N, () => 0.25);
    const b = audio(N, () => 0.125);
    const sizes: number[] = [];
    const Real = Float32Array;
    vi.stubGlobal('Float32Array', new Proxy(Real, {
      construct(target, args: unknown[]) {
        sizes.push(typeof args[0] === 'number' ? args[0] : 0);
        return Reflect.construct(target, args) as object;
      },
    }));
    const r = mix([a, b]);
    vi.unstubAllGlobals();
    expect(r.L.length).toBe(N);
    expect(r.L[N - 1]).toBeCloseTo(0.375, 6);
    const total = sizes.reduce((s, n) => s + n, 0);
    // The output (2 x N) plus the offline engine's own buffers; copying the tracks would add 4 x N more.
    expect(total).toBeLessThan(2 * N + N);
  });
});
