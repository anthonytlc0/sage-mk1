/**
 * Tempo sync, speed and SPEED CHANGE (Parameter Guide p. 3 TEMPO SYNC, p. 4 SPEED CHANGE; spec "Transport").
 *
 * rate = (TEMPO SYNC SW ? memory tempo / recorded tempo : 1) x {HALF 0.5, NORMAL 1, DOUBLE 2}, clamped to 0.25..4.
 * PITCH resamples (pitch follows the rate); XFADE stretches (pitch stays).
 *
 * The brief's own cases run at sr 48000, where a 1 kHz sine is exactly 48 frames a cycle. The rest run on the harness's
 * sr 1000. The harness turns LOOP SYNC off (free loops: the recorded tempo is the memory tempo when recording ends),
 * but leaves TEMPO SYNC SW at its default, ON.
 */
import { describe, expect, it, vi } from 'vitest';
import { at, configure, dc, makeCore, makeOutput, ramp, recPlay, run, stop, trk, XF } from './harness';
import type { LooperCore } from '../../src/core/looper';
import { AudioTake } from '../../src/core/chunks';

const SR48 = 48000;
const tone = (hz: number, sr = SR48, amp = 1) => (f: number): number => amp * Math.sin((2 * Math.PI * hz * f) / sr);
const tone1k = tone(1000);

const rhythmOn = (core: LooperCore): void => core.command({ t: 'rhythmStartStop' });
const runTo = (core: LooperCore, frame: number, input?: (f: number) => number) => run(core, frame - core.frame, input);

/** Positive-going zero crossings in `x[from, from + n)`. */
function crossings(x: Float32Array, from: number, n: number): number {
  let c = 0;
  for (let i = from + 1; i < from + n; i++) if (x[i - 1] < 0 && x[i] >= 0) c++;
  return c;
}

/** `a - b` on the unit circle, in [-0.5, 0.5). */
function phaseDiff(a: number, b: number): number {
  const d = a - b;
  return d - Math.round(d);
}

/** Run `n` frames of silence without keeping the output (for long runs). */
function runSilent(core: LooperCore, n: number, block = 128): void {
  const inL = new Float32Array(block);
  const inR = new Float32Array(block);
  const out = makeOutput(block);
  for (let done = 0; done < n; done += block) core.process(inL, inR, inL, inR, out, Math.min(block, n - done));
}

/** A core at sr 48000 holding a 2 s free loop of a 1 kHz sine recorded at tempo 120 (frames 0..96000), playing. */
function sineLoop(track: Record<string, unknown> = {}): LooperCore {
  const core = makeCore({ tempo: 120, track: [track] }, { sampleRate: SR48 });
  at(core, 0, recPlay(), tone1k);
  at(core, 96000, recPlay(), tone1k);
  expect(trk(core).state).toBe('playing');
  expect(trk(core).lengthFrames).toBe(96000);
  return core;
}

describe('TEMPO SYNC (the brief, sr 48000)', () => {
  it('PITCH: recorded at 120, memory tempo 60 -> the 1 kHz sine plays at 500 Hz and the loop takes twice as long', () => {
    const core = sineLoop({ tempoSyncSw: true, tempoSyncMode: 'PITCH' });
    configure(core, { tempo: 60 });
    const p0 = trk(core).position;
    const out = run(core, 48000, tone1k).tracks[0];
    const hz = crossings(out, 12000, 24000) / 0.5;
    expect(hz).toBeGreaterThanOrEqual(495);
    expect(hz).toBeLessThanOrEqual(505);
    expect(phaseDiff(trk(core).position, p0 + 0.25)).toBeCloseTo(0, 9); // 1 s plays half a second of the loop
    run(core, 48000);
    expect(phaseDiff(trk(core).position, p0 + 0.5)).toBeCloseTo(0, 9); // a full loop length in: only half way
    run(core, 96000);
    expect(phaseDiff(trk(core).position, p0)).toBeCloseTo(0, 9); // the period is 192000 frames
  });

  it('XFADE: memory tempo 60 -> the sine stays at 1 kHz and the loop takes twice as long', () => {
    const core = sineLoop({ tempoSyncSw: true, tempoSyncMode: 'XFADE' });
    configure(core, { tempo: 60 });
    const p0 = trk(core).position;
    const out = run(core, 48000, tone1k).tracks[0];
    const hz = crossings(out, 12000, 24000) / 0.5;
    expect(hz).toBeGreaterThanOrEqual(980);
    expect(hz).toBeLessThanOrEqual(1020);
    expect(phaseDiff(trk(core).position, p0 + 0.25)).toBeCloseTo(0, 9);
    run(core, 48000);
    expect(phaseDiff(trk(core).position, p0 + 0.5)).toBeCloseTo(0, 9);
    run(core, 96000);
    expect(phaseDiff(trk(core).position, p0)).toBeCloseTo(0, 9);
  });

  it('TEMPO SYNC SW OFF: rate 1 whatever the memory tempo', () => {
    const core = sineLoop({ tempoSyncSw: false, tempoSyncMode: 'PITCH' });
    configure(core, { tempo: 60 });
    const p0 = trk(core).position;
    const out = run(core, 48000, tone1k).tracks[0];
    const hz = crossings(out, 12000, 24000) / 0.5;
    expect(hz).toBeGreaterThanOrEqual(998); // a crossing can fall either side of the window edge
    expect(hz).toBeLessThanOrEqual(1002);
    expect(phaseDiff(trk(core).position, p0 + 0.5)).toBeCloseTo(0, 9);
  });

  it('SPEED DOUBLE: the period halves (and PITCH doubles the pitch)', () => {
    const core = sineLoop({ tempoSyncSw: true, tempoSyncMode: 'PITCH' });
    configure(core, { track: [{ tempoSyncSpeed: 'DOUBLE' }] });
    const p0 = trk(core).position;
    const out = run(core, 24000, tone1k).tracks[0];
    expect(phaseDiff(trk(core).position, p0 + 0.5)).toBeCloseTo(0, 9);
    run(core, 24000);
    expect(phaseDiff(trk(core).position, p0)).toBeCloseTo(0, 9); // the period is 48000 frames
    const hz = crossings(out, 6000, 12000) / 0.25;
    expect(hz).toBeGreaterThanOrEqual(1980);
    expect(hz).toBeLessThanOrEqual(2020);
    expect(trk(core).speed).toBe('DOUBLE');
  });
});

describe('speed', () => {
  /** sr 1000: a 1000-frame free loop recorded at 120, playing from frame 1000 at position 0. */
  function loop(track: Record<string, unknown> = {}, play: Record<string, unknown> = {}): LooperCore {
    const core = makeCore({ track: [{ tempoSyncMode: 'PITCH', ...track }], play });
    at(core, 0, recPlay(), ramp);
    at(core, 1000, recPlay(), ramp);
    return core;
  }

  it('speedMoment HALF holds half speed; null goes back to normal', () => {
    const core = loop();
    core.command({ t: 'speedMoment', track: 0, speed: 'HALF' });
    expect(trk(core).speed).toBe('HALF');
    run(core, 200);
    expect(trk(core).position).toBeCloseTo(0.1, 9);
    core.command({ t: 'speedMoment', track: 0, speed: null });
    expect(trk(core).speed).toBe('NORMAL');
    run(core, 200);
    expect(trk(core).position).toBeCloseTo(0.3, 9);
  });

  it('speedMoment overrides the track speed while held (DOUBLE over HALF)', () => {
    const core = loop({ tempoSyncSpeed: 'HALF' });
    run(core, 100);
    expect(trk(core).position).toBeCloseTo(0.05, 9);
    core.command({ t: 'speedMoment', track: 0, speed: 'DOUBLE' });
    run(core, 100);
    expect(trk(core).position).toBeCloseTo(0.25, 9);
    core.command({ t: 'speedMoment', track: 0, speed: null });
    run(core, 100);
    expect(trk(core).position).toBeCloseTo(0.3, 9);
  });

  it('SPEED CHANGE IMMEDIATE switches at once', () => {
    const core = loop({}, { speedChange: 'IMMEDIATE' });
    runTo(core, 1500);
    configure(core, { track: [{ tempoSyncSpeed: 'DOUBLE' }] });
    runTo(core, 1700);
    expect(trk(core).position).toBeCloseTo(0.9, 9);
  });

  it('SPEED CHANGE LOOP END waits for the seam, then switches', () => {
    const core = loop({}, { speedChange: 'LOOP END' });
    runTo(core, 1500);
    configure(core, { track: [{ tempoSyncSpeed: 'DOUBLE' }] });
    runTo(core, 1999);
    expect(trk(core).speed).toBe('NORMAL'); // still waiting for the loop end
    expect(trk(core).position).toBeCloseTo(0.999, 9);
    runTo(core, 2000);
    expect(trk(core).position).toBe(0);
    runTo(core, 2250);
    expect(trk(core).speed).toBe('DOUBLE');
    expect(trk(core).position).toBeCloseTo(0.5, 9);
  });

  it('SPEED CHANGE LOOP END applies a speedMoment at the seam too', () => {
    const core = loop({}, { speedChange: 'LOOP END' });
    runTo(core, 1500);
    core.command({ t: 'speedMoment', track: 0, speed: 'HALF' });
    runTo(core, 1900);
    expect(trk(core).position).toBeCloseTo(0.9, 9);
    runTo(core, 2400);
    expect(trk(core).position).toBeCloseTo(0.2, 9);
  });

  it('a stopped track takes a new speed at once: it starts at that speed', () => {
    const core = loop({}, { speedChange: 'LOOP END' });
    core.command(stop());
    configure(core, { track: [{ tempoSyncSpeed: 'HALF' }] });
    expect(trk(core).speed).toBe('HALF');
    core.command(recPlay());
    run(core, 400);
    expect(trk(core).position).toBeCloseTo(0.2, 9);
  });

  it('rate 8x raises TEMPO TOO FAST and plays at the clamped 4x', () => {
    const core = makeCore({ tempo: 40, track: [{ tempoSyncMode: 'PITCH', tempoSyncSpeed: 'DOUBLE' }] });
    at(core, 0, recPlay(), ramp);
    at(core, 1000, recPlay(), ramp); // a 1000-frame loop recorded at 40
    core.takeMessages();
    configure(core, { tempo: 160 }); // 160/40 x DOUBLE = 8
    run(core, 100);
    expect(core.takeMessages()).toEqual(['TEMPO TOO FAST']);
    expect(trk(core).position).toBeCloseTo(0.4, 9);
    run(core, 100);
    expect(core.takeMessages()).toEqual([]); // raised once, not on every block
  });

  it('rate below 0.25x raises TEMPO TOO SLOW and plays at the clamped 0.25x', () => {
    const core = makeCore({ tempo: 300, track: [{ tempoSyncMode: 'PITCH', tempoSyncSpeed: 'HALF' }] });
    at(core, 0, recPlay(), ramp);
    at(core, 1000, recPlay(), ramp);
    core.takeMessages();
    configure(core, { tempo: 40 }); // 40/300 x HALF = 0.067
    run(core, 400);
    expect(core.takeMessages()).toEqual(['TEMPO TOO SLOW']);
    expect(trk(core).position).toBeCloseTo(0.1, 9);
  });
});

describe('reading at a fractional rate', () => {
  it('PITCH at half rate reads between samples (a recorded ramp plays back as a ramp of half the slope)', () => {
    const core = makeCore({ track: [{ tempoSyncMode: 'PITCH' }] });
    at(core, 0, recPlay(), ramp);
    at(core, 1000, recPlay(), ramp);
    configure(core, { tempo: 60 });
    const out = run(core, 1900, ramp).tracks[0];
    // Positions below XF + 2 hold (or interpolate) the seam crossfade, so start past them.
    for (let k = 2 * (XF + 2); k < 1900; k += 7) expect(out[k]).toBeCloseTo(0.5 * k, 2);
  });

  it('REVERSE at half rate plays backwards at half speed', () => {
    const core = makeCore({ track: [{ tempoSyncMode: 'PITCH', reverse: true }] });
    at(core, 0, recPlay(), ramp);
    at(core, 1000, recPlay(), ramp); // playing backwards from position 999
    configure(core, { tempo: 60 });
    const out = run(core, 1900, ramp).tracks[0];
    for (let k = XF; k < 1900; k += 7) expect(out[k]).toBeCloseTo(999 - 0.5 * k, 2);
  });

  it('1SHOT at DOUBLE plays once in half the time, then stops', () => {
    const core = makeCore({ track: [{ tempoSyncMode: 'PITCH', oneShot: true, tempoSyncSpeed: 'DOUBLE' }] });
    at(core, 0, recPlay(), dc(0.5));
    at(core, 1000, recPlay(), dc(0.5));
    runTo(core, 1499);
    expect(trk(core).state).toBe('playing');
    runTo(core, 1501);
    expect(trk(core).state).toBe('stopped');
  });

  it.each(['PITCH', 'XFADE'] as const)('%s: an IMMEDIATE stop at half rate still ramps out over 5 ms', (mode) => {
    const core = makeCore({ track: [{ tempoSyncMode: mode }] });
    at(core, 0, recPlay(), dc(0.5));
    at(core, 1000, recPlay(), dc(0.5));
    configure(core, { tempo: 60 });
    run(core, 300);
    core.command(stop());
    const out = run(core, 20).tracks[0];
    for (let k = 0; k < XF; k++) expect(out[k]).toBeCloseTo(0.5 * (1 - k / XF), 6);
    for (let k = XF; k < 20; k++) expect(out[k]).toBe(0);
  });
});

describe('overdubbing at a rate other than 1 (INFERRED: splatted at the fractional playhead)', () => {
  const slow = (f: number): number => 0.5 * Math.sin((2 * Math.PI * 3 * f) / 1000); // 3 Hz at sr 1000

  it('PITCH at half rate: playing back at the same rate reproduces the overdub', () => {
    const core = makeCore({ track: [{ tempoSyncMode: 'PITCH' }] });
    at(core, 0, recPlay(), dc(0));
    at(core, 2000, recPlay(), dc(0)); // a silent 2000-frame loop at tempo 120
    configure(core, { tempo: 60 }); // rate 0.5: one pass is 4000 frames
    at(core, 2500, recPlay(), dc(0)); // punch in at position 250
    at(core, 6500, recPlay(), slow); // punch out one pass later
    const out = run(core, 4000, slow).tracks[0];
    for (let k = 20; k < 3980; k++) expect(out[k]).toBeCloseTo(slow(2500 + k), 3);
  });

  it('PITCH at double rate: playing back at the same rate reproduces the overdub', () => {
    const core = makeCore({ track: [{ tempoSyncMode: 'PITCH', tempoSyncSpeed: 'DOUBLE' }] });
    at(core, 0, recPlay(), dc(0));
    at(core, 2000, recPlay(), dc(0)); // one pass is 1000 frames
    at(core, 2500, recPlay(), dc(0));
    at(core, 3500, recPlay(), slow);
    const out = run(core, 1000, slow).tracks[0];
    for (let k = 20; k < 980; k++) expect(out[k]).toBeCloseTo(slow(2500 + k), 3);
  });

  it('PITCH at 2.5x (between whole frames, wider than a frame apart): playing back reproduces the overdub', () => {
    const core = makeCore({ track: [{ tempoSyncMode: 'PITCH', tempoSyncSpeed: 'DOUBLE' }] });
    at(core, 0, recPlay(), dc(0));
    at(core, 2000, recPlay(), dc(0));
    configure(core, { tempo: 150 }); // 150/120 x DOUBLE = 2.5: one pass is 800 frames
    at(core, 2500, recPlay(), dc(0)); // position 1250
    at(core, 3300, recPlay(), slow);
    const out = run(core, 800, slow).tracks[0];
    for (let k = 20; k < 780; k++) expect(out[k]).toBeCloseTo(slow(2500 + k), 3);
  });

  it('PITCH at the 4x limit in 256-frame blocks: nothing is dropped from the overdub', () => {
    const core = makeCore({ track: [{ tempoSyncMode: 'PITCH', tempoSyncSpeed: 'DOUBLE' }] });
    at(core, 0, recPlay(), dc(0));
    at(core, 2000, recPlay(), dc(0));
    configure(core, { tempo: 240 }); // 240/120 x DOUBLE = 4: one pass is 500 frames
    at(core, 2500, recPlay(), dc(0)); // position 0 again (2000 frames played at 4x)
    run(core, 500, slow, 256);
    core.command(recPlay());
    const out = run(core, 500, slow, 256).tracks[0];
    for (let k = 20; k < 480; k++) expect(out[k]).toBeCloseTo(slow(2500 + k), 2);
  });

  // Each frame must be read before the pass writes it, so the overdub is heard from the next pass. PITCH reads one
  // frame either side of the playhead, which only one-frame blocks expose; the XFADE heads lag the playhead by up to
  // (1 - rate) * 1440 frames at sr 48000, which re-read what the pass just wrote unless its writes wait for them.
  it('PITCH: the overdub is not heard during its own pass, even in one-frame blocks', () => {
    const core = makeCore({ track: [{ tempoSyncMode: 'PITCH' }] });
    at(core, 0, recPlay(), dc(0));
    at(core, 2000, recPlay(), dc(0)); // a silent loop
    configure(core, { tempo: 60 }); // rate 0.5
    at(core, 2500, recPlay(), dc(0));
    const during = run(core, 3500, dc(0.5), 1).tracks[0]; // 7/8 of a pass
    expect(during.every((v) => v === 0)).toBe(true);
    core.command(recPlay());
    expect(run(core, 3000).tracks[0][1500]).toBeCloseTo(0.5, 3); // the next pass plays it
  });

  it('XFADE: the overdub is not heard during its own pass through the lagging read heads', () => {
    const core = makeCore({ track: [{ tempoSyncMode: 'XFADE' }] }, { sampleRate: SR48 });
    at(core, 0, recPlay(), dc(0));
    at(core, 48000, recPlay(), dc(0)); // a silent 1 s loop
    configure(core, { tempo: 60 }); // rate 0.5: a pass takes 2 s
    at(core, 50000, recPlay(), dc(0));
    const during = run(core, 84000, tone1k).tracks[0]; // 7/8 of a pass
    expect(during.every((v) => v === 0)).toBe(true);
    core.command(recPlay());
    const after = run(core, 96000).tracks[0];
    let peak = 0;
    for (let i = 40000; i < 60000; i++) peak = Math.max(peak, Math.abs(after[i]));
    expect(peak).toBeGreaterThan(0.5); // the next pass plays it
  });

  it('a tempo change in the middle of an overdub carries the pass on without a gap or a double write', () => {
    const core = makeCore({ track: [{ tempoSyncMode: 'PITCH' }] });
    at(core, 0, recPlay(), dc(0));
    at(core, 2000, recPlay(), dc(0)); // a silent 2000-frame loop, rate 1
    at(core, 2100, recPlay(), dc(0)); // punch in at position 100 (whole frames)
    at(core, 3000, { t: 'tempo', bpm: 60 }, dc(0.5)); // position 1000: now half rate, between frames
    at(core, 4600, recPlay(), dc(0.5)); // position 1800: punch out
    run(core, 300, dc(0.5));
    const a = core.getTrackAudio(0)!.L;
    for (let p = 100 + XF; p < 1795; p++) expect(a[p]).toBeCloseTo(0.5, 6);
    expect(a[50]).toBe(0);
    expect(a[1850]).toBe(0);
  });

  it('STOP during an overdub at half rate keeps the 5 ms punch-out fade', () => {
    const core = makeCore({ track: [{ tempoSyncMode: 'PITCH' }] });
    at(core, 0, recPlay(), dc(0));
    at(core, 2000, recPlay(), dc(0));
    configure(core, { tempo: 60 });
    at(core, 2500, recPlay(), dc(0)); // position 250
    at(core, 3500, stop(), dc(0.5)); // position 750: the pass ends and the track stops
    run(core, 50, dc(0.5));
    const a = core.getTrackAudio(0)!.L;
    expect(a[745]).toBeCloseTo(0.5, 6);
    expect(a[755]).toBe(0);
    let prev = 0.5;
    let fading = 0;
    for (let p = 746; p < 755; p++) {
      expect(a[p]).toBeLessThanOrEqual(prev + 1e-6);
      if (a[p] > 1e-6 && a[p] < 0.5 - 1e-6) fading++;
      prev = a[p];
    }
    expect(fading).toBeGreaterThanOrEqual(2); // a ramp, not a step
  });

  it('REPLACE1 at half rate replaces the old audio completely', () => {
    const core = makeCore({ track: [{ tempoSyncMode: 'PITCH', dubMode: 'REPLACE1' }] });
    const input = (f: number): number => (f < 2000 ? 0.5 : 0.25);
    at(core, 0, recPlay(), input);
    at(core, 2000, recPlay(), input);
    configure(core, { tempo: 60 });
    at(core, 2500, recPlay(), input);
    at(core, 6500, recPlay(), input);
    const out = run(core, 4000, input).tracks[0];
    for (let k = 40; k < 3960; k++) expect(out[k]).toBeCloseTo(0.25, 6);
  });

  it('XFADE at half rate: the overdub plays back at the pitch it was played (1 kHz stays 1 kHz)', () => {
    const core = makeCore({ track: [{ tempoSyncMode: 'XFADE' }] }, { sampleRate: SR48 });
    at(core, 0, recPlay(), dc(0));
    at(core, 48000, recPlay(), dc(0)); // a silent 1 s loop at tempo 120
    configure(core, { tempo: 60 }); // one pass is 2 s
    at(core, 50400, recPlay(), dc(0));
    at(core, 50400 + 96000, recPlay(), tone1k);
    const out = run(core, 96000).tracks[0];
    const hz = crossings(out, 24000, 24000) / 0.5;
    expect(hz).toBeGreaterThanOrEqual(970);
    expect(hz).toBeLessThanOrEqual(1030);
    let s = 0;
    for (let i = 24000; i < 48000; i++) s += out[i] * out[i];
    const rms = Math.sqrt(s / 24000);
    expect(rms).toBeGreaterThan(0.5);
    expect(rms).toBeLessThan(0.85);
  });
});

describe('the recorded tempo', () => {
  it('a synced loop records the exact tempo of its whole-frame length (dispatch note b)', () => {
    const core = makeCore({ tempo: 133, track: [{ loopSyncSw: true }] }, { sampleRate: SR48 });
    rhythmOn(core);
    at(core, 0, recPlay(), dc(0.5));
    at(core, 86617, recPlay(), dc(0.5));
    expect(core.getTrackAudio(0)!.recordedTempo).toBe((1 * 4 * 60 * SR48) / 86617); // 132.99929, not 133
  });

  it('a derived tempo clamped to 300 leaves the loop at rate 1 (its recorded tempo stays in the saveable range)', () => {
    const core = makeCore({ track: [{ loopSyncSw: true, measure: { measures: 1 }, tempoSyncMode: 'PITCH' }] });
    at(core, 0, recPlay(), dc(0.5));
    at(core, 500, recPlay(), dc(0.5)); // one 4/4 measure in 500 frames would be 480 bpm
    expect(core.status().tempo).toBe(300);
    expect(core.getTrackAudio(0)!.recordedTempo).toBe(300);
    run(core, 100);
    expect(trk(core).position).toBeCloseTo(0.2, 9);
  });
});

describe('loaded loops', () => {
  it('a loaded loop plays at memory tempo / its recorded tempo', () => {
    const core = makeCore({ tempo: 120, track: [{ tempoSyncMode: 'PITCH' }] });
    const L = new Float32Array(1000).fill(0.5);
    core.setTrackAudio(0, { L, R: L.slice(), sampleRate: 1000, recordedTempo: 60, measures: null });
    core.command(recPlay());
    run(core, 200);
    expect(trk(core).position).toBeCloseTo(0.4, 9); // rate 2
  });

  it('XFADE plays a loaded loop in reverse at half rate', () => {
    const core = makeCore({ tempo: 60, track: [{ tempoSyncMode: 'XFADE', reverse: true }] });
    const L = new Float32Array(1000).fill(0.5);
    core.setTrackAudio(0, { L, R: L.slice(), sampleRate: 1000, recordedTempo: 120, measures: null });
    core.command(recPlay());
    const out = run(core, 400).tracks[0];
    expect(trk(core).position).toBeCloseTo((999 - 200) / 1000, 9);
    for (let k = XF; k < 400; k++) expect(out[k]).toBeCloseTo(0.5, 5);
  });
});

describe('synced loops follow the grid', () => {
  it('a tempo change while playing keeps a synced loop locked to the measure grid', () => {
    const core = makeCore({ track: [{ loopSyncSw: true }] }); // tempo 120: a measure is 2000 frames
    rhythmOn(core);
    at(core, 0, recPlay(), dc(0.5));
    at(core, 2000, recPlay(), dc(0.5)); // one measure, playing in step from 2000
    runTo(core, 2700);
    core.command({ t: 'tempo', bpm: 100 }); // a measure is now 2400 frames
    for (const f of [3000, 4100, 7777, 12345]) {
      runTo(core, f);
      const s = core.status();
      expect(phaseDiff(s.tracks[0].position, s.measurePhase)).toBeCloseTo(0, 9);
    }
  });

  it('a MEASURE start at a new tempo lands on the line, in step with the grid', () => {
    const core = makeCore({ track: [{ loopSyncSw: true }, { loopSyncSw: true, loopSyncMode: 'MEASURE' }] });
    rhythmOn(core);
    at(core, 0, recPlay(1), dc(0.5));
    at(core, 2000, recPlay(1), dc(0.5)); // track 2: one measure at 120
    core.command(stop(1));
    configure(core, { tempo: 150 }); // a measure is now 1600 frames
    runTo(core, 4100);
    core.command(recPlay(1));
    expect(trk(core, 1).pending).toBe('play');
    const line = 2000 + 1600 * Math.ceil((4100 - 2000) / 1600); // the grid kept its phase at 2000
    runTo(core, line + 400);
    const s = core.status();
    expect(s.tracks[1].state).toBe('playing');
    expect(s.tracks[1].position).toBeCloseTo(400 / 1600, 9);
    expect(phaseDiff(s.tracks[1].position, s.measurePhase)).toBeCloseTo(0, 9);
  });

  it(
    'note b: 10 minutes at 48 kHz and 133 bpm (a measure is 86616.54 frames) drift less than one frame',
    () => {
      for (const mode of ['PITCH', 'XFADE'] as const) {
        const core = makeCore({ tempo: 133, track: [{ loopSyncSw: true, tempoSyncMode: mode }] }, { sampleRate: SR48 });
        rhythmOn(core);
        at(core, 0, recPlay(), tone(440));
        at(core, 86617, recPlay(), tone(440)); // one measure, rounded to 86617 frames
        expect(trk(core).lengthFrames).toBe(86617);
        expect(trk(core).measures).toBe(1);
        const err = (): number => {
          const s = core.status();
          return phaseDiff(s.tracks[0].position, s.measurePhase) * s.tracks[0].lengthFrames;
        };
        const e0 = err();
        expect(Math.abs(e0)).toBeLessThan(1);
        // At rate 1 the loop would gain 0.46 frames a measure: about 153 frames over these 332 measures.
        for (let minute = 0; minute < 10; minute++) {
          runSilent(core, 60 * SR48);
          expect(Math.abs(err() - e0)).toBeLessThan(1);
        }
        expect(Math.abs(err() - e0)).toBeLessThan(0.01);
      }
    },
    120_000,
  );
});

describe('note c: a tempo change while a recording waits for its line', () => {
  it('re-aims the wait at the same musical line instead of trimming the take', () => {
    const core = makeCore({ track: [{ loopSyncSw: true }] }); // tempo 120: a measure is 2000 frames
    rhythmOn(core);
    at(core, 0, recPlay(), dc(0.5));
    at(core, 3000, recPlay(), dc(0.5)); // early: it waits for the end of measure 2, at 4000
    expect(trk(core).pending).toBe('play');
    core.command({ t: 'tempo', bpm: 240 }); // 1.5 measures in; the end of measure 2 is now 500 frames away
    runTo(core, 3499, dc(0.5));
    expect(trk(core).state).toBe('recording');
    expect(trk(core).lengthFrames).toBe(3499);
    runTo(core, 3500, dc(0.5));
    const s = trk(core);
    expect(s.state).toBe('playing');
    expect(s.lengthFrames).toBe(3500);
    expect(s.measures).toBe(2);
    // Two measures at 240 take 2000 frames: the loop plays at 1.75x, in step with the grid.
    runTo(core, 4500);
    expect(trk(core).position).toBeCloseTo(0.5, 9);
    expect(core.status().measurePhase).toBeCloseTo(0, 9);
  });

  it('re-aims a fixed-length recording (MEASURE 2) the same way', () => {
    const core = makeCore({ track: [{ loopSyncSw: true, measure: { measures: 2 } }] });
    rhythmOn(core);
    at(core, 0, recPlay(), dc(0.5));
    runTo(core, 3000, dc(0.5));
    core.command({ t: 'tempo', bpm: 240 });
    runTo(core, 3500, dc(0.5));
    expect(trk(core).state).toBe('playing');
    expect(trk(core).lengthFrames).toBe(3500);
  });

  it('a late end press after a tempo change snaps to whole measures of the music played', () => {
    const core = makeCore({ track: [{ loopSyncSw: true }] });
    rhythmOn(core);
    at(core, 0, recPlay(), dc(0.5));
    at(core, 3000, { t: 'tempo', bpm: 240 }, dc(0.5)); // 1.5 measures at 120, then 1000-frame measures
    at(core, 3600, recPlay(), dc(0.5)); // 2.1 measures in: 100 frames late for the end of measure 2
    expect(trk(core).state).toBe('playing');
    expect(trk(core).lengthFrames).toBe(3500);
    expect(trk(core).measures).toBe(2);
  });
});

describe('note d: an overshoot longer than the loop', () => {
  it('a target that shrinks far below the take dubs at most one loop length of overshoot in one callback', () => {
    const core = makeCore({
      rec: { recAction: 'REC->DUB' },
      track: [{ loopSyncSw: true, measure: 'FREE', dubMode: 'OVERDUB' }],
    });
    rhythmOn(core);
    at(core, 0, recPlay(), ramp);
    runTo(core, 12000, ramp); // six measures recorded, no end press yet
    configure(core, { track: [{ measure: { measures: 1 } }] }); // the fixed length is now one measure
    const spy = vi.spyOn(AudioTake.prototype, 'write');
    run(core, 1, ramp); // the loop closes as frame 12000 renders: 10000 frames of overshoot
    const calls = spy.mock.calls.length;
    spy.mockRestore();
    expect(trk(core).state).toBe('overdubbing');
    expect(trk(core).lengthFrames).toBe(2000);
    // All five passes over the loop would be ~40 writes of 256 frames; one loop length is ~8.
    expect(calls).toBeLessThan(16);
    // Position 1000: recorded at frame 1000, plus the last pass of the overshoot over it (frame 11000) only.
    expect(core.getTrackAudio(0)!.L[1000]).toBe(1000 + 11000);
  });
});
