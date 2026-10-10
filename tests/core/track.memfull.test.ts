import { describe, expect, it } from 'vitest';
import { at, dc, makeCore, recPlay, run, SR, trk } from './harness';

const CHUNK_BYTES = SR * 2 * 4; // one 1 s stereo float chunk

describe('MEMORY FULL', () => {
  it('a recording that runs out of memory ends at the last full chunk and plays', () => {
    const core = makeCore({}, { memoryBudgetBytes: 3 * CHUNK_BYTES });
    at(core, 0, recPlay(), dc(0.5));
    run(core, 4000, dc(0.5)); // the budget holds 3000 frames
    expect(core.takeMessages()).toEqual(['MEMORY FULL']);
    expect(core.takeMessages()).toEqual([]); // taken once
    const s = trk(core);
    expect(s.lengthFrames).toBe(3000);
    expect(s.state).toBe('playing');
    // It played from position 0 at frame 3000: frame 3999 is position 999.
    expect(s.position).toBeCloseTo(1000 / 3000, 6);
    expect(run(core, 1000).tracks[0][500]).toBe(0.5);
    expect(core.status().memoryBytes).toBe(3 * CHUNK_BYTES);
  });

  it('ends in playback even with REC->DUB (an overdub could not be stored either)', () => {
    const core = makeCore({ rec: { recAction: 'REC->DUB' } }, { memoryBudgetBytes: 2 * CHUNK_BYTES });
    at(core, 0, recPlay(), dc(0.5));
    run(core, 2500, dc(0.5));
    expect(core.takeMessages()).toEqual(['MEMORY FULL']);
    expect(trk(core).state).toBe('playing');
    expect(trk(core).lengthFrames).toBe(2000);
  });

  it('a recording that gets no memory at all leaves the track empty', () => {
    const core = makeCore({}, { memoryBudgetBytes: 2 * CHUNK_BYTES });
    at(core, 0, recPlay(0), dc(0.5));
    run(core, 2500, dc(0.5)); // track 1 takes the whole budget
    core.takeMessages();
    at(core, 3000, recPlay(1), dc(0.5));
    run(core, 500, dc(0.5));
    expect(core.takeMessages()).toEqual(['MEMORY FULL']);
    expect(trk(core, 1).state).toBe('empty');
    expect(trk(core, 0).state).toBe('playing');
  });

  it('an overdub that cannot copy a shared chunk posts MEMORY FULL, ends the pass and leaves the audio unchanged', () => {
    const core = makeCore({}, { memoryBudgetBytes: 2 * CHUNK_BYTES });
    at(core, 0, recPlay(), dc(0.5));
    at(core, 1500, recPlay(), dc(0.5)); // 1500 frames: two chunks, the whole budget
    run(core, 100, dc(0.5)); // let the seam crossfade finish
    // Hold a snapshot (as undo will in Task 8): every chunk is now shared, so the first overdub write must copy one.
    const held = core.tracks[0].take.snapshot();
    at(core, 1700, recPlay(), dc(0.25));
    run(core, 50, dc(0.25));
    expect(core.takeMessages()).toEqual(['MEMORY FULL']);
    expect(trk(core).state).toBe('playing');
    const out = run(core, 1500).tracks[0];
    expect(out.every((v) => v === 0.5)).toBe(true); // nothing was layered
    held.release();
  });

  it('loading audio that does not fit posts MEMORY FULL and leaves the track empty', () => {
    const core = makeCore({}, { memoryBudgetBytes: 2 * CHUNK_BYTES });
    const L = new Float32Array(2500).fill(0.5);
    core.setTrackAudio(0, { L, R: L.slice(), sampleRate: SR, recordedTempo: 120, measures: null });
    expect(core.takeMessages()).toEqual(['MEMORY FULL']);
    expect(trk(core).state).toBe('empty');
    expect(core.status().memoryBytes).toBe(0);
  });
});
