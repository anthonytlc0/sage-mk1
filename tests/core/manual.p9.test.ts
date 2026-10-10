/**
 * Owner's Manual p.9, "Recording on a Single Track": record, play back, overdub, play back (repeat as needed), stop.
 * The default REC ACTION (REC->PLAY) gives exactly that order: Recording -> Playback -> Overdubbing -> Playback.
 * LED colors are the controller's job; here the states behind them are checked: red = recording, green = playing,
 * yellow = overdubbing, dark = stopped (the phrase is kept, so the TRACK button stays lit).
 */
import { describe, expect, it } from 'vitest';
import { at, makeCore, recPlay, run, stop, trk, XF } from './harness';

/** The performance: a 0.5 phrase, then 0.25 and 0.125 overdub layers. */
function performance(f: number): number {
  if (f < 1000) return 0.5;
  if (f < 3000) return 0.25;
  return 0.125;
}

describe('Owner\'s Manual p.9: recording on a single track', () => {
  it('record -> playback -> overdub -> playback -> overdub -> playback -> stop', () => {
    const core = makeCore(); // guide defaults: REC ACTION = REC->PLAY, DUB MODE = OVERDUB
    expect(trk(core).state).toBe('empty');

    // Recording: press REC/DUB/PLAY.
    at(core, 0, recPlay(), performance);
    run(core, 1, performance);
    expect(trk(core).state).toBe('recording');

    // Playback: press again. The recorded phrase plays as a loop.
    at(core, 1000, recPlay(), performance);
    expect(trk(core).state).toBe('playing');
    expect(trk(core).lengthFrames).toBe(1000);
    expect(run(core, 1000, performance).tracks[0][500]).toBe(0.5); // frames 1000..1999

    // Overdubbing: press to layer onto the looping phrase.
    at(core, 2000, recPlay(), performance);
    expect(trk(core).state).toBe('overdubbing');

    // Playback.
    at(core, 3000, recPlay(), performance);
    expect(trk(core).state).toBe('playing');
    expect(run(core, 1000, performance).tracks[0][500]).toBe(0.75); // frames 3000..3999

    // Repeat as many times as necessary.
    at(core, 4000, recPlay(), performance);
    expect(trk(core).state).toBe('overdubbing');
    at(core, 5000, recPlay(), performance);
    expect(trk(core).state).toBe('playing');
    expect(run(core, 1000, performance).tracks[0][500]).toBe(0.875);

    // Stopping: press STOP. The button goes dark; the phrase is kept.
    at(core, 6500, stop(), performance);
    const s = trk(core);
    expect(s.state).toBe('stopped');
    expect(s.lengthFrames).toBe(1000);
    expect(run(core, 1000).tracks[0].subarray(XF).every((v) => v === 0)).toBe(true); // a 5 ms ramp, then silence
    expect(trk(core).lengthFrames).toBe(1000);
  });
});
