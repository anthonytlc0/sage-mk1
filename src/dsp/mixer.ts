/**
 * The mixer: fader taper, pan law, and the sum of the five tracks, the input and the rhythm into two stereo buses.
 *
 *   out  = what you hear: tracks (fader x LOOP OUT, per OUTPUT ROUTING) + rhythm (RHYTHM OUT) + the mic only while
 *          INPUT THRU is ON and MIC1 is routed to an output.
 *   perf = the recorder bus: the same mix with the mic always included.
 *
 * The app has one stereo output, so the hardware's MAIN / SUB1 / SUB2 jacks collapse into it: a track routed to any of
 * the three is heard, once (not once per jack). PHONES routing and the SUB / PHONES OUT levels do not affect `out`.
 * Gains that change (a fader move, a menu edit) ramp linearly across the next block, so there is no zipper noise.
 * Audio-thread code: nothing allocates in process().
 */

import type { SystemSettings } from '../schema/types';

const TRACKS = 5;

/**
 * Fader position 0..1 to linear gain: 0 is silence, the top (1) is unity, and `pos^2` in between gives an audio
 * taper. The manuals do not give the hardware's fader curve.
 */
// INFERRED
export function faderGain(pos: number): number {
  if (!(pos > 0)) return 0;
  return pos >= 1 ? 1 : pos * pos;
}

/** Constant-power pan law for a pan of -50 (hard left) .. 50 (hard right): `[left, right]` gains, centre = 1/sqrt(2). */
export function panGains(pan: number): [number, number] {
  const p = pan !== pan ? 0 : Math.min(50, Math.max(-50, pan));
  if (p <= -50) return [1, 0];
  if (p >= 50) return [0, 1];
  const theta = ((p + 50) / 100) * (Math.PI / 2);
  return [Math.cos(theta), Math.sin(theta)];
}

type Stereo = [Float32Array, Float32Array];

export class Mixer {
  // Targets, set by configure() / setFader().
  private readonly fader = new Float64Array(TRACKS).fill(1);
  private readonly routeL = new Uint8Array(TRACKS).fill(1);
  private readonly routeR = new Uint8Array(TRACKS).fill(1);
  private loop = 1;
  private rhythm = 1;
  private thru = 0;

  // Where each gain is now (the previous block's end).
  private readonly curL = new Float64Array(TRACKS);
  private readonly curR = new Float64Array(TRACKS);
  private curRhythm = 0;
  private curThru = 0;
  /** True until the first block: gains jump straight to their targets instead of fading in from silence. */
  private snap = true;

  constructor(readonly sr: number) {}

  configure(sys: SystemSettings): void {
    const r = sys.output.routing;
    for (let i = 0; i < TRACKS; i++) {
      this.routeL[i] = r.track.MAINL[i] || r.track.SUB1L[i] || r.track.SUB2L[i] ? 1 : 0;
      this.routeR[i] = r.track.MAINR[i] || r.track.SUB1R[i] || r.track.SUB2R[i] ? 1 : 0;
    }
    const m = sys.mixer;
    this.loop = m.loopOut / 100;
    // INFERRED: RHYTHM OUT = LOOP sends the rhythm with the loop sound, so it follows LOOP OUT; OUTPUT uses its own RHYTHM OUT level.
    const rhythmRouted = r.inputRhythm.MAIN.RHYTHM || r.inputRhythm.SUB1.RHYTHM || r.inputRhythm.SUB2.RHYTHM;
    this.rhythm = rhythmRouted ? (r.rhythmOut === 'LOOP' ? m.loopOut : m.rhythmOut) / 100 : 0;
    // The app's one mic is MIC1. Its level is already applied by the InputChain (MIXER MIC 1 IN).
    const micRouted = r.inputRhythm.MAIN.MIC1 || r.inputRhythm.SUB1.MIC1 || r.inputRhythm.SUB2.MIC1;
    this.thru = r.inputThru && micRouted ? 1 : 0;
  }

  /** Sets track `i`'s fader to a linear gain, as returned by faderGain(). */
  setFader(i: number, gain: number): void {
    if (i >= 0 && i < TRACKS) this.fader[i] = gain > 0 ? gain : 0;
  }

  process(tracks: Stereo[], input: Stereo, rhythm: Stereo, out: Stereo, perf: Stereo, n: number): void {
    const outL = out[0], outR = out[1];
    outL.fill(0, 0, n);
    outR.fill(0, 0, n);
    if (this.snap) this.settle();

    const count = tracks.length < TRACKS ? tracks.length : TRACKS;
    for (let i = 0; i < count; i++) {
      const t = tracks[i]!;
      const gl = this.fader[i]! * this.loop * this.routeL[i]!;
      const gr = this.fader[i]! * this.loop * this.routeR[i]!;
      accumulate(outL, t[0], this.curL[i]!, gl, n);
      accumulate(outR, t[1], this.curR[i]!, gr, n);
      this.curL[i] = gl;
      this.curR[i] = gr;
    }
    accumulate(outL, rhythm[0], this.curRhythm, this.rhythm, n);
    accumulate(outR, rhythm[1], this.curRhythm, this.rhythm, n);
    this.curRhythm = this.rhythm;

    // perf: the mix so far plus the mic at unity. out: the mix plus the mic only through the THRU gate.
    const perfL = perf[0], perfR = perf[1], inL = input[0], inR = input[1];
    for (let k = 0; k < n; k++) { perfL[k] = outL[k]! + inL[k]!; perfR[k] = outR[k]! + inR[k]!; }
    accumulate(outL, inL, this.curThru, this.thru, n);
    accumulate(outR, inR, this.curThru, this.thru, n);
    this.curThru = this.thru;
    this.snap = false;
  }

  /** First block only: put every "current" gain at its target. */
  private settle(): void {
    for (let i = 0; i < TRACKS; i++) {
      this.curL[i] = this.fader[i]! * this.loop * this.routeL[i]!;
      this.curR[i] = this.fader[i]! * this.loop * this.routeR[i]!;
    }
    this.curRhythm = this.rhythm;
    this.curThru = this.thru;
  }
}

/** dst[k] += src[k] * g, with g moving linearly from g0 to g1 across the n samples. */
function accumulate(dst: Float32Array, src: Float32Array, g0: number, g1: number, n: number): void {
  if (g0 === g1) {
    if (g1 === 0) return;
    for (let k = 0; k < n; k++) dst[k] = dst[k]! + src[k]! * g1;
    return;
  }
  const step = (g1 - g0) / n;
  let g = g0;
  for (let k = 0; k < n; k++) { dst[k] = dst[k]! + src[k]! * g; g += step; }
}
