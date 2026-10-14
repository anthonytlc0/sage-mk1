/**
 * The offline render behind LOOP MIX (Task 9): the loops that are playing, mixed down to one full cycle.
 *
 * One cycle is the least common multiple of the playing tracks' lengths after rate (each track's length in frames
 * divided by the rate it plays at live), capped at 10 minutes; past the cap it falls back to the longest track (and never
 * runs past the cap: INFERRED, so a single loop longer than 10 minutes renders its first 10). Every playing track
 * starts at frame 0, as an ALL START would start them.
 *
 * It renders with the live engine itself rather than a copy of it: an offline `LooperCore` plays the tracks, so the
 * rate (`playbackRate`, clamped to RATE_MIN..RATE_MAX), TEMPO SYNC PITCH and XFADE, REVERSE, 1SHOT, PLAY LEVEL, PAN, the
 * 5 ms start ramp and the exact path's seam correction are the very code the loops play through live, and the
 * engine's `Mixer` applies the faders, LOOP OUT and the OUTPUT ROUTING as live. The live input and the GUIDE click are
 * left out, and so is MASTER FX: LOOP MIX (src/recorder/loopMix.ts) runs that on the result itself.
 *
 * For the render the tracks start together and stay together: LOOP SYNC is off (no line to wait for), START MODE is
 * IMMEDIATE (no fade-in: the mix is the loops as they sound once playing) and PLAY MODE MULTI (two SINGLE tracks that
 * are both playing must not stop each other).
 *
 * The tempo: live, a synced loop plays at the transport's exact tempo, which the memory stores only to 0.1 BPM
 * (ruling R31: 128.4453 comes back as 128.4). Rendered at 128.4, every synced loop would be stretched by a hair and off
 * the exact path. So LOOP MIX hands over the engine's tempo (`MixOptions.tempo`, from its status), and the offline
 * transport is set to exactly that (fix round 1).
 *
 * The cycle starts 5 ms in, past the live start ramp, so its first frames are the steady state and it loops without a
 * dip at its seam (fix round 1).
 *
 * Streaming (ruling R63): `mixRenderer` hands the mix out a block at a time, so LOOP MIX never holds the cycle as
 * floats; `renderMix` (the brief's interface) renders it into two arrays at once. The tracks are read in place
 * (`AudioTake.view`), not copied into the offline core's pool; the renderer holds its engine's state (about 5 MB at
 * 48 kHz, most of it the input delay rings) and one block. Runs on the main thread; it never runs in the worklet (it is
 * not on the worklet's import path).
 */
import { LooperCore } from './looper';
import type { CoreOutput } from './looper';
import { xfadeFrames } from './fade';
import { RATE_MAX, RATE_MIN, playbackRate } from './track';
import { Mixer } from '../dsp/mixer';
import type { MemorySettings, SystemSettings, TrackSettings } from '../schema/types';
import { TRACKS } from '../shared/ids';
import type { TrackAudio } from '../shared/protocol';

/** The longest render. */
export const MIX_CAP_SECONDS = 10 * 60;
/** Frames rendered per block. */
const BLOCK = 1024;
/** The offline core's pool budget: it holds no audio of its own (the tracks are views), so this is only a backstop. */
const OFFLINE_BUDGET = 64 * 1024 * 1024;

/**
 * A loop of `frames` frames played at `rate` (already clamped), in timeline frames: `frames` itself when the rate is 1
 * to within half a frame per pass (the exact path, as `Track.isUnity` decides), else `frames / rate` rounded.
 */
export function lengthAfterRate(frames: number, rate: number): number {
  if (Math.abs(rate - 1) * frames <= 0.5 + 1e-9) return frames;
  return Math.max(1, Math.round(frames / rate));
}

/** The least common multiple of `lengths` if it is at most `cap`, else the longest; never more than `cap`. */
export function cycleLength(lengths: readonly number[], cap: number): number {
  let longest = 0;
  for (const n of lengths) longest = Math.max(longest, n);
  let l = 1;
  for (const n of lengths) {
    l = (l / gcd(l, n)) * n;
    if (l > cap) return Math.min(longest, cap);
  }
  return lengths.length === 0 ? 0 : l;
}

function gcd(a: number, b: number): number {
  while (b !== 0) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

/** A playing track's rate at `tempo`, as the live track computes it (before a SPEED MOMENT, which is not saved). */
function rateOf(cfg: TrackSettings, tempo: number, audio: TrackAudio): number {
  const r = playbackRate(cfg.tempoSyncSw, tempo, audio.recordedTempo, cfg.tempoSyncSpeed);
  return r > RATE_MAX ? RATE_MAX : r < RATE_MIN ? RATE_MIN : r;
}

export interface MixOptions {
  /**
   * The tempo the loops play at: the engine's exact transport tempo (`status.tempo`). The memory keeps the tempo only
   * to 0.1 BPM (ruling R31), and a loop synced at 119.97 played at the memory's 120.0 would be stretched off the exact
   * path. Default: the memory tempo.
   */
  tempo?: number;
  /** The most frames to render (LOOP MIX's cap on a touch device); a longer cycle is cut there (`cut`). */
  maxFrames?: number;
}

/** One full cycle of the mix, rendered on demand a block at a time (ruling R63: LOOP MIX streams it). */
export interface MixRenderer {
  /** Frames in the mix (0: nothing is playing). */
  readonly frames: number;
  /** The cycle was longer than the mix: it was cut at `frames` (MixOptions.maxFrames, or a loop past the 10 minutes). */
  readonly cut: boolean;
  /** The next `n` frames of the mix into `L`/`R` from index 0 (silence past its end). */
  render(L: Float32Array, R: Float32Array, n: number): void;
}

const NOTHING: MixRenderer = {
  frames: 0,
  cut: false,
  render(L: Float32Array, R: Float32Array, n: number): void {
    L.fill(0, 0, n);
    R.fill(0, 0, n);
  },
};

/**
 * A renderer of one full cycle of the playing tracks at `sr` (the engine's rate, which `exportTracks` gives the tracks
 * at): `tracks[i]` sounds when `playing[i]`, at linear fader gain `faderGains[i]`.
 *
 * The engine renders in BLOCK-frame blocks whatever the caller asks for, so any chunking gives the same samples. It
 * runs XF frames (the 5 ms start ramp) before the first: the cycle begins there, in steady state, and so loops without
 * a dip at its seam (fix round 1). A 1SHOT loses its first 5 ms with it.
 */
export function mixRenderer(
  memory: MemorySettings,
  system: SystemSettings,
  tracks: (TrackAudio | null)[],
  playing: boolean[],
  faderGains: number[],
  sr: number,
  opts: MixOptions = {},
): MixRenderer {
  const idx: number[] = [];
  for (const i of TRACKS) {
    const t = tracks[i];
    if (playing[i] === true && t && t.L.length > 0 && t.L.length === t.R.length && memory.track[i]) idx.push(i);
  }
  if (idx.length === 0) return NOTHING;

  const tempo = typeof opts.tempo === 'number' && Number.isFinite(opts.tempo) && opts.tempo > 0 ? opts.tempo : memory.tempo;
  const mem: MemorySettings = {
    ...memory,
    tempo,
    track: memory.track.map((t) => ({ ...t, loopSyncSw: false, startMode: 'IMMEDIATE', playMode: 'MULTI' })),
  };
  const lengths = idx.map((i) => lengthAfterRate(tracks[i]!.L.length, rateOf(mem.track[i], tempo, tracks[i]!)));
  const cap = Math.round(MIX_CAP_SECONDS * sr);
  const longest = Math.max(...lengths);
  const cycle = cycleLength(lengths, cap);
  const full = Math.max(cycle, longest); // the cycle itself (the longest track, past 10 minutes), uncut
  const most = typeof opts.maxFrames === 'number' && opts.maxFrames >= 0 ? Math.floor(opts.maxFrames) : Infinity;
  const frames = Math.min(cycle, most);

  const core = new LooperCore({ sampleRate: sr, memoryBudgetBytes: OFFLINE_BUDGET, inPlaceLoads: true });
  core.setSettings(mem, system);
  // Exactly the tempo asked for: setSettings keeps a transport tempo within 0.05 BPM of the memory's (R31).
  core.command({ t: 'tempo', bpm: tempo });
  for (const i of idx) core.setTrackAudio(TRACKS[i], tracks[i]);
  for (const i of idx) core.command({ t: 'recPlay', track: TRACKS[i] });

  const mixer = new Mixer(sr);
  mixer.configure(system);
  for (const i of TRACKS) mixer.setFader(i, faderGains[i] ?? 1);

  const silence = new Float32Array(BLOCK);
  const quiet: [Float32Array, Float32Array] = [silence, silence];
  const out: CoreOutput = {
    tracks: TRACKS.map((): [Float32Array, Float32Array] => [new Float32Array(BLOCK), new Float32Array(BLOCK)]),
    click: [new Float32Array(BLOCK), new Float32Array(BLOCK)],
  };
  const bufL = new Float32Array(BLOCK);
  const bufR = new Float32Array(BLOCK);
  const mixOut: [Float32Array, Float32Array] = [bufL, bufR];
  // The start ramp, before the cycle's first frame.
  core.process(silence, silence, silence, silence, out, xfadeFrames(sr));

  let done = 0; // frames of the mix rendered into the block buffers
  let have = 0; // frames in them
  let next = 0; // the next of those to hand out
  return {
    frames,
    cut: frames < full,
    render(L: Float32Array, R: Float32Array, n: number): void {
      let k = 0;
      while (k < n) {
        if (next === have) {
          const m = Math.min(BLOCK, frames - done);
          if (m <= 0) {
            L.fill(0, k, n);
            R.fill(0, k, n);
            return;
          }
          core.process(silence, silence, silence, silence, out, m);
          mixer.process(out.tracks, quiet, quiet, mixOut, null, m);
          done += m;
          have = m;
          next = 0;
        }
        const c = Math.min(n - k, have - next);
        for (let j = 0; j < c; j++) {
          L[k + j] = bufL[next + j];
          R[k + j] = bufR[next + j];
        }
        k += c;
        next += c;
      }
    },
  };
}

/**
 * Render one full cycle of the playing tracks at `sr` into two arrays (`mixRenderer`, all at once), at `tempo` (default:
 * the memory tempo). Returns empty arrays when nothing plays.
 */
export function renderMix(
  memory: MemorySettings,
  system: SystemSettings,
  tracks: (TrackAudio | null)[],
  playing: boolean[],
  faderGains: number[],
  sr: number,
  tempo?: number,
): { L: Float32Array; R: Float32Array } {
  const r = mixRenderer(memory, system, tracks, playing, faderGains, sr, tempo === undefined ? {} : { tempo });
  const L = new Float32Array(r.frames);
  const R = new Float32Array(r.frames);
  if (r.frames > 0) r.render(L, R, r.frames);
  return { L, R };
}
