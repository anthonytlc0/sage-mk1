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
 * the exact path. A memory tempo within 0.05 BPM of a playing loop's recorded tempo rounded to 0.1 is taken to be
 * that tempo (of the candidates, the one that puts the most loops on the exact path), as the core does with a pushed
 * memory tempo.
 *
 * Memory: the tracks are read in place (`AudioTake.view`), not copied into the offline core's pool, so the render
 * allocates its output (2 channels x the cycle x 4 bytes: 230 MB at the 10-minute cap at 48 kHz) and well under a
 * megabyte of engine state. Runs on the main thread; it never runs in the worklet (it is not on the worklet's import
 * path).
 */
import { LooperCore } from './looper';
import type { CoreOutput } from './looper';
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

/** The tempo the loops play at live (see the file comment on R31). */
function liveTempo(memory: MemorySettings, tracks: readonly (TrackAudio | null)[], idx: readonly number[]): number {
  let best = memory.tempo;
  let bestExact = -1;
  const candidates = [memory.tempo];
  for (const i of idx) {
    const rt = tracks[i]!.recordedTempo;
    if (Number.isFinite(rt) && rt > 0 && Math.abs(memory.tempo - Math.round(rt * 10) / 10) < 0.05) candidates.push(rt);
  }
  for (const tempo of candidates) {
    let exact = 0;
    for (const i of idx) {
      const t = tracks[i]!;
      if (lengthAfterRate(t.L.length, rateOf(memory.track[i], tempo, t)) === t.L.length) exact++;
    }
    if (exact > bestExact) {
      best = tempo;
      bestExact = exact;
    }
  }
  return best;
}

/**
 * Render one full cycle of the playing tracks at `sr` (the engine's rate, which `exportTracks` gives the tracks at):
 * `tracks[i]` sounds when `playing[i]`, at linear fader gain `faderGains[i]`. Returns empty arrays when nothing plays.
 */
export function renderMix(
  memory: MemorySettings,
  system: SystemSettings,
  tracks: (TrackAudio | null)[],
  playing: boolean[],
  faderGains: number[],
  sr: number,
): { L: Float32Array; R: Float32Array } {
  const idx: number[] = [];
  for (const i of TRACKS) {
    const t = tracks[i];
    if (playing[i] === true && t && t.L.length > 0 && t.L.length === t.R.length && memory.track[i]) idx.push(i);
  }
  if (idx.length === 0) return { L: new Float32Array(0), R: new Float32Array(0) };

  const tempo = liveTempo(memory, tracks, idx);
  const mem: MemorySettings = {
    ...memory,
    tempo,
    track: memory.track.map((t) => ({ ...t, loopSyncSw: false, startMode: 'IMMEDIATE', playMode: 'MULTI' })),
  };
  const lengths = idx.map((i) => lengthAfterRate(tracks[i]!.L.length, rateOf(mem.track[i], tempo, tracks[i]!)));
  const total = cycleLength(lengths, Math.round(MIX_CAP_SECONDS * sr));

  const core = new LooperCore({ sampleRate: sr, memoryBudgetBytes: OFFLINE_BUDGET, inPlaceLoads: true });
  core.setSettings(mem, system);
  for (const i of idx) core.setTrackAudio(TRACKS[i], tracks[i]);
  for (const i of idx) core.command({ t: 'recPlay', track: TRACKS[i] });

  const mixer = new Mixer(sr);
  mixer.configure(system);
  for (const i of TRACKS) mixer.setFader(i, faderGains[i] ?? 1);

  const L = new Float32Array(total);
  const R = new Float32Array(total);
  const silence = new Float32Array(BLOCK);
  const quiet: [Float32Array, Float32Array] = [silence, silence];
  const out: CoreOutput = {
    tracks: TRACKS.map((): [Float32Array, Float32Array] => [new Float32Array(BLOCK), new Float32Array(BLOCK)]),
    click: [new Float32Array(BLOCK), new Float32Array(BLOCK)],
  };
  for (let at = 0; at < total; at += BLOCK) {
    const n = Math.min(BLOCK, total - at);
    core.process(silence, silence, silence, silence, out, n);
    mixer.process(out.tracks, quiet, quiet, [L.subarray(at, at + n), R.subarray(at, at + n)], null, n);
  }
  return { L, R };
}
