import { afterEach, describe, expect, it, vi } from 'vitest';
import { cycleLength, lengthAfterRate, mixRenderer, renderMix } from '../../src/core/render';
import { LooperCore } from '../../src/core/looper';
import { RATE_MAX } from '../../src/core/track';
import { Mixer } from '../../src/dsp/mixer';
import { defaultMemory } from '../../src/schema/memory';
import { defaultSystem } from '../../src/schema/system';
import type { MemorySettings, SystemSettings, TrackSettings } from '../../src/schema/types';
import type { TrackAudio } from '../../src/shared/protocol';
import { makeOutput, run, XF } from './harness';

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

  it('with no offsets, all playing tracks are at their start on the cycle\'s first frame, summed, past the start ramp', () => {
    const { L, R } = mix([audio(2000, (k) => 0.1 + k / 10000), audio(3000, (k) => -k / 20000)]);
    for (let f = 0; f < 6000; f += 101) {
      expect(L[f]).toBeCloseTo(0.1 + (f % 2000) / 10000 - (f % 3000) / 20000, 6);
      expect(R[f]).toBeCloseTo(L[f], 9);
    }
  });

  it('its first frames are the steady state, so the cycle loops with no dip at its seam', () => {
    const t = audio(1000, (k) => 0.25 + k / 10000);
    const { L } = mix([t]);
    for (let f = 0; f < 1000; f++) expect(L[f]).toBeCloseTo(t.L[f], 6);
  });

  it('mixRenderer streams the very samples renderMix returns, whatever the chunk size', () => {
    const sine = (hz: number) => (k: number): number => 0.4 * Math.sin((2 * Math.PI * hz * k) / SR);
    const tracks: Slot[] = [audio(2000, sine(7), 60), audio(3000, sine(11), 120), audio(1500, sine(3), 100), null, null];
    const edit = (m: MemorySettings): void => {
      m.track[0].tempoSyncMode = 'PITCH';
      m.track[1].reverse = true;
      m.track[2].tempoSyncMode = 'XFADE';
    };
    const { memory, system } = settings(edit);
    const playing = [true, true, true, false, false];
    const gains = [1, 0.5, 0.8, 1, 1];
    const whole = renderMix(memory, system, tracks, playing, gains, SR);
    expect(whole.L.length).toBeGreaterThan(0);
    for (const step of [4096, 777, 1]) {
      const r = mixRenderer(memory, system, tracks, playing, gains, SR);
      expect(r.frames).toBe(whole.L.length);
      expect(r.cut).toBe(false);
      const L = new Float32Array(r.frames);
      const R = new Float32Array(r.frames);
      const bl = new Float32Array(step);
      const br = new Float32Array(step);
      for (let at = 0; at < r.frames; at += step) {
        const n = Math.min(step, r.frames - at);
        r.render(bl, br, n);
        L.set(bl.subarray(0, n), at);
        R.set(br.subarray(0, n), at);
      }
      expect(L).toEqual(whole.L);
      expect(R).toEqual(whole.R);
    }
  });

  it('a cap shorter than the cycle cuts it there and says so', () => {
    const tracks: Slot[] = [audio(2000, () => 0.25), audio(3000, () => 0.125), null, null, null];
    const { memory, system } = settings();
    const playing = [true, true, false, false, false];
    const capped = mixRenderer(memory, system, tracks, playing, [1, 1, 1, 1, 1], SR, { maxFrames: 1500 });
    expect(capped.frames).toBe(1500);
    expect(capped.cut).toBe(true);
    const free = mixRenderer(memory, system, tracks, playing, [1, 1, 1, 1, 1], SR, { maxFrames: 6000 });
    expect(free.frames).toBe(6000);
    expect(free.cut).toBe(false);
    // Past 10 minutes the cycle falls back to the longest track: that is the brief's rule, not a cut.
    const coprime = mixRenderer(memory, system, [audio(1009, () => 0.1), audio(997, () => 0.1), null, null, null], playing, [1, 1, 1, 1, 1], SR);
    expect(coprime.frames).toBe(1009);
    expect(coprime.cut).toBe(false);
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
    expect(rev.L[0]).toBeCloseTo(0.999, 6);
    expect(rev.L[100]).toBeCloseTo(0.899, 6);
    const once = mix([audio(1000, () => 0.5), audio(3000, () => 0)], track((s) => {
      s.oneShot = true;
    }));
    expect(once.L.length).toBe(3000);
    expect(once.L[500]).toBeCloseTo(0.5, 6);
    expect(once.L[999]).toBeCloseTo(0.5, 6);
    // Once, from the cycle's first frame; its end ramps out over 5 ms, as live.
    expect(once.L.subarray(1000 + XF).every((v) => v === 0)).toBe(true);
  });

  it('a 1SHOT starts with the live 5 ms ramp from silence, not a step (PROMOTED 1)', () => {
    const once = mix([audio(1000, () => 0.5), audio(3000, () => 0.25)], track((s) => {
      s.oneShot = true;
    }));
    for (let f = 0; f < XF; f++) expect(once.L[f]).toBeCloseTo(0.25 + (0.5 * f) / XF, 6);
    expect(once.L[XF]).toBeCloseTo(0.75, 6);
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
    for (let f = 0; f < 1000; f += 53) expect(r.L[f]).toBeCloseTo((2 * f) / 10000, 5);
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

  it('plays at the tempo it is given, the engine\'s exact one, not the memory\'s 0.1 BPM copy (R31)', () => {
    // 8 measures of 4/4 in 14948 frames: 128.4453 BPM, which the memory stores as 128.4.
    const T = 14948;
    const bpm = (8 * 4 * 60 * SR) / T;
    const t = audio(T, (k) => Math.sin(k / 7) * 0.5, bpm, 8);
    const { memory, system } = settings((m) => {
      m.tempo = 128.4;
    });
    const r = renderMix(memory, system, [t, null, null, null, null], [true, false, false, false, false], [1, 1, 1, 1, 1], SR, bpm);
    expect(r.L.length).toBe(T);
    for (let f = 0; f < T; f += 113) expect(r.L[f]).toBe(t.L[f]);
  });

  it('plays at the tempo it is given even where loading the loop would snap to its exact one (R65 is for recalls)', () => {
    // A TAP TEMPO can set the engine to exactly 128.4 while a 128.4453 loop plays stretched: the mix must sound the same.
    const T = 3737;
    const t = audio(T, (k) => Math.sin(k / 7) * 0.5, 480000 / T, 2);
    const { memory, system } = settings((m) => {
      m.tempo = 128.4;
    });
    const r = renderMix(memory, system, [t, null, null, null, null], [true, false, false, false, false], [1, 1, 1, 1, 1], SR, 128.4);
    expect(r.L.length).toBe(lengthAfterRate(T, 128.4 / (480000 / T)));
    let same = 0;
    for (let f = 0; f < T; f++) if (r.L[f] === t.L[f]) same++;
    expect(same).toBeLessThan(T / 2); // stretched, not the take as it is
  });

  it('a loop at 119.97 BPM under a memory tempo of 120.0 plays bit for bit as it does live', () => {
    // 8 measures in 16004 frames. The memory's 120.0 is within R31's 0.05 of it, which once left the offline transport
    // at 120.0 and played the loop 0.025 % fast through XFADE.
    const T = 16004;
    const bpm = (8 * 4 * 60 * SR) / T;
    const t = audio(T, (k) => Math.sin(k / 5) * 0.5 + Math.sin(k / 31) * 0.3, bpm, 8);
    const { memory, system } = settings((m) => {
      m.tempo = 120;
    });
    const tracks: Slot[] = [t, null, null, null, null];
    const playing = [true, false, false, false, false];
    const r = renderMix(memory, system, tracks, playing, [1, 1, 1, 1, 1], SR, bpm);
    expect(r.L.length).toBe(T);

    // Live: the engine's transport is at the loop's exact tempo, and the loop starts from stopped.
    const live = new LooperCore({ sampleRate: SR, memoryBudgetBytes: 64 * 1024 * 1024 });
    const liveMem = settings((m) => {
      m.tempo = 120;
      for (const s of m.track) s.loopSyncSw = false;
    }).memory;
    live.setSettings(liveMem, system);
    live.command({ t: 'tempo', bpm });
    live.setTrackAudio(0, t);
    live.command({ t: 'recPlay', track: 0 });
    const out = { tracks: [0, 1, 2, 3, 4].map((): [Float32Array, Float32Array] => [new Float32Array(2 * T), new Float32Array(2 * T)]), click: [new Float32Array(2 * T), new Float32Array(2 * T)] as [Float32Array, Float32Array] };
    const z = new Float32Array(2 * T);
    live.process(z, z, z, z, out, 2 * T);
    let differ = 0;
    for (let f = 0; f < T; f++) if (r.L[f] !== out.tracks[0][0][T + f]) differ++; // its second pass, past the ramp
    expect(differ).toBe(0);
    const streamed = mixRenderer(memory, system, tracks, playing, [1, 1, 1, 1, 1], SR, { tempo: bpm });
    const L = new Float32Array(T);
    const R = new Float32Array(T);
    streamed.render(L, R, T);
    expect(L).toEqual(r.L);
  });
});

describe('renderMix: from the live playheads (ruling R64)', () => {
  const BUDGET = 64 * 1024 * 1024;

  /** The next `n` frames of a live core through the engine's Mixer (faders at unity), as the speaker gets them. */
  function liveMix(core: LooperCore, system: SystemSettings, n: number): { L: Float32Array; R: Float32Array } {
    const B = 128;
    const mixer = new Mixer(SR);
    mixer.configure(system);
    const out = makeOutput(B);
    const z = new Float32Array(B);
    const quiet: [Float32Array, Float32Array] = [z, z];
    const mixOut: [Float32Array, Float32Array] = [new Float32Array(B), new Float32Array(B)];
    const L = new Float32Array(n);
    const R = new Float32Array(n);
    for (let done = 0; done < n; done += B) {
      const m = Math.min(B, n - done);
      core.process(z, z, z, z, out, m);
      mixer.process(out.tracks, quiet, quiet, mixOut, null, m);
      L.set(mixOut[0].subarray(0, m), done);
      R.set(mixOut[1].subarray(0, m), done);
    }
    return { L, R };
  }

  /**
   * Where each track is in its loop now, from one live status, as LOOP MIX hands it on: the status's `position` is the
   * playhead's place in the take (running 1 -> 0 in REVERSE), the offset counts frames into the loop in play order.
   */
  function offsetsOf(core: LooperCore, tracks: Slot[], memory: MemorySettings): number[] {
    return core.status().tracks.map((s, i) => {
      const t = tracks[i];
      if (!t) return 0;
      const p = s.position * t.L.length;
      return memory.track[i].reverse ? t.L.length - 1 - p : p;
    });
  }

  function liveCore(memory: MemorySettings, system: SystemSettings, tracks: Slot[]): LooperCore {
    const core = new LooperCore({ sampleRate: SR, memoryBudgetBytes: BUDGET });
    core.setSettings(memory, system);
    tracks.forEach((t, i) => {
      if (t) core.setTrackAudio(([0, 1, 2, 3, 4] as const)[i], t);
    });
    return core;
  }

  const differing = (a: Float32Array, b: Float32Array): number => {
    let d = 0;
    for (let f = 0; f < a.length; f++) if (a[f] !== b[f]) d++;
    return d;
  };

  it('a loop handed an offset is that many frames into itself on the cycle\'s first frame (REVERSE: from its end)', () => {
    const t = audio(1000, (k) => k / 1000);
    const { memory, system } = settings();
    const fwd = renderMix(memory, system, [t, null, null, null, null], [true, false, false, false, false], [1, 1, 1, 1, 1], SR, undefined, [250]);
    for (let f = 0; f < 1000; f += 7) expect(fwd.L[f]).toBeCloseTo(((f + 250) % 1000) / 1000, 6);
    const rev = settings((m) => {
      m.track[0].reverse = true;
    });
    const back = renderMix(rev.memory, rev.system, [t, null, null, null, null], [true, false, false, false, false], [1, 1, 1, 1, 1], SR, undefined, [250]);
    for (let f = 0; f < 1000; f += 7) expect(back.L[f]).toBeCloseTo((999 - ((f + 250) % 1000)) / 1000, 6);
  });

  it('offsets outside the loop wrap into it, and one that is not a number counts as 0', () => {
    const t = audio(1000, (k) => k / 1000);
    const { memory, system } = settings();
    const at = (o: number) =>
      renderMix(memory, system, [t, null, null, null, null], [true, false, false, false, false], [1, 1, 1, 1, 1], SR, undefined, [o]).L[0];
    expect(at(1010)).toBeCloseTo(0.01, 6);
    expect(at(-10)).toBeCloseTo(0.99, 6);
    expect(at(Number.NaN)).toBeCloseTo(0, 6);
  });

  it('a stretched loop starts at its offset too (PITCH at 2x reads from there)', () => {
    const t = audio(2000, (k) => k / 10000, 60);
    const { memory, system } = settings((m) => {
      m.track[0].tempoSyncMode = 'PITCH';
    });
    const r = renderMix(memory, system, [t, null, null, null, null], [true, false, false, false, false], [1, 1, 1, 1, 1], SR, undefined, [600]);
    expect(r.L.length).toBe(1000);
    for (let f = 0; f < 700; f += 37) expect(r.L[f]).toBeCloseTo((600 + 2 * f) / 10000, 4);
  });

  it('equals the live output from the press onward, sample for sample, over one cycle', () => {
    const four = audio(8000, (k) => 0.3 * Math.sin(k / 11) + k / 80000);
    const two = audio(4000, (k) => 0.2 * Math.sin(k / 5) - 0.05);
    const back = audio(3000, (k) => 0.1 * Math.cos(k / 3) + k / 90000);
    const { memory, system } = settings((m) => {
      for (const s of m.track) s.loopSyncSw = false;
      m.track[0].playLevel = 80;
      m.track[1].pan = -20;
      m.track[2].reverse = true;
    });
    const tracks: Slot[] = [four, two, back, null, null];
    const live = liveCore(memory, system, tracks);
    live.command({ t: 'recPlay', track: 0 });
    run(live, 2000);
    live.command({ t: 'recPlay', track: 1 }); // a bar in
    run(live, 1500);
    live.command({ t: 'recPlay', track: 2 });
    run(live, 9321 - 3500);
    // The press: one status gives every playhead.
    const offsets = offsetsOf(live, tracks, memory);
    const playing = [true, true, true, false, false];
    const r = mixRenderer(memory, system, tracks, playing, [1, 1, 1, 1, 1], SR, { tempo: live.status().tempo, offsets });
    expect(r.frames).toBe(24000);
    const L = new Float32Array(r.frames);
    const R = new Float32Array(r.frames);
    r.render(L, R, r.frames);
    const heard = liveMix(live, system, r.frames);
    expect(differing(L, heard.L)).toBe(0);
    expect(differing(R, heard.R)).toBe(0);
  });

  it('a 2-bar layer started at bar 1 of a 4-bar loop keeps its place against it (review I5)', () => {
    // A marker 100 frames into each loop. Live, the 4-bar loop's falls at 100, 8100, ...; the 2-bar layer's, started at
    // bar 1 (frame 2000), at 2100, 6100, 10100, ...
    const four = audio(8000, (k) => (k >= 100 && k < 110 ? 1 : 0));
    const two = audio(4000, (k) => (k >= 100 && k < 110 ? 0.5 : 0));
    const { memory, system } = settings((m) => {
      for (const s of m.track) s.loopSyncSw = false;
    });
    const tracks: Slot[] = [four, two, null, null, null];
    const live = liveCore(memory, system, tracks);
    live.command({ t: 'recPlay', track: 0 });
    run(live, 2000);
    live.command({ t: 'recPlay', track: 1 });
    run(live, 3000); // LOOP MIX pressed at frame 5000
    const r = renderMix(memory, system, tracks, [true, true, false, false, false], [1, 1, 1, 1, 1], SR, undefined, offsetsOf(live, tracks, memory));
    expect(r.L.length).toBe(8000);
    const marks: number[] = [];
    for (let f = 0; f < r.L.length; f++) if (r.L[f] !== 0 && (f === 0 || r.L[f - 1] === 0)) marks.push(f);
    // From the press: the layer's at 6100 and 10100, the loop's at 8100.
    expect(marks).toEqual([1100, 3100, 5100]);
    expect(r.L[1100]).toBe(0.5);
    expect(r.L[3100]).toBe(1);
  });

  it('a 1SHOT caught mid-way starts there, ramping in from silence, and does not come round again', () => {
    const shot = audio(1000, () => 0.5);
    const bed = audio(3000, () => 0);
    const { memory, system } = settings((m) => {
      m.track[0].oneShot = true;
    });
    const r = renderMix(memory, system, [shot, bed, null, null, null], [true, true, false, false, false], [1, 1, 1, 1, 1], SR, undefined, [600, 0]);
    expect(r.L.length).toBe(3000);
    for (let f = 0; f < XF; f++) expect(r.L[f]).toBeCloseTo((0.5 * f) / XF, 6);
    for (let f = XF; f < 400; f++) expect(r.L[f]).toBeCloseTo(0.5, 6);
    expect(r.L.subarray(400 + XF).every((v) => v === 0)).toBe(true);
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
