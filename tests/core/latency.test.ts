import { describe, expect, it } from 'vitest';
import type { LooperCore } from '../../src/core/looper';
import { at, dc, makeCore, ramp, recPlay, run, trk, XF } from './harness';
import { exportTracks, freeSettings, makeProcessor, maxAbs, run as runProcessor, send } from '../engine/helpers';

const PLAY = { rec: { recAction: 'REC->PLAY' as const } };

/** A core at sr 1000 with a round trip of 30 frames and an output latency of 10. */
function lagged(over = {}): LooperCore {
  const core = makeCore({ ...PLAY, ...over });
  core.setLatency(30, 10);
  return core;
}

describe('the latency pipeline (writes lag the heard timeline by the round trip)', () => {
  it('setLatency(30, 10); ramp input; record at 100, end at 1100 -> sample 0 is 130 and the length 1000', () => {
    const core = lagged();
    at(core, 100, recPlay(), ramp);
    at(core, 1100, recPlay(), ramp);
    expect(trk(core).state).toBe('recording'); // the end press's last 30 frames of input are still on their way
    run(core, 30, ramp); // frame 1130: they have arrived and the loop closes
    expect(trk(core).state).toBe('playing');
    const a = core.getTrackAudio(0)!;
    expect(a.L.length).toBe(1000);
    expect(a.L[0]).toBe(130);
    expect(a.L[999]).toBe(1129);

    // Then the seam crossfade bakes the 5 ms after the loop end into its start, as without latency; the rest stays.
    run(core, 100, ramp);
    const b = core.getTrackAudio(0)!.L;
    expect(b[0]).toBe(1130);
    for (let k = XF; k < 1000; k += 97) expect(b[k]).toBe(130 + k);
  });

  it('the loop plays in step with the heard timeline once it closes: heard frame 1100 + k plays position k', () => {
    const core = lagged();
    at(core, 100, recPlay(), ramp);
    at(core, 1100, recPlay(), ramp);
    const out = run(core, 900, ramp).tracks[0]; // frames 1100..1999
    for (let f = 1140; f < 2000; f += 53) expect(out[f - 1100]).toBe(130 + (f - 1100));
  });

  it('a command with no date counts as heard at frame - outputLatencyFrames', () => {
    const core = lagged();
    run(core, 100, ramp);
    core.command(recPlay()); // heard at 90: its input arrives from frame 120
    run(core, 1000, ramp);
    core.command(recPlay()); // heard at 1090
    run(core, 50, ramp);
    const a = core.getTrackAudio(0)!;
    expect(a.L.length).toBe(1000);
    expect(a.L[XF]).toBe(120 + XF);
  });

  it('an overdub lands where it was heard: playing along with the loop doubles it in place', () => {
    const core = lagged();
    const pos = (f: number): number => (((f - 1000) % 1000) + 1000) % 1000; // the loop position heard at frame f
    // The input that arrives at frame f was played at f - 30: the recording is a ramp (take frame k = k / 1000), the
    // overdub repeats the loop the player heard.
    const x = (f: number): number => (f < 2000 ? (f - 30) / 1000 : pos(f - 30) / 1000);
    at(core, 0, recPlay(), x);
    at(core, 1000, recPlay(), x); // closes at 1030; heard frame f plays position pos(f)
    at(core, 2000, recPlay(), x); // overdub from position 0, as heard
    at(core, 3000, recPlay(), x); // one whole pass
    run(core, 100, x);
    const loop = core.getTrackAudio(0)!.L;
    for (let k = 10; k < 1000; k += 7) expect(loop[k]).toBeCloseTo((2 * k) / 1000, 6);
  });

  it('with steady input, latency changes nothing: the same heard presses give the same loop, short passes included', () => {
    const build = (rt: number): Float32Array => {
      const core = makeCore(PLAY);
      core.setLatency(rt, 0);
      const x = (f: number): number => (f < 1500 ? 0.25 : 0.1);
      at(core, 0, recPlay(), x);
      at(core, 1000, recPlay(), x);
      at(core, 2000, recPlay(), x); // a pass of 300 frames
      at(core, 2300, recPlay(), x);
      at(core, 2600, recPlay(), x); // a pass of 12 frames: shorter than the round trip
      at(core, 2612, recPlay(), x);
      at(core, 2700, recPlay(), x); // and one of 3, shorter than the punch-in ramp
      at(core, 2703, recPlay(), x);
      run(core, 200, x);
      return core.getTrackAudio(0)!.L;
    };
    const plain = build(0);
    const late = build(30);
    expect(late.length).toBe(plain.length);
    for (let k = 0; k < plain.length; k++) expect(late[k]).toBeCloseTo(plain[k], 6);
  });

  it('a round trip outside 0..1 s is clamped: negative or NaN is 0, too long is one second', () => {
    const none = makeCore(PLAY);
    none.setLatency(-5, Number.NaN);
    at(none, 100, recPlay(), ramp);
    at(none, 1100, recPlay(), ramp);
    expect(none.getTrackAudio(0)!.L[XF]).toBe(100 + XF);

    const long = makeCore(PLAY);
    long.setLatency(1e9, 0);
    at(long, 100, recPlay(), ramp);
    at(long, 1100, recPlay(), ramp);
    run(long, 1000, ramp);
    expect(trk(long).lengthFrames).toBe(1000);
    expect(long.getTrackAudio(0)!.L[XF]).toBe(1100 + XF);
  });
});

describe('an interruption leaves no delayed write waiting for input from after it (Task 5 note)', () => {
  /** Input: `level` until `cut`, then 5 frames of silence (the engine's post-interrupt gate), then 0.9. */
  const gated = (level: number, cut: number) => (f: number): number => (f < cut ? level : f < cut + XF ? 0 : 0.9);

  it('a punch-out still writing its last round trip of input: only the 5 ms fade stays (on the gated silence)', () => {
    const core = lagged();
    const x = gated(0.25, 2510);
    at(core, 0, recPlay(), x);
    at(core, 1000, recPlay(), x); // a loop of 0.25, position pos(f) = (f - 1000) mod 1000
    at(core, 2000, recPlay(), x);
    at(core, 2500, recPlay(), x); // writes until frame 2530, then a 5-frame fade
    at(core, 2510, { t: 'interrupt' }, x);
    run(core, 500, x);
    const loop = core.getTrackAudio(0)!.L;
    expect(maxAbs(loop)).toBeLessThanOrEqual(0.5 + 1e-6); // no 0.9 anywhere
    expect(loop[470]).toBeCloseTo(0.5, 6); // written before the interruption (heard 2470)
    expect(loop[490]).toBeCloseTo(0.25, 6); // heard before the punch-out, but its input never came
  });

  it('a punch-in whose writes had not begun writes nothing', () => {
    const core = lagged();
    const x = gated(0.25, 2010);
    at(core, 0, recPlay(), x);
    at(core, 1000, recPlay(), x);
    at(core, 2000, recPlay(), x);
    at(core, 2010, { t: 'interrupt' }, x);
    expect(trk(core).state).toBe('playing');
    run(core, 500, x);
    const loop = core.getTrackAudio(0)!.L;
    for (let k = 0; k < 1000; k++) expect(loop[k]).toBeCloseTo(0.25, 6);
  });

  it('a recording waiting for its last round trip of input ends with what it has', () => {
    const core = lagged();
    const x = gated(0.25, 1010);
    at(core, 0, recPlay(), x);
    at(core, 1000, recPlay(), x); // closes at 1030 unless interrupted
    at(core, 1010, { t: 'interrupt' }, x);
    expect(trk(core).state).toBe('playing');
    expect(trk(core).lengthFrames).toBe(980);
    run(core, 500, x);
    expect(maxAbs(core.getTrackAudio(0)!.L)).toBeLessThanOrEqual(0.25 + 1e-6);
  });

  it('a recording whose input had not begun is dropped', () => {
    const core = lagged();
    at(core, 100, recPlay(), dc(0.25));
    at(core, 120, { t: 'interrupt' }, dc(0.25));
    expect(trk(core).state).toBe('empty');
    run(core, 200, dc(0.9));
    expect(trk(core).state).toBe('empty');
  });
});

describe('the engine hands the round trip to the core (Task 21 calibration -> latency command)', () => {
  it('a latency command shifts what a dated recording holds by the round trip', () => {
    const { p, port } = makeProcessor();
    send(port, freeSettings((m) => {
      m.rec.recAction = 'REC->PLAY';
    }));
    send(port, { t: 'latency', roundTripFrames: 1440, outputLatencyFrames: 480 });
    send(port, { t: 'recPlay', track: 0 }, 4800); // heard at context frame 4800
    send(port, { t: 'recPlay', track: 0 }, 9600);
    // The mic steps up 1000 frames after the input for heard frame 4800 arrives (at 4800 + 1440).
    runProcessor(p, 12000, (f) => (f < 7240 ? 0 : 0.5), 128, 0);
    const a = exportTracks(p, port)[0]!;
    expect(a.L.length).toBe(4800);
    // (Frames 0-239 hold the 5 ms seam crossfade of the input after the loop end. The mic's noise suppressor opens
    // over a few ms, so the step shows as its first sample.)
    expect(maxAbs(a.L, 240, 1000)).toBe(0);
    expect(a.L[1000]).toBeGreaterThan(0);
    expect(a.L[2000]).toBeCloseTo(0.5, 5);
  });

  it('with the post-interrupt gate, an interruption mid round trip puts no later input in the loop', () => {
    const { p, port } = makeProcessor();
    send(port, freeSettings((m) => {
      m.rec.recAction = 'REC->PLAY';
    }));
    send(port, { t: 'latency', roundTripFrames: 1440, outputLatencyFrames: 480 });
    send(port, { t: 'recPlay', track: 0 });
    runProcessor(p, 48000, 0.25);
    send(port, { t: 'recPlay', track: 0 }); // the loop closes 960 frames on
    runProcessor(p, 48000, 0.25);
    send(port, { t: 'recPlay', track: 0 }); // overdub
    runProcessor(p, 24000, 0.25);
    send(port, { t: 'recPlay', track: 0 }); // punch out: 960 frames of input still to come, then the 5 ms fade
    runProcessor(p, 480, 0.25);
    send(port, { t: 'interrupt' });
    runProcessor(p, 4800, 0.9); // what comes in after the interruption
    const loop = exportTracks(p, port)[0]!.L;
    expect(loop.length).toBe(48000);
    expect(maxAbs(loop)).toBeLessThanOrEqual(0.5 + 1e-5);
    expect(maxAbs(loop)).toBeGreaterThan(0.5 - 1e-5); // the overdub is there
  });
});
