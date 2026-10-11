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
 * TEMPO SYNC PITCH splats at the playhead. XFADE overdubs reach the writer through `SpliceWriter` (below), which
 * time-compresses the input in pitch-keeping splices and deposits each splice frame on one take frame.
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

/** Most splices a frame can belong to at once (1.25 x rate + 1 at 4x is 6). */
const SPLICES = 8;

/**
 * The XFADE overdub: the input time-compressed (or stretched) by the rate in splices, keeping its pitch, so the
 * stretcher plays it back at the pitch it was played.
 *
 * INFERRED (fix round 1). Every `hop` input frames a splice starts: `rate * hop` consecutive input frames copied one for
 * one into consecutive take frames, centred where the playhead is at the splice's centre. At rate < 1 the input between
 * splices is dropped; at rate > 1 it is used twice. Neighbouring splices overlap by an eighth of a splice with a linear
 * (equal-gain) crossfade, so each take frame holds one moment of the input, or two in the short crossfade. (Writing
 * every input frame through both stretcher heads instead averaged up to 2 / rate moments a few milliseconds apart on
 * each frame: a comb filter, -29 dB at 440 Hz at 0.5x.)
 *
 * The hop is 2/7 of the stretcher's grain (17 ms at 60 ms grains). A hop that divides the grain (a quarter, 15 ms) makes
 * the splice joins beat against the read heads on replay, so some tones always lose level; at 2/7 they do not line up.
 *
 * Splice positions are whole stream frames, so a splice is a straight copy. Deposits land up to `reach` frames from
 * the playhead (behind or ahead). Nothing is allocated after construction.
 */
export class SpliceWriter {
  /** Input frames between splice starts (even). */
  readonly hop: number;
  /** The farthest a deposit lands from the playhead, in frames, at rates up to 4x. */
  readonly reach: number;
  private n = 0;
  private next = 0;
  private started = false;
  private count = 0;
  /** Live splices: centre (input frame), take centre (stream frame), half-length and crossfade length. */
  private readonly centre = new Float64Array(SPLICES);
  private readonly at = new Float64Array(SPLICES);
  private readonly half = new Float64Array(SPLICES);
  private readonly ramp = new Float64Array(SPLICES);

  /** `grainFrames`: the stretcher's grain. A splice starts every 2/7 of a grain (17 ms at 60 ms grains). */
  constructor(grainFrames: number) {
    this.hop = 2 * Math.max(1, Math.round(grainFrames / 7));
    const maxRate = SPLAT_MAX_WIDTH;
    // A splice spans 1.25 x rate x hop; its frames land (rate - 1) x that half-span from the moving playhead.
    this.reach = Math.ceil((maxRate - 1) * (maxRate * this.hop * 0.625)) + 2;
  }

  /** Start afresh: the next input frame begins a new run of splices (the input is not continuous with the last). */
  reset(): void {
    this.n = 0;
    this.started = false;
    this.count = 0;
  }

  /**
   * One input frame (`xL`, `xR`, keep-gain `alpha`, input gain `beta`) arriving while the playhead is at stream frame
   * `q`, playing at `rate` (> 0). It lands in each splice that covers it, weighted by the splice's crossfade.
   */
  push(
    writer: SplatWriter,
    q: number,
    rate: number,
    xL: number,
    xR: number,
    alpha: number,
    beta: number,
  ): void {
    const hop = this.hop;
    const h = (rate * hop) / 2; // half a splice, in frames
    const x = Math.max(2, h / 4); // crossfade length: an eighth of the splice (2 ms at 1x), at least 2 frames
    const reachIn = h + x / 2;
    const n = this.n;
    if (!this.started) {
      this.next = Math.floor((n - reachIn - hop / 2) / hop) + 1;
      this.started = true;
    }
    // Open the splices whose windows have begun; each is placed where the playhead will be at its centre.
    while (this.next * hop + hop / 2 - reachIn <= n) {
      const c = this.next * hop + hop / 2;
      if (this.count === SPLICES) this.drop(0);
      const i = this.count++;
      this.centre[i] = c;
      this.at[i] = Math.round(q + rate * (c - n));
      this.half[i] = h;
      this.ramp[i] = x;
      this.next++;
    }
    for (let i = 0; i < this.count; ) {
      const d = n - this.centre[i];
      const edge = this.half[i] + this.ramp[i] / 2;
      if (d >= edge) {
        this.drop(i); // this splice is over
        continue;
      }
      const ad = d < 0 ? -d : d;
      if (ad < edge) {
        const w = (edge - ad) / this.ramp[i];
        writer.deposit(this.at[i] + d, 1, w > 1 ? 1 : w, xL, xR, alpha, beta);
      }
      i++;
    }
    this.n = n + 1;
  }

  private drop(i: number): void {
    const last = --this.count;
    for (let k = i; k < last; k++) {
      this.centre[k] = this.centre[k + 1];
      this.at[k] = this.at[k + 1];
      this.half[k] = this.half[k + 1];
      this.ramp[k] = this.ramp[k + 1];
    }
  }
}
