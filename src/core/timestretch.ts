/**
 * The XFADE stretcher: TEMPO SYNC MODE XFADE ("adjusts the playback speed to match the tempo without changing the
 * pitch", Parameter Guide p. 3).
 *
 * A virtual source position S moves through the take at the playback rate. Two read heads each move through the take
 * at 1.0x (so the pitch is the take's own). Every grain (60 ms) each head is re-seeded at S, the two heads half a grain
 * apart, and the output crossfades between them with equal-power windows: head A at sin(pi*i/G), head B at
 * cos(pi*i/G), so `gA^2 + gB^2 = 1`. A head is seeded so that it reads S exactly at its window's peak (the seed is
 * `S - (1 - rate) * G/2`), which keeps the audio centred on the beat rather than lagging or leading it by half a grain.
 *
 * INFERRED (level): equal-power windows hold the level when the heads read unrelated audio, but when they read
 * correlated audio (any rate near 1, where the heads sit only a few frames apart) the two windows add in amplitude and
 * the level swells by up to 3 dB at every crossover, a 33 Hz flutter. So the crossfade is scaled by
 * `1 / sqrt(1 + 2 rho gA gB)`, where rho (clamped to 0..1) is the heads' correlation measured since the last re-seed.
 * rho = 0 leaves it equal-power; rho = 1 makes it an equal-gain crossfade.
 *
 * The take is read as a loop (`readInterpolated` wraps), so heads near the seam read across it, unless `bounded` is
 * set (a 1SHOT): then a head past either end of the take reads silence, so the last grain of a sample that plays once
 * carries no ghost of its start. Negative rates play in reverse: S and both heads move backwards.
 *
 * Nothing is allocated after construction.
 */
import type { AudioTake } from './chunks';
import { readInterpolated } from './resampleRead';

export class XfadeStretcher {
  /** Grain length in frames (even). Each head is re-seeded once per grain, the two half a grain apart. */
  readonly grainFrames: number;
  /** Heads past the take's ends read silence instead of wrapping (a 1SHOT). */
  bounded = false;

  private readonly half: number;
  /** sin(pi * i / grain) for i in [0, grain). */
  private readonly win: Float64Array;
  /** The virtual source position: where plain playback at the rate would be. */
  private src = 0;
  private headA = 0;
  private headB = 0;
  /** Head A's index into its window; head B is half a grain on. */
  private phase = 0;
  /** Correlation sums of the two heads (mono) since the last re-seed. */
  private sab = 0;
  private saa = 0;
  private sbb = 0;
  private readonly tapL = new Float32Array(2);
  private readonly tapR = new Float32Array(2);

  constructor(sr: number, grainMs = 60) {
    this.half = Math.max(1, Math.round((grainMs * sr) / 2000));
    this.grainFrames = 2 * this.half;
    this.win = new Float64Array(this.grainFrames);
    for (let i = 0; i < this.grainFrames; i++) this.win[i] = Math.sin((Math.PI * i) / this.grainFrames);
  }

  /** The virtual source position. */
  get position(): number {
    return this.src;
  }

  /**
   * Jump to source position `pos`. Head A starts there at the peak of its window (gain 1) and head B at gain 0, so the
   * first frame rendered is exactly the take's sample at `pos`: a jump into the stretcher from plain playback is
   * seamless.
   */
  reset(pos: number): void {
    this.src = pos;
    this.headA = pos;
    this.headB = pos;
    this.phase = this.half;
    this.sab = 0;
    this.saa = 0;
    this.sbb = 0;
  }

  /** Move the source and both heads by `delta` (a loop length when the playhead wraps): the output is unchanged. */
  shift(delta: number): void {
    this.src += delta;
    this.headA += delta;
    this.headB += delta;
  }

  /**
   * Render `n` frames into `outL`/`outR` from `offset`, the source position moving at `rate` (the playback tempo
   * ratio; negative plays in reverse). The source position ends `rate * n` further on.
   */
  render(take: AudioTake, rate: number, n: number, outL: Float32Array, outR: Float32Array, offset: number): void {
    this.run(take, rate, n, outL, outR, offset);
  }

  /** What `render` would produce, leaving the stretcher exactly as it was. */
  peek(take: AudioTake, rate: number, n: number, outL: Float32Array, outR: Float32Array, offset: number): void {
    const { src, headA, headB, phase, sab, saa, sbb } = this;
    this.run(take, rate, n, outL, outR, offset);
    this.src = src;
    this.headA = headA;
    this.headB = headB;
    this.phase = phase;
    this.sab = sab;
    this.saa = saa;
    this.sbb = sbb;
  }

  private run(
    take: AudioTake,
    rate: number,
    n: number,
    outL: Float32Array,
    outR: Float32Array,
    offset: number,
  ): void {
    const { win, half, tapL, tapR } = this;
    const grain = this.grainFrames;
    const dir = rate < 0 ? -1 : 1;
    // A head seeded here reads S exactly when its window peaks, half a grain later.
    const lead = (rate - dir) * half;
    const src = this.src;
    let headA = this.headA;
    let headB = this.headB;
    let phase = this.phase;
    let sab = this.sab;
    let saa = this.saa;
    let sbb = this.sbb;
    for (let k = 0; k < n; k++) {
      if (phase === 0) {
        headA = src + rate * k + lead;
        sab = saa = sbb = 0;
      } else if (phase === half) {
        headB = src + rate * k + lead;
        sab = saa = sbb = 0;
      }
      readInterpolated(take, headA, tapL, tapR, 0, this.bounded);
      readInterpolated(take, headB, tapL, tapR, 1, this.bounded);
      const gA = win[phase];
      const gB = win[phase >= half ? phase - half : phase + half];
      const aL = tapL[0];
      const aR = tapR[0];
      const bL = tapL[1];
      const bR = tapR[1];
      const ma = aL + aR;
      const mb = bL + bR;
      sab += ma * mb;
      saa += ma * ma;
      sbb += mb * mb;
      const energy = saa * sbb;
      let rho = energy > 1e-30 ? sab / Math.sqrt(energy) : 0;
      if (rho < 0) rho = 0;
      else if (rho > 1) rho = 1;
      const norm = 1 / Math.sqrt(1 + 2 * rho * gA * gB);
      const wa = gA * norm;
      const wb = gB * norm;
      outL[offset + k] = wa * aL + wb * bL;
      outR[offset + k] = wa * aR + wb * bR;
      headA += dir;
      headB += dir;
      phase = phase + 1 === grain ? 0 : phase + 1;
    }
    this.src = src + rate * n;
    this.headA = headA;
    this.headB = headB;
    this.phase = phase;
    this.sab = sab;
    this.saa = saa;
    this.sbb = sbb;
  }
}
