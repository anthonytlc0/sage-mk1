import { describe, expect, it } from 'vitest';
import { at, clear, dc, makeCore, ramp, recPlay, run, stop, trk, XF } from './harness';

describe('rapid and out-of-order presses', () => {
  it('two recPlay commands in one block apply in order, each at its own frame', () => {
    const core = makeCore();
    // Queued out of order; both land inside the first 128-frame block.
    core.command(recPlay(), 60);
    core.command(recPlay(), 10);
    run(core, 128, dc(0.5));
    const s = trk(core);
    expect(s.state).toBe('playing');
    expect(s.lengthFrames).toBe(50);
  });

  it('commands at the same frame apply in the order they were sent', () => {
    const core = makeCore();
    at(core, 0, recPlay(), dc(0.5));
    core.command(recPlay(), 1000); // ends the recording -> playing
    core.command(stop(), 1000); // then stops it
    run(core, 1200, dc(0.5));
    expect(trk(core).state).toBe('stopped');
    expect(trk(core).lengthFrames).toBe(1000);
  });

  it('a command inside a block applies at its exact sample offset', () => {
    const core = makeCore();
    run(core, 200);
    core.command(recPlay(), 250); // inside the block 200..327
    run(core, 128, dc(0.5));
    expect(trk(core).lengthFrames).toBe(78);
  });

  it('a command dated in the past applies at the start of the next block', () => {
    const core = makeCore();
    run(core, 500);
    core.command(recPlay(), 200);
    run(core, 100, dc(0.5));
    expect(trk(core).lengthFrames).toBe(100);
  });

  it('a command with no frame applies at the current frame', () => {
    const core = makeCore();
    run(core, 300);
    core.command(recPlay());
    core.command(recPlay(), null);
    run(core, 50, dc(0.5));
    expect(trk(core).state).toBe('empty'); // started and ended at the same frame: discarded
  });

  it('more than a full queue of commands are all applied, in order', () => {
    const core = makeCore();
    // 65 presses 100 frames apart: rec, play, then 63 alternating dub/play presses, ending in overdub.
    for (let k = 0; k < 65; k++) core.command(recPlay(), 100 + 100 * k);
    run(core, 7000, dc(0.5));
    expect(trk(core).state).toBe('overdubbing');
  });

  it('recPlay during a FADE stop is ignored and the fade continues', () => {
    const core = makeCore({ tempo: 120, track: [{ stopMode: 'FADE' }], play: { fadeOut: { measures: 1 } } });
    at(core, 0, recPlay(), dc(0.5));
    at(core, 1000, recPlay(), dc(0.5));
    at(core, 1500, stop(), dc(0.5));
    at(core, 2000, recPlay());
    expect(trk(core).state).toBe('playing');
    expect(trk(core).stopping).toBe(true);
    const out = run(core, 1600).tracks[0]; // frames 2000..3599
    expect(out[500]).toBeCloseTo(0.5 * (1 - 1000 / 2000), 6); // still on the fade line
    expect(out[1500]).toBe(0);
    expect(trk(core).state).toBe('stopped');
  });

  it('recPlay during a LOOP stop is ignored', () => {
    const core = makeCore({ track: [{ stopMode: 'LOOP' }] });
    at(core, 0, recPlay(), dc(0.5));
    at(core, 1000, recPlay(), dc(0.5));
    at(core, 1200, stop(), dc(0.5));
    at(core, 1400, recPlay(), dc(0.5));
    expect(trk(core).state).toBe('playing');
    expect(trk(core).stopping).toBe(true);
    run(core, 700);
    expect(trk(core).state).toBe('stopped');
  });

  it('stop on an empty track is a no-op', () => {
    const core = makeCore();
    at(core, 100, stop());
    run(core, 100);
    const s = trk(core);
    expect(s.state).toBe('empty');
    expect(s.stopping).toBe(false);
    expect(core.takeMessages()).toEqual([]);
  });

  it('a recording of 2 x XFADE frames or fewer is discarded and the track returns to empty', () => {
    const core = makeCore();
    at(core, 100, recPlay(), dc(0.5));
    at(core, 100 + 2 * XF, recPlay(), dc(0.5));
    run(core, 50, dc(0.5));
    expect(trk(core).state).toBe('empty');
    expect(trk(core).lengthFrames).toBe(0);
    expect(core.status().memoryBytes).toBe(0);
    // One frame longer is kept.
    at(core, 500, recPlay(), dc(0.5));
    at(core, 500 + 2 * XF + 1, recPlay(), dc(0.5));
    run(core, 50, dc(0.5));
    expect(trk(core).state).toBe('playing');
    expect(trk(core).lengthFrames).toBe(2 * XF + 1);
  });

  it('STOP while recording ends the recording, keeps it, and leaves the track stopped', () => {
    const core = makeCore();
    at(core, 0, recPlay(), ramp);
    at(core, 800, stop(), ramp);
    run(core, 100, ramp);
    expect(trk(core).state).toBe('stopped');
    expect(trk(core).lengthFrames).toBe(800);
    at(core, 1000, recPlay());
    expect(run(core, 300).tracks[0][200]).toBe(200);
  });

  it('STOP while overdubbing ends the pass, then stops per STOP MODE', () => {
    const core = makeCore();
    const input = (f: number): number => (f < 1000 ? 0.5 : 0.25);
    at(core, 0, recPlay(), input);
    at(core, 1000, recPlay(), input);
    at(core, 2000, recPlay(), input); // overdub
    at(core, 2500, stop(), input);
    expect(trk(core).state).toBe('stopped');
    at(core, 3000, recPlay(), input);
    const out = run(core, 1000).tracks[0];
    expect(out[200]).toBe(0.75); // overdubbed half
    expect(out[700]).toBe(0.5); // untouched half
  });

  it('clear while recording discards the take', () => {
    const core = makeCore();
    at(core, 0, recPlay(), dc(0.5));
    at(core, 1500, clear(), dc(0.5));
    run(core, 100, dc(0.5));
    expect(trk(core).state).toBe('empty');
    expect(core.status().memoryBytes).toBe(0);
    at(core, 2000, recPlay(), dc(0.25)); // records afresh
    at(core, 3000, recPlay(), dc(0.25));
    expect(run(core, 1000).tracks[0][500]).toBe(0.25);
  });

  it('clearAll empties every track', () => {
    const core = makeCore();
    at(core, 0, recPlay(0), dc(0.5));
    core.command(recPlay(1), 0);
    at(core, 1000, recPlay(0), dc(0.5));
    core.command(recPlay(1), 1000);
    at(core, 1500, { t: 'clearAll' });
    run(core, 1);
    expect(core.status().tracks.map((s) => s.state)).toEqual(['empty', 'empty', 'empty', 'empty', 'empty']);
  });

  it('interrupt ends recording and overdubbing passes in playback, keeping the audio', () => {
    const core = makeCore({ rec: { recAction: 'REC->DUB' } });
    const input = (f: number): number => (f < 1000 ? 0.5 : 0.25);
    at(core, 0, recPlay(0), input);
    at(core, 1000, recPlay(0), input); // track 1 overdubbing
    core.command(recPlay(1), 1000); // track 2 recording
    at(core, 1600, { t: 'interrupt' }, input);
    run(core, 1, input);
    expect(trk(core, 0).state).toBe('playing');
    expect(trk(core, 1).state).toBe('playing');
    expect(trk(core, 1).lengthFrames).toBe(600);
    const out = run(core, 1000);
    // Track 1: frames 1601..2600 are positions 601..999, 0..600. Overdubbed at positions 0..599 only.
    expect(out.tracks[0][100]).toBe(0.5); // position 701
    expect(out.tracks[0][600]).toBe(0.75); // position 201
    // Track 2: frames 1601.. are positions 1..600, then from 0.
    expect(out.tracks[1][300]).toBe(0.25);
  });

  it('interrupt leaves playing, stopped and empty tracks alone', () => {
    const core = makeCore();
    at(core, 0, recPlay(0), dc(0.5));
    at(core, 1000, recPlay(0), dc(0.5));
    at(core, 1200, { t: 'interrupt' });
    run(core, 1);
    expect(trk(core, 0).state).toBe('playing');
    expect(trk(core, 1).state).toBe('empty');
  });

  it('engine-only commands are ignored without error', () => {
    const core = makeCore();
    core.command({ t: 'exportTracks', reqId: 1 });
    core.command({ t: 'recorder', on: true });
    core.command({ t: 'calibrate', reqId: 2 });
    core.command({ t: 'latency', roundTripFrames: 30, outputLatencyFrames: 10 });
    core.command({ t: 'rhythmStartStop' });
    core.command({ t: 'fader', track: 0, gain: 0.5 });
    core.command({ t: 'undoRedo', track: 0 });
    core.command({ t: 'allStartStop' });
    expect(() => run(core, 300)).not.toThrow();
    expect(trk(core).state).toBe('empty');
  });

  it('the tempo command sets the tempo', () => {
    const core = makeCore();
    core.command({ t: 'tempo', bpm: 90 });
    run(core, 1);
    expect(core.status().tempo).toBe(90);
  });
});
