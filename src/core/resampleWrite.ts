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

  /** Drop the contributions gathered for stream frames `[from, to)` (frames already written are left alone). */
  clear(from: number, to: number): void {
    const start = Math.max(Math.ceil(from), this.base);
    const end = to === Infinity ? this.hi : Math.min(Math.ceil(to), this.hi);
    const { w, a, bl, br, mask } = this;
    for (let j = start; j < end; j++) {
      const x = j & mask;
      w[x] = 0;
      a[x] = 0;
      bl[x] = 0;
      br[x] = 0;
    }
  }
}

/** Most splices open at once (each spans 1.125 x rate splice hops; at 4x that is 5). */
const SPLICES = 8;

/**
 * The XFADE overdub: the input time-compressed (or stretched) by the rate in splices, keeping its pitch, so the
 * stretcher plays it back at the pitch it was played.
 *
 * INFERRED (fix rounds 1 and 2). The punched span of the take is tiled with splices from the punch-in on: splice k
 * covers `rate * hop + x` take frames starting `k * rate * hop` after the punch-in, and holds that many consecutive
 * input frames copied one for one, centred on the moment the playhead passes the splice's centre. At rate < 1 the
 * input between splices is dropped; at rate > 1 it is used twice. Neighbouring splices overlap by x (an eighth of a
 * splice) with a linear, equal-gain crossfade, so each take frame holds one moment of the input, or two in the short
 * crossfade. (Writing every input frame through both stretcher heads instead averaged up to 2 / rate moments a few
 * milliseconds apart on each frame: a comb filter, -29 dB at 440 Hz at 0.5x.)
 *
 * The span is covered exactly, from the punch-in to the end of the punch-out tail:
 *  - A splice whose centred input would begin before the punch-in begins at the punch-in instead (above 1x the first
 *    splices all do), so nothing lands before it and nothing after it is missed. Such a splice is shortened so that its
 *    last frame lands within `reach` of the playhead (the playhead runs ahead of a one-for-one copy at rate - 1 frames
 *    per frame), and the next splice starts where it ends.
 *  - When the input ends (`finish`), a splice whose input ran out leaves a gap; one last splice anchored at the end,
 *    taken from the recent input, covers it (crossfading from what is there), and everything gathered past the end is
 *    dropped.
 *  - The punch-in ramp and the punch-out fade belong to take positions, not to input frames: above 1x a splice reuses
 *    input, and carrying the gains with the input would repeat the 5 ms fade-in inside the span. So the gain of a
 *    deposit comes from its position: rising over `rate * 5 ms` from the punch-in, falling over the same from the
 *    punch-out. Splices placed before the punch-out was known are rebuilt from it by the last splice.
 *
 * The hop is 2/7 of the stretcher's grain (17 ms at 60 ms grains). A hop that divides the grain (a quarter, 15 ms)
 * makes the splice joins beat against the read heads on replay, so some tones always lose level; at 2/7 they do not.
 * Splice positions are whole stream frames, so a splice is a straight copy. Deposits land up to `reach` frames from
 * the playhead (behind or ahead). Nothing is allocated after construction.
 */
export class SpliceWriter {
  /** Input frames between splice starts at 1x (even). */
  readonly hop: number;
  /** The farthest a deposit lands from the playhead, in frames, at rates up to 4x. */
  readonly reach: number;
  private n = 0;
  private live = false;
  /** The pass's DUB MODE replaces (else it overdubs). */
  private replace = false;
  /** Punch-in ramp: input frames already into it at the punch-in, its length in input frames, the rate then. */
  private rampFrom = 0;
  private rampFrames = 1;
  private rampRate = 1;
  /** Punch-out: the stream frame of the press (Infinity until then) and the rate then. */
  private outAt = Infinity;
  private outRate = 1;
  /** First take frame of the punched span (stream frames), and the take start of the next splice. */
  private spanStart = 0;
  private nextAt = 0;
  private lastRamp = 2;
  private count = 0;
  /** Open splices: first take frame, first input frame, length and crossfade length. */
  private readonly at = new Float64Array(SPLICES);
  private readonly from = new Float64Array(SPLICES);
  private readonly len = new Float64Array(SPLICES);
  private readonly ramp = new Float64Array(SPLICES);
  /** The recent input, for the splice anchored at the end. */
  private readonly histMask: number;
  private readonly histL: Float32Array;
  private readonly histR: Float32Array;

  /** `grainFrames`: the stretcher's grain. A splice starts every 2/7 of a grain (17 ms at 60 ms grains). */
  constructor(grainFrames: number) {
    this.hop = 2 * Math.max(1, Math.round(grainFrames / 7));
    const maxRate = SPLAT_MAX_WIDTH;
    const maxLen = maxRate * this.hop * 1.125;
    // An anchored splice's first frame lands up to (rate - 1) x half a splice from the moving playhead.
    this.reach = Math.ceil((maxRate - 1) * (maxRate * this.hop * 0.625)) + 2;
    let hist = 1;
    while (hist < 2 * maxLen + 64) hist *= 2;
    this.histMask = hist - 1;
    this.histL = new Float32Array(hist);
    this.histR = new Float32Array(hist);
  }

  /**
   * Start afresh at stream frame `q` (the punch-in): the input is not continuous with any earlier splice. `replace`:
   * the DUB MODE replaces. The punch-in ramp is `rampFrames` input frames long and `rampFrom` of them are already done
   * (a pass that starts at full gain has `rampFrom >= rampFrames`); `rate` is the rate at the punch-in.
   */
  reset(q: number, replace = false, rampFrom = 0, rampFrames = 1, rate = 1): void {
    this.n = 0;
    this.live = false;
    this.count = 0;
    this.spanStart = Math.round(q);
    this.nextAt = this.spanStart;
    this.replace = replace;
    this.rampFrom = rampFrom;
    this.rampFrames = Math.max(1, rampFrames);
    this.rampRate = rate;
    this.outAt = Infinity;
  }

  /** The pass ended with the playhead at stream frame `q`, at `rate`: from there the overdub fades out. */
  punchOut(q: number, rate: number): void {
    this.outAt = q;
    this.outRate = rate;
  }

  /** The punch gain at stream frame `pos`: the punch-in ramp times the punch-out fade, by position. */
  private gainAt(pos: number): number {
    const into = this.rampFrom + (pos - this.spanStart) / this.rampRate;
    let g = into >= this.rampFrames ? 1 : into <= 0 ? 0 : into / this.rampFrames;
    if (pos >= this.outAt) {
      const left = this.rampFrames - (pos - this.outAt) / this.outRate;
      g *= left >= this.rampFrames ? 1 : left <= 0 ? 0 : left / this.rampFrames;
    }
    return g;
  }

  /** Deposit `x` at stream frame `pos` with crossfade weight `w`, under the punch gain there. */
  private put(writer: SplatWriter, pos: number, w: number, xL: number, xR: number): void {
    const g = this.gainAt(pos);
    writer.deposit(pos, 1, w, xL, xR, this.replace ? 1 - g : 1, g);
  }

  /**
   * One input frame (`xL`, `xR`) arriving while the playhead is at stream frame `q`, playing at `rate` (> 0). It lands
   * in each open splice, weighted by the splice's crossfade and the punch gain where it lands.
   */
  push(writer: SplatWriter, q: number, rate: number, xL: number, xR: number): void {
    const n = this.n;
    const k = n & this.histMask;
    this.histL[k] = xL;
    this.histR[k] = xR;
    const h = (rate * this.hop) / 2; // half the distance between splice starts, in take frames
    const x = Math.max(2, h / 4); // the crossfade: an eighth of a splice (2 ms at 1x), at least 2 frames
    const len = 2 * h + x;
    // Open each splice whose input window has begun: centred on the moment the playhead passes the splice's centre,
    // or starting now if that moment is already too close (the splices anchored at the punch-in).
    while (this.count < SPLICES) {
      const p = this.nextAt;
      const first = n + (p + len / 2 - q) / rate - len / 2;
      if (first > n) break;
      // A splice starting now, at take frame p, has its frame u land (q - p) + (rate - 1) u behind the playhead.
      let l = len;
      if (rate > 1) l = Math.max(2 * x + 1, Math.min(len, (this.reach - 8 - (q - p)) / (rate - 1)));
      const i = this.count++;
      this.at[i] = Math.round(p);
      this.from[i] = n;
      this.len[i] = l;
      this.ramp[i] = x;
      this.lastRamp = x;
      this.nextAt = p + l - x;
    }
    for (let i = 0; i < this.count; ) {
      const u = n - this.from[i];
      const l = this.len[i];
      if (u >= l) {
        this.drop(i); // this splice is complete
        continue;
      }
      const r = this.ramp[i];
      let w = 1;
      if (u < r) w = (u + 0.5) / r;
      else if (u > l - r) w = (l - u) / r;
      const pos = this.at[i] + u;
      if (pos >= this.spanStart) this.put(writer, pos, w, xL, xR);
      i++;
    }
    this.n = n + 1;
    this.live = true;
  }

  /**
   * The input has ended with the playhead at stream frame `qEnd` (the end of the punch-out tail, or a jump). A splice
   * whose input ran out left a gap before `qEnd`: one last splice of the most recent input, ending at `qEnd`, covers it
   * (its first frames crossfade from what is already there). Then everything gathered at or past `qEnd` is dropped, so
   * nothing lands outside the punched span.
   */
  finish(writer: SplatWriter, qEnd: number): void {
    if (!this.live) return;
    const end = Math.round(qEnd);
    const total = this.n;
    let gap = Infinity;
    for (let i = 0; i < this.count; i++) {
      const got = total - this.from[i];
      if (got < this.len[i]) gap = Math.min(gap, this.at[i] + got);
    }
    // The next splice never opened: the one before it covers up to its start plus the crossfade.
    gap = Math.min(gap, Math.round(this.nextAt) + Math.ceil(this.lastRamp));
    // Splices placed before the punch-out was known carry full gain past it: rebuild from there too.
    gap = Math.min(gap, Math.floor(this.outAt));
    if (gap < end) {
      const x = Math.max(2, Math.round(this.lastRamp));
      let start = Math.max(this.spanStart, Math.floor(gap) - x);
      let length = end - start;
      const most = Math.min(total, this.histMask + 1);
      if (length > most) {
        length = most;
        start = end - length;
      }
      const fade = Math.min(x, length);
      writer.clear(start + fade, Infinity);
      for (let u = 0; u < length; u++) {
        const k = (total - length + u) & this.histMask;
        const w = u < fade ? (u + 0.5) / fade : 1;
        this.put(writer, start + u, w, this.histL[k], this.histR[k]);
      }
    }
    writer.clear(end, Infinity);
    this.live = false;
    this.count = 0;
  }

  private drop(i: number): void {
    const last = --this.count;
    for (let k = i; k < last; k++) {
      this.at[k] = this.at[k + 1];
      this.from[k] = this.from[k + 1];
      this.len[k] = this.len[k + 1];
      this.ramp[k] = this.ramp[k + 1];
    }
  }
}
