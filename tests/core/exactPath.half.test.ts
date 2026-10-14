/**
 * The exact path's half-frame edge (found in the final fix pass, alongside R65). A grid loop's length is its ideal length
 * on the grid rounded to whole frames, so it is at most half a frame off, and `Track.isUnity` is meant to keep every
 * such loop on the exact path ("the loop's length on the timeline is within half a frame of its length in frames").
 * It measured `|rate - 1| x length` instead of `|length / rate - length|`, which is a hair over half a frame exactly when
 * the ideal length is a whole number and a half (rounded up). That is every 1-measure layer over a 2-measure first loop
 * of an odd length, and every 2-measure layer over a 4-measure one: they went through the stretcher.
 *
 * sr 1000 (the harness).
 */
import { describe, expect, it } from 'vitest';
import { at, makeCore, recPlay, run, stop, trk, XF } from './harness';
import { renderMix } from '../../src/core/render';
import { defaultMemory } from '../../src/schema/memory';
import { defaultSystem } from '../../src/schema/system';
import type { LooperCore } from '../../src/core/looper';

const voice = (f: number): number => 0.5 * Math.sin(f / 7) + 0.25 * Math.sin(f / 53);

/** Track 1: a free 2-measure first loop of 3737 frames (128.4453 BPM). Track 2: one measure on its grid (1868.5). */
function layered(): LooperCore {
  const core = makeCore({
    rec: { quantize: 'MEASURE' },
    track: [{ loopSyncSw: true, measure: 'AUTO' }, { loopSyncSw: true, measure: { measures: 1 } }],
  });
  at(core, 0, recPlay(0), voice);
  at(core, 3737, recPlay(0), voice);
  at(core, 4000, recPlay(1), voice); // waits for the line at 5605.5 -> 5606
  run(core, 9000, voice);
  at(core, core.frame, recPlay(1), voice);
  run(core, 6000, voice);
  expect(trk(core, 1).lengthFrames).toBe(1869);
  expect(trk(core, 1).measures).toBe(1);
  return core;
}

describe('a grid loop half a frame off its grid stays on the exact path', () => {
  it('the 1-measure layer plays its own frames, sample for sample', () => {
    const core = layered();
    const take = core.getTrackAudio(1)!;
    core.command(stop(0));
    core.command(stop(1));
    run(core, 50);
    core.command(recPlay(1));
    const out = run(core, 1869).tracks[1];
    let differ = 0;
    for (let f = XF; f < 1869; f++) if (out[f] !== take.L[f]) differ++;
    expect(differ).toBe(0);
  });

  it('LOOP MIX at the engine\'s tempo renders it sample for sample too', () => {
    const core = layered();
    const take = core.getTrackAudio(1)!;
    const memory = defaultMemory();
    memory.tempo = 128.4;
    const r = renderMix(memory, defaultSystem(), [null, take, null, null, null], [false, true, false, false, false], [1, 1, 1, 1, 1], 1000, core.status().tempo);
    expect(r.L.length).toBe(1869);
    let differ = 0;
    for (let f = 0; f < 1869; f++) if (r.L[f] !== take.L[f]) differ++;
    expect(differ).toBe(0);
  });
});
