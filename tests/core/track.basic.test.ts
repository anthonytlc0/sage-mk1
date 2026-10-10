import { describe, expect, it } from 'vitest';
import { at, clear, dc, makeCore, ramp, recPlay, run, stop, trk, XF } from './harness';

describe('track basics (free loop, LOOP SYNC OFF)', () => {
  it('REC->DUB: record, overdub, play; the length is set by the second press and layers add', () => {
    const core = makeCore({ rec: { recAction: 'REC->DUB' } });
    const input = (f: number): number => (f < 1000 ? 0.5 : 0.25);
    at(core, 0, recPlay(), input);
    const recording = at(core, 1000, recPlay(), input);
    expect(recording.tracks[0].every((v) => v === 0)).toBe(true); // a recording track outputs nothing
    expect(trk(core).state).toBe('overdubbing');
    at(core, 2000, recPlay(), input);

    const s = trk(core);
    expect(s.state).toBe('playing');
    expect(s.lengthFrames).toBe(1000);
    const out = run(core, 1000, input); // frames 2000..2999 are loop positions 0..999
    expect(out.tracks[0][500]).toBe(0.75);
  });

  it('REC->PLAY: the second press plays the loop', () => {
    const core = makeCore({ rec: { recAction: 'REC->PLAY' } });
    at(core, 0, recPlay(), dc(0.5));
    expect(trk(core).state).toBe('recording');
    at(core, 1000, recPlay(), dc(0.5));
    expect(trk(core).state).toBe('playing');
    expect(trk(core).lengthFrames).toBe(1000);
    const out = run(core, 2000);
    expect(out.tracks[0][500]).toBe(0.5); // first pass
    expect(out.tracks[0][1500]).toBe(0.5); // it loops
  });

  it('stop (IMMEDIATE) stops at once: the output ramps out over XF frames, then is silent', () => {
    const core = makeCore();
    at(core, 0, recPlay(), dc(0.5));
    at(core, 1000, recPlay(), dc(0.5));
    const before = at(core, 1500, stop());
    expect(before.tracks[0][499]).toBe(0.5);
    expect(trk(core).state).toBe('stopped');
    expect(trk(core).stopping).toBe(false);
    const after = run(core, 1000).tracks[0];
    for (let i = 1; i <= XF; i++) expect(after[i]).toBeLessThan(after[i - 1]); // a monotonic ramp down
    expect(after[0]).toBeLessThanOrEqual(0.5);
    expect(after.subarray(XF).every((v) => v === 0)).toBe(true); // silent after XF frames
    expect(trk(core).lengthFrames).toBe(1000); // the phrase is kept
  });

  it('clear empties the track', () => {
    const core = makeCore();
    at(core, 0, recPlay(), dc(0.5));
    at(core, 1000, recPlay(), dc(0.5));
    at(core, 1200, clear());
    run(core, 1);
    expect(trk(core).state).toBe('empty');
    expect(trk(core).lengthFrames).toBe(0);
    // Frame 1200 began a 5 ms ramp-out (frames 1200..1204); silent after it.
    expect(run(core, 500).tracks[0].subarray(XF - 1).every((v) => v === 0)).toBe(true);
    expect(core.status().memoryBytes).toBe(0);
  });

  it('recPlay from stopped plays from position 0', () => {
    const core = makeCore();
    at(core, 0, recPlay(), ramp);
    at(core, 1000, recPlay(), ramp);
    at(core, 1300, stop()); // stopped at loop position 300
    at(core, 2000, recPlay());
    expect(trk(core).state).toBe('playing');
    const out = run(core, 400);
    expect(out.tracks[0][100]).toBe(100); // the recorded ramp: position k holds k
    expect(out.tracks[0][399]).toBe(399);
    expect(trk(core).position).toBeCloseTo(0.4, 6);
  });

  it('the loop seam is crossfaded: the 5 ms after the end press is blended into the loop start', () => {
    const core = makeCore();
    at(core, 0, recPlay(), ramp);
    at(core, 1000, recPlay(), ramp);
    const out = run(core, 2000, ramp).tracks[0]; // frames 1000..2999: two passes
    // First pass: the loop as recorded (0, 1, 2, ...), once the XF start ramp is done.
    expect(out[0]).toBe(0);
    expect(out[XF]).toBe(XF);
    expect(out[XF + 3]).toBe(XF + 3);
    // Second pass: across the seam the ramp continues (999 -> 1000) instead of jumping back to 0...
    expect(out[999]).toBe(999);
    expect(out[1000]).toBe(1000);
    // ...and returns to the recorded audio over XF frames, never in one step.
    let maxStep = 0;
    for (let i = 995; i < 1000 + XF + 5; i++) maxStep = Math.max(maxStep, Math.abs(out[i + 1] - out[i]));
    expect(maxStep).toBeLessThanOrEqual(1000 / XF);
    expect(out[1000 + XF]).toBe(XF); // interior: untouched
  });

  it('REC->DUB: the overdub input is written at gain exactly 1 through the seam crossfade', () => {
    // Record silence, then overdub 0.5 straight from the end press; end the pass mid-loop (no punch-out at the seam).
    const core = makeCore({ rec: { recAction: 'REC->DUB' } });
    const input = (f: number): number => (f < 1000 ? 0 : 0.5);
    at(core, 0, recPlay(), input);
    at(core, 1000, recPlay(), input); // overdub from position 0
    at(core, 1500, recPlay(), input); // play from position 500
    run(core, 20, input);
    const L = core.getTrackAudio(0)!.L;
    for (let j = 0; j <= XF + 2; j++) expect(L[j]).toBeCloseTo(0.5, 6); // no dip in the first XF frames
    expect(L[400]).toBe(0.5);
    expect(L[700]).toBe(0);
  });

  it('REC->DUB: through the seam the recording crossfades in under the full-gain overdub', () => {
    const core = makeCore({ rec: { recAction: 'REC->DUB' } });
    const input = (f: number): number => (f < 1000 ? 0.5 : 0.25);
    at(core, 0, recPlay(), input);
    at(core, 1000, recPlay(), input);
    at(core, 1500, recPlay(), input);
    run(core, 20, input);
    const L = core.getTrackAudio(0)!.L;
    // Position j < XF: the recording at weight j/XF (the seam crossfade) plus the overdub at weight 1.
    for (let j = 0; j <= XF; j++) expect(L[j]).toBeCloseTo(0.5 * (j / XF) + 0.25, 6);
    expect(L[400]).toBe(0.75);
  });

  it('overdub punch-in and punch-out ramp over 5 ms', () => {
    const core = makeCore();
    const input = (f: number): number => (f < 1000 ? 0.5 : 0.25);
    at(core, 0, recPlay(), input);
    at(core, 1000, recPlay(), input); // play
    at(core, 1300, recPlay(), input); // overdub from position 300
    at(core, 1600, recPlay(), input); // play from position 600
    const out = run(core, 1400, input).tracks[0]; // frames 1600..2999; position p is at index p + 400
    const pos = (p: number): number => out[p + 400];
    expect(pos(250)).toBe(0.5);
    expect(pos(450)).toBe(0.75);
    expect(pos(650)).toBe(0.5);
    let maxStep = 0;
    for (let p = 290; p < 620; p++) maxStep = Math.max(maxStep, Math.abs(pos(p + 1) - pos(p)));
    expect(maxStep).toBeLessThanOrEqual(0.25 / XF + 1e-6);
  });
});
