/**
 * Loop sync, MEASURE and QUANTIZE (spec "Transport"; Parameter Guide pp. 3-4).
 *
 * sr 1000, tempo 120, 4/4: a measure is 2000 frames and a beat 500. The harness switches LOOP SYNC off on every track,
 * so each test switches it back on for the tracks it syncs.
 *
 * An armed action fires as the frame it waits for is rendered, so at that frame's own status it still shows as
 * pending. The tests therefore check one frame either side of each line.
 */
import { describe, expect, it } from 'vitest';
import { at, dc, makeCore, ramp, recPlay, run, SR, stop, trk, XF } from './harness';
import type { LooperCore } from '../../src/core/looper';

const rhythmOn = (core: LooperCore): void => core.command({ t: 'rhythmStartStop' });

/** Run until the core is at `frame`, feeding `input`. */
function runTo(core: LooperCore, frame: number, input?: (f: number) => number) {
  return run(core, frame - core.frame, input);
}

describe('QUANTIZE MEASURE with the rhythm on', () => {
  it('a press arms until the next measure; the end press snaps to whole measures and recording runs to the line', () => {
    const core = makeCore({ tempo: 120, track: [{ loopSyncSw: true }] });
    rhythmOn(core); // frame 0: the grid starts here
    expect(core.status().rhythm).toBe('on');

    at(core, 500, recPlay(), ramp);
    expect(trk(core).pending).toBe('rec');
    expect(trk(core).state).toBe('empty');
    runTo(core, 1999, ramp);
    expect(trk(core).pending).toBe('rec');
    expect(trk(core).state).toBe('empty');
    runTo(core, 2001, ramp); // frame 2000 is the first one recorded
    expect(trk(core).state).toBe('recording');
    expect(trk(core).pending).toBeNull();
    expect(trk(core).lengthFrames).toBe(1);

    at(core, 5900, recPlay(), ramp); // 3900 frames in: early, so it snaps up to 2 measures
    expect(trk(core).state).toBe('recording');
    expect(trk(core).pending).toBe('play');
    expect(trk(core).lengthFrames).toBe(3900);
    runTo(core, 5999, ramp);
    expect(trk(core).state).toBe('recording');
    expect(trk(core).lengthFrames).toBe(3999);
    runTo(core, 6000, ramp);
    const s = trk(core);
    expect(s.state).toBe('playing');
    expect(s.pending).toBeNull();
    expect(s.lengthFrames).toBe(4000);
    expect(s.measures).toBe(2);
    expect(core.status().tempo).toBe(120);

    expect(run(core, 200, ramp).tracks[0][100]).toBe(2100); // frame 6100 plays position 100
    // The loop holds frames 2000..5999; its first 5 ms became the seam crossfade (frame 6000's input at position 0)
    // as frames 6000..6004 were rendered.
    const a = core.getTrackAudio(0)!;
    expect(a.L[0]).toBe(6000);
    expect(a.L[100]).toBe(2100);
    expect(a.L[3999]).toBe(5999);
    expect(a.measures).toBe(2);
  });

  it('REC->DUB: an early end press waits as pending dub, then overdubs from the line', () => {
    const core = makeCore({ rec: { recAction: 'REC->DUB' }, track: [{ loopSyncSw: true }] });
    rhythmOn(core);
    at(core, 500, recPlay(), dc(0.5));
    at(core, 3000, recPlay(), dc(0.5)); // 1000 frames in: snaps to 1 measure, ending at 4000
    expect(trk(core).pending).toBe('dub');
    runTo(core, 4000, dc(0.5));
    expect(trk(core).state).toBe('overdubbing');
    expect(trk(core).lengthFrames).toBe(2000);
  });

  it('QUANTIZE OFF with a reference: recording begins at the press, and the end still snaps to whole measures', () => {
    const core = makeCore({ rec: { quantize: 'OFF' }, track: [{ loopSyncSw: true }] });
    rhythmOn(core);
    at(core, 500, recPlay(), dc(0.5));
    expect(trk(core).pending).toBeNull();
    expect(trk(core).state).toBe('recording');
    at(core, 4300, recPlay(), dc(0.5)); // 3800 frames: snaps to 4000, so recording runs on to 4500
    expect(trk(core).pending).toBe('play');
    runTo(core, 4500, dc(0.5));
    expect(trk(core).state).toBe('playing');
    expect(trk(core).lengthFrames).toBe(4000);
  });

  it('LOOP SYNC MODE MEASURE starts the recording at a measure even with QUANTIZE OFF (INFERRED from the guide)', () => {
    const core = makeCore({ rec: { quantize: 'OFF' }, track: [{ loopSyncSw: true, loopSyncMode: 'MEASURE' }] });
    rhythmOn(core);
    at(core, 500, recPlay(), dc(0.5));
    expect(trk(core).pending).toBe('rec');
    runTo(core, 2001, dc(0.5));
    expect(trk(core).state).toBe('recording');
    expect(trk(core).lengthFrames).toBe(1);
  });

  it('a late end press trims the overshoot with a 5 ms crossfade: the loop is as if pressed on the line', () => {
    // Press exactly on the line (4000), 2 frames late (inside the crossfade) and 100 frames late.
    const take = (press: number) => {
      const core = makeCore({ track: [{ loopSyncSw: true }] });
      rhythmOn(core);
      at(core, 0, recPlay(), ramp); // the press is on the line: recording starts at once
      expect(trk(core).pending).toBeNull();
      at(core, press, recPlay(), ramp);
      const s = trk(core);
      expect(s.state).toBe('playing');
      expect(s.pending).toBeNull();
      expect(s.lengthFrames).toBe(4000);
      expect(s.position).toBeCloseTo((press - 4000) / 4000, 9); // already in step with the grid
      const out = runTo(core, 4300, ramp).tracks[0];
      return { audio: core.getTrackAudio(0)!.L, out, press };
    };
    const exact = take(4000);
    for (const late of [take(4002), take(4100)]) {
      expect(late.audio).toEqual(exact.audio);
      // After its 5 ms ramp-in, the late loop plays exactly what the on-time one plays.
      for (let f = late.press + XF; f < 4300; f++) expect(late.out[f - late.press]).toBe(exact.out[f - 4000]);
    }
    expect(exact.audio[0]).toBe(4000); // the seam: the input just after the end, crossfading into frame 0's audio
    expect(exact.audio[1]).toBeCloseTo(0.8 * 4001 + 0.2 * 1, 2);
    expect(exact.audio[XF]).toBe(XF);
  });
});

describe('a late end press with REC->DUB', () => {
  /** The take after recording 0 -> 4000 (rhythm on), ending at `press`, and overdubbing until 5000. */
  const takeAfter = (dubMode: 'OVERDUB' | 'REPLACE1' | 'REPLACE2', press: number): Float32Array => {
    const core = makeCore({ rec: { recAction: 'REC->DUB' }, track: [{ loopSyncSw: true, dubMode }] });
    rhythmOn(core);
    at(core, 0, recPlay(), ramp);
    at(core, press, recPlay(), ramp); // ends the recording (4000 frames) and starts the pass
    expect(trk(core).state).toBe('overdubbing');
    expect(trk(core).lengthFrames).toBe(4000);
    at(core, 5000, recPlay(), ramp); // ends the pass at position 1000 in both
    run(core, 10, ramp);
    return core.getTrackAudio(0)!.L;
  };

  it.each([
    ['OVERDUB', 2], // inside the 5 ms seam crossfade
    ['REPLACE1', 2],
    ['REPLACE2', 2],
    ['OVERDUB', 100], // past it: the performer's input from the line to the press must still be dubbed in
    ['REPLACE1', 100],
    ['REPLACE2', 100],
  ] as const)('%s, %i frames late: the loop is sample-for-sample the on-time one', (dubMode, late) => {
    expect(takeAfter(dubMode, 4000 + late)).toEqual(takeAfter(dubMode, 4000));
  });

  it('the overshoot is dubbed in by the pass rules: OVERDUB adds it, REPLACE writes it', () => {
    // Position 50: recorded at frame 50, and the input at the line + 50 is 4050.
    expect(takeAfter('OVERDUB', 4100)[50]).toBe(50 + 4050);
    expect(takeAfter('REPLACE1', 4100)[50]).toBe(4050);
  });
});

describe('the first synced recording with no tempo reference', () => {
  it('MEASURE AUTO: the length is set by the second press and sets the tempo; later AUTO tracks share the count', () => {
    const core = makeCore({
      tempo: 90,
      track: [{ loopSyncSw: true, measure: 'AUTO' }, { loopSyncSw: true, measure: 'AUTO' }],
    });
    at(core, 0, recPlay(0), ramp);
    expect(trk(core, 0).pending).toBeNull(); // nothing to wait for
    expect(trk(core, 0).state).toBe('recording');
    at(core, 4000, recPlay(0), ramp);
    const s = core.status();
    expect(s.tempo).toBe(120);
    expect(s.tracks[0].measures).toBe(2);
    expect(s.tracks[0].lengthFrames).toBe(4000);
    expect(s.tracks[0].state).toBe('playing');

    at(core, 4100, recPlay(1), ramp);
    expect(trk(core, 1).pending).toBe('rec');
    runTo(core, 5999, ramp);
    expect(trk(core, 1).state).toBe('empty');
    runTo(core, 6001, ramp);
    expect(trk(core, 1).state).toBe('recording');
    at(core, 7000, recPlay(1), ramp); // 1000 frames in, but AUTO holds it to track 1's 2 measures
    expect(trk(core, 1).pending).toBe('play');
    runTo(core, 9999, ramp);
    expect(trk(core, 1).state).toBe('recording');
    runTo(core, 10000, ramp);
    expect(trk(core, 1).state).toBe('playing');
    expect(trk(core, 1).lengthFrames).toBe(4000);
    expect(trk(core, 1).measures).toBe(2);
  });

  it('a later AUTO track ends by itself at the shared measure count (INFERRED: no end press needed)', () => {
    const core = makeCore({ track: [{ loopSyncSw: true, measure: 'AUTO' }, { loopSyncSw: true, measure: 'AUTO' }] });
    at(core, 0, recPlay(0), dc(0.5));
    at(core, 4000, recPlay(0), dc(0.5));
    at(core, 4100, recPlay(1), dc(0.5));
    runTo(core, 10000, dc(0.5));
    expect(trk(core, 1).state).toBe('playing');
    expect(trk(core, 1).lengthFrames).toBe(4000);
  });

  it('the transport origin is the recording start', () => {
    const core = makeCore({ track: [{ loopSyncSw: true }, { loopSyncSw: true }] });
    at(core, 500, recPlay(0), dc(0.5));
    at(core, 4500, recPlay(0), dc(0.5)); // 4000 frames: tempo 120, measures from 500
    expect(core.status().measurePhase).toBe(0);
    at(core, 4600, recPlay(1), dc(0.5));
    expect(trk(core, 1).pending).toBe('rec');
    runTo(core, 6500, dc(0.5));
    expect(trk(core, 1).state).toBe('empty');
    runTo(core, 6501, dc(0.5));
    expect(trk(core, 1).state).toBe('recording');
  });

  it('a manual MEASURE count sets the tempo from the recorded length', () => {
    const core = makeCore({ tempo: 100, track: [{ loopSyncSw: true, measure: { measures: 4 } }] });
    at(core, 0, recPlay(), dc(0.5));
    at(core, 4000, recPlay(), dc(0.5));
    expect(core.status().tempo).toBe(240); // 4 measures of 4/4 in 4 s
    expect(trk(core).measures).toBe(4);
  });

  it('with a reference, a manual MEASURE count ends the recording by itself (INFERRED from the guide\'s MEASURE text)', () => {
    const core = makeCore({ track: [{ loopSyncSw: true, measure: { measures: 1 } }] });
    rhythmOn(core);
    at(core, 0, recPlay(), dc(0.5));
    runTo(core, 1999, dc(0.5));
    expect(trk(core).state).toBe('recording');
    runTo(core, 2000, dc(0.5));
    expect(trk(core).state).toBe('playing');
    expect(trk(core).lengthFrames).toBe(2000);
    expect(trk(core).measures).toBe(1);
  });
});

describe('LOOP SYNC MODE', () => {
  /** Track 1 synced and recorded 0 -> 4000 (tempo 120, origin 0, playing); track 2 loaded with a ramp of `len`. */
  function withLoaded(len: number): LooperCore {
    const core = makeCore({
      track: [{ loopSyncSw: true, measure: 'AUTO' }, { loopSyncSw: true, loopSyncMode: 'MEASURE' }],
    });
    at(core, 0, recPlay(0), dc(0.5));
    at(core, 4000, recPlay(0), dc(0.5));
    const L = Float32Array.from({ length: len }, (_, i) => i);
    core.setTrackAudio(1, { L, R: L, sampleRate: SR, recordedTempo: 120, measures: len / 2000 });
    return core;
  }

  it('MEASURE: a start waits for the next measure and begins phrase-aligned (position 0 at 6000, length 2000)', () => {
    const core = withLoaded(2000);
    at(core, 4500, recPlay(1));
    expect(trk(core, 1).pending).toBe('play');
    expect(trk(core, 1).state).toBe('stopped');
    const waiting = runTo(core, 6000).tracks[1];
    expect(waiting.every((v) => v === 0)).toBe(true);
    expect(trk(core, 1).pending).toBe('play');
    const out = run(core, 200).tracks[1]; // frames 6000..6199
    expect(out[0]).toBe(0); // the 5 ms ramp-in from silence
    expect(out[100]).toBe(100); // position 0 at frame 6000
    expect(trk(core, 1).state).toBe('playing');
    expect(trk(core, 1).pending).toBeNull();
  });

  it('MEASURE: the phrase position is (frame - origin) mod length (position 2000 at 6000, length 4000)', () => {
    const core = withLoaded(4000);
    at(core, 4500, recPlay(1));
    runTo(core, 6000);
    const out = run(core, 200).tracks[1];
    expect(out[100]).toBe(2100);
  });

  it('LOOP SYNC OFF: the length is exactly the press interval, even with the rhythm on', () => {
    const core = makeCore(); // LOOP SYNC off
    rhythmOn(core);
    at(core, 500, recPlay(), dc(0.5));
    expect(trk(core).pending).toBeNull();
    expect(trk(core).state).toBe('recording');
    at(core, 1700, recPlay(), dc(0.5));
    expect(trk(core).state).toBe('playing');
    expect(trk(core).lengthFrames).toBe(1200);
    expect(trk(core).measures).toBeNull();
  });

  it('LOOP LENGTH with play.loopLength 4: the end press snaps to 4 measures', () => {
    const core = makeCore({ track: [{ loopSyncSw: true, loopSyncMode: 'LOOP LENGTH' }], play: { loopLength: 4 } });
    rhythmOn(core);
    at(core, 500, recPlay(), dc(0.5));
    expect(trk(core).pending).toBe('rec');
    runTo(core, 2001, dc(0.5));
    expect(trk(core).state).toBe('recording');
    at(core, 3000, recPlay(), dc(0.5));
    expect(trk(core).pending).toBe('play');
    runTo(core, 9999, dc(0.5));
    expect(trk(core).state).toBe('recording');
    runTo(core, 10000, dc(0.5));
    expect(trk(core).state).toBe('playing');
    expect(trk(core).lengthFrames).toBe(8000);
    expect(trk(core).measures).toBe(4);
  });

  it('LOOP LENGTH with no end press ends by itself at LOOP LENGTH (INFERRED)', () => {
    const core = makeCore({ track: [{ loopSyncSw: true, loopSyncMode: 'LOOP LENGTH' }], play: { loopLength: 1 } });
    rhythmOn(core);
    at(core, 0, recPlay(), dc(0.5));
    runTo(core, 2000, dc(0.5));
    expect(trk(core).state).toBe('playing');
    expect(trk(core).lengthFrames).toBe(2000);
  });
});

describe('several synced tracks recorded in ascending order (Owner\'s Manual p.10 sync part; ALL START/STOP is Task 8)', () => {
  it('track 2 records on the measure grid of track 1, and the two loops play in step', () => {
    const core = makeCore({ track: [{ loopSyncSw: true }, { loopSyncSw: true }] });
    at(core, 0, recPlay(0), ramp);
    at(core, 4000, recPlay(0), ramp); // tempo 120, 2 measures, origin 0
    expect(core.status().tempo).toBe(120);
    at(core, 4100, recPlay(1), ramp); // arms for 6000
    expect(trk(core, 1).pending).toBe('rec');
    at(core, 9900, recPlay(1), ramp); // 3900 frames in: snaps to 4000, ends at 10000
    expect(trk(core, 1).pending).toBe('play');
    runTo(core, 10000, ramp);
    expect(trk(core, 0).state).toBe('playing');
    expect(trk(core, 1).state).toBe('playing');
    expect(trk(core, 1).lengthFrames).toBe(4000);
    expect(trk(core, 1).measures).toBe(2);

    const out = runTo(core, 12200, ramp); // frames 10000..12199
    // Frame 12100: track 1 is at position 12100 mod 4000 = 100 (frame 100's audio); track 2 started its loop at
    // 10000, so it is at position 2100 (frame 6000 + 2100's audio). Both phrases start on measure lines.
    expect(out.tracks[0][2100]).toBe(100);
    expect(out.tracks[1][2100]).toBe(8100);
  });
});

describe('the grid when nothing is playing', () => {
  it('with the rhythm off and every synced loop stopped, a MEASURE start plays at once and restarts the grid (INFERRED)', () => {
    const core = makeCore({ track: [{ loopSyncSw: true, loopSyncMode: 'MEASURE' }] });
    at(core, 0, recPlay(), ramp);
    at(core, 4000, recPlay(), ramp);
    at(core, 5000, stop());
    at(core, 7300, recPlay());
    expect(trk(core).pending).toBeNull();
    expect(trk(core).state).toBe('playing');
    expect(core.status().measurePhase).toBe(0);
    expect(run(core, 100).tracks[0][50]).toBe(50);
  });

  it('a synced recording with a reference but nothing running starts at once and still snaps to whole measures', () => {
    const core = makeCore({ track: [{ loopSyncSw: true }, { loopSyncSw: true }] });
    at(core, 0, recPlay(0), dc(0.5));
    at(core, 4000, recPlay(0), dc(0.5));
    at(core, 5000, stop(0));
    at(core, 7300, recPlay(1), dc(0.5));
    expect(trk(core, 1).pending).toBeNull();
    expect(trk(core, 1).state).toBe('recording');
    at(core, 9200, recPlay(1), dc(0.5)); // 1900 frames: snaps to 2000, ends at 9300
    expect(trk(core, 1).pending).toBe('play');
    runTo(core, 9300, dc(0.5));
    expect(trk(core, 1).state).toBe('playing');
    expect(trk(core, 1).lengthFrames).toBe(2000);
    expect(trk(core, 1).measures).toBe(1);
  });
});

describe('SYNC ADJUST (LOOP SYNC MODE IMMEDIATE restarts)', () => {
  /** A 4-measure synced loop recorded 0 -> 8000 with the rhythm on, stopped at 9000, restarted at `frame`. */
  function restart(frame: number, syncAdjust: 'MEASURE' | 'BEAT') {
    const core = makeCore({ track: [{ loopSyncSw: true }], play: { syncAdjust } });
    rhythmOn(core);
    at(core, 0, recPlay(), ramp);
    at(core, 8000, recPlay(), ramp);
    at(core, 9000, stop(), ramp);
    at(core, frame, recPlay());
    const s = trk(core);
    expect(s.pending).toBeNull(); // IMMEDIATE never waits
    expect(s.state).toBe('playing');
    return { core, position: s.position * 8000 };
  }

  it.each([
    ['MEASURE', 16300, 300], // 300 frames after a phrase line: snapped back to it
    ['MEASURE', 15000, 7000], // 1000 frames before one: in step with it (INFERRED: starts at once, phrase-aligned)
    ['MEASURE', 12000, 0], // mid-phrase, more than a measure from either line: from the start
    ['BEAT', 16300, 300],
    ['BEAT', 16700, 0], // 700 frames out is more than a beat
  ] as const)('SYNC ADJUST %s, restart at %i -> position %i', (adjust, frame, position) => {
    const { core, position: got } = restart(frame, adjust);
    expect(got).toBeCloseTo(position, 6);
    expect(run(core, 20).tracks[0][10]).toBe(position + 10);
  });

  it('SYNC ADJUST applies only with SPEED CHANGE IMMEDIATE (guide p.4); with LOOP END the restart is from the start', () => {
    const core = makeCore({ track: [{ loopSyncSw: true }], play: { syncAdjust: 'MEASURE', speedChange: 'LOOP END' } });
    rhythmOn(core);
    at(core, 0, recPlay(), ramp);
    at(core, 8000, recPlay(), ramp);
    at(core, 9000, stop(), ramp);
    at(core, 16300, recPlay()); // 300 frames after a phrase line: would snap with SPEED CHANGE IMMEDIATE
    expect(trk(core).state).toBe('playing');
    expect(trk(core).position).toBe(0);
    expect(run(core, 20).tracks[0][10]).toBe(10);
  });
});
