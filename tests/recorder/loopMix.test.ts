import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeStatus } from '../../src/control/fakeEngine';
import { Session } from '../../src/control/session';
import { mixRenderer, renderMix } from '../../src/core/render';
import type { MixRenderer } from '../../src/core/render';
import { MasterFx } from '../../src/dsp/master';
import { NothingToMixError, exportLoopMix, mixCutNote, mixFromArrays, touchMixFrames } from '../../src/recorder/loopMix';
import type { LoopMixSource, RenderMixFn } from '../../src/recorder/loopMix';
import { Pcm24Stream } from '../../src/recorder/encode';
import { wavHeader } from '../../src/storage/wav';
import type { TrackState } from '../../src/shared/protocol';
import type { EngineStatus, TrackAudio } from '../../src/shared/protocol';
import { EXPORT_RATE } from '../../src/shared/constants';
import { decodeWav } from '../../src/storage/wav';
import { bytesOf, sameBytes } from './helpers';

const SR = 48000;

function track(frames: number, value: number, sr = SR): TrackAudio {
  return { L: new Float32Array(frames).fill(value), R: new Float32Array(frames).fill(-value), sampleRate: sr, recordedTempo: 120, measures: 1 };
}

/** A stand-in for Task 9's renderMix: every playing track looped to the longest playing one, scaled by its fader, summed. */
const fakeRender: RenderMixFn = (_m, _s, tracks, playing, gains) => {
  const lens = tracks.map((t, i) => (playing[i] && t ? t.L.length : 0));
  const n = Math.max(0, ...lens);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  tracks.forEach((t, i) => {
    if (!playing[i] || !t) return;
    for (let k = 0; k < n; k++) {
      L[k] += t.L[k % t.L.length]! * gains[i]!;
      R[k] += t.R[k % t.R.length]! * gains[i]!;
    }
  });
  return mixFromArrays(L, R);
};

function source(tracks: (TrackAudio | null)[], states: TrackState[], opts: { gains?: number[]; sampleRate?: number; status?: EngineStatus | null } = {}): LoopMixSource & { session: Session } {
  const gains = opts.gains ?? [1, 1, 1, 1, 1];
  const status =
    opts.status === undefined
      ? makeStatus({ sampleRate: opts.sampleRate ?? SR }, states.map((state) => ({ state })))
      : opts.status;
  return {
    session: new Session(),
    status,
    faderGain: (i: number) => gains[i]!,
    requestTracks: async () => tracks,
  };
}

const decoded = async (blob: Blob) => decodeWav(await bytesOf(blob));

describe('exportLoopMix', () => {
  it('mixes two tracks of 1 s and 2 s at 48 kHz into a 2.0 s WAV at 44.1 kHz, 24-bit stereo', async () => {
    const src = source([track(SR, 0.25), track(2 * SR, 0.125), null, null, null], ['playing', 'playing', 'empty', 'empty', 'empty']);
    const blob = await exportLoopMix(src, fakeRender);

    expect(blob.type).toBe('audio/wav');
    const bytes = await bytesOf(blob);
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(24, true)).toBe(EXPORT_RATE);
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint16(34, true)).toBe(24);
    expect(view.getUint32(40, true)).toBe(2 * EXPORT_RATE * 6); // exactly 2.0 s of data
    expect(bytes.length).toBe(44 + 2 * EXPORT_RATE * 6);

    const wav = decodeWav(bytes);
    expect(wav.sr).toBe(EXPORT_RATE);
    expect(wav.chs[0]!.length).toBe(2 * EXPORT_RATE);
    // 0.25 + 0.125 for the first second (the short track), 0.125 + 0.25 again... every sample is the sum: 0.375 in the middle.
    expect(wav.chs[0]![EXPORT_RATE / 2]).toBeCloseTo(0.375, 3);
    expect(wav.chs[1]![EXPORT_RATE / 2]).toBeCloseTo(-0.375, 3);
    expect(wav.chs[0]![EXPORT_RATE + EXPORT_RATE / 2]).toBeCloseTo(0.125 + 0.25, 3);
  });

  it('hands the injected render the memory, the system settings, the tracks, the playing set, the fader gains and the rate', async () => {
    const tracks = [track(100, 0.1), track(100, 0.2), track(100, 0.3), track(100, 0.4), null];
    const states: TrackState[] = ['playing', 'overdubbing', 'stopped', 'recording', 'empty'];
    const src = source(tracks, states, { gains: [1, 0.5, 0.25, 0, 1] });
    const render = vi.fn(fakeRender);
    await exportLoopMix(src, render);

    expect(render).toHaveBeenCalledTimes(1);
    const [memory, system, got, playing, gains, sr, opts] = render.mock.calls[0]!;
    expect(memory).toBe(src.session.memory);
    expect(system).toBe(src.session.system);
    expect(got).toBe(tracks);
    expect(playing).toEqual([true, true, false, false, false]); // playing and overdubbing sound; stopped, recording, empty do not
    expect(gains).toEqual([1, 0.5, 0.25, 0, 1]);
    expect(sr).toBe(SR);
    // The engine's exact tempo (the memory keeps it to 0.1 BPM only), the desktop's 10-minute cap, and where each track
    // is (all at their start in this status).
    expect(opts).toEqual({ tempo: src.status!.tempo, maxFrames: 10 * 60 * SR, offsets: [0, 0, 0, 0, 0] });
  });

  it('hands on each playing track\'s live playhead from the status, as frames into its loop in play order (R64)', async () => {
    const tracks = [track(1000, 0.1), track(1000, 0.2), track(400, 0.3), track(1000, 0.4), null];
    const states: TrackState[] = ['playing', 'overdubbing', 'playing', 'stopped', 'empty'];
    const status = makeStatus({ sampleRate: SR, tempo: 121.37 }, [
      { state: 'playing', position: 0.25 },
      { state: 'overdubbing', position: 0.5 },
      { state: 'playing', position: 0.75 }, // REVERSE: the playhead runs 1 -> 0 through the take
      { state: 'stopped', position: 0 },
      { state: 'empty', position: 0 },
    ]);
    const src = source(tracks, states, { status });
    src.session.memory.track[2].reverse = true;
    const render = vi.fn(fakeRender);
    await exportLoopMix(src, render);
    const opts = render.mock.calls[0]![6]!;
    expect(opts.tempo).toBe(121.37);
    // 250 frames in; 500 in; the REVERSE track's playhead at take frame 300 is 400 - 1 - 300 = 99 frames into its
    // backwards loop; the stopped and empty tracks do not play.
    expect(opts.offsets).toEqual([250, 500, 99, 0, 0]);
  });

  it('takes the playheads, the playing set and the tempo from the one status there is at the press', async () => {
    const tracks = [track(1000, 0.1), track(1000, 0.2), null, null, null];
    const atPress = makeStatus({ sampleRate: SR, tempo: 128.4453 }, [
      { state: 'playing', position: 0.1 },
      { state: 'playing', position: 0.2 },
    ]);
    const later = makeStatus({ sampleRate: SR, tempo: 100 }, [
      { state: 'playing', position: 0.9 },
      { state: 'stopped', position: 0 },
    ]);
    let exported = false;
    const src: LoopMixSource & { session: Session } = {
      session: new Session(),
      get status() {
        return exported ? later : atPress;
      },
      faderGain: () => 1,
      requestTracks: async () => {
        exported = true; // the engine has moved on by the time the tracks arrive
        return tracks;
      },
    };
    const render = vi.fn(fakeRender);
    await exportLoopMix(src, render);
    const [, , , playing, , , opts] = render.mock.calls[0]!;
    expect(playing).toEqual([true, true, false, false, false]);
    expect(opts!.tempo).toBe(128.4453);
    expect(opts!.offsets).toEqual([100, 200, 0, 0, 0]);
  });

  it('a track the status calls playing but that has no audio is not in the set', async () => {
    const render = vi.fn(fakeRender);
    await exportLoopMix(source([track(100, 0.1), null, null, null, null], ['playing', 'playing', 'empty', 'empty', 'empty']), render);
    expect(render.mock.calls[0]![3]).toEqual([true, false, false, false, false]);
  });

  it('with no status yet, every track that has audio counts as playing, at the first track\'s rate', async () => {
    const render = vi.fn(fakeRender);
    const src = source([track(100, 0.1, 44100), null, track(100, 0.1, 44100), null, null], [], { status: null });
    await exportLoopMix(src, render);
    expect(render.mock.calls[0]![3]).toEqual([true, false, true, false, false]);
    expect(render.mock.calls[0]![5]).toBe(44100);
  });

  it('refuses when nothing is playing, without rendering', async () => {
    const render = vi.fn(fakeRender);
    const src = source([track(100, 0.1), null, null, null, null], ['stopped', 'empty', 'empty', 'empty', 'empty']);
    await expect(exportLoopMix(src, render)).rejects.toBeInstanceOf(NothingToMixError);
    expect(render).not.toHaveBeenCalled();
  });

  it('refuses when the render comes back empty', async () => {
    const src = source([track(100, 0.1), null, null, null, null], ['playing', 'empty', 'empty', 'empty', 'empty']);
    await expect(exportLoopMix(src, () => mixFromArrays(new Float32Array(0), new Float32Array(0)))).rejects.toBeInstanceOf(NothingToMixError);
  });

  it('does not resample when the context already runs at 44.1 kHz', async () => {
    const src = source([track(44100, 0.25), null, null, null, null], ['playing', 'empty', 'empty', 'empty', 'empty'], { sampleRate: 44100 });
    const wav = await decoded(await exportLoopMix(src, fakeRender));
    expect(wav.chs[0]!.length).toBe(44100);
  });

  it('rounds the length of an odd-rate conversion up, like the take recorder', async () => {
    const src = source([track(1000, 0.25), null, null, null, null], ['playing', 'empty', 'empty', 'empty', 'empty']);
    const wav = await decoded(await exportLoopMix(src, fakeRender));
    expect(wav.chs[0]!.length).toBe(Math.ceil((1000 * EXPORT_RATE) / SR));
  });

  describe('MASTER FX', () => {
    const impulse: RenderMixFn = () => {
      const L = new Float32Array(SR);
      const R = new Float32Array(SR);
      L[0] = R[0] = 0.5;
      return mixFromArrays(L, R);
    };
    const playingOne = (): LoopMixSource & { session: Session } =>
      source([track(4800, 0.1), null, null, null, null], ['playing', 'empty', 'empty', 'empty', 'empty']);

    it('runs on the rendered mix: the system master level scales it', async () => {
      const full = playingOne();
      const half = playingOne();
      half.session.system.mixer.masterOut = 50;
      const a = await decoded(await exportLoopMix(full, fakeRender));
      const b = await decoded(await exportLoopMix(half, fakeRender));
      const mid = (w: { chs: Float32Array[] }) => w.chs[0]![2000]!;
      expect(mid(a)).toBeCloseTo(0.1 * 1, 2);
      expect(mid(b) / mid(a)).toBeCloseTo(0.5, 2);
    });

    it('runs on the rendered mix: the reverb adds a tail after an impulse', async () => {
      const dry = playingOne();
      const wet = playingOne();
      wet.session.system.master.reverb = 40;
      const a = await decoded(await exportLoopMix(dry, impulse));
      const b = await decoded(await exportLoopMix(wet, impulse));
      const energy = (w: { chs: Float32Array[] }) => w.chs[0]!.subarray(5000, 20000).reduce((s, x) => s + x * x, 0);
      expect(energy(a)).toBeLessThan(1e-9);
      expect(energy(b)).toBeGreaterThan(1e-4);
    });

    it('uses a fresh MasterFx every time, so a second export is bit-identical to the first', async () => {
      const src = playingOne();
      src.session.system.master.reverb = 40;
      src.session.system.master.comp = 20;
      const a = await bytesOf(await exportLoopMix(src, impulse));
      const b = await bytesOf(await exportLoopMix(src, impulse));
      expect(sameBytes(a, b)).toBe(true);
    });
  });
});

describe('exportLoopMix: streamed (ruling R63)', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** Two synced-looking loops of 4 s and 6 s at 48 kHz: a 12 s cycle. */
  function long(): LoopMixSource & { session: Session } {
    const a = track(4 * SR, 0.25);
    const b = track(6 * SR, 0.125);
    for (let k = 0; k < a.L.length; k++) a.L[k] = 0.25 * Math.sin(k / 50);
    return source([a, b, null, null, null], ['playing', 'playing', 'empty', 'empty', 'empty']);
  }

  it('the WAV is the renderMix cycle through MASTER FX and the converter, byte for byte', async () => {
    const src = long();
    src.session.system.master.reverb = 30;
    const blob = await exportLoopMix(src, mixRenderer);
    // The reference: the whole cycle at once, as LOOP MIX did before it streamed.
    const { memory, system } = src.session;
    const tracks = await src.requestTracks();
    const ref = renderMix(memory, system, tracks, [true, true, false, false, false], [1, 1, 1, 1, 1], SR, src.status!.tempo);
    expect(ref.L.length).toBe(12 * SR);
    const fx = new MasterFx(SR);
    fx.configure(system);
    const stream = new Pcm24Stream(SR);
    const parts: Uint8Array[] = [];
    for (let at = 0; at < ref.L.length; at += 4096) {
      const n = Math.min(4096, ref.L.length - at);
      const l = ref.L.subarray(at, at + n);
      const r = ref.R.subarray(at, at + n);
      fx.process(l, r, n);
      parts.push(stream.push(l, r));
    }
    parts.push(stream.flush());
    const want = await bytesOf(new Blob([wavHeader(stream.frames * 6, EXPORT_RATE, 2, 'pcm24'), ...parts] as Uint8Array<ArrayBuffer>[]));
    expect(sameBytes(await bytesOf(blob), want)).toBe(true);
  });

  it('never allocates a cycle-sized float buffer', async () => {
    const src = long();
    const sizes: number[] = [];
    const Real = Float32Array;
    vi.stubGlobal('Float32Array', new Proxy(Real, {
      construct(target, args: unknown[]) {
        sizes.push(typeof args[0] === 'number' ? args[0] : (args[0] as { length?: number } | undefined)?.length ?? 0);
        return Reflect.construct(target, args) as object;
      },
    }));
    const blob = await exportLoopMix(src, mixRenderer);
    vi.unstubAllGlobals();
    expect(blob.size).toBe(44 + 12 * EXPORT_RATE * 6);
    // The cycle is 12 x 48000 frames; nothing near that is ever allocated (the loops themselves are read in place; the
    // largest buffers are the offline engine's fixed rings).
    expect(Math.max(...sizes)).toBeLessThan((12 * SR) / 4);
  });

  it('keeps the page live: it yields to other tasks while it renders', async () => {
    const src = source([track(SR, 0.1), null, null, null, null], ['playing', 'empty', 'empty', 'empty', 'empty']);
    const frames = 40 * 4096;
    const slow: RenderMixFn = () => ({
      frames,
      cut: false,
      render(L: Float32Array, R: Float32Array, n: number) {
        const until = performance.now() + 2;
        while (performance.now() < until) {
          // a render that takes its time
        }
        L.fill(0.1, 0, n);
        R.fill(0.1, 0, n);
      },
    });
    const order: string[] = [];
    setTimeout(() => order.push('timer'), 0);
    await exportLoopMix(src, slow);
    order.push('done');
    expect(order).toEqual(['timer', 'done']);
  });

  it('on a touch device the cycle is capped so its WAV stays within 100 MB, and a cut mix says where it was cut', async () => {
    const frames = touchMixFrames(SR);
    const bytes = 44 + 6 * Math.ceil((frames * EXPORT_RATE) / SR);
    expect(bytes).toBeLessThanOrEqual(100_000_000);
    expect(bytes).toBeGreaterThan(99_990_000);

    const src = source([track(SR, 0.1), null, null, null, null], ['playing', 'empty', 'empty', 'empty', 'empty']);
    const seen: number[] = [];
    const cutAt: number[] = [];
    const render: RenderMixFn = (_m, _s, _t, _p, _g, _sr, opts) => {
      seen.push(opts?.maxFrames ?? -1);
      const r: MixRenderer = mixFromArrays(new Float32Array(SR).fill(0.1), new Float32Array(SR).fill(0.1));
      return { ...r, cut: true, render: r.render.bind(r) };
    };
    await exportLoopMix(src, render, { touch: true, onCut: (s) => cutAt.push(s) });
    expect(seen).toEqual([frames]);
    expect(cutAt).toEqual([1]);
    await exportLoopMix(src, render, { touch: false });
    expect(seen[1]).toBe(10 * 60 * SR);
    expect(mixCutNote(377.9)).toBe('MIX CUT AT 6:17');
    expect(mixCutNote(65)).toBe('MIX CUT AT 1:05');
  });
});
