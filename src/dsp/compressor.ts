/**
 * Feed-forward RMS compressor for MIC1 COMP (depth OFF, 1-100) and the MASTER FX COMP (depth OFF, 1-40).
 *
 * The guide gives only the depth range, so the depth -> threshold / ratio / time mappings below are INFERRED: depth 1
 * is a light touch (high threshold, low ratio) and the top depth is a heavy squash. There is no make-up gain (the
 * MIXER levels are the volume control), so a deeper setting is also a quieter one.
 *
 * Detector: one-pole mean-square (10 ms) -> dB -> soft-knee gain computer -> attack / release smoothing of the gain
 * reduction in dB. Audio-thread code: all state lives in fields, nothing allocates in the process methods.
 */

import { FLUSH } from './biquad';

export type CompKind = 'mic' | 'master';

/** Soft-knee width in dB. */
const KNEE_DB = 6;
/** Mean-square detector time constant in seconds. */
const DETECTOR_S = 0.010;
const LN10_20 = Math.LN10 / 20;

interface Curve { thrHi: number; thrLo: number; ratioLo: number; ratioHi: number; attackS: number; releaseS: number; maxDepth: number }

// INFERRED
// Depth d in 1..max maps t = (d - 1) / (max - 1) to threshold = thrHi + t * (thrLo - thrHi) dBFS (RMS) and
// ratio = ratioLo + t * (ratioHi - ratioLo). The master comp is gentler (it works on the whole mix) and slower.
const CURVES: Record<CompKind, Curve> = {
  mic: { thrHi: -10, thrLo: -30, ratioLo: 1.5, ratioHi: 6, attackS: 0.010, releaseS: 0.150, maxDepth: 100 },
  master: { thrHi: -6, thrLo: -24, ratioLo: 1.5, ratioHi: 4, attackS: 0.020, releaseS: 0.250, maxDepth: 40 },
};

const coef = (seconds: number, sr: number): number => Math.exp(-1 / (seconds * sr));

export class Compressor {
  private readonly curve: Curve;
  private readonly aRms: number;
  private readonly aAtt: number;
  private readonly aRel: number;

  private active = false;
  private thr = 0;
  private slope = 0;          // 1 / ratio - 1  (negative)
  private kneeLoLin = 0;      // mean-square below which the gain computer reads 0 dB reduction
  private env = 0;            // mean-square
  private gr = 0;             // smoothed gain reduction in dB (<= 0)

  constructor(sr: number, kind: CompKind) {
    this.curve = CURVES[kind];
    this.aRms = coef(DETECTOR_S, sr);
    this.aAtt = coef(this.curve.attackS, sr);
    this.aRel = coef(this.curve.releaseS, sr);
  }

  /** 'OFF' bypasses (after letting any gain reduction in progress release); a number is the depth, 1..max. */
  setDepth(depth: 'OFF' | number): void {
    if (depth === 'OFF') { this.active = false; return; }
    const c = this.curve;
    const t = Math.min(Math.max((depth - 1) / (c.maxDepth - 1), 0), 1);
    this.thr = c.thrHi + t * (c.thrLo - c.thrHi);
    this.slope = 1 / (c.ratioLo + t * (c.ratioHi - c.ratioLo)) - 1;
    this.kneeLoLin = Math.pow(10, (this.thr - KNEE_DB / 2) / 10);
    this.active = true;
  }

  processMono(buf: Float32Array, n: number): void {
    if (!this.active && this.gr === 0) return;
    for (let i = 0; i < n; i++) {
      const x = buf[i]!;
      buf[i] = x * this.gainFor(x * x);
    }
  }

  /** Both channels get the same gain, driven by the mean power of the two (linked detector). */
  processStereo(l: Float32Array, r: Float32Array, n: number): void {
    if (!this.active && this.gr === 0) return;
    for (let i = 0; i < n; i++) {
      const a = l[i]!, b = r[i]!;
      const g = this.gainFor(0.5 * (a * a + b * b));
      l[i] = a * g;
      r[i] = b * g;
    }
  }

  reset(): void { this.env = 0; this.gr = 0; }

  /** Advances the detector and the gain smoother by one sample and returns the linear gain. */
  private gainFor(sq: number): number {
    let env = sq + this.aRms * (this.env - sq);
    if (env < FLUSH) env = 0;
    this.env = env;

    let target = 0;
    if (this.active && env > this.kneeLoLin) {
      const over = 10 * Math.log10(env) - this.thr;
      target = over >= KNEE_DB / 2 ? this.slope * over : this.slope * (over + KNEE_DB / 2) * (over + KNEE_DB / 2) / (2 * KNEE_DB);
    }

    const gr = this.gr;
    const a = target < gr ? this.aAtt : this.aRel;
    let g = target + a * (gr - target);
    if (g > -1e-9) g = 0;   // gr is never positive; this also flushes the release tail
    this.gr = g;
    return g === 0 ? 1 : Math.exp(g * LN10_20);
  }
}
