/**
 * Armed presses at the edges: STOP, repeats, tempo changes, clears and interruptions while an action waits for its
 * measure line, plus block-size independence. sr 1000, tempo 120, 4/4 (a measure is 2000 frames).
 */
import { describe, expect, it } from 'vitest';
import { at, clear, configure, dc, makeCore, ramp, recPlay, run, SR, stop, trk } from './harness';
import type { LooperCore } from '../../src/core/looper';

const CHUNK_BYTES = SR * 2 * 4;
const rhythmOn = (core: LooperCore): void => core.command({ t: 'rhythmStartStop' });

function runTo(core: LooperCore, frame: number, input?: (f: number) => number) {
  return run(core, frame - core.frame, input);
}

/** Rhythm on at frame 0 and a synced track 1 armed at 500 for the line at 2000. */
function armed(over: Parameters<typeof makeCore>[0] = {}): LooperCore {
  const core = makeCore({ track: [{ loopSyncSw: true }], ...over });
  rhythmOn(core);
  at(core, 500, recPlay(), dc(0.5));
  expect(trk(core).pending).toBe('rec');
  return core;
}

describe('an armed recording', () => {
  it('STOP while pending rec cancels the arm', () => {
    const core = armed();
    at(core, 1000, stop());
    expect(trk(core).pending).toBeNull();
    expect(trk(core).state).toBe('empty');
    runTo(core, 4000, dc(0.5));
    expect(trk(core).state).toBe('empty');
    expect(trk(core).lengthFrames).toBe(0);
    expect(core.status().memoryBytes).toBe(0);
  });

  it('recPlay twice while armed keeps a single arm', () => {
    const core = armed();
    at(core, 1000, recPlay(), dc(0.5));
    expect(trk(core).pending).toBe('rec');
    runTo(core, 2001, dc(0.5));
    expect(trk(core).state).toBe('recording'); // started on the line...
    runTo(core, 5000, dc(0.5));
    expect(trk(core).state).toBe('recording'); // ...and the repeat press did not end it
    expect(trk(core).lengthFrames).toBe(3000);
  });

  it('a repeat press keeps the arm even when the grid has stopped since (it does not restart the wait)', () => {
    const core = makeCore({ track: [{ loopSyncSw: true }, { loopSyncSw: true }] });
    at(core, 0, recPlay(0), dc(0.5));
    at(core, 4000, recPlay(0), dc(0.5)); // track 1 playing: tempo 120, origin 0
    at(core, 4100, recPlay(1), dc(0.5)); // armed for 6000
    at(core, 4500, stop(0)); // only the arm itself keeps the grid now
    at(core, 5000, recPlay(1), dc(0.5));
    expect(trk(core, 1).pending).toBe('rec');
    expect(trk(core, 1).state).toBe('empty');
    runTo(core, 6000, dc(0.5));
    expect(trk(core, 1).state).toBe('empty');
    runTo(core, 6001, dc(0.5));
    expect(trk(core, 1).state).toBe('recording');
  });

  it('a tempo change while armed re-targets the boundary (the same downbeat, at the new tempo)', () => {
    const core = armed();
    runTo(core, 1000, dc(0.5));
    expect(core.status().measurePhase).toBeCloseTo(0.5, 9);
    core.command({ t: 'tempo', bpm: 60 }); // a measure is now 4000 frames
    // The tempo change keeps the musical position: still half way through measure 0, whose end is now at 3000.
    expect(core.status().measurePhase).toBeCloseTo(0.5, 9);
    runTo(core, 2001, dc(0.5));
    expect(trk(core).pending).toBe('rec');
    expect(trk(core).state).toBe('empty');
    runTo(core, 2999, dc(0.5));
    expect(trk(core).state).toBe('empty');
    runTo(core, 3001, dc(0.5));
    expect(trk(core).state).toBe('recording');
    expect(trk(core).lengthFrames).toBe(1);
  });

  it('a settings tempo change while armed re-targets the boundary too', () => {
    const core = armed();
    runTo(core, 1000, dc(0.5));
    configure(core, { tempo: 240 }); // a measure is now 1000 frames; frame 1000 is half way through measure 0
    runTo(core, 1499, dc(0.5));
    expect(trk(core).state).toBe('empty');
    runTo(core, 1501, dc(0.5));
    expect(trk(core).state).toBe('recording');
  });

  it('clear while armed drops the arm', () => {
    const core = armed();
    at(core, 1000, clear());
    expect(trk(core).pending).toBeNull();
    runTo(core, 3000, dc(0.5));
    expect(trk(core).state).toBe('empty');
  });

  it('armed actions do not go through the command queue: an overflowing queue never fires them early', () => {
    const core = armed();
    for (let k = 0; k < 70; k++) core.command({ t: 'tempo', bpm: 120 }, 5000 + k); // overflows the 64-entry queue
    expect(trk(core).pending).toBe('rec');
    runTo(core, 1999, dc(0.5));
    expect(trk(core).state).toBe('empty');
    runTo(core, 2001, dc(0.5));
    expect(trk(core).state).toBe('recording');
  });

  it('the rhythm can be switched off again', () => {
    const core = makeCore();
    rhythmOn(core);
    expect(core.status().rhythm).toBe('on');
    rhythmOn(core);
    expect(core.status().rhythm).toBe('off');
  });
});

describe('an armed start', () => {
  /** Track 1 synced and playing (0 -> 4000, tempo 120); track 2 synced, MEASURE, stopped, and armed at 4500. */
  function armedStart(): LooperCore {
    const core = makeCore({ track: [{ loopSyncSw: true }, { loopSyncSw: true, loopSyncMode: 'MEASURE' }] });
    at(core, 0, recPlay(0), dc(0.5));
    at(core, 4000, recPlay(0), dc(0.5));
    const L = new Float32Array(2000).fill(0.25);
    core.setTrackAudio(1, { L, R: L, sampleRate: SR, recordedTempo: 120, measures: 1 });
    at(core, 4500, recPlay(1));
    expect(trk(core, 1).pending).toBe('play');
    return core;
  }

  it('STOP while pending play cancels the start', () => {
    const core = armedStart();
    at(core, 5000, stop(1));
    expect(trk(core, 1).pending).toBeNull();
    expect(runTo(core, 7000).tracks[1].every((v) => v === 0)).toBe(true);
    expect(trk(core, 1).state).toBe('stopped');
  });

  it('recPlay while pending play is a no-op: it starts once, on the line', () => {
    const core = armedStart();
    at(core, 5000, recPlay(1));
    expect(trk(core, 1).pending).toBe('play');
    runTo(core, 6001);
    expect(trk(core, 1).state).toBe('playing');
    expect(trk(core, 1).position).toBeCloseTo(1 / 2000, 9);
  });
});

describe('a recording waiting for its line', () => {
  it('STOP turns the wait into a stop at the line, keeping the snapped loop (INFERRED)', () => {
    const core = armed();
    at(core, 3000, recPlay(), dc(0.5)); // snaps to 1 measure: waits for 4000
    expect(trk(core).pending).toBe('play');
    at(core, 3500, stop(), dc(0.5));
    expect(trk(core).pending).toBe('stop');
    expect(trk(core).state).toBe('recording');
    runTo(core, 4000, dc(0.5));
    expect(trk(core).state).toBe('stopped');
    expect(trk(core).lengthFrames).toBe(2000);
  });

  it('a repeat REC/DUB/PLAY while waiting is a no-op', () => {
    const core = armed();
    at(core, 3000, recPlay(), dc(0.5));
    at(core, 3500, recPlay(), dc(0.5));
    expect(trk(core).pending).toBe('play');
    runTo(core, 4000, dc(0.5));
    expect(trk(core).state).toBe('playing'); // not overdubbing
    expect(trk(core).lengthFrames).toBe(2000);
  });

  it('interrupt ends it at once on the last whole measure (INFERRED: the host lost audio, so it cannot wait)', () => {
    const core = armed();
    at(core, 5000, recPlay(), dc(0.5)); // 3000 frames in: snaps to 4000, waiting for 6000
    at(core, 5500, { t: 'interrupt' }, dc(0.5));
    expect(trk(core).state).toBe('playing');
    expect(trk(core).lengthFrames).toBe(2000); // 3500 recorded: floor to 1 measure
    expect(trk(core).pending).toBeNull();
  });
});

describe('a grid recording that runs out of memory', () => {
  it('ends on the last whole measure that fit and plays in step (INFERRED)', () => {
    const core = makeCore({ track: [{ loopSyncSw: true }] }, { memoryBudgetBytes: 3 * CHUNK_BYTES });
    rhythmOn(core);
    at(core, 0, recPlay(), ramp);
    runTo(core, 3500, ramp); // the budget holds 3000 frames
    expect(core.takeMessages()).toEqual(['MEMORY FULL']);
    const s = trk(core);
    expect(s.state).toBe('playing');
    expect(s.lengthFrames).toBe(2000);
    expect(s.measures).toBe(1);
    expect(s.position).toBeCloseTo(1500 / 2000, 9); // it has played since 3000, from position 1000
    expect(core.status().memoryBytes).toBe(2 * CHUNK_BYTES); // the trimmed chunk went back to the pool
  });
});

describe('block size', () => {
  it('arms, snapped ends and trims land on the same frames whatever the block size', () => {
    const scenario = (block: number) => {
      const core = makeCore({ track: [{ loopSyncSw: true }, { loopSyncSw: true }] });
      core.command({ t: 'rhythmStartStop' }, 0);
      core.command(recPlay(0), 500); // arms for 2000
      core.command(recPlay(0), 5900); // early: waits for 6000
      core.command(recPlay(1), 2500); // arms for 4000
      core.command(recPlay(1), 6100); // late: 2100 frames snaps down to 2000, trimmed at the press
      const out = run(core, 9000, ramp, block);
      return { out: out.sum, a: core.getTrackAudio(0)!.L, b: core.getTrackAudio(1)!.L };
    };
    const ref = scenario(128);
    expect(ref.a).toHaveLength(4000);
    expect(ref.b).toHaveLength(2000);
    for (const block of [1, 37, 300]) {
      const got = scenario(block);
      expect(got.a).toEqual(ref.a);
      expect(got.b).toEqual(ref.b);
      expect(got.out).toEqual(ref.out);
    }
  });
});
