/**
 * The GUIDE click (phase 1's rhythm, ruling R2): an original metronome click on every beat of the transport's grid while
 * the rhythm runs. Each click is a 20 ms decaying sine at -12 dBFS peak: 2 kHz on the downbeat, 1 kHz on the other
 * beats (the brief). Beats are counted from the grid origin in the transport's beat (a 6/8 measure clicks six eighth
 * notes), and a click starts on the first whole frame at or after its beat.
 *
 * The click is a pure function of the grid and the frame, so any span renders the same samples whatever the block size
 * (the core renders it span by span, the latency pipeline reads it again later). Both tones are tabulated once at
 * construction; `render` allocates nothing.
 */
import { beatFrames } from './transport';
import type { Transport } from './transport';

/** Click length. */
export const CLICK_MS = 20;
/** Peak level: -12 dBFS. */
export const CLICK_LEVEL = 10 ** (-12 / 20);
export const DOWNBEAT_HZ = 2000;
export const BEAT_HZ = 1000;
/** A sample rate too low for 2 kHz (the core tests' 1 kHz) scales both tones down together, keeping them below this share of it. */
const MAX_SHARE = 0.4;
/** Slack so a beat computed as `k * beat` still counts as on beat k despite float rounding (as the transport's grid). */
const EPS = 1e-9;

export class GuideClick {
  private readonly len: number;
  private readonly down: Float32Array;
  private readonly beat: Float32Array;

  constructor(private readonly sr: number) {
    this.len = Math.max(1, Math.round((CLICK_MS / 1000) * sr));
    const scale = Math.min(1, (MAX_SHARE * sr) / DOWNBEAT_HZ);
    this.down = this.tone(DOWNBEAT_HZ * scale);
    this.beat = this.tone(BEAT_HZ * scale);
  }

  /**
   * The click for timeline frames `[startFrame, startFrame + n)` into `outL`/`outR` from `offset` (both channels the
   * same: centred). Overwrites; silence while the transport is not running.
   */
  render(transport: Transport, startFrame: number, n: number, outL: Float32Array, outR: Float32Array, offset = 0): void {
    outL.fill(0, offset, offset + n);
    outR.fill(0, offset, offset + n);
    if (!transport.running || n <= 0) return;
    const unit = beatFrames(this.sr, transport.bpm, transport.beat);
    const origin = transport.origin;
    const num = transport.beat.num;
    const len = this.len;
    const end = startFrame + n;
    // The last beat that started a click still sounding at startFrame, then each beat after it up to the span's end.
    let k = Math.floor((startFrame - len - origin) / unit + EPS);
    for (;;) {
      const onset = Math.ceil(origin + k * unit - EPS);
      if (onset >= end) return;
      const from = Math.max(onset, startFrame);
      const to = Math.min(onset + len, end);
      if (to > from) {
        const table = (((k % num) + num) % num) === 0 ? this.down : this.beat;
        for (let f = from; f < to; f++) {
          const v = table[f - onset];
          outL[offset + f - startFrame] = v;
          outR[offset + f - startFrame] = v;
        }
      }
      k++;
    }
  }

  /** One click at `hz`: a sine sampled at frame centres, an exponential decay, and a taper to silence at its end. */
  private tone(hz: number): Float32Array {
    const len = this.len;
    const t = new Float32Array(len);
    const tau = len / 5; // about -43 dB by the end, where the taper takes it to 0
    for (let i = 0; i < len; i++) {
      t[i] = CLICK_LEVEL * Math.exp(-i / tau) * (1 - i / len) * Math.sin((2 * Math.PI * hz * (i + 0.5)) / this.sr);
    }
    return t;
  }
}
