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
import type { EngineCommand } from '../../src/shared/protocol';

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

/**
 * The local pitch of `x[a, b)` in Hz: the sample rate over the median interval between positive-going zero crossings
 * (so an occasional phase step at a splice join does not move it).
 */
function medianPitch(x: Float32Array, a: number, b: number, sr = SR48): number {
  const gaps: number[] = [];
  let last = -1;
  for (let i = a + 1; i < b; i++) {
    if (x[i - 1] < 0 && x[i] >= 0) {
      const t = i - 1 + x[i - 1] / (x[i - 1] - x[i]); // interpolated crossing
      if (last >= 0) gaps.push(t - last);
      last = t;
    }
  }
  gaps.sort((p, q) => p - q);
  return sr / gaps[gaps.length >> 1];
}

/** RMS of `x[a, b)` in dB relative to a full-scale sine (RMS 1/sqrt 2). */
function sineDb(x: Float32Array, a: number, b: number): number {
  let s = 0;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return 20 * Math.log10(Math.sqrt(s / (b - a)) / Math.SQRT1_2);
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

/** sr 48000, tempo 133, rhythm on: one synced 4/4 measure recorded from frame 0 (86617 frames), playing. */
function loop133(mode: 'PITCH' | 'XFADE'): LooperCore {
  const core = makeCore({ tempo: 133, track: [{ loopSyncSw: true, tempoSyncMode: mode }] }, { sampleRate: SR48 });
  rhythmOn(core);
  at(core, 0, recPlay(), tone(440));
  at(core, 86617, recPlay(), tone(440)); // one measure is 86616.54 frames: rounded to 86617
  run(core, 300, tone(440)); // past the 5 ms seam tail, so the take is final
  expect(trk(core).lengthFrames).toBe(86617);
  expect(trk(core).measures).toBe(1);
  return core;
}

/** How far a one-measure loop's playhead is from the measure grid, in frames. */
function gridError(core: LooperCore): number {
  const s = core.status();
  return phaseDiff(s.tracks[0].position, s.measurePhase) * s.tracks[0].lengthFrames;
}

/** Track 1's output for the next `n` frames and the playhead (a whole frame) where they start. */
function capture(core: LooperCore, n: number): { out: Float32Array; p0: number } {
  const p0 = Math.round(trk(core).position * trk(core).lengthFrames);
  return { out: run(core, n).tracks[0], p0 };
}

/**
 * Check the next `n` frames of output are the take's samples one for one from the playhead, up to the seam (where a
 * correction may move the next pass by a frame). Returns the frames compared.
 */
function expectExact(core: LooperCore, take: Float32Array, n: number): number {
  const { out, p0 } = capture(core, n);
  const upTo = Math.min(n, take.length - p0);
  for (let i = 0; i < upTo; i++) if (out[i] !== take[p0 + i]) expect(`frame ${i}: ${out[i]}`).toBe(`${take[p0 + i]}`);
  return upTo;
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

  // Fix round 1: a 1SHOT plays once. The stretcher's heads run up to |rate - 1| * G/2 past the play position, and the
  // PITCH taps two frames; wrapping them would leak the sample's other end into its last grain.
  it.each([
    ['XFADE', 'NORMAL', 60, false, 2800, 3000],
    ['XFADE', 'DOUBLE', 120, false, 1300, 1500],
    ['PITCH', 'NORMAL', 60, false, 2800, 3000],
    ['XFADE', 'NORMAL', 60, true, 2800, 2999], // backwards from position 999, so it ends a frame sooner
  ] as const)('a 1SHOT in %s (%s, tempo %i, reverse %s) ends in silence, with no ghost of its other end', (mode, speed, tempo, reverse, from, to) => {
    // Loud at the end the play finishes away from (the start, or the end in REVERSE), silent elsewhere. Forwards the
    // input stays loud after the end press too, so the seam crossfade keeps the sample's first frames loud.
    const loud = (f: number): number => ((reverse ? f >= 900 && f < 1000 : f < 100 || f >= 1000) ? 0.5 : 0);
    const core = makeCore({ track: [{ tempoSyncMode: mode, oneShot: true, reverse, tempoSyncSpeed: speed }] });
    at(core, 0, recPlay(), loud);
    at(core, 1000, recPlay(), loud); // a 1000-frame sample; it plays once from here
    configure(core, { tempo });
    const out = run(core, to - 1 - 1000, loud).tracks[0]; // up to the frame before the sample's end
    expect(trk(core).state).toBe('playing');
    for (let f = from; f < to - 1; f++) expect(out[f - 1000]).toBe(0);
    run(core, 2);
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
    // (A crossing count would miscount: each splice join can step the phase. Splatting at the playhead gives 2 kHz.)
    const hz = medianPitch(out, 12000, 84000);
    expect(hz).toBeGreaterThanOrEqual(990);
    expect(hz).toBeLessThanOrEqual(1010);
  });

  // Fix round 1: one input moment per take frame. Averaging the moments the two heads wrote was a comb filter (-29 dB
  // at 440 Hz at 0.5x). The stored overdub must keep the input's level, and so must its replay through the stretcher.
  // (The replay check is valid for these tones; on others the stretcher itself can lose up to 4.4 dB on a recorded
  // take too, since its heads are not phase-aligned. That is deferred by ruling.)
  it.each([
    [440, 0.5],
    [1033, 0.5],
    [440, 0.75],
    [1033, 0.75],
  ])('XFADE overdub of %f Hz at %fx: stored and replayed within 1.5 dB of the input', (freq, rate) => {
    const core = makeCore({ track: [{ tempoSyncMode: 'XFADE' }] }, { sampleRate: SR48 });
    at(core, 0, recPlay(), dc(0));
    at(core, 48000, recPlay(), dc(0)); // a silent 1 s loop at tempo 120
    configure(core, { tempo: 120 * rate });
    const pass = Math.round(48000 / rate);
    at(core, 50000, recPlay(), dc(0));
    at(core, 50000 + pass, recPlay(), tone(freq)); // one whole pass
    const replay = run(core, pass).tracks[0];
    const stored = core.getTrackAudio(0)!.L;
    expect(Math.abs(sineDb(stored, 4800, 43200))).toBeLessThan(1.5);
    expect(Math.abs(sineDb(replay, 4800, pass - 4800))).toBeLessThan(1.5);
  });

  it('XFADE REPLACE1 at half rate replaces the old audio with the overdub at its level', () => {
    const core = makeCore({ track: [{ tempoSyncMode: 'XFADE', dubMode: 'REPLACE1' }] }, { sampleRate: SR48 });
    at(core, 0, recPlay(), tone(660));
    at(core, 48000, recPlay(), tone(660)); // a 660 Hz loop
    const old = core.getTrackAudio(0)!.L;
    configure(core, { tempo: 60 });
    at(core, 50000, recPlay(), tone(660));
    at(core, 50000 + 96000, recPlay(), tone(440)); // replace one whole pass with 440 Hz
    run(core, 300, tone(440));
    const stored = core.getTrackAudio(0)!.L;
    expect(Math.abs(sineDb(stored, 4800, 43200))).toBeLessThan(1.5); // 440 alone (with 660 left over it would be +3 dB)
    let dot = 0;
    let norm = 0;
    for (let i = 4800; i < 43200; i++) {
      dot += stored[i] * old[i];
      norm += old[i] * old[i];
    }
    expect(Math.abs(dot / norm)).toBeLessThan(0.05); // nothing of the old 660 Hz remains
  });
});

describe('flushPendingWrites (for Task 8 snapshots)', () => {
  it('lands the gathered writes of a pass at half rate, so a snapshot taken after it is complete', () => {
    const core = makeCore({ track: [{ tempoSyncMode: 'PITCH' }] });
    at(core, 0, recPlay(), dc(0));
    at(core, 2000, recPlay(), dc(0)); // a silent 2000-frame loop
    configure(core, { tempo: 60 }); // rate 0.5
    at(core, 2500, recPlay(), dc(0)); // punch in at position 250
    run(core, 3000, dc(0.5)); // to position 1750
    const track = core.tracks[0];
    expect(track.flushPendingWrites()).toBe(false); // the pass is still running
    core.command(recPlay()); // punch out
    run(core, 10, dc(0.5)); // the 5 ms tail is done; the last frames written are still gathered
    const L = new Float32Array(1500);
    const R = new Float32Array(1500);
    const early = track.take.snapshot();
    early.read(250 + XF, L, R, 0, 1490);
    early.release();
    expect(L.subarray(0, 1490).every((v) => v === 0.5)).toBe(false); // a snapshot now would miss the end of the pass
    expect(track.flushPendingWrites()).toBe(true);
    const snap = track.take.snapshot();
    snap.read(250 + XF, L, R, 0, 1490);
    snap.release();
    for (let i = 0; i < 1490; i++) expect(L[i]).toBeCloseTo(0.5, 6);
  });

  it('is complete at once on the exact path once the tail has ended', () => {
    const core = makeCore();
    at(core, 0, recPlay(), dc(0));
    at(core, 1000, recPlay(), dc(0));
    at(core, 1200, recPlay(), dc(0.5));
    at(core, 1500, recPlay(), dc(0.5));
    expect(core.tracks[0].flushPendingWrites()).toBe(false); // the 5 ms punch-out tail is still writing
    run(core, XF, dc(0.5));
    expect(core.tracks[0].flushPendingWrites()).toBe(true);
  });
});

describe('audio() just after a pass at a rate other than 1 (binding note 2)', () => {
  /**
   * A 2 s loop of 440 Hz at 1.5x (XFADE), overdubbed with 660 Hz from frame 100000 (position 6000); at 148000
   * (position 78000) `end` ends the pass, then `after` frames run. While the loop still plays, the last ~6000 frames of
   * the pass are only gathered until the read heads have passed them (up to ~129 ms).
   */
  function dubbed(end: EngineCommand, after: number): LooperCore {
    const core = makeCore({ track: [{ tempoSyncMode: 'XFADE' }] }, { sampleRate: SR48 });
    at(core, 0, recPlay(), tone(440, SR48, 0.4));
    at(core, 96000, recPlay(), tone(440, SR48, 0.4));
    configure(core, { tempo: 180 });
    at(core, 100000, recPlay(), tone(660, SR48, 0.4));
    at(core, 148000, end, tone(660, SR48, 0.4));
    run(core, after, tone(660, SR48, 0.4));
    return core;
  }

  /** Frames of `got` that differ from `want` inside the pass, short of its last 1500 (where the tail still writes). */
  function missing(got: Float32Array, want: Float32Array): number {
    let n = 0;
    for (let j = 7000; j < 78000 - 1500; j++) if (Math.abs(got[j] - want[j]) > 1e-6) n++;
    return n;
  }

  it.each([
    ['2 frames after a punch-out (the loop plays on)', recPlay(), 2],
    ['at the STOP frame itself', stop(), 0],
  ] as const)('%s it holds the gathered end of the pass, baked into the copy only', (_name, end, after) => {
    const core = dubbed(end, after);
    const got = core.getTrackAudio(0)!.L;
    const ref = dubbed(end, after);
    run(ref, 48000, tone(660, SR48, 0.4));
    const want = ref.getTrackAudio(0)!.L;
    expect(missing(got, want)).toBe(0);
    run(core, 48000, tone(660, SR48, 0.4));
    expect(core.getTrackAudio(0)!.L).toEqual(want); // the live take was not touched by the bake
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
    'note b / R45: 10 minutes at 48 kHz and 133 bpm stay within 0.75 of a frame of the grid, playing the take sample for sample',
    () => {
      for (const mode of ['PITCH', 'XFADE'] as const) {
        const core = loop133(mode);
        const take = core.getTrackAudio(0)!.L;
        expect(Math.abs(gridError(core))).toBeLessThan(0.76);
        // At rate 1 with no seam correction the loop would gain 0.46 frames a measure: ~153 frames over the run.
        let checked = 0;
        // The seam correction keeps the error centred on the grid: within 0.75 of a frame (0.5 rounding plus half the
        // 0.46-frame drift of a pass), absolutely; checked at points spread over the whole run.
        for (let t = 0; t < 600; t += 7) {
          runSilent(core, 7 * SR48);
          expect(Math.abs(gridError(core))).toBeLessThan(0.76);
          checked += expectExact(core, take, 4096);
          expect(Math.abs(gridError(core))).toBeLessThan(0.76);
        }
        expect(checked).toBeGreaterThan(80 * 3000); // most of every window was compared
      }
    },
    120_000,
  );

  it('R45: a tempo nudged away and back returns to sample-for-sample playback at the next seam', () => {
    const core = loop133('XFADE');
    const take = core.getTrackAudio(0)!.L;
    runSilent(core, 10000);
    configure(core, { tempo: 134 }); // a real change: the loop is stretched
    runSilent(core, 30000);
    configure(core, { tempo: 133 }); // back to the loop's own tempo, between frames
    const before = capture(core, 2000);
    let differs = 0;
    for (let i = 0; i < 2000; i++) if (before.out[i] !== take[(before.p0 + i) % 86617]) differs++;
    expect(differs).toBeGreaterThan(0); // still the stretched path until the seam
    runSilent(core, 86617); // past the seam
    expect(expectExact(core, take, 4096)).toBeGreaterThan(3000);
  });

  it('R45: an overdub on a 133 bpm loop lands sample-aligned at once (no added delay)', () => {
    const core = loop133('XFADE');
    const old = core.getTrackAudio(0)!.L;
    runSilent(core, 20000);
    const p0 = Math.round(trk(core).position * 86617);
    const f0 = core.frame;
    const input = (f: number): number => ((f * 7) % 1000) / 4000;
    core.command(recPlay()); // overdub
    run(core, 10000, input);
    core.command(recPlay()); // punch out
    run(core, 300, input); // past the 5 ms tail, and no more
    const a = core.getTrackAudio(0)!.L;
    const xf = 240; // the 5 ms punch-in ramp at 48 kHz
    for (let k = xf; k < 10000; k++) {
      if (a[p0 + k] !== Math.fround(old[p0 + k] + Math.fround(input(f0 + k)))) {
        expect(`${k}: ${a[p0 + k]}`).toBe(`${k}: ${Math.fround(old[p0 + k] + Math.fround(input(f0 + k)))}`);
      }
    }
  });
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
