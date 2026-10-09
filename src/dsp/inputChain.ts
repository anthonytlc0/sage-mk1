/**
 * The mic input chain: MIXER MIC 1 IN gain (and mute) -> INPUT EQ (MIC1) -> MIC1 COMP -> MIC1 NS, then the mono result
 * is placed at the centre of both channels at unity (the app has one mic, mapped to MIC1; the INST inputs are silent).
 *
 * Gain changes ramp linearly across the block. A non-finite mic sample is replaced by silence so it cannot poison the
 * filter and detector state. Audio-thread code: the chain works in place in `outL`, so nothing allocates in process().
 */

import type { SystemSettings } from '../schema/types';
import { Compressor } from './compressor';
import { ParametricEq } from './eq';
import { NoiseSuppressor } from './noiseSuppressor';

export class InputChain {
  private readonly eq: ParametricEq;
  private readonly comp: Compressor;
  private readonly ns: NoiseSuppressor;

  private level = 1;       // MIXER MIC 1 IN / 100
  private muted = false;
  private cur = 1;         // the gain at the end of the previous block
  private snap = true;     // first block: no fade-in from silence

  constructor(sr: number) {
    this.eq = new ParametricEq(sr);
    this.comp = new Compressor(sr, 'mic');
    this.ns = new NoiseSuppressor(sr);
  }

  configure(sys: SystemSettings): void {
    this.level = sys.mixer.mic1In / 100;
    this.eq.configure(sys.input.eq.MIC1);
    this.comp.setDepth(sys.input.dynamics.mic1Comp);
    this.ns.setAmount(sys.input.dynamics.mic1Ns);
  }

  /** Mutes or unmutes the mic ahead of the whole chain (a short fade, no click). */
  setMute(muted: boolean): void { this.muted = muted; }

  /**
   * Processes `n` mic samples into `outL` / `outR` (identical, mono at the centre). Returns the peak of the input after
   * the gain stage, for the input meter.
   */
  process(mic: Float32Array, outL: Float32Array, outR: Float32Array, n: number): number {
    const target = this.muted ? 0 : this.level;
    if (this.snap) { this.cur = target; this.snap = false; }
    const step = (target - this.cur) / n;
    let g = this.cur;
    let peak = 0;
    for (let k = 0; k < n; k++) {
      let x = mic[k]!;
      if (x - x !== 0) x = 0;       // NaN / Infinity
      const y = x * g;
      g += step;
      outL[k] = y;
      const a = y < 0 ? -y : y;
      if (a > peak) peak = a;
    }
    this.cur = target;

    this.eq.process(outL, n);
    this.comp.processMono(outL, n);
    this.ns.process(outL, n);

    for (let k = 0; k < n; k++) outR[k] = outL[k]!;
    return peak;
  }
}
