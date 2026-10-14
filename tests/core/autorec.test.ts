import { describe, expect, it } from 'vitest';
import { at, dc, makeCore, recPlay, run, stop, trk } from './harness';

const AUTO = { rec: { autoRecSw: true, autoRecSens: 50, recAction: 'REC->PLAY' as const } };

describe('AUTO REC', () => {
  it('with SENS 50: silence until frame 700, then 0.3 -> the recording starts at frame 700', () => {
    const core = makeCore(AUTO);
    const input = (f: number): number => (f < 700 ? 0 : 0.3);
    at(core, 100, recPlay(), input);
    expect(trk(core).autoRecWaiting).toBe(true);
    expect(trk(core).state).toBe('empty');
    run(core, 599, input); // up to frame 699
    expect(trk(core).autoRecWaiting).toBe(true);
    expect(trk(core).state).toBe('empty');
    run(core, 301, input); // up to frame 1000
    expect(trk(core).autoRecWaiting).toBe(false);
    expect(trk(core).state).toBe('recording');
    expect(Math.abs(trk(core).lengthFrames - 300)).toBeLessThanOrEqual(1);

    at(core, 1500, recPlay(), input);
    const a = core.getTrackAudio(0)!;
    expect(Math.abs(a.L.length - 800)).toBeLessThanOrEqual(1);
    expect(a.L[0]).toBeCloseTo(0.3, 6); // the first sample over the threshold is the loop's first
  });

  it('the threshold is SENS / 100 x 0.5 of full scale (either sign, either channel)', () => {
    for (const [sens, below, above] of [[50, 0.24, 0.26], [10, 0.04, 0.06], [100, 0.49, 0.51]] as const) {
      const quiet = makeCore({ rec: { autoRecSw: true, autoRecSens: sens } });
      at(quiet, 0, recPlay());
      run(quiet, 1000, dc(below));
      expect(trk(quiet).state).toBe('empty');
      expect(trk(quiet).autoRecWaiting).toBe(true);

      const loud = makeCore({ rec: { autoRecSw: true, autoRecSens: sens } });
      at(loud, 0, recPlay());
      run(loud, 500, (f) => (f < 200 ? 0 : -above));
      expect(trk(loud).state).toBe('recording');
      expect(trk(loud).lengthFrames).toBe(300);
    }
  });

  it('STOP cancels the wait; a loud input then records nothing', () => {
    const core = makeCore(AUTO);
    at(core, 0, recPlay());
    at(core, 100, stop());
    expect(trk(core).autoRecWaiting).toBe(false);
    run(core, 500, dc(0.9));
    expect(trk(core).state).toBe('empty');
  });

  it('a second press while waiting changes nothing (one wait at a time, as with an armed recording)', () => {
    const core = makeCore(AUTO);
    at(core, 0, recPlay());
    at(core, 100, recPlay());
    expect(trk(core).autoRecWaiting).toBe(true);
    expect(trk(core).state).toBe('empty');
    run(core, 100, dc(0.5));
    expect(trk(core).state).toBe('recording');
  });

  it('only the first recording waits: on a track with a loop, REC/DUB/PLAY overdubs at once', () => {
    const core = makeCore(AUTO);
    at(core, 0, recPlay());
    run(core, 1000, dc(0.5));
    at(core, 2000, recPlay(), dc(0.5)); // it started on the first frame: a 2000-frame loop, playing (REC->PLAY)
    expect(trk(core).state).toBe('playing');
    at(core, 2500, recPlay());
    expect(trk(core).state).toBe('overdubbing');
    expect(trk(core).autoRecWaiting).toBe(false);
  });

  it('with AUTO REC off the press records at once', () => {
    const core = makeCore({ rec: { autoRecSw: false } });
    at(core, 0, recPlay());
    expect(trk(core).state).toBe('recording');
    expect(trk(core).autoRecWaiting).toBe(false);
  });

  it('listens to the mic, not to the playback BOUNCE IN would add', () => {
    const core = makeCore({ ...AUTO, track: [{}, { bounceIn: true }] });
    at(core, 0, recPlay(0), dc(0.5));
    at(core, 1000, recPlay(0), dc(0.5)); // track 1 starts on the first frame: a 1000-frame loop of 0.5, playing
    run(core, 1000, dc(0.5));
    at(core, 3500, recPlay(1)); // track 2 waits
    run(core, 500); // track 1 plays 0.5, the mic is silent
    expect(trk(core, 1).autoRecWaiting).toBe(true);
    expect(trk(core, 1).state).toBe('empty');
    run(core, 10, dc(0.3));
    expect(trk(core, 1).state).toBe('recording');
  });

  it('an interruption (audio lost) cancels the wait', () => {
    const core = makeCore(AUTO);
    at(core, 0, recPlay());
    core.command({ t: 'interrupt' });
    expect(trk(core).autoRecWaiting).toBe(false);
    run(core, 300, dc(0.9));
    expect(trk(core).state).toBe('empty');
  });

  it('CLEAR and ALL START/STOP end the wait too', () => {
    const cleared = makeCore(AUTO);
    at(cleared, 0, recPlay());
    at(cleared, 10, { t: 'clear', track: 0 });
    expect(trk(cleared).autoRecWaiting).toBe(false);

    const allStopped = makeCore(AUTO);
    at(allStopped, 0, recPlay());
    at(allStopped, 10, { t: 'allStartStop' });
    expect(trk(allStopped).autoRecWaiting).toBe(false);
    run(allStopped, 100, dc(0.9));
    expect(trk(allStopped).state).toBe('empty');
  });

  it('with latency, the sample that triggers it is still the first sample of the loop', () => {
    const core = makeCore(AUTO);
    core.setLatency(30, 10);
    const input = (f: number): number => (f < 700 ? 0 : 0.3 + f / 1e5);
    at(core, 100, recPlay(), input);
    run(core, 900, input);
    expect(trk(core).state).toBe('recording');
    expect(trk(core).lengthFrames).toBe(300);
    at(core, 1500, recPlay(), input);
    run(core, 100, input);
    const a = core.getTrackAudio(0)!;
    expect(a.L[10]).toBeCloseTo(0.3 + 710 / 1e5, 6);
  });
});
