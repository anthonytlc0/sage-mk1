/**
 * The engine side of MENU > SETUP > LATENCY (non-hardware addition): on `calibrate`, the processor plays 8 clicks
 * 500 ms apart through the output, after a 500 ms lead-in that gives the noise floor, and records the raw mic for the
 * whole window plus 500 ms. Then it posts `{ t: 'calibration', reqId, capture, clickFrames }`; the main thread turns
 * that into a latency (control/calibrate.ts).
 *
 * FRAME BASE: `clickFrames` and `capture` are both capture-relative. Frame 0 is the first frame of the render block in
 * which `calibrate` was applied; `capture[i]` is the mic at that frame + i, and a click listed at frame c was written
 * to the output at that same frame + c. Neither is expressed in core frames or AudioContext frames (the status
 * timeline, which may be offset from the core's), so nothing needs converting: a click written at capture frame c and
 * heard by the mic at capture frame g took g - c frames, the round trip the core compensates.
 *
 * While it runs the click replaces the output: loops and INPUT THRU monitoring are muted so they cannot be taken for
 * clicks (and the mic cannot feed back through the speaker).
 *
 * The click is a 20 ms 1 kHz burst with an exponential decay, started at its peak (cosine phase) so its onset is its
 * first sample. GuideClick (Task 9) is not used: it arrives on another lane; this burst is generated here.
 */

import type { EngineEvent } from '../shared/protocol';

export const CALIB_CLICKS = 8;
/** Seconds between clicks, and before the first one. */
export const CALIB_INTERVAL_S = 0.5;
/** Seconds recorded after the last click. */
export const CALIB_TAIL_S = 0.5;
export const CLICK_S = 0.02;
export const CLICK_HZ = 1000;
export const CLICK_GAIN = 0.5;
/** Decay time constant of the burst: down to e^-5 (-43 dB) by its end. */
const CLICK_TAU_S = CLICK_S / 5;

/** The frames (from the start of the measurement) at which the clicks start. */
export function calibrationClickFrames(sr: number): number[] {
  return Array.from({ length: CALIB_CLICKS }, (_, i) => Math.round((i + 1) * CALIB_INTERVAL_S * sr));
}

/** Frames recorded: the lead-in and the clicks, then the tail. */
export function calibrationFrames(sr: number): number {
  return Math.round((CALIB_CLICKS * CALIB_INTERVAL_S + CALIB_TAIL_S) * sr);
}

/** One click: a decaying 1 kHz burst, CLICK_S long, starting at CLICK_GAIN. */
export function clickBurst(sr: number): Float32Array {
  const n = Math.max(1, Math.round(CLICK_S * sr));
  const out = new Float32Array(n);
  for (let k = 0; k < n; k++) out[k] = CLICK_GAIN * Math.cos((2 * Math.PI * CLICK_HZ * k) / sr) * Math.exp(-k / (CLICK_TAU_S * sr));
  return out;
}

/** One measurement in progress. Allocated when `calibrate` arrives (once per user action); `process` allocates nothing. */
export class Calibrator {
  readonly capture: Float32Array<ArrayBuffer>;
  readonly clickFrames: number[];
  private readonly burst: Float32Array;
  private pos = 0;
  /** The click being played or next to play. */
  private click = 0;

  constructor(readonly reqId: number, sr: number) {
    this.capture = new Float32Array(calibrationFrames(sr));
    this.clickFrames = calibrationClickFrames(sr);
    this.burst = clickBurst(sr);
  }

  /**
   * One block of `n` frames: records `mic` (silence when there is none) and writes the clicks over `outL` / `outR`.
   * Returns true once the capture is full; the frames past its end are silent.
   */
  process(mic: Float32Array | undefined, outL: Float32Array, outR: Float32Array, n: number): boolean {
    const cap = this.capture;
    const len = cap.length;
    const frames = this.clickFrames;
    const burst = this.burst;
    for (let k = 0; k < n; k++) {
      const f = this.pos + k;
      if (f < len) cap[f] = mic !== undefined && k < mic.length ? mic[k]! : 0;
      while (this.click < frames.length && f >= frames[this.click]! + burst.length) this.click++;
      let s = 0;
      if (f < len && this.click < frames.length && f >= frames[this.click]!) s = burst[f - frames[this.click]!]!;
      outL[k] = s;
      outR[k] = s;
    }
    this.pos += n;
    return this.pos >= len;
  }

  /** The result to post (transfer `capture.buffer`). `clickFrames` index `capture` (see FRAME BASE above). */
  event(): Extract<EngineEvent, { t: 'calibration' }> {
    return { t: 'calibration', reqId: this.reqId, capture: this.capture, clickFrames: this.clickFrames };
  }
}
