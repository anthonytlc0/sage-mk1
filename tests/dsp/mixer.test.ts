import { describe, it, expect } from 'vitest';
import { Mixer, faderGain, panGains } from '../../src/dsp/mixer';
import { defaultSystem } from '../../src/schema/params';
import type { SystemSettings } from '../../src/schema/types';
import { allFinite, fill } from './helpers';

const N = 128;
type Stereo = [Float32Array, Float32Array];
const stereo = (l = 0, r = l): Stereo => [fill(N, l), fill(N, r)];
const silentTracks = (): Stereo[] => Array.from({ length: 5 }, () => stereo(0));

/** Runs the mixer for a few blocks so any gain ramp has settled, and returns the last block. */
function run(mixer: Mixer, tracks: Stereo[], input: Stereo, rhythm: Stereo) {
  const out = stereo(), perf = stereo();
  for (let i = 0; i < 4; i++) mixer.process(tracks, input, rhythm, out, perf, N);
  return { out, perf };
}

function setup(edit?: (sys: SystemSettings) => void): { mixer: Mixer; sys: SystemSettings } {
  const sys = defaultSystem();
  edit?.(sys);
  const mixer = new Mixer(48000);
  mixer.configure(sys);
  return { mixer, sys };
}

describe('panGains', () => {
  it('is constant power: centre is 1/sqrt(2) each side', () => {
    const [l, r] = panGains(0);
    expect(l).toBeCloseTo(0.7071, 4);
    expect(r).toBeCloseTo(0.7071, 4);
  });
  it('hard left is [1, 0] and hard right is [0, 1]', () => {
    expect(panGains(-50)).toEqual([1, 0]);
    expect(panGains(50)).toEqual([0, 1]);
  });
  it('keeps l^2 + r^2 = 1 across the range and clamps out-of-range pans', () => {
    for (let p = -50; p <= 50; p += 5) {
      const [l, r] = panGains(p);
      expect(l * l + r * r).toBeCloseTo(1, 12);
    }
    expect(panGains(-80)).toEqual([1, 0]);
    expect(panGains(80)).toEqual([0, 1]);
  });
});

describe('faderGain', () => {
  it('is 0 at the bottom and unity at the top', () => {
    expect(faderGain(0)).toBe(0);
    expect(faderGain(1)).toBe(1);
  });
  it('is a squared (audio) taper in between and clamps', () => {
    expect(faderGain(0.5)).toBeCloseTo(0.25, 12);
    expect(faderGain(-1)).toBe(0);
    expect(faderGain(2)).toBe(1);
  });
});

describe('Mixer: tracks', () => {
  it('passes tracks to out and perf at unity with default settings', () => {
    const { mixer } = setup();
    const tracks = silentTracks();
    tracks[0] = stereo(0.5, 0.25);
    const { out, perf } = run(mixer, tracks, stereo(0), stereo(0));
    expect(out[0][10]).toBeCloseTo(0.5, 6);
    expect(out[1][10]).toBeCloseTo(0.25, 6);
    expect(perf[0][10]).toBeCloseTo(0.5, 6);
    expect(perf[1][10]).toBeCloseTo(0.25, 6);
  });

  it('sums all five tracks', () => {
    const { mixer } = setup();
    const tracks = [stereo(0.1), stereo(0.2), stereo(0.3), stereo(0.05), stereo(0.01)];
    const { out } = run(mixer, tracks, stereo(0), stereo(0));
    expect(out[0][0]).toBeCloseTo(0.66, 6);
    expect(out[1][0]).toBeCloseTo(0.66, 6);
  });

  it('applies the per-track fader gain given to setFader', () => {
    const { mixer } = setup();
    mixer.setFader(1, faderGain(0.5));
    const tracks = silentTracks();
    tracks[1] = stereo(0.8);
    tracks[2] = stereo(0.1);
    const { out } = run(mixer, tracks, stereo(0), stereo(0));
    expect(out[0][5]).toBeCloseTo(0.8 * 0.25 + 0.1, 6);
  });

  it('ramps a fader move over the block instead of stepping (no zipper)', () => {
    const { mixer } = setup();
    const tracks = silentTracks();
    tracks[0] = stereo(1);
    const out = stereo(), perf = stereo();
    mixer.process(tracks, stereo(0), stereo(0), out, perf, N);   // settle at unity
    mixer.setFader(0, 0);
    mixer.process(tracks, stereo(0), stereo(0), out, perf, N);
    expect(out[0][0]).toBeGreaterThan(0.9);
    expect(out[0][N - 1]).toBeLessThan(0.05);
    for (let i = 1; i < N; i++) expect(out[0][i]!).toBeLessThanOrEqual(out[0][i - 1]!);
    mixer.process(tracks, stereo(0), stereo(0), out, perf, N);
    expect(out[0][0]).toBe(0);
  });

  it('scales tracks by MIXER LOOP OUT (v/100)', () => {
    const { mixer } = setup((s) => { s.mixer.loopOut = 50; });
    const tracks = silentTracks();
    tracks[0] = stereo(0.4);
    expect(run(mixer, tracks, stereo(0), stereo(0)).out[0][3]).toBeCloseTo(0.2, 6);
    const hot = setup((s) => { s.mixer.loopOut = 200; });
    expect(run(hot.mixer, tracks, stereo(0), stereo(0)).out[0][3]).toBeCloseTo(0.8, 6);
  });

  it('hears a track routed to MAIN, SUB1 or SUB2 once, not once per jack', () => {
    const { mixer } = setup();   // default: every track routed to every jack
    const tracks = silentTracks();
    tracks[0] = stereo(0.3);
    expect(run(mixer, tracks, stereo(0), stereo(0)).out[0][0]).toBeCloseTo(0.3, 6);
  });

  it('hears a track routed only to a SUB jack', () => {
    const { mixer } = setup((s) => {
      for (const jack of ['MAINL', 'MAINR', 'SUB1R', 'SUB2L', 'SUB2R'] as const) s.output.routing.track[jack][2] = false;
      s.output.routing.track.PHONES[2] = false;
    });
    const tracks = silentTracks();
    tracks[2] = stereo(0.3, 0.2);
    const { out } = run(mixer, tracks, stereo(0), stereo(0));
    expect(out[0][0]).toBeCloseTo(0.3, 6);      // SUB1-L still routed
    expect(out[1][0]).toBe(0);                  // right side routed nowhere
  });

  it('mutes a track that is routed only to PHONES', () => {
    const { mixer } = setup((s) => {
      for (const jack of ['MAINL', 'MAINR', 'SUB1L', 'SUB1R', 'SUB2L', 'SUB2R'] as const) s.output.routing.track[jack][3] = false;
    });
    const tracks = silentTracks();
    tracks[3] = stereo(0.7);
    const { out, perf } = run(mixer, tracks, stereo(0), stereo(0));
    expect(out[0][0]).toBe(0);
    expect(out[1][0]).toBe(0);
    expect(perf[0][0]).toBe(0);
  });
});

describe('Mixer: input and the recorder bus', () => {
  it('INPUT THRU OFF: out has no input, perf has it', () => {
    const { mixer, sys } = setup();
    expect(sys.output.routing.inputThru).toBe(false);
    const { out, perf } = run(mixer, silentTracks(), stereo(0.4), stereo(0));
    expect(out[0][7]).toBe(0);
    expect(out[1][7]).toBe(0);
    expect(perf[0][7]).toBeCloseTo(0.4, 6);
    expect(perf[1][7]).toBeCloseTo(0.4, 6);
  });

  it('INPUT THRU ON: out has the input too', () => {
    const { mixer } = setup((s) => { s.output.routing.inputThru = true; });
    const { out, perf } = run(mixer, silentTracks(), stereo(0.4), stereo(0));
    expect(out[0][7]).toBeCloseTo(0.4, 6);
    expect(perf[0][7]).toBeCloseTo(0.4, 6);
  });

  it('INPUT THRU ON but MIC1 routed to no output: out stays silent, perf still has the input', () => {
    const { mixer } = setup((s) => {
      s.output.routing.inputThru = true;
      for (const dest of ['MAIN', 'SUB1', 'SUB2'] as const) s.output.routing.inputRhythm[dest].MIC1 = false;
    });
    const { out, perf } = run(mixer, silentTracks(), stereo(0.4), stereo(0));
    expect(out[0][7]).toBe(0);
    expect(perf[0][7]).toBeCloseTo(0.4, 6);
  });

  it('perf is the out mix plus the input: tracks and rhythm are in both', () => {
    const { mixer } = setup();
    const tracks = silentTracks();
    tracks[0] = stereo(0.2);
    const { out, perf } = run(mixer, tracks, stereo(0.1), stereo(0.05));
    expect(out[0][0]).toBeCloseTo(0.2 + 0.05, 6);
    expect(perf[0][0]).toBeCloseTo(0.2 + 0.05 + 0.1, 6);
  });

  it('does not switch the input into out abruptly: the THRU change ramps over a block', () => {
    const { mixer, sys } = setup();
    const out = stereo(), perf = stereo();
    const input = stereo(0.5);
    mixer.process(silentTracks(), input, stereo(0), out, perf, N);
    sys.output.routing.inputThru = true;
    mixer.configure(sys);
    mixer.process(silentTracks(), input, stereo(0), out, perf, N);
    expect(out[0][0]).toBeLessThan(0.05);
    expect(out[0][N - 1]).toBeGreaterThan(0.45);
  });
});

describe('Mixer: rhythm', () => {
  it('scales the rhythm by RHYTHM OUT (v/100) when RHYTHM OUT is OUTPUT', () => {
    const { mixer } = setup((s) => { s.mixer.rhythmOut = 50; s.mixer.loopOut = 200; });
    expect(run(mixer, silentTracks(), stereo(0), stereo(0.6)).out[0][0]).toBeCloseTo(0.3, 6);
  });

  it('is silent when RHYTHM is routed to none of MAIN / SUB1 / SUB2', () => {
    const { mixer } = setup((s) => {
      for (const dest of ['MAIN', 'SUB1', 'SUB2'] as const) s.output.routing.inputRhythm[dest].RHYTHM = false;
    });
    const { out, perf } = run(mixer, silentTracks(), stereo(0), stereo(0.6));
    expect(out[0][0]).toBe(0);
    expect(perf[0][0]).toBe(0);
  });

  it('follows LOOP OUT instead of RHYTHM OUT when RHYTHM OUT is set to LOOP', () => {
    const { mixer } = setup((s) => { s.output.routing.rhythmOut = 'LOOP'; s.mixer.rhythmOut = 0; s.mixer.loopOut = 50; });
    expect(run(mixer, silentTracks(), stereo(0), stereo(0.6)).out[0][0]).toBeCloseTo(0.3, 6);
  });
});

describe('Mixer: robustness', () => {
  it('returns finite values for a 1e-30 input', () => {
    const { mixer } = setup((s) => { s.output.routing.inputThru = true; });
    const tracks = Array.from({ length: 5 }, () => stereo(1e-30));
    const { out, perf } = run(mixer, tracks, stereo(1e-30), stereo(1e-30));
    for (const b of [...out, ...perf]) expect(allFinite(b)).toBe(true);
  });

  it('accepts a short final block', () => {
    const { mixer } = setup();
    const tracks = silentTracks();
    tracks[0] = stereo(0.5);
    const out = stereo(), perf = stereo();
    mixer.process(tracks, stereo(0), stereo(0), out, perf, 37);
    expect(out[0][36]).toBeCloseTo(0.5, 6);
    expect(out[0][37]).toBe(0);
  });
});
