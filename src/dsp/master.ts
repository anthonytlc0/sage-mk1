/**
 * MASTER FX and the output stage, applied to a stereo bus in place:
 *
 *   MASTER FX COMP (OFF, 1-40) -> REVERB (0-40) -> OUTPUT EQ (MAIN) -> MASTER OUT x MAIN-L / MAIN-R OUT
 *
 * The engine runs one instance on the audible bus and a second on the recorder bus (each has its own state).
 * Settings used: master.comp / master.reverb / master.insert, output.eq.MAINL / MAINR (+ output.stereoLink.MAIN),
 * mixer.masterOut / mainLOut / mainROut. MASTER FX INSERT = OFF bypasses COMP and REVERB; any other insert point
 * applies them, because every jack is summed into the app's single output.
 *
 * Audio-thread code: nothing allocates in process(). A non-finite sample is replaced by silence on the way in so it
 * cannot poison the compressor, the reverb loop or the EQ state.
 */

import type { SystemSettings } from '../schema/types';
import { Compressor } from './compressor';
import { ParametricEq } from './eq';
import { Reverb } from './reverb';

export class MasterFx {
  private readonly comp: Compressor;
  private readonly reverb: Reverb;
  private readonly eqL: ParametricEq;
  private readonly eqR: ParametricEq;

  private fxOn = true;
  private targetL = 1; private targetR = 1;
  private curL = 1; private curR = 1;
  private snap = true;

  constructor(sr: number) {
    this.comp = new Compressor(sr, 'master');
    this.reverb = new Reverb(sr);
    this.eqL = new ParametricEq(sr);
    this.eqR = new ParametricEq(sr);
  }

  configure(sys: SystemSettings): void {
    this.fxOn = sys.master.insert !== 'OFF';
    this.comp.setDepth(this.fxOn ? sys.master.comp : 'OFF');
    this.reverb.setDepth(this.fxOn ? sys.master.reverb : 0);
    const eq = sys.output.eq;
    this.eqL.configure(eq.MAINL);
    this.eqR.configure(sys.output.stereoLink.MAIN ? eq.MAINL : eq.MAINR);
    const m = sys.mixer;
    this.targetL = (m.masterOut / 100) * (m.mainLOut / 100);
    this.targetR = (m.masterOut / 100) * (m.mainROut / 100);
  }

  process(L: Float32Array, R: Float32Array, n: number): void {
    for (let k = 0; k < n; k++) {
      const a = L[k]!, b = R[k]!;
      if (a - a !== 0) L[k] = 0;
      if (b - b !== 0) R[k] = 0;
    }
    this.comp.processStereo(L, R, n);
    this.reverb.process(L, R, n);
    this.eqL.process(L, n);
    this.eqR.process(R, n);

    if (this.snap) { this.curL = this.targetL; this.curR = this.targetR; this.snap = false; }
    ramp(L, this.curL, this.targetL, n);
    ramp(R, this.curR, this.targetR, n);
    this.curL = this.targetL;
    this.curR = this.targetR;
  }
}

/** buf[k] *= g, with g moving linearly from g0 to g1 across n samples. Unity gain leaves the buffer untouched. */
function ramp(buf: Float32Array, g0: number, g1: number, n: number): void {
  if (g0 === g1) {
    if (g1 === 1) return;
    for (let k = 0; k < n; k++) buf[k] = buf[k]! * g1;
    return;
  }
  const step = (g1 - g0) / n;
  let g = g0;
  for (let k = 0; k < n; k++) { buf[k] = buf[k]! * g; g += step; }
}
