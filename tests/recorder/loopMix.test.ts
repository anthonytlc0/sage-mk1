import { describe, expect, it, vi } from 'vitest';
import { makeStatus } from '../../src/control/fakeEngine';
import { Session } from '../../src/control/session';
import { NothingToMixError, exportLoopMix } from '../../src/recorder/loopMix';
import type { LoopMixSource, RenderMixFn } from '../../src/recorder/loopMix';
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
  return { L, R };
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
    const [memory, system, got, playing, gains, sr] = render.mock.calls[0]!;
    expect(memory).toBe(src.session.memory);
    expect(system).toBe(src.session.system);
    expect(got).toBe(tracks);
    expect(playing).toEqual([true, true, false, false, false]); // playing and overdubbing sound; stopped, recording, empty do not
    expect(gains).toEqual([1, 0.5, 0.25, 0, 1]);
    expect(sr).toBe(SR);
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
    await expect(exportLoopMix(src, () => ({ L: new Float32Array(0), R: new Float32Array(0) }))).rejects.toBeInstanceOf(NothingToMixError);
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
      return { L, R };
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
