/**
 * Tempo sync at its edges (Task 7 fix round 2), all at sr 48000:
 *  - seam corrections during an exact-path overdub (a skip writes the skipped frame; a replay plays the frame as it
 *    was before the pass wrote it),
 *  - the return from the stretcher to exact playback crossfades,
 *  - an XFADE overdub above 1x covers exactly its punched span,
 *  - the exact path's absolute grid error, and leaving it on a replayed frame.
 */
import { describe, expect, it } from 'vitest';
import { at, configure, dc, makeCore, recPlay, run, trk } from './harness';
import type { LooperCore } from '../../src/core/looper';

const SR = 48000;
const tone = (hz: number, amp = 1) => (f: number): number => amp * Math.sin((2 * Math.PI * hz * f) / SR);
const rhythmOn = (core: LooperCore): void => core.command({ t: 'rhythmStartStop' });
const runTo = (core: LooperCore, frame: number, input?: (f: number) => number) => run(core, frame - core.frame, input);

/** Largest |second difference| of `x[a, b)`. */
function maxD2(x: Float32Array, a: number, b: number): number {
  let m = 0;
  for (let i = Math.max(1, a); i < Math.min(x.length - 1, b); i++) {
    const d = Math.abs(x[i + 1] - 2 * x[i] + x[i - 1]);
    if (d > m) m = d;
  }
  return m;
}

/** |second difference| of a loop at frame `i`, reading across the seam. */
function loopD2(x: Float32Array, i: number): number {
  const n = x.length;
  return Math.abs(x[(i + 1) % n] - 2 * x[i] + x[(i - 1 + n) % n]);
}

/** `a - b` on the unit circle, in [-0.5, 0.5). */
function phaseDiff(a: number, b: number): number {
  const d = a - b;
  return d - Math.round(d);
}

/** How far a one-measure loop's playhead is from the measure grid, in frames. */
function gridError(core: LooperCore): number {
  const s = core.status();
  return phaseDiff(s.tracks[0].position, s.measurePhase) * s.tracks[0].lengthFrames;
}

/** A synced one-measure loop of silence at `bpm`, rhythm on, recorded from the measure line `line` (0 or 1). */
function silentLoop(bpm: number, line = 0): { core: LooperCore; L: number } {
  const core = makeCore({ tempo: bpm, track: [{ loopSyncSw: true }] }, { sampleRate: SR });
  rhythmOn(core);
  const M = (4 * 60 * SR) / bpm;
  const L = Math.round(M);
  const start = Math.round(line * M);
  if (line > 0) at(core, Math.round(start / 2), recPlay(), dc(0)); // armed: recording starts on the line
  else at(core, 0, recPlay(), dc(0));
  at(core, start + L, recPlay(), dc(0)); // an on-time end press: one measure
  run(core, 300);
  expect(trk(core).lengthFrames).toBe(L);
  expect(trk(core).measures).toBe(1);
  return { core, L };
}

describe('seam corrections during an exact-path overdub', () => {
  // 133 bpm: a measure is 86616.54 frames, the loop 86617, so the seam skips a frame about every other pass.
  // 124 bpm: a measure is 92903.23 frames, the loop 92903, so the seam replays a frame about every fourth pass.
  it.each([
    [133, 5, 'skips'],
    [124, 10, 'replays'],
  ])('at %i bpm over %i passes (%s): no hole or click in the take, no spike in the output', (bpm, passes) => {
    const { core, L } = silentLoop(bpm);
    const input = tone(100, 0.5);
    core.command(recPlay()); // overdub from position 300
    const out = run(core, passes * L, input).tracks[0];
    core.command(recPlay());
    run(core, 300, input);
    expect(core.tracks[0].flushPendingWrites()).toBe(true);
    const take = core.getTrackAudio(0)!.L;
    // The take holds `passes` layers of 0.5 at 100 Hz: its second difference is about 4e-4 anywhere smooth. A frame
    // a pass never wrote steps by up to the input's full swing (1.5 after a few passes). Each correction leaves at most
    // a one-sample stall or skip in one layer (0.5 x 2 pi 100/48000 = 0.0065).
    let neighbours = 0;
    for (let i = 1; i <= 20; i++) neighbours = Math.max(neighbours, loopD2(take, i), loopD2(take, L - i));
    const atSeam = loopD2(take, 0);
    expect(atSeam).toBeLessThan(0.05);
    expect(atSeam).toBeLessThan(neighbours + 0.02);
    let worst = 0;
    for (let i = 0; i < L; i++) worst = Math.max(worst, loopD2(take, i));
    expect(worst).toBeLessThan(0.05);
    // The output is the take as it was before each frame's write: a frame replayed after the pass wrote it would
    // show the input's full value for one sample.
    expect(maxD2(out, 1, out.length - 1)).toBeLessThan(0.05);
  });
});

describe('the return from the stretcher to exact playback', () => {
  // A seamless 1 s loop (440 Hz + 2200 Hz, whole cycles), recorded free at tempo 120 (rate 1, exact).
  const content = (f: number): number => 0.1 * Math.sin((2 * Math.PI * 440 * f) / SR) + 0.1 * Math.sin((2 * Math.PI * 2200 * f) / SR);
  function seamless(over: Record<string, unknown> = {}): LooperCore {
    const core = makeCore({ track: [{ tempoSyncMode: 'XFADE' }], ...over }, { sampleRate: SR });
    at(core, 0, recPlay(), content);
    at(core, 48000, recPlay(), content); // plays from frame 48000 at position 0
    return core;
  }

  /**
   * The output's largest second difference around `switchAt` (+-400 frames), against the stretched playback before
   * it (`baseFrom`..`baseTo`) and the steady exact playback at the start.
   */
  function check(out: Float32Array, from: number, switchAt: number, baseFrom: number, baseTo: number): void {
    const steady = maxD2(out, 48500 - from, 49900 - from);
    const base = maxD2(out, baseFrom - from, baseTo - from);
    const sw = maxD2(out, switchAt - 400 - from, switchAt + 400 - from);
    expect(steady).toBeGreaterThan(0.005); // the content itself
    expect(sw).toBeLessThan(1.5 * Math.max(base, steady));
  }

  it('DOUBLE back to NORMAL with SPEED CHANGE LOOP END crossfades at the seam', () => {
    const core = seamless({ play: { speedChange: 'LOOP END' } });
    const before = run(core, 2000, content).tracks[0]; // 48000..50000, exact
    runTo(core, 60000, content);
    configure(core, { track: [{ tempoSyncSpeed: 'DOUBLE' }] }); // from the seam at 96000: rate 2, stretched
    runTo(core, 100000, content);
    configure(core, { track: [{ tempoSyncSpeed: 'NORMAL' }] }); // from the seam at 120000: exact again
    const out = run(core, 30000, content).tracks[0];
    const full = new Float32Array(130000);
    full.set(before, 48000);
    full.set(out, 100000);
    check(full, 0, 120000, 104000, 118000);
  });

  it('HALF back to NORMAL (IMMEDIATE) 10 ms before the seam crossfades at the seam', () => {
    const core = seamless({ play: { speedChange: 'IMMEDIATE' } });
    const before = run(core, 2000, content).tracks[0]; // 48000..50000, exact
    configure(core, { track: [{ tempoSyncSpeed: 'HALF' }] }); // position 2000; the seam comes at 142000
    runTo(core, 120000, content);
    const mid = run(core, 21520, content).tracks[0]; // to 141520
    configure(core, { track: [{ tempoSyncSpeed: 'NORMAL' }] }); // 240 frames before the seam: rate 1, still stretched
    const after = run(core, 2000, content).tracks[0];
    const full = new Float32Array(144000);
    full.set(before, 48000);
    full.set(mid, 120000);
    full.set(after, 141520);
    check(full, 0, 141760, 121000, 141000);
  });

  it('a SPEED MOMENT released under LOOP END crossfades at the seam', () => {
    const core = seamless({ play: { speedChange: 'LOOP END' } });
    const before = run(core, 2000, content).tracks[0];
    runTo(core, 60000, content);
    core.command({ t: 'speedMoment', track: 0, speed: 'DOUBLE' }); // from the seam at 96000
    runTo(core, 100000, content);
    core.command({ t: 'speedMoment', track: 0, speed: null }); // from the seam at 120000
    const out = run(core, 30000, content).tracks[0];
    const full = new Float32Array(130000);
    full.set(before, 48000);
    full.set(out, 100000);
    check(full, 0, 120000, 104000, 118000);
  });

  it('TEMPO SYNC SW turned OFF just before a seam crossfades at the seam', () => {
    const core = seamless();
    const before = run(core, 2000, content).tracks[0]; // 48000..50000, exact
    configure(core, { tempo: 100 }); // rate 0.8333 from 50000 (position 2000)
    runTo(core, 80000, content);
    const mid = run(core, 24912, content).tracks[0]; // 80000..104912, stretched; position 47760 at the end
    configure(core, { track: [{ tempoSyncSw: false }] }); // rate 1: the seam comes 240 frames later, at 105152
    const after = run(core, 2000, content).tracks[0];
    const full = new Float32Array(107000);
    full.set(before, 48000);
    full.set(mid, 80000);
    full.set(after, 104912);
    check(full, 0, 105152, 81000, 104500);
  });
});

describe('an XFADE overdub covers exactly its punched span', () => {
  // A 2 s loop recorded at tempo 120 holding `old`; overdubbed with a steady 0.25 for 0.2 s at `rate`. Inside the span
  // (past the punch-in ramp and before the punch-out tail) every frame must be written; outside it none may be.
  it.each([
    ['OVERDUB', 0.75],
    ['OVERDUB', 1.5],
    ['OVERDUB', 2],
    ['OVERDUB', 4],
    ['REPLACE1', 0.75],
    ['REPLACE1', 1.5],
    ['REPLACE1', 2],
    ['REPLACE1', 4],
  ] as const)('%s at %fx', (dubMode, rate) => {
    const old = dubMode === 'OVERDUB' ? 0 : 0.5;
    const want = dubMode === 'OVERDUB' ? 0.25 : 0.25;
    const speed = rate === 4 ? 'DOUBLE' : 'NORMAL';
    const core = makeCore({ track: [{ tempoSyncMode: 'XFADE', dubMode, tempoSyncSpeed: speed }] }, { sampleRate: SR });
    at(core, 0, recPlay(), dc(old));
    at(core, 96000, recPlay(), dc(old));
    configure(core, { tempo: (120 * rate) / (speed === 'DOUBLE' ? 2 : 1) }); // the loop plays at `rate` from 96000
    const input = (f: number): number => (f < 98000 ? old : 0.25); // (the recording's seam tail takes `old`)
    at(core, 98000, recPlay(), input); // punch in at position 2000 x rate
    at(core, 98000 + 9600, recPlay(), input); // punch out 0.2 s later
    run(core, 600, input); // past the 5 ms tail
    expect(core.tracks[0].flushPendingWrites()).toBe(true);
    const take = core.getTrackAudio(0)!.L;
    const xf = 240; // 5 ms
    const pIn = 2000 * rate;
    const pOut = pIn + 9600 * rate;
    const pEnd = pOut + xf * rate;
    let holes = 0;
    for (let j = Math.ceil(pIn + xf * rate) + 1; j < Math.floor(pOut) - 1; j++) if (Math.abs(take[j] - want) > 1e-6) holes++;
    let spill = 0;
    for (let j = Math.ceil(pEnd) + 1; j < 96000; j++) if (take[j] !== old) spill++;
    for (let j = 0; j < Math.floor(pIn) - 1; j++) if (take[j] !== old) spill++;
    expect({ holes, spill }).toEqual({ holes: 0, spill: 0 });
    // The punch-in ramp and the punch-out fade sit at the punch points (each 5 ms of input, so rate x 240 frames),
    // half way through at their middles: not repeated inside the span, not cut short.
    const mid = (old + want) / 2;
    expect(take[Math.round(pIn + (xf * rate) / 2)]).toBeCloseTo(mid, 1);
    expect(take[Math.round(pOut + (xf * rate) / 2)]).toBeCloseTo(mid, 1);
  });

  it('an overdub running across a return to exact playback writes each frame once', () => {
    // XFADE at DOUBLE (rate 2), back to NORMAL at the seam (LOOP END), overdubbing 0.25 onto silence throughout.
    const core = makeCore({ track: [{ tempoSyncMode: 'XFADE', tempoSyncSpeed: 'DOUBLE' }], play: { speedChange: 'LOOP END' } }, { sampleRate: SR });
    at(core, 0, recPlay(), dc(0));
    at(core, 96000, recPlay(), dc(0)); // plays at rate 2 from 96000: the seam comes at 144000
    const input = (f: number): number => (f < 130000 ? 0 : 0.25);
    at(core, 130000, recPlay(), input); // overdub from position 68000
    configure(core, { track: [{ tempoSyncSpeed: 'NORMAL' }] }); // exact again from the seam
    runTo(core, 150000, input); // 6000 frames past the seam, at rate 1
    core.command(recPlay());
    run(core, 600, input);
    expect(core.tracks[0].flushPendingWrites()).toBe(true);
    const take = core.getTrackAudio(0)!.L;
    let wrong = 0;
    for (let j = 300; j < 5700; j++) if (Math.abs(take[j] - 0.25) > 1e-6) wrong++; // after the seam: once, exactly
    for (let j = 70000; j < 95000; j++) if (Math.abs(take[j] - 0.25) > 1e-6) wrong++; // before it, splices
    expect(wrong).toBe(0);
  });
});

describe('the exact path against the grid', () => {
  it.each([0, 1])(
    'a 133 bpm loop recorded from measure line %i stays within 0.75 of a frame of the grid, absolutely',
    (line) => {
      const { core } = silentLoop(133, line);
      expect(Math.abs(gridError(core))).toBeLessThan(0.76);
      for (let t = 0; t < 120; t += 3) {
        run(core, 3 * SR - 1);
        expect(Math.abs(gridError(core))).toBeLessThan(0.76);
        for (let k = 0; k < 7; k++) {
          run(core, 1);
          expect(Math.abs(gridError(core))).toBeLessThan(0.76);
        }
      }
    },
    60_000,
  );

  it('leaving the exact path on a replayed frame does not cross the seam a second time', () => {
    const { core, L } = silentLoop(124); // replays a frame every few passes
    configure(core, { play: { speedChange: 'LOOP END' } });
    // Find a replayed frame: the playhead shows the loop's last frame twice running (the second time it is frame -1).
    let found = false;
    const close = core.frame - 300;
    for (let k = 1; k <= 10 && !found; k++) {
      runTo(core, close + k * L - 12);
      let prev = -1;
      for (let i = 0; i < 24 && !found; i++) {
        run(core, 1, undefined, 1);
        const p = Math.round(trk(core).position * L);
        if (p === L - 1 && prev === L - 1) found = true;
        prev = p;
      }
    }
    expect(found).toBe(true);
    // Now on frame -1: a tempo change leaves the exact path (rate 0.968) and a speed change waits for the seam.
    configure(core, { tempo: 120, track: [{ tempoSyncSpeed: 'DOUBLE' }] });
    run(core, 5, undefined, 1);
    expect(trk(core).speed).toBe('NORMAL'); // no seam was crossed: the frame -1 is already past it
    expect(trk(core).position).toBeLessThan(10 / L);
  });
});
