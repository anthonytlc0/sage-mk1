/**
 * PLAY MODE SINGLE with S.TRK CHANGE, and ALL START/STOP (Parameter Guide p. 2 PLAY MODE, p. 4 S.TRK CHANGE and ALL
 * START TRK; Owner's Manual p. 4 [ALL START/STOP]).
 *
 * sr 1000, tempo 120, 4/4: a measure is 2000 frames. The harness switches LOOP SYNC off (free loops). An armed start
 * fires as its frame is rendered, so the tests look one frame either side of it.
 */
import { describe, expect, it } from 'vitest';
import { at, configure, dc, makeCore, recPlay, run, stop, trk, XF } from './harness';
import type { LooperCore } from '../../src/core/looper';
import type { EngineCommand } from '../../src/shared/protocol';

const allStartStop: EngineCommand = { t: 'allStartStop' };
const rhythmOn = (core: LooperCore): void => core.command({ t: 'rhythmStartStop' });
const runTo = (core: LooperCore, frame: number, input?: (f: number) => number) => run(core, frame - core.frame, input);

/**
 * Track 1: a 1000-frame loop of 0.5 recorded from frame 0 and playing from 1000 (its seams fall on whole thousands).
 * Track 2: a 600-frame loop of 0.25 recorded from 3000, stopped. Both SINGLE unless `modes` says otherwise.
 */
function twoLoops(play: Record<string, unknown> = {}, modes: ('SINGLE' | 'MULTI')[] = ['SINGLE', 'SINGLE']): LooperCore {
  const core = makeCore({ track: [{ playMode: modes[0] }, { playMode: modes[1] }], play });
  rhythmOn(core); // the grid runs from frame 0 (free loops ignore it)
  const input = (f: number): number => (f < 1005 ? 0.5 : f < 3000 ? 0 : 0.25);
  at(core, 0, recPlay(0), input);
  at(core, 1000, recPlay(0), input);
  at(core, 3000, recPlay(1), input);
  at(core, 3600, stop(1), input);
  run(core, 100, input);
  expect(trk(core, 0).state).toBe('playing');
  expect(trk(core, 1).state).toBe('stopped');
  return core;
}

describe('PLAY MODE SINGLE', () => {
  it('IMMEDIATE: starting track 2 stops track 1 at the same frame', () => {
    const core = twoLoops();
    at(core, 4300, recPlay(1));
    expect(trk(core, 0).state).toBe('stopped');
    expect(trk(core, 1).state).toBe('playing');
    const out = run(core, 100);
    expect(out.tracks[0][0]).toBe(0.5); // the 5 ms ramp-out starts at the press...
    expect(out.tracks[0].subarray(XF).every((v) => v === 0)).toBe(true);
    expect(out.tracks[1][0]).toBe(0); // ...where track 2's ramp-in starts
    expect(out.tracks[1][XF]).toBe(0.25);
  });

  it('LOOP END: track 2 waits for track 1 to reach its seam; track 1 stops there and track 2 starts', () => {
    const core = twoLoops({ sTrkChange: 'LOOP END' });
    at(core, 4300, recPlay(1));
    expect(trk(core, 1).pending).toBe('play');
    expect(trk(core, 1).state).toBe('stopped');
    const before = runTo(core, 4999);
    expect(before.tracks[0].every((v) => v === 0.5)).toBe(true);
    expect(trk(core, 0).state).toBe('playing');
    expect(trk(core, 1).pending).toBe('play');
    const out = runTo(core, 5100); // frames 4999..5099; the seam is at 5000
    expect(trk(core, 0).state).toBe('stopped');
    expect(trk(core, 1).state).toBe('playing');
    expect(trk(core, 1).pending).toBeNull();
    expect(out.tracks[0][0]).toBe(0.5);
    expect(out.tracks[0].subarray(1 + XF).every((v) => v === 0)).toBe(true);
    expect(out.tracks[1][1]).toBe(0); // track 2's first frame (ramp-in) is 5000
    expect(out.tracks[1][1 + XF]).toBe(0.25);
    expect(out.tracks[1][0]).toBe(0);
  });

  it('MEASURE: the change waits for the next measure line', () => {
    const core = twoLoops({ sTrkChange: 'MEASURE' });
    at(core, 4300, recPlay(1));
    expect(trk(core, 1).pending).toBe('play');
    runTo(core, 5999);
    expect(trk(core, 0).state).toBe('playing'); // its seam at 5000 did not change anything
    expect(trk(core, 1).state).toBe('stopped');
    const out = runTo(core, 6100);
    expect(trk(core, 0).state).toBe('stopped');
    expect(trk(core, 1).state).toBe('playing');
    expect(out.tracks[0].subarray(1 + XF).every((v) => v === 0)).toBe(true);
    expect(out.tracks[1][1 + XF]).toBe(0.25);
  });

  it('IMMEDIATE with LOOP SYNC MODE MEASURE: the change comes at the next measure, when track 2 starts', () => {
    const core = twoLoops();
    configure(core, { track: [{}, { loopSyncSw: true, loopSyncMode: 'MEASURE' }] });
    at(core, 4300, recPlay(1));
    expect(trk(core, 1).pending).toBe('play');
    runTo(core, 5999);
    expect(trk(core, 0).state).toBe('playing');
    const out = runTo(core, 6100);
    expect(trk(core, 0).state).toBe('stopped');
    expect(trk(core, 1).state).toBe('playing');
    expect(out.tracks[0].subarray(1 + XF).every((v) => v === 0)).toBe(true);
    expect(out.tracks[1][1 + XF]).toBe(0.25);
  });

  it('STOP on the waiting track cancels the change', () => {
    const core = twoLoops({ sTrkChange: 'LOOP END' });
    at(core, 4300, recPlay(1));
    at(core, 4500, stop(1));
    runTo(core, 5200);
    expect(trk(core, 0).state).toBe('playing');
    expect(trk(core, 1).state).toBe('stopped');
  });

  it('an overdubbing SINGLE track ends its pass and stops when another starts', () => {
    const core = twoLoops();
    at(core, 4000, recPlay(0), dc(0.25));
    at(core, 4300, recPlay(1), dc(0.25));
    expect(trk(core, 0).state).toBe('stopped');
    expect(trk(core, 0).canUndo).toBe(true); // the pass was kept, and can be undone
    run(core, 100);
    const a = core.getTrackAudio(0)!.L;
    expect(a[100]).toBe(0.75);
    expect(a[400]).toBe(0.5);
  });

  it('MULTI tracks are left alone, and starting a MULTI track stops nothing', () => {
    const core = twoLoops({}, ['MULTI', 'SINGLE']);
    at(core, 4300, recPlay(1)); // a SINGLE track starts: track 1 is MULTI and keeps playing
    expect(trk(core, 0).state).toBe('playing');
    expect(trk(core, 1).state).toBe('playing');
    const core2 = twoLoops({}, ['SINGLE', 'MULTI']);
    at(core2, 4300, recPlay(1)); // a MULTI track starts
    expect(trk(core2, 0).state).toBe('playing');
    expect(trk(core2, 1).state).toBe('playing');
  });
});

/** Tracks 1-3 hold 1000-frame loops of 0.5, 0.25 and 0.125, each recorded and then stopped. */
function threeStopped(over: Parameters<typeof makeCore>[0] = {}): LooperCore {
  const core = makeCore(over);
  for (const [i, v] of [[0, 0.5], [1, 0.25], [2, 0.125]] as const) {
    const f = core.frame;
    at(core, f, recPlay(i), dc(v));
    at(core, f + 1000, stop(i), dc(v));
    run(core, 100, dc(v));
  }
  for (const i of [0, 1, 2] as const) expect(trk(core, i).state).toBe('stopped');
  return core;
}

describe('ALL START/STOP', () => {
  it('allStartTrk [T,T,F,T,T] with tracks 1-3 recorded: 1 and 2 start at the same frame, 3 does not; again: all stop', () => {
    const core = threeStopped({ play: { allStartTrk: [true, true, false, true, true] } });
    at(core, 5000, allStartStop);
    const states = () => [0, 1, 2, 3, 4].map((i) => trk(core, i as 0).state);
    expect(states()).toEqual(['playing', 'playing', 'stopped', 'empty', 'empty']);
    const out = run(core, 500);
    for (const [i, v] of [[0, 0.5], [1, 0.25]] as const) {
      expect(out.tracks[i][0]).toBe(0); // both ramp in from frame 5000
      expect(out.tracks[i][1]).toBeGreaterThan(0);
      expect(out.tracks[i][XF]).toBe(v);
    }
    expect(out.tracks[2].every((v) => v === 0)).toBe(true);
    expect(trk(core, 0).position).toBe(trk(core, 1).position); // in step

    core.command(allStartStop);
    expect(states()).toEqual(['stopped', 'stopped', 'stopped', 'empty', 'empty']);
    const after = run(core, 100);
    for (const i of [0, 1] as const) expect(after.tracks[i].subarray(XF).every((v) => v === 0)).toBe(true);
  });

  it('stops a recording (keeping it) and an overdub (keeping the pass), each per STOP MODE', () => {
    const core = threeStopped({ track: [{ stopMode: 'FADE' }] });
    core.command(recPlay(0)); // track 1 plays
    run(core, 1000, dc(0));
    core.command(recPlay(0)); // and overdubs
    core.command(recPlay(3)); // track 4 records
    run(core, 400, dc(0.25));
    core.command(allStartStop);
    expect(trk(core, 0).state).toBe('playing'); // STOP MODE FADE: fading out
    expect(trk(core, 0).stopping).toBe(true);
    expect(trk(core, 0).canUndo).toBe(true);
    expect(trk(core, 3).state).toBe('stopped');
    expect(trk(core, 3).lengthFrames).toBe(400);
    run(core, 5000);
    expect(trk(core, 0).state).toBe('stopped');
    expect(core.getTrackAudio(0)!.L[200]).toBe(0.75);
  });

  it('START MODE FADE fades in; STOP MODE LOOP plays to the loop end', () => {
    const core = threeStopped({ track: [{ startMode: 'FADE' }, { stopMode: 'LOOP' }] });
    at(core, 5000, allStartStop);
    const out = run(core, 300);
    expect(out.tracks[0][100]).toBeGreaterThan(0);
    expect(out.tracks[0][100]).toBeLessThan(0.5);
    core.command(allStartStop);
    expect(trk(core, 1).state).toBe('playing'); // until its loop end at 6000
    runTo(core, 6100);
    expect(trk(core, 1).state).toBe('stopped');
  });

  it('with LOOP SYNC MODE MEASURE and the grid running, everything starts together at the next measure', () => {
    const core = threeStopped({ play: { allStartTrk: [true, true, true, false, false] } });
    rhythmOn(core); // the grid restarts at this frame (3300): lines at 5300, 7300, ...
    configure(core, { track: [{ loopSyncSw: true, loopSyncMode: 'MEASURE' }, {}, { loopSyncSw: true, loopSyncMode: 'MEASURE' }] });
    at(core, 4000, allStartStop);
    for (const i of [0, 1, 2] as const) expect(trk(core, i).pending).toBe('play');
    runTo(core, 5299);
    for (const i of [0, 1, 2] as const) expect(trk(core, i).state).toBe('stopped');
    const out = runTo(core, 5400);
    for (const [i, v] of [[0, 0.5], [1, 0.25], [2, 0.125]] as const) {
      expect(trk(core, i).state).toBe('playing');
      expect(out.tracks[i][1]).toBe(0);
      expect(out.tracks[i][1 + XF]).toBe(v);
    }
  });

  it('starts only one SINGLE track: the current track when it is one of them', () => {
    const core = threeStopped({
      track: [{ playMode: 'SINGLE' }, { playMode: 'SINGLE' }, {}],
      play: { currentTrack: 1 },
    });
    at(core, 5000, allStartStop);
    expect([0, 1, 2].map((i) => trk(core, i as 0).state)).toEqual(['stopped', 'playing', 'playing']);
  });

  it('a press while a track plays stops it and cancels the starts still waiting for their line', () => {
    const core = threeStopped();
    rhythmOn(core); // lines at 3300, 5300, ...
    configure(core, { track: [{ loopSyncSw: true, loopSyncMode: 'MEASURE' }] });
    run(core, 100);
    core.command(recPlay(1)); // track 2 plays (free)
    core.command(recPlay(0)); // track 1 waits for the measure
    expect(trk(core, 0).pending).toBe('play');
    core.command(allStartStop);
    expect(trk(core, 0).pending).toBeNull();
    expect(trk(core, 1).state).toBe('stopped');
    run(core, 3000);
    expect(trk(core, 0).state).toBe('stopped');
  });

  it('does nothing on an empty looper', () => {
    const core = makeCore();
    core.command(allStartStop);
    run(core, 100);
    expect(core.status().tracks.every((t) => t.state === 'empty')).toBe(true);
  });
});

describe('ALL START/STOP with starts waiting for their line (fix round 1, ruling R61)', () => {
  it('a second press while the starts wait cancels them, and nothing starts', () => {
    const core = threeStopped({ play: { allStartTrk: [true, true, true, false, false] } });
    rhythmOn(core); // lines at 3300, 5300, ...
    configure(core, { track: [{ loopSyncSw: true, loopSyncMode: 'MEASURE' }, {}, { loopSyncSw: true, loopSyncMode: 'MEASURE' }] });
    at(core, 4000, allStartStop);
    for (const i of [0, 1, 2] as const) expect(trk(core, i).pending).toBe('play');
    at(core, 4500, allStartStop);
    for (const i of [0, 1, 2] as const) expect(trk(core, i).pending).toBeNull();
    runTo(core, 6000);
    for (const i of [0, 1, 2] as const) expect(trk(core, i).state).toBe('stopped');
  });
});
