/**
 * Writing an overdub into a take that plays at a rate other than 1.
 *
 * INFERRED (the brief: "input is written at the fractional playhead with linear splatting, so playing back at the same
 * rate reproduces it"). Each input frame lands at a fractional take position `q` and is spread over the frames around
 * it with a triangular (linear) kernel. The kernel's half-width is max(1, rate): at rate <= 1 several input frames land
 * on each take frame and the kernel averages them; at rate > 1 the input frames are further apart than take frames and
 * the wider kernel interpolates between them, so no take frame is skipped.
 *
 * The contributions are gathered per take frame and only written once complete: the take frame becomes
 * `take * A/W + B/W`, where W is the sum of the kernel weights that landed on it, A the weights times each input
 * frame's keep-gain (alpha) and B the weights times its input gain (beta) times the input. So the result is a
 * normalized average (no ripple from the kernel's uneven coverage), and the DUB MODE rules carry over: OVERDUB is
 * alpha 1, beta g; REPLACE is alpha 1 - g, beta g (g the punch-in or punch-out gain).
 *
 * Positions are "stream" frames: take positions that keep counting up past the loop end (the caller wraps nothing).
 * `flush` maps them onto the loop. Gathering also keeps the core's rule that the playhead reads a frame before that
 * pass writes it: the caller flushes frames only once its read heads can no longer reach them.
 *
 * Nothing is allocated after construction. The ring holds `[base, hi)`: frames below `base` are written; frames at
 * `hi` and above have no contributions yet.
 */
import type { AudioTake } from './chunks';

/** The widest kernel: rates are clamped to 4x. */
export const SPLAT_MAX_WIDTH = 4;

/** Frames per take read/write while flushing. */
const RUN = 256;

export class SplatWriter {
  private readonly size: number;
  private readonly mask: number;
  private readonly w: Float32Array;
  private readonly a: Float32Array;
  private readonly bl: Float32Array;
  private readonly br: Float32Array;
  private base = 0;
  private hi = 0;
  private readonly tmpL = new Float32Array(RUN);
  private readonly tmpR = new Float32Array(RUN);
  private readonly outL = new Float32Array(RUN);
  private readonly outR = new Float32Array(RUN);

  /** `span`: the most frames that can be gathered but not yet written at once. The ring is the next power of two. */
  constructor(span: number) {
    let size = 1;
    while (size < span) size *= 2;
    this.size = size;
    this.mask = size - 1;
    this.w = new Float32Array(size);
    this.a = new Float32Array(size);
    this.bl = new Float32Array(size);
    this.br = new Float32Array(size);
  }

  /** Contributions are gathered and not yet written. */
  get pending(): boolean {
    return this.hi > this.base;
  }

  /**
   * Start a stream whose contributions will land no lower than `floor(q) - back`. Does nothing while frames are
   * pending: the stream that left them carries on in the same stream frames.
   */
  begin(q: number, back: number): void {
    if (this.hi > this.base) return;
    this.base = this.hi = Math.floor(q) - back;
  }

  /**
   * Spread one input frame (`xL`, `xR`) over the take frames within `width` of position `q`, each weighted by
   * `scale * (1 - |q - j| / width)`, with keep-gain `alpha` and input gain `beta`. Frames already written (below the
   * base) or beyond the ring are dropped; the caller's flush timing keeps both from happening.
   */
  deposit(q: number, width: number, scale: number, xL: number, xR: number, alpha: number, beta: number): void {
    const first = Math.floor(q - width) + 1;
    const last = Math.ceil(q + width) - 1;
    const { w, a, bl, br, mask } = this;
    for (let j = first; j <= last; j++) {
      const d = q - j;
      const wt = scale * (1 - (d < 0 ? -d : d) / width);
      if (wt <= 0 || j < this.base) continue;
      if (j >= this.hi) {
        if (j - this.base >= this.size) continue;
        for (let z = this.hi; z <= j; z++) {
          const x = z & mask;
          w[x] = 0;
          a[x] = 0;
          bl[x] = 0;
          br[x] = 0;
        }
        this.hi = j + 1;
      }
      const x = j & mask;
      w[x] += wt;
      a[x] += wt * alpha;
      const wb = wt * beta;
      bl[x] += wb * xL;
      br[x] += wb * xR;
    }
  }

  /**
   * Write the pending frames below stream frame `upTo` into `take`, at `j mod loopLen`. Returns false on MEMORY FULL
   * (a shared chunk could not be copied): the frames already written stay, the rest are dropped.
   */
  flush(take: AudioTake, upTo: number, loopLen: number): boolean {
    const end = Math.min(this.hi, upTo === Infinity ? this.hi : Math.floor(upTo));
    if (loopLen <= 0) {
      this.base = this.hi;
      return true;
    }
    const { w, a, bl, br, mask, tmpL, tmpR, outL, outR } = this;
    while (this.base < end) {
      let pos = this.base % loopLen;
      if (pos < 0) pos += loopLen;
      const n = Math.min(end - this.base, loopLen - pos, RUN);
      take.read(pos, tmpL, tmpR, 0, n);
      for (let i = 0; i < n; i++) {
        const x = (this.base + i) & mask;
        const wt = w[x];
        if (wt > 0) {
          const keep = a[x] / wt;
          outL[i] = tmpL[i] * keep + bl[x] / wt;
          outR[i] = tmpR[i] * keep + br[x] / wt;
        } else {
          outL[i] = tmpL[i];
          outR[i] = tmpR[i];
        }
      }
      if (!take.write(pos, outL, outR, n, 'replace')) {
        this.base = this.hi;
        return false;
      }
      this.base += n;
    }
    return true;
  }

  /** Drop everything pending without writing it. */
  discard(): void {
    this.base = this.hi;
  }
}
