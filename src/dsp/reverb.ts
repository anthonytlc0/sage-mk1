/**
 * MASTER FX REVERB (0-40): a small 8-line feedback delay network with a Hadamard feedback matrix.
 *
 * Eight delay lines (prime lengths of 23-46 ms) feed back through a one-pole lowpass (damping), a per-line gain that
 * sets the decay time, and an orthogonal 8x8 Hadamard matrix (a lossless mix, so the decay is set by the gains alone).
 * Left and right are tapped from the lines with two orthogonal sign patterns, so the tail is decorrelated.
 *
 * The guide gives only the 0-40 range. INFERRED: the depth sets both the wet level (1.2 * sqrt(depth / 40), which is
 * about -25 dB to -7 dB against sustained dry input) and the decay time (0.4 s at depth 1 to 3 s at depth 40).
 *
 * Depth 0 is a bit-exact passthrough: the lines are not even run. Lowering the depth to 0 fades the wet signal out
 * (about a quarter of a second), then clears the lines and bypasses. Audio-thread code: buffers are allocated once in
 * the constructor, and the tails are flushed to exactly zero so they never reach denormal range.
 */

import { FLUSH } from './biquad';

const LINES = 8;
/** Mutually prime delay lengths in samples at 48 kHz; scaled for other rates. */
const BASE_LENGTHS = [1087, 1223, 1361, 1523, 1693, 1861, 2029, 2213];
/** Per-line sign of the input injection (any mix that is not a single Hadamard row). */
const IN_SIGN = [1, 1, -1, 1, -1, -1, 1, -1];
const IN_GAIN = 1 / Math.sqrt(LINES);
const OUT_GAIN = 1 / Math.sqrt(LINES);
const HADAMARD_SCALE = 1 / Math.sqrt(LINES);
/** One-pole damping coefficient of the feedback lowpass (~8 kHz at 48 kHz). INFERRED. */
const DAMP = 0.35;
/** Wet fade time constant in seconds (used when the depth changes). */
const FADE_S = 0.02;
const MAX_DEPTH = 40;
// INFERRED: the depth -> wet level and depth -> decay mappings in setDepth() below, and DAMP above.

export class Reverb {
  private readonly sr: number;
  private readonly buf: Float64Array;
  private readonly off = new Int32Array(LINES);
  private readonly len = new Int32Array(LINES);
  private readonly pos = new Int32Array(LINES);
  private readonly gain = new Float64Array(LINES);   // feedback gain per line
  private readonly lp = new Float64Array(LINES);     // damping filter state
  private readonly x = new Float64Array(LINES);      // scratch: line outputs
  private readonly y = new Float64Array(LINES);      // scratch: feedback vector
  private readonly fade: number;

  private wet = 0;
  private wetTarget = 0;

  constructor(sr: number) {
    this.sr = sr;
    let total = 0;
    for (let j = 0; j < LINES; j++) {
      this.len[j] = Math.max(2, Math.round((BASE_LENGTHS[j]! * sr) / 48000));
      this.off[j] = total;
      total += this.len[j]!;
    }
    this.buf = new Float64Array(total);
    this.fade = 1 - Math.exp(-1 / (FADE_S * sr));
  }

  /** 0 = off (passthrough), 1..40 = reverb depth. */
  setDepth(depth: number): void {
    const d = Math.min(Math.max(depth, 0), MAX_DEPTH);
    const t = d / MAX_DEPTH;
    const wasIdle = this.wet === 0 && this.wetTarget === 0;
    this.wetTarget = d === 0 ? 0 : 1.2 * Math.sqrt(t);
    if (d === 0) return;
    // A reverb that starts from silence has nothing to fade: take the wet level at once.
    if (wasIdle) this.wet = this.wetTarget;
    const t60 = 0.4 + 2.6 * t;
    for (let j = 0; j < LINES; j++) this.gain[j] = Math.pow(10, (-3 * this.len[j]!) / (this.sr * t60));
  }

  /** Adds the reverb to `l` and `r` (0..n) in place. */
  process(l: Float32Array, r: Float32Array, n: number): void {
    if (this.wet === 0 && this.wetTarget === 0) return;
    const buf = this.buf, off = this.off, len = this.len, pos = this.pos, gain = this.gain, lp = this.lp;
    const x = this.x, y = this.y;
    let wet = this.wet;
    const target = this.wetTarget, fade = this.fade;

    for (let i = 0; i < n; i++) {
      const a = l[i]!, b = r[i]!;
      let inM = 0.5 * (a + b);
      if (inM - inM !== 0) inM = 0;   // NaN / Infinity must not enter the feedback loop

      for (let j = 0; j < LINES; j++) x[j] = buf[off[j]! + pos[j]!]!;

      const wl = (x[0]! + x[1]! + x[2]! + x[3]! - x[4]! - x[5]! - x[6]! - x[7]!) * OUT_GAIN;
      const wr = (x[0]! - x[1]! + x[2]! - x[3]! + x[4]! - x[5]! + x[6]! - x[7]!) * OUT_GAIN;

      for (let j = 0; j < LINES; j++) {
        let s = x[j]! + DAMP * (lp[j]! - x[j]!);
        if (s < FLUSH && s > -FLUSH) s = 0;
        lp[j] = s;
        y[j] = s * gain[j]!;
      }

      // Fast Walsh-Hadamard transform, in place: three butterfly stages.
      for (let j = 0; j < LINES; j += 2) { const p = y[j]!, q = y[j + 1]!; y[j] = p + q; y[j + 1] = p - q; }
      for (let j = 0; j < LINES; j += 4) {
        for (let k = j; k < j + 2; k++) { const p = y[k]!, q = y[k + 2]!; y[k] = p + q; y[k + 2] = p - q; }
      }
      for (let k = 0; k < 4; k++) { const p = y[k]!, q = y[k + 4]!; y[k] = p + q; y[k + 4] = p - q; }

      const inj = inM * IN_GAIN;
      for (let j = 0; j < LINES; j++) {
        let v = y[j]! * HADAMARD_SCALE + IN_SIGN[j]! * inj;
        if (v < FLUSH && v > -FLUSH) v = 0;
        const p = pos[j]!;
        buf[off[j]! + p] = v;
        pos[j] = p + 1 === len[j]! ? 0 : p + 1;
      }

      wet += (target - wet) * fade;
      l[i] = a + wl * wet;
      r[i] = b + wr * wet;
    }

    if (target === 0 && wet < 1e-6) {
      wet = 0;                       // faded out: drop the tail so a later start is clean, and bypass again
      buf.fill(0); lp.fill(0);
    }
    this.wet = wet;
  }
}
