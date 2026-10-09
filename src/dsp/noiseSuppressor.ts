/**
 * Noise suppressor for the mic (MIC1 NS, 0-100): a downward expander.
 *
 * The guide gives only the 0-100 range, so the whole curve is INFERRED: NS 0 is off (a bit-exact passthrough) and each
 * step raises the threshold below which the signal is pushed down, from -80 dBFS (NS 1) to -35 dBFS (NS 100). Below the
 * threshold the level falls 2 dB for every dB the signal sits under it (a 3:1 expander), down to a floor of -60 dB.
 * The gain opens in about a millisecond so word onsets are not clipped and closes over ~100 ms so tails are not chopped.
 *
 * Audio-thread code: no allocation in process().
 */

import { FLUSH } from './biquad';

const DETECTOR_S = 0.005;
const OPEN_S = 0.001;
const CLOSE_S = 0.100;
// INFERRED: the times above and the gain computer below. SLOPE is the dB of extra attenuation per dB under the
// threshold (a 3:1 expander is a slope of 2); FLOOR_DB is the deepest cut.
const SLOPE = 2;
const FLOOR_DB = -60;
const LN10_20 = Math.LN10 / 20;

/** Threshold in dBFS (RMS) for a NS setting 1..100. */
// INFERRED
export function nsThresholdDb(ns: number): number { return -80 + 0.45 * ns; }

const coef = (seconds: number, sr: number): number => Math.exp(-1 / (seconds * sr));

export class NoiseSuppressor {
  private readonly aDet: number;
  private readonly aOpen: number;
  private readonly aClose: number;

  private amount = 0;
  private thr = 0;
  private thrLin = 0;   // mean-square at the threshold; at or above it the expander does nothing
  private env = 0;      // mean-square
  private gain = 0;     // smoothed gain in dB (<= 0)

  constructor(sr: number) {
    this.aDet = coef(DETECTOR_S, sr);
    this.aOpen = coef(OPEN_S, sr);
    this.aClose = coef(CLOSE_S, sr);
  }

  /** 0 = off, 1..100 = suppression amount. */
  setAmount(ns: number): void {
    this.amount = ns > 0 ? ns : 0;
    this.thr = nsThresholdDb(this.amount);
    this.thrLin = Math.pow(10, this.thr / 10);
  }

  /** Expands `buf[0..n)` in place. */
  process(buf: Float32Array, n: number): void {
    if (this.amount === 0 && this.gain === 0) return;
    for (let i = 0; i < n; i++) {
      const x = buf[i]!;
      let env = x * x + this.aDet * (this.env - x * x);
      if (env < FLUSH) env = 0;
      this.env = env;

      let target = 0;
      if (this.amount > 0 && env < this.thrLin) {
        target = SLOPE * (10 * Math.log10(env + 1e-30) - this.thr);
        if (target < FLOOR_DB) target = FLOOR_DB;
      }

      const g0 = this.gain;
      const a = target > g0 ? this.aOpen : this.aClose;
      let g = target + a * (g0 - target);
      if (g > -1e-6) g = 0;
      this.gain = g;
      buf[i] = g === 0 ? x : x * Math.exp(g * LN10_20);
    }
  }

  reset(): void { this.env = 0; this.gain = 0; }
}
