import { describe, expect, it } from 'vitest';
import { at, dc, makeCore, ramp, recPlay, run, stop, trk, XF } from './harness';

/** 0.5 while recording (frames < 1000), 0.25 after. */
const layered = (f: number): number => (f < 1000 ? 0.5 : 0.25);

describe('DUB MODE', () => {
  it('REPLACE1 overwrites while the old audio is still heard', () => {
    const core = makeCore({ track: [{ dubMode: 'REPLACE1' }] });
    at(core, 0, recPlay(), layered);
    at(core, 1000, recPlay(), layered); // play
    at(core, 2000, recPlay(), layered); // overdub a whole pass
    const during = at(core, 3000, recPlay(), layered).tracks[0];
    expect(during[500]).toBe(0.5); // the old audio plays during the pass
    expect(trk(core).state).toBe('playing');
    const after = run(core, 1000, layered).tracks[0];
    expect(after[500]).toBe(0.25); // ...and was replaced
  });

  it('REPLACE2 overwrites without playing the track', () => {
    const core = makeCore({ track: [{ dubMode: 'REPLACE2' }] });
    at(core, 0, recPlay(), layered);
    at(core, 1000, recPlay(), layered);
    at(core, 2000, recPlay(), layered);
    const during = at(core, 3000, recPlay(), layered).tracks[0];
    expect(during.subarray(XF, 1000 - XF).every((v) => v === 0)).toBe(true); // silent apart from the 5 ms mute ramps
    const after = run(core, 1000, layered).tracks[0];
    expect(after[500]).toBe(0.25);
  });

  it.each(['REPLACE1', 'REPLACE2'] as const)(
    'REC->DUB into %s has no seam dip: the replaced loop start is exactly the input',
    (dubMode) => {
      // Record silence, then replace it with 0.5 straight from the recording. The recording's seam crossfade already
      // fades the input in over the loop start, so the pass must not ramp it in a second time (which gave
      // 0.5 0.42 0.38 0.38 0.42 0.5, a 1 - u + u^2 dip).
      const core = makeCore({ rec: { recAction: 'REC->DUB' }, track: [{ dubMode }] });
      const input = (f: number): number => (f < 1000 ? 0 : 0.5);
      at(core, 0, recPlay(), input);
      at(core, 1000, recPlay(), input); // overdubbing (replacing) from position 0
      at(core, 2000, recPlay(), input); // a whole pass replaced
      run(core, 10, input);
      const a = core.getTrackAudio(0)!.L;
      expect(Array.from(a.subarray(0, XF + 1))).toEqual([0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
      expect(a.every((v) => v === 0.5)).toBe(true);
    },
  );

  it('a REPLACE pass from playback still ramps in over XF frames', () => {
    const core = makeCore({ track: [{ dubMode: 'REPLACE1' }] });
    const input = (f: number): number => (f < 1000 ? 0 : 0.5);
    at(core, 0, recPlay(), input);
    at(core, 1000, recPlay(), input);
    at(core, 2500, recPlay(), input); // punch in at position 500
    at(core, 2700, recPlay(), input);
    run(core, 10, input);
    const a = core.getTrackAudio(0)!.L;
    expect(a[500]).toBe(0);
    expect(a[502]).toBeCloseTo(0.5 * (2 / XF), 6);
    expect(a[600]).toBe(0.5);
  });

  it('OVERDUB adds; the output during the pass is the old audio', () => {
    const core = makeCore({ track: [{ dubMode: 'OVERDUB' }] });
    at(core, 0, recPlay(), layered);
    at(core, 1000, recPlay(), layered);
    at(core, 2000, recPlay(), layered);
    const during = at(core, 3000, recPlay(), layered).tracks[0];
    expect(during[500]).toBe(0.5);
    expect(run(core, 1000, layered).tracks[0][500]).toBe(0.75);
  });
});

describe('STOP MODE', () => {
  it('FADE fades out over FADE TIME OUT, then stops; a second STOP stops at once', () => {
    // tempo 120, 4/4, sr 1000: one measure is 2000 frames.
    const core = makeCore({ tempo: 120, track: [{ stopMode: 'FADE' }], play: { fadeOut: { measures: 1 } } });
    at(core, 0, recPlay(), dc(0.5));
    at(core, 1000, recPlay(), dc(0.5));
    at(core, 1500, stop(), dc(0.5)); // input continues through the seam crossfade after the end press
    expect(trk(core).state).toBe('playing');
    expect(trk(core).stopping).toBe(true);
    const fading = run(core, 1999).tracks[0]; // frames 1500..3498
    expect(fading[0]).toBe(0.5);
    expect(fading[1000]).toBeCloseTo(0.25, 6);
    expect(fading[1998]).toBeGreaterThan(0);
    expect(fading[1998]).toBeLessThan(0.001);
    for (let i = 1; i < fading.length; i++) expect(fading[i]).toBeLessThanOrEqual(fading[i - 1]);
    expect(trk(core).stopping).toBe(true);
    const end = run(core, 10).tracks[0]; // frame 3499 is the last fading frame; 3500 = +2000
    expect(end[0]).toBeGreaterThan(0);
    expect(end[1]).toBe(0);
    expect(trk(core).state).toBe('stopped');
    expect(trk(core).stopping).toBe(false);
  });

  it('FADE: a second STOP while fading stops at the next frame', () => {
    const core = makeCore({ tempo: 120, track: [{ stopMode: 'FADE' }], play: { fadeOut: { measures: 1 } } });
    at(core, 0, recPlay(), dc(0.5));
    at(core, 1000, recPlay(), dc(0.5));
    at(core, 1500, stop());
    at(core, 2000, stop());
    expect(trk(core).state).toBe('stopped');
    expect(trk(core).stopping).toBe(false);
    expect(run(core, 500).tracks[0].subarray(XF).every((v) => v === 0)).toBe(true); // silent after XF frames
  });

  it('LOOP plays to the loop end, then stops', () => {
    const core = makeCore({ track: [{ stopMode: 'LOOP' }] });
    at(core, 0, recPlay(), dc(0.5));
    at(core, 1000, recPlay(), dc(0.5));
    at(core, 1300, stop(), dc(0.5)); // loop position 300; the input runs on through the seam crossfade
    expect(trk(core).stopping).toBe(true);
    const tail = run(core, 1000).tracks[0]; // frames 1300..2299; the loop ends at 2000
    expect(tail[0]).toBe(0.5);
    expect(tail[699]).toBe(0.5); // position 999
    for (let i = 700; i <= 700 + XF; i++) expect(tail[i]).toBeLessThanOrEqual(tail[i - 1]); // XF ramp after the loop end
    expect(tail.subarray(700 + XF).every((v) => v === 0)).toBe(true);
    expect(trk(core).state).toBe('stopped');
    expect(trk(core).stopping).toBe(false);
  });
});

describe('START MODE', () => {
  it('FADE ramps from 0 to full over FADE TIME IN', () => {
    const core = makeCore({ tempo: 120, track: [{ startMode: 'FADE' }], play: { fadeIn: { measures: 1 } } });
    at(core, 0, recPlay(), dc(0.5));
    at(core, 1000, recPlay(), dc(0.5)); // playback right after recording does not fade in
    expect(run(core, 10, dc(0.5)).tracks[0][9]).toBe(0.5);
    at(core, 1500, stop());
    at(core, 3000, recPlay());
    const out = run(core, 2500).tracks[0]; // frames 3000..5499
    expect(out[0]).toBe(0);
    expect(out[1100]).toBeCloseTo(0.5 * (1100 / 2000), 6);
    for (let i = 1; i < 2000; i++) expect(out[i]).toBeGreaterThanOrEqual(out[i - 1]);
    expect(out[2100]).toBe(0.5);
  });

  it('IMMEDIATE starts at full level', () => {
    const core = makeCore({ track: [{ startMode: 'IMMEDIATE' }] });
    at(core, 0, recPlay(), dc(0.5));
    at(core, 1000, recPlay(), dc(0.5));
    at(core, 1500, stop());
    at(core, 3000, recPlay());
    expect(run(core, 100).tracks[0][XF + 1]).toBe(0.5);
  });
});

describe('1SHOT', () => {
  it('plays once and stops; a press during playback retriggers from the start; no overdub', () => {
    const core = makeCore({ track: [{ oneShot: true }] });
    at(core, 0, recPlay(), ramp);
    at(core, 1000, recPlay(), ramp); // plays once: frames 1000..1999
    const once = run(core, 1500).tracks[0];
    expect(once[500]).toBe(500);
    expect(once.subarray(1000 + XF).every((v) => v === 0)).toBe(true); // an XF ramp after the end, then silence
    expect(trk(core).state).toBe('stopped');

    at(core, 3000, recPlay());
    expect(trk(core).state).toBe('playing');
    at(core, 3400, recPlay()); // retrigger at position 400
    expect(trk(core).state).toBe('playing'); // not overdubbing
    const re = run(core, 1200).tracks[0];
    expect(re[100]).toBe(100);
    expect(re[999]).toBe(999);
    expect(re.subarray(1000 + XF).every((v) => v === 0)).toBe(true);
    expect(trk(core).state).toBe('stopped');
  });

  it('REC->DUB ends the recording in playback, since a 1SHOT track cannot overdub', () => {
    const core = makeCore({ rec: { recAction: 'REC->DUB' }, track: [{ oneShot: true }] });
    at(core, 0, recPlay(), dc(0.5));
    at(core, 1000, recPlay(), dc(0.5));
    expect(trk(core).state).toBe('playing');
  });
});

describe('REVERSE', () => {
  it('plays the phrase backwards; a press during playback does not overdub', () => {
    const core = makeCore({ track: [{ reverse: true }] });
    at(core, 0, recPlay(), ramp); // records 0..999
    at(core, 1000, recPlay(), ramp);
    const out = run(core, 500, ramp).tracks[0]; // frames 1000..1499; the first XF frames ramp in
    expect(out[XF]).toBe(999 - XF);
    expect(out[XF + 1]).toBe(998 - XF);
    expect(out[499]).toBe(500);
    at(core, 1500, recPlay(), ramp);
    expect(trk(core).state).toBe('playing');
    const more = run(core, 600, ramp).tracks[0]; // frames 1500..2099: positions 499 down to 0, then from 999
    expect(more[0]).toBe(499);
    expect(more[400]).toBe(99);
    expect(more[550]).toBe(949); // wrapped to the end, still unchanged: no overdub happened
  });

  it('REC->DUB ends the recording in playback, since a REVERSE track cannot overdub', () => {
    const core = makeCore({ rec: { recAction: 'REC->DUB' }, track: [{ reverse: true }] });
    at(core, 0, recPlay(), dc(0.5));
    at(core, 1000, recPlay(), dc(0.5));
    expect(trk(core).state).toBe('playing');
  });
});

describe('PAN and PLAY LEVEL', () => {
  it('PAN L50 silences the right channel; CENTER is unity on both', () => {
    const core = makeCore({ track: [{ pan: -50 }, { pan: 0 }] });
    at(core, 0, recPlay(0), dc(0.5));
    core.command(recPlay(1), 0);
    at(core, 1000, recPlay(0), dc(0.5));
    core.command(recPlay(1), 1000);
    const out = run(core, 1000);
    expect(out.tracks[0][500]).toBe(0.5);
    expect(out.tracksR[0][500]).toBe(0);
    expect(out.tracks[1][500]).toBe(0.5);
    expect(out.tracksR[1][500]).toBe(0.5);
  });

  it('PAN R25 halves the left channel', () => {
    const core = makeCore({ track: [{ pan: 25 }] });
    at(core, 0, recPlay(), dc(0.5));
    at(core, 1000, recPlay(), dc(0.5));
    const out = run(core, 1000);
    expect(out.tracks[0][500]).toBe(0.25);
    expect(out.tracksR[0][500]).toBe(0.5);
  });

  it('PLAY LEVEL 200 doubles the output', () => {
    const core = makeCore({ track: [{ playLevel: 200 }] });
    at(core, 0, recPlay(), dc(0.25));
    at(core, 1000, recPlay(), dc(0.25));
    const out = run(core, 1000);
    expect(out.tracks[0][500]).toBe(0.5);
    expect(out.tracksR[0][500]).toBe(0.5);
  });
});
