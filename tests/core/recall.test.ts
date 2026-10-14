/**
 * Recalling a memory (ruling R65, final review I4): the memory keeps its tempo to 0.1 BPM, but each loop keeps the
 * exact tempo it was recorded at. When the tracks load and none is running, a memory tempo that is the 0.1 BPM copy of
 * a loaded loop's exact tempo (R31's own test) gives way to that exact tempo, so the recalled loops play sample for
 * sample as they were recorded instead of going through the XFADE stretcher. The tempo that keeps the most loops on the
 * exact path wins; the transport's own tempo keeps a tie, then the loops in track order.
 *
 * sr 1000 (the harness): a 4/4 measure at 120 BPM is 2000 frames.
 */
import { describe, expect, it } from 'vitest';
import { at, configure, makeCore, recPlay, run, XF } from './harness';
import type { LooperCore } from '../../src/core/looper';
import { TRACKS } from '../../src/shared/ids';
import type { TrackAudio } from '../../src/shared/protocol';

const SR = 1000;
const voice = (f: number): number => 0.5 * Math.sin(f / 7) + 0.25 * Math.sin(f / 53);

/** The 0.1 BPM step the memory stores the tempo at. */
const stored = (bpm: number): number => Math.round(bpm * 10) / 10;

/** The controller's recall: the memory's settings first, then a `loadTrack` for every track (null for an empty one). */
function recall(core: LooperCore, tracks: (TrackAudio | null)[]): void {
  for (const i of TRACKS) core.command({ t: 'loadTrack', track: i, audio: tracks[i] ?? null });
}

/** The next `n` frames of track `i`'s output, left channel. */
function play(core: LooperCore, n: number, i = 0): Float32Array {
  return run(core, n).tracks[i];
}

/** How many frames of `out[from, to)` differ from the loop `L` played from its start at frame 0. */
function differences(out: Float32Array, L: Float32Array, from: number, to: number): number {
  let d = 0;
  for (let f = from; f < to; f++) if (out[f] !== L[f % L.length]) d++;
  return d;
}

function loop(frames: number, recordedTempo: number, measures: number | null): TrackAudio {
  const L = new Float32Array(frames);
  for (let k = 0; k < frames; k++) L[k] = voice(k + 17 * frames);
  return { L, R: L, sampleRate: SR, recordedTempo, measures };
}

describe('recalling a memory whose tempo its first loop set (R65)', () => {
  /** A synced AUTO first loop recorded 0 -> 3737 with no reference: 2 measures at 480000 / 3737 = 128.4453 BPM. */
  function recorded(): TrackAudio {
    const core = makeCore({ track: [{ loopSyncSw: true, measure: 'AUTO' }] });
    at(core, 0, recPlay(), voice);
    at(core, 3737, recPlay(), voice);
    run(core, 300, voice); // past the 5 ms seam crossfade, so the take is final
    const a = core.getTrackAudio(0)!;
    expect(a.L.length).toBe(3737);
    expect(a.recordedTempo).toBe(480000 / 3737);
    expect(stored(a.recordedTempo)).toBe(128.4);
    return a;
  }

  it('the transport takes the loop\'s exact tempo, and the loop plays bit for bit as it was recorded', () => {
    const take = recorded();
    // Power-on (or a recall): a fresh engine gets the memory's 0.1 BPM tempo, then the tracks.
    const core = makeCore({ tempo: 128.4, track: [{ loopSyncSw: true, measure: 'AUTO' }] });
    expect(core.status().tempo).toBe(128.4);
    recall(core, [take]);
    expect(core.status().tempo).toBe(take.recordedTempo);
    core.command(recPlay());
    const out = play(core, 3 * 3737);
    expect(differences(out, take.L, XF, 3 * 3737)).toBe(0); // past the 5 ms start ramp, every pass and seam
  });

  it('a later settings push of the memory tempo does not round it again (R31)', () => {
    const take = recorded();
    const core = makeCore({ tempo: 128.4, track: [{ loopSyncSw: true, measure: 'AUTO' }] });
    recall(core, [take]);
    configure(core, { tempo: 128.4 });
    expect(core.status().tempo).toBe(take.recordedTempo);
    core.command(recPlay());
    expect(differences(play(core, 2 * 3737), take.L, XF, 2 * 3737)).toBe(0);
  });

  it('also when the transport held another tempo before the recall', () => {
    const take = recorded();
    const core = makeCore({ tempo: 120, track: [{ loopSyncSw: true, measure: 'AUTO' }] });
    run(core, 500);
    configure(core, { tempo: 128.4 });
    recall(core, [take]);
    expect(core.status().tempo).toBe(take.recordedTempo);
  });

  it('picks the tempo that keeps every loop exact, even when it is not track 1\'s', () => {
    // Track 2's loop set the tempo (4 measures in 7473 frames, 128.4625 BPM); track 1's is one measure of that grid
    // (1868.25 frames), rounded to 1868 (128.4797 BPM). Both are stored as 128.5. At track 1's tempo track 2 would leave
    // the exact path (a frame a pass off), and so it would at 128.5; at track 2's both stay on it.
    const grid = loop(1868, 240000 / 1868, 1);
    const first = loop(7473, 960000 / 7473, 4);
    const core = makeCore({ tempo: 128.5, track: [{ loopSyncSw: true }, { loopSyncSw: true }] });
    recall(core, [grid, first]);
    expect(core.status().tempo).toBe(960000 / 7473);
    core.command(recPlay(0));
    core.command(recPlay(1));
    const out = run(core, 2 * 7473);
    expect(differences(out.tracks[1], first.L, XF, 2 * 7473)).toBe(0);
    // The grid loop plays its own frames up to its first seam (where the seam correction may move it by a frame).
    expect(differences(out.tracks[0], grid.L, XF, 1868)).toBe(0);
  });

  it('leaves the tempo alone while a track is running', () => {
    const take = recorded();
    const core = makeCore({ tempo: 128.4, track: [{ loopSyncSw: true }, { loopSyncSw: false }] });
    const other = loop(1500, 128.4, null);
    core.setTrackAudio(1, other);
    core.command(recPlay(1));
    run(core, 200);
    core.command({ t: 'loadTrack', track: 0, audio: take });
    expect(core.status().tempo).toBe(128.4);
  });

  it('a memory tempo that is not the loop\'s 0.1 BPM copy is a real tempo and stays', () => {
    const take = recorded();
    const core = makeCore({ tempo: 130, track: [{ loopSyncSw: true }] });
    recall(core, [take]);
    expect(core.status().tempo).toBe(130);
  });
});

describe('recalling a memory whose tempo was typed', () => {
  it('120.0 with loops recorded at 120.0 stays 120.0', () => {
    const core = makeCore({ tempo: 120, track: [{ loopSyncSw: true }, { loopSyncSw: true }] });
    recall(core, [loop(2000, 120, 1), loop(8000, 120, 4)]);
    expect(core.status().tempo).toBe(120);
  });

  it('123.0 with grid loops a fraction of a frame off it stays 123.0 (each loop\'s own tempo would push the other off)', () => {
    // A measure at 123 BPM is 1951.22 frames: one measure rounds to 1951 (123.0138 BPM), four to 7805 (122.9980 BPM).
    // Both play on the exact path at 123.0. At the first loop's tempo the second would not.
    const a = loop(1951, 240000 / 1951, 1);
    const b = loop(7805, 960000 / 7805, 4);
    const core = makeCore({ tempo: 123, track: [{ loopSyncSw: true }, { loopSyncSw: true }] });
    recall(core, [a, b]);
    expect(core.status().tempo).toBe(123);
  });

  it('the recorded 123.0 grid plays as before: the loops stay on the exact path', () => {
    const b = loop(7805, 960000 / 7805, 4);
    const core = makeCore({ tempo: 123, track: [{ loopSyncSw: true }] });
    recall(core, [b]);
    core.command(recPlay());
    const out = play(core, 7805);
    // Within the first pass the seam correction has nothing to do: the loop plays its own frames.
    expect(differences(out, b.L, XF, 7805)).toBe(0);
  });
});
