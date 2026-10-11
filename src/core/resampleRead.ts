/**
 * Reading a take between its samples, for playback at a rate other than 1 (TEMPO SYNC PITCH, SPEED, and the XFADE
 * stretcher's read heads).
 *
 * 4-point cubic Hermite (Catmull-Rom): it passes through the samples (a whole position returns the stored sample
 * exactly) and reproduces straight lines. The take is read as a loop: positions outside `[0, length)` wrap, so the
 * taps around the seam read across it, which the loop-seam crossfade made continuous.
 *
 * No allocation: the four taps come straight from the take's chunk arrays.
 */
import type { AudioTake } from './chunks';

/** The take's sample at fractional `pos` (wrapped into the loop) into `outL[i]`, `outR[i]`. An empty take reads 0. */
export function readInterpolated(
  take: AudioTake,
  pos: number,
  outL: Float32Array,
  outR: Float32Array,
  i: number,
): void {
  const len = take.length;
  if (len === 0) {
    outL[i] = 0;
    outR[i] = 0;
    return;
  }
  let p = pos;
  if (p < 0 || p >= len) {
    p %= len;
    if (p < 0) p += len;
    if (p >= len) p = 0; // -tiny % len + len can round up to len
  }
  const i0 = Math.floor(p);
  const t = p - i0;
  const cf = take.chunkFrames;
  let am1: number, a0: number, a1: number, a2: number;
  let bm1: number, b0: number, b1: number, b2: number;
  const first = i0 - 1;
  const ci = Math.floor(first / cf);
  if (first >= 0 && i0 + 2 < len && ci === Math.floor((i0 + 2) / cf)) {
    // All four taps in one chunk: the usual case.
    const L = take.chunkL(ci);
    const R = take.chunkR(ci);
    const k = first - ci * cf;
    am1 = L[k];
    a0 = L[k + 1];
    a1 = L[k + 2];
    a2 = L[k + 3];
    bm1 = R[k];
    b0 = R[k + 1];
    b1 = R[k + 2];
    b2 = R[k + 3];
  } else {
    // Near a chunk boundary or the seam: look each tap up on its own, wrapping around the loop.
    let j = first < 0 ? first + len : first;
    let c = Math.floor(j / cf);
    am1 = take.chunkL(c)[j - c * cf];
    bm1 = take.chunkR(c)[j - c * cf];
    j = i0;
    c = Math.floor(j / cf);
    a0 = take.chunkL(c)[j - c * cf];
    b0 = take.chunkR(c)[j - c * cf];
    j = i0 + 1 >= len ? i0 + 1 - len : i0 + 1;
    c = Math.floor(j / cf);
    a1 = take.chunkL(c)[j - c * cf];
    b1 = take.chunkR(c)[j - c * cf];
    j = i0 + 2;
    while (j >= len) j -= len; // a loop of 1 or 2 frames wraps more than once
    c = Math.floor(j / cf);
    a2 = take.chunkL(c)[j - c * cf];
    b2 = take.chunkR(c)[j - c * cf];
  }
  outL[i] = hermite(am1, a0, a1, a2, t);
  outR[i] = hermite(bm1, b0, b1, b2, t);
}

/** Catmull-Rom between `x0` (t = 0) and `x1` (t = 1), with neighbours `xm1` and `x2`. Exactly `x0` at t = 0. */
function hermite(xm1: number, x0: number, x1: number, x2: number, t: number): number {
  if (t === 0) return x0;
  const c1 = 0.5 * (x1 - xm1);
  const c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2;
  const c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
  return ((c3 * t + c2) * t + c1) * t + x0;
}
