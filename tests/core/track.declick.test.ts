/**
 * No hard steps: every start, stop, retrigger and REPLACE2 punch moves the output over the 5 ms XFADE (XF frames).
 *
 * Signal: a cosine of amplitude A with a 100-frame period, so a 1000-frame recording loops seamlessly and loop
 * position 0 sits on a peak (+A). Its own largest step is about A * 2pi/100 = 0.03. A hard step from a peak is A
 * (or 2A between opposite peaks), while a 5 ms ramp moves at most 2A / XF per frame. The bound is 2.5 * A / XF.
 */
import { describe, expect, it } from 'vitest';
import { dc, makeCore, recPlay, run, stop, trk, XF } from './harness';
import type { LooperCore } from '../../src/core/looper';
import type { EngineCommand } from '../../src/shared/protocol';

const A = 0.5;
const wave = (f: number): number => A * Math.cos((2 * Math.PI * f) / 100);
const BOUND = (2.5 * A) / XF;

function maxStep(a: Float32Array, from = 0, to = a.length): number {
  let m = 0;
  for (let i = from + 1; i < to; i++) m = Math.max(m, Math.abs(a[i] - a[i - 1]));
  return m;
}

/** Queue `script` (frame, command) and run `n` frames of `input` from frame 0; returns track 1's left output. */
function play(core: LooperCore, n: number, script: [number, EngineCommand][], input: (f: number) => number): Float32Array {
  for (const [f, cmd] of script) core.command(cmd, f);
  return run(core, n, input).tracks[0];
}

describe('smooth starts', () => {
  it('the first playback after a recording ramps in over XF frames (REC->PLAY)', () => {
    const core = makeCore({ rec: { recAction: 'REC->PLAY' } });
    const out = play(core, 1300, [[0, recPlay()], [1000, recPlay()]], wave);
    expect(out[1000]).toBe(0); // starts from silence...
    expect(out[1000 + XF]).toBeCloseTo(wave(XF), 5); // ...and is at full level after XF frames
    expect(maxStep(out)).toBeLessThanOrEqual(BOUND);
  });

  it('the first pass after a recording ramps in over XF frames (REC->DUB, OVERDUB)', () => {
    const core = makeCore({ rec: { recAction: 'REC->DUB' } });
    const out = play(core, 1300, [[0, recPlay()], [1000, recPlay()]], wave);
    expect(trk(core).state).toBe('overdubbing');
    expect(out[1000]).toBe(0);
    expect(maxStep(out)).toBeLessThanOrEqual(BOUND);
  });

  it('START MODE IMMEDIATE from stopped ramps in over XF frames', () => {
    const core = makeCore({ track: [{ startMode: 'IMMEDIATE' }] });
    const out = play(core, 2200, [[0, recPlay()], [1000, recPlay()], [1500, stop()], [1800, recPlay()]], wave);
    expect(out[1799]).toBe(0);
    expect(out[1800]).toBe(0); // position 0 is a peak, but the start ramps from 0
    expect(out[1800 + XF]).toBeCloseTo(wave(XF), 5);
    expect(maxStep(out)).toBeLessThanOrEqual(BOUND);
  });

  it('a 1SHOT retrigger crossfades the old position into the start', () => {
    const core = makeCore({ track: [{ oneShot: true }] });
    // Retrigger at loop position 450, a trough (-A); the start (position 0) is a peak (+A).
    const out = play(core, 1600, [[0, recPlay()], [1000, recPlay()], [1450, recPlay()]], wave);
    expect(out[1449]).toBeCloseTo(wave(449), 5);
    expect(out[1450 + XF + 10]).toBeCloseTo(wave(XF + 10), 5); // playing from the start
    expect(maxStep(out)).toBeLessThanOrEqual(BOUND);
    expect(trk(core).state).toBe('playing');
  });
});

describe('smooth stops (XF ramp, then silence)', () => {
  it('IMMEDIATE stop ramps out over XF frames', () => {
    const core = makeCore({ track: [{ stopMode: 'IMMEDIATE' }] });
    const out = play(core, 1700, [[0, recPlay()], [1000, recPlay()], [1500, stop()]], wave); // stop on a peak
    expect(trk(core).state).toBe('stopped'); // stopped at once; only the output ramps
    expect(out[1500]).toBeCloseTo(A, 3);
    expect(out.subarray(1500 + XF).every((v) => v === 0)).toBe(true);
    expect(maxStep(out)).toBeLessThanOrEqual(BOUND);
  });

  it('the end of a LOOP stop ramps out over XF frames after the loop end', () => {
    const core = makeCore({ track: [{ stopMode: 'LOOP' }] });
    const out = play(core, 2200, [[0, recPlay()], [1000, recPlay()], [1300, stop()]], wave);
    expect(out[1999]).toBeCloseTo(wave(999), 5); // the loop plays to its end
    expect(out.subarray(2000 + XF).every((v) => v === 0)).toBe(true);
    expect(maxStep(out)).toBeLessThanOrEqual(BOUND);
    expect(trk(core).state).toBe('stopped');
  });

  it('the end of a 1SHOT ramps out over XF frames', () => {
    const core = makeCore({ track: [{ oneShot: true }] });
    const out = play(core, 2200, [[0, recPlay()], [1000, recPlay()]], wave);
    expect(out[1999]).toBeCloseTo(wave(999), 5);
    expect(out.subarray(2000 + XF).every((v) => v === 0)).toBe(true);
    expect(maxStep(out)).toBeLessThanOrEqual(BOUND);
  });

  it('a second STOP during a FADE stop ramps out over XF frames from the current fade level', () => {
    const core = makeCore({ tempo: 120, track: [{ stopMode: 'FADE' }], play: { fadeOut: { measures: 1 } } });
    const out = play(core, 2300, [[0, recPlay()], [1000, recPlay()], [1500, stop()], [2000, stop()]], wave);
    expect(out.subarray(2000 + XF).every((v) => v === 0)).toBe(true);
    expect(maxStep(out)).toBeLessThanOrEqual(BOUND);
  });

  it.each([
    ['IMMEDIATE stop', { stopMode: 'IMMEDIATE' as const }, [[1500, stop()]] as [number, EngineCommand][], 1500],
    ['LOOP stop end', { stopMode: 'LOOP' as const }, [[1300, stop()]] as [number, EngineCommand][], 2000],
    ['1SHOT end', { oneShot: true }, [] as [number, EngineCommand][], 2000],
  ])('the %s ramp is monotonic: from the level before the cut down to 0', (_name, track, extra, cut) => {
    const core = makeCore({ track: [track] });
    const out = play(core, 2200, [[0, recPlay()], [1000, recPlay()], ...extra], dc(0.5));
    expect(out[cut - 1]).toBe(0.5);
    for (let i = cut; i <= cut + XF; i++) expect(out[i]).toBeLessThanOrEqual(out[i - 1]);
    expect(out[cut]).toBeGreaterThan(0);
    expect(out[cut + XF - 1]).toBeGreaterThan(0);
    expect(out[cut + XF]).toBe(0);
    expect(maxStep(out, cut - 1, cut + XF + 1)).toBeLessThanOrEqual(0.5 / XF + 1e-6);
  });
});

describe('smooth REPLACE2 punches', () => {
  it('a REPLACE2 punch-in from playback mutes over XF frames and unmutes over XF at punch-out', () => {
    const core = makeCore({ track: [{ dubMode: 'REPLACE2' }] });
    const out = play(core, 2300, [[0, recPlay()], [1000, recPlay()], [1500, recPlay()], [2000, recPlay()]], wave);
    expect(out.subarray(1500 + XF, 2000).every((v) => v === 0)).toBe(true);
    expect(maxStep(out)).toBeLessThanOrEqual(BOUND);
  });

  it('REC->DUB into REPLACE2 stays silent from the end press: the track never plays during the pass', () => {
    const core = makeCore({ rec: { recAction: 'REC->DUB' }, track: [{ dubMode: 'REPLACE2' }] });
    const out = play(core, 2300, [[0, recPlay()], [1000, recPlay()], [2000, recPlay()]], wave);
    expect(out.subarray(0, 2000).every((v) => v === 0)).toBe(true); // recording, then the whole REPLACE2 pass
    expect(out[2000 + XF + 10]).toBeCloseTo(wave(XF + 10), 5); // then it plays what was written
    expect(maxStep(out)).toBeLessThanOrEqual(BOUND);
  });
});
