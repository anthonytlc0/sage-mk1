/**
 * The EQ block shared by INPUT EQ and OUTPUT EQ (Parameter Guide v1.3 pp. 11-13 and 17-19).
 *
 * Signal path: LO CUT -> LO GAIN shelf -> LO MID peak -> HI MID peak -> HIGH GAIN shelf -> HI CUT -> LEVEL.
 * With SW off the block is skipped entirely (a bit-exact passthrough). Bands that do nothing (0 dB, FLAT) are skipped
 * as well, so a lightly edited EQ costs a lightly edited EQ.
 */

import type { EqSettings } from '../schema/types';
import { Biquad } from './biquad';

// INFERRED
// The guide gives no corner for the LO GAIN / HIGH GAIN shelves. 150 Hz keeps a 50 Hz sine within 1 dB of the
// set gain, and 6 kHz is its mirror on the voice-oriented spectrum.
const LO_SHELF_HZ = 150;
const HI_SHELF_HZ = 6000;
/** LO CUT / HI CUT are 2nd-order Butterworth (12 dB/oct). The guide does not state the slope. */
// INFERRED
const CUT_Q = Math.SQRT1_2;

export class ParametricEq {
  private readonly sr: number;
  private readonly loCut = new Biquad();
  private readonly loShelf = new Biquad();
  private readonly loMid = new Biquad();
  private readonly hiMid = new Biquad();
  private readonly hiShelf = new Biquad();
  private readonly hiCut = new Biquad();

  private on = false;
  private onLoCut = false; private onLoShelf = false; private onLoMid = false;
  private onHiMid = false; private onHiShelf = false; private onHiCut = false;
  private gain = 1;

  constructor(sr: number) { this.sr = sr; }

  configure(s: EqSettings): void {
    const sr = this.sr;
    const wasOn = this.on;
    this.on = s.sw;
    const wake = s.sw && !wasOn;   // a block coming back from bypass starts from silence, not from stale state

    const cutLo = s.loCut !== 'FLAT';
    if (cutLo) this.loCut.highpass(sr, s.loCut as number, CUT_Q);
    this.onLoCut = this.restart(this.loCut, this.onLoCut, cutLo, wake);

    const shLo = s.loGain !== 0;
    if (shLo) this.loShelf.lowShelf(sr, LO_SHELF_HZ, s.loGain);
    this.onLoShelf = this.restart(this.loShelf, this.onLoShelf, shLo, wake);

    const midLo = s.loMidGain !== 0;
    if (midLo) this.loMid.peaking(sr, s.loMidFreq, s.loMidQ, s.loMidGain);
    this.onLoMid = this.restart(this.loMid, this.onLoMid, midLo, wake);

    const midHi = s.hiMidGain !== 0;
    if (midHi) this.hiMid.peaking(sr, s.hiMidFreq, s.hiMidQ, s.hiMidGain);
    this.onHiMid = this.restart(this.hiMid, this.onHiMid, midHi, wake);

    const shHi = s.hiGain !== 0;
    if (shHi) this.hiShelf.highShelf(sr, HI_SHELF_HZ, s.hiGain);
    this.onHiShelf = this.restart(this.hiShelf, this.onHiShelf, shHi, wake);

    const cutHi = s.hiCut !== 'FLAT';
    if (cutHi) this.hiCut.lowpass(sr, s.hiCut as number, CUT_Q);
    this.onHiCut = this.restart(this.hiCut, this.onHiCut, cutHi, wake);

    this.gain = s.level === 0 ? 1 : Math.pow(10, s.level / 20);
  }

  /** Filters `buf[0..n)` in place. */
  process(buf: Float32Array, n: number): void {
    if (!this.on) return;
    if (this.onLoCut) this.loCut.process(buf, n);
    if (this.onLoShelf) this.loShelf.process(buf, n);
    if (this.onLoMid) this.loMid.process(buf, n);
    if (this.onHiMid) this.hiMid.process(buf, n);
    if (this.onHiShelf) this.hiShelf.process(buf, n);
    if (this.onHiCut) this.hiCut.process(buf, n);
    const g = this.gain;
    if (g !== 1) for (let i = 0; i < n; i++) buf[i] = buf[i]! * g;
  }

  reset(): void {
    this.loCut.reset(); this.loShelf.reset(); this.loMid.reset(); this.hiMid.reset(); this.hiShelf.reset(); this.hiCut.reset();
  }

  /** Returns the new active flag; a band that was idle (or the whole block was bypassed) restarts with clean state. */
  private restart(b: Biquad, was: boolean, now: boolean, wake: boolean): boolean {
    if (now && (!was || wake)) b.reset();
    return now;
  }
}
