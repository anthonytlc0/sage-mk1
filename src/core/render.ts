/**
 * The offline render behind LOOP MIX (Task 9): the loops that are playing, mixed down to one full cycle.
 *
 * One cycle is the least common multiple of the playing tracks' lengths after rate (each track's length in frames
 * divided by the rate it plays at live), capped at 10 minutes; past the cap it falls back to the longest track (and never
 * runs past the cap: INFERRED, so a single loop longer than 10 minutes renders its first 10).
 *
 * The mix is what is heard (ruling R64, final review I5): the cycle starts at the press, with each track where its live
 * playhead is then (`MixOptions.offsets`, which LOOP MIX takes from one engine status), so layers started at different
 * bars keep their places against each other. Each loop repeats with its own length, so the mix still loops seamlessly
 * after one cycle. A 1SHOT caught mid-way plays out from there, once. With no offsets every track is at its start on
 * the cycle's first frame, as an ALL START would start them.
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
 * The loops start 5 ms before the cycle (that much earlier in each loop), so the cycle's first frames are past the live
 * start ramp, in steady state, and it loops without a dip at its seam (fix round 1). A 1SHOT starts on the cycle's
 * first frame with the live ramp-in instead (PROMOTED 1).
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

/** A loop of `frames` frames at `rate` plays on the exact path: the rate is 1 to within half a frame per pass (`Track.isUnity`). */
function exactPath(frames: number, rate: number): boolean {
  return Math.abs(rate - 1) * frames <= 0.5 + 1e-9;
}

/**
 * A loop of `frames` frames played at `rate` (already clamped), in timeline frames: `frames` itself when the rate is 1
 * to within half a frame per pass (the exact path, as `Track.isUnity` decides), else `frames / rate` rounded.
 */
export function lengthAfterRate(frames: number, rate: number): number {
  if (exactPath(frames, rate)) return frames;
  return Math.max(1, Math.round(frames / rate));
}

/**
 * Where a loop of `len` frames at `rate` starts, `pre` timeline frames before the cycle's first frame, so that it is
 * `offset` frames into the loop (in play order) on that frame: its take position and its seam phase. On the exact path
 * the position is a whole frame (it reads whole frames, so it stays exact); otherwise the playhead is fractional, as
 * live. REVERSE counts from the loop's end.
 *
 * The phase: a loop a fraction of a frame off its grid length moves its seam a frame now and then on the exact path
 * (ruling R45). A pre-roll that runs across the seam would have that correction move the loop a frame there, just
 * before the cycle. Started with the phase that makes that crossing on time, the pass from the seam is the one a fresh
 * start there plays. (Otherwise the phase is 0, as for a start from stopped. The live loop's own phase is not in the
 * status, so at later seams the mix can differ from live by one such frame, inside the seam crossfade.)
 */
function startOf(len: number, rate: number, reverse: boolean, offset: number | undefined, pre: number): { pos: number; phase: number } {
  const exact = exactPath(len, rate);
  let e = typeof offset === 'number' && Number.isFinite(offset) ? offset : 0;
  if (exact) e = Math.round(e);
  e %= len;
  if (e < 0) e += len;
  if (e >= len) e -= len; // a tiny negative remainder that rounded up to len
  let s = e - (exact ? pre : pre * rate);
  const phase = exact && s < 0 ? len - len / rate : 0; // minus the drift a pass: the crossing is on time
  while (s < 0) s += len;
  if (s >= len) s -= len;
  if (!reverse) return { pos: s, phase };
  const p = len - 1 - s;
  return { pos: p < 0 ? p + len : p, phase };
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
  /**
   * Where each track is in its loop on the cycle's first frame (ruling R64: the cycle starts at the press, each track at
   * its live playhead), indexed by track: frames into the loop in play order, at the take's own frames (0 is its start,
   * the last frame in REVERSE; k is k frames on from there). A missing entry, or one that is not a number, is 0; any
   * other wraps into the loop. LOOP MIX takes them from one engine status (`TrackStatus.position`). Default: every
   * track at its start.
   */
  offsets?: readonly number[];
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
 * at): `tracks[i]` sounds when `playing[i]`, at linear fader gain `faderGains[i]`, starting at `opts.offsets[i]`.
 *
 * The engine renders in BLOCK-frame blocks whatever the caller asks for, so any chunking gives the same samples. It
 * runs XF frames (the 5 ms start ramp) before the first, with each loop started that much earlier in itself: on the
 * cycle's first frame every loop is at its offset, in steady state, so the mix loops without a dip at its seam (fix
 * round 1). On the exact path the loops then play sample for sample as live from the press. A 1SHOT starts after the
 * pre-roll, on the cycle's first frame at its offset, with the live 5 ms ramp-in (PROMOTED 1: through the pre-roll it
 * lost its ramp and started with a step).
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
  const rates = idx.map((i) => rateOf(mem.track[i], tempo, tracks[i]!));
  const lengths = idx.map((i, k) => lengthAfterRate(tracks[i]!.L.length, rates[k]));
  const cap = Math.round(MIX_CAP_SECONDS * sr);
  const longest = Math.max(...lengths);
  const cycle = cycleLength(lengths, cap);
  const full = Math.max(cycle, longest); // the cycle itself (the longest track, past 10 minutes), uncut
  const most = typeof opts.maxFrames === 'number' && opts.maxFrames >= 0 ? Math.floor(opts.maxFrames) : Infinity;
  const frames = Math.min(cycle, most);

  const xf = xfadeFrames(sr);
  const core = new LooperCore({ sampleRate: sr, memoryBudgetBytes: OFFLINE_BUDGET, inPlaceLoads: true });
  core.setSettings(mem, system);
  for (const i of idx) core.setTrackAudio(TRACKS[i], tracks[i]);
  // Exactly the tempo asked for, after the loads: setSettings keeps a transport tempo within 0.05 BPM of the memory's
  // (R31), and a load can move it to a loaded loop's exact tempo (R65); LOOP MIX renders the tempo the engine plays.
  core.command({ t: 'tempo', bpm: tempo });
  /** Start track `idx[k]` now, `pre` frames before the cycle's first frame, at its offset. */
  const start = (k: number, pre: number): void => {
    const i = idx[k];
    const { pos, phase } = startOf(tracks[i]!.L.length, rates[k], mem.track[i].reverse, opts.offsets?.[i], pre);
    core.startTrackAt(TRACKS[i], pos, phase);
  };
  // The loops start before the pre-roll (below), so the cycle begins past their start ramp. A 1SHOT starts after it,
  // on the cycle's first frame, with the live ramp: through the pre-roll it would start with a step (PROMOTED 1), and
  // one caught mid-way ramps in from there rather than stepping in.
  idx.forEach((i, k) => {
    if (!mem.track[i].oneShot) start(k, xf);
  });

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
  core.process(silence, silence, silence, silence, out, xf);
  idx.forEach((i, k) => {
    if (mem.track[i].oneShot) start(k, 0);
  });

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
 * the memory tempo), each track starting at its entry in `offsets` (`MixOptions.offsets`; default: every track at its
 * start). Returns empty arrays when nothing plays.
 */
export function renderMix(
  memory: MemorySettings,
  system: SystemSettings,
  tracks: (TrackAudio | null)[],
  playing: boolean[],
  faderGains: number[],
  sr: number,
  tempo?: number,
  offsets?: readonly number[],
): { L: Float32Array; R: Float32Array } {
  const opts: MixOptions = {};
  if (tempo !== undefined) opts.tempo = tempo;
  if (offsets !== undefined) opts.offsets = offsets;
  const r = mixRenderer(memory, system, tracks, playing, faderGains, sr, opts);
  const L = new Float32Array(r.frames);
  const R = new Float32Array(r.frames);
  if (r.frames > 0) r.render(L, R, r.frames);
  return { L, R };
}
