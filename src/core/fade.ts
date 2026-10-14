/**
 * Fade and crossfade helpers for the track engine: the 5 ms seam/punch crossfade length, FADE TIME in frames, the
 * punch-in/punch-out write gains, and a linear gain ramp for start/stop fades and the REPLACE2 mute. Pure arithmetic,
 * no allocation after construction.
 */
import { XFADE_MS } from '../shared/constants';
import type { Beat, FadeTime } from '../schema/types';
import { fadeFrames } from './transport';

/** Frames in the loop-seam and punch crossfade: 5 ms, at least one frame. */
export function xfadeFrames(sr: number): number {
  return Math.max(1, Math.round((XFADE_MS * sr) / 1000));
}

/** FADE TIME (IN or OUT) in whole frames at the given tempo and beat, at least one frame. */
export function fadeTimeFrames(sr: number, bpm: number, beat: Beat, f: FadeTime): number {
  return Math.max(1, Math.round(fadeFrames(sr, bpm, beat, f)));
}

/**
 * Input gain `j` frames after a punch-in: rises linearly from 0 (at the press) to 1 at `xf` frames, then stays 1. Before
 * the press (`j` < 0: input still on its way through the latency pipeline from before it) it is 0.
 */
export function punchInGain(j: number, xf: number): number {
  return j >= xf ? 1 : j <= 0 ? 0 : j / xf;
}

/**
 * Input gain of a punch-out tail with `left` of its `xf` frames still to write: 1 on the first frame after the press,
 * falling linearly to 1/xf on the last. Paired with `punchInGain` the two sum to 1 across a press. More than `xf` left
 * (a tail still carrying the input heard before the press, through the latency pipeline) is 1.
 */
export function punchOutGain(left: number, xf: number): number {
  return left >= xf ? 1 : left / xf;
}

/**
 * A linear gain ramp (INFERRED: the guide gives fade lengths, not curves): from the value it had when `start` was
 * called to `to` over `len` frames, then holding `to`.
 * `next()` returns the gain for the current frame and steps one frame on.
 */
export class Ramp {
  private from: number;
  private to: number;
  private len = 1;
  private left = 0;

  constructor(value = 1) {
    this.from = value;
    this.to = value;
  }

  /** The gain for the current frame. Exactly `to` once the ramp has finished. */
  get value(): number {
    return this.left > 0 ? this.to + ((this.from - this.to) * this.left) / this.len : this.to;
  }

  /** True while the ramp is still moving. */
  get active(): boolean {
    return this.left > 0;
  }

  /** Frames until the ramp reaches its target (0 when it has). */
  get remaining(): number {
    return this.left;
  }

  /** Jump to `v` at once. */
  set(v: number): void {
    this.from = v;
    this.to = v;
    this.left = 0;
  }

  /** Ramp from the current value to `to` over `len` frames (at least one). The first frame still has the old value. */
  start(to: number, len: number): void {
    this.from = this.value;
    this.to = to;
    this.len = Math.max(1, Math.round(len));
    this.left = this.len;
  }

  /** The gain for this frame, then advance one frame. */
  next(): number {
    const v = this.value;
    if (this.left > 0) this.left--;
    return v;
  }
}
