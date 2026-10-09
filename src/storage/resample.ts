/**
 * Streaming stereo sample-rate converter (device rate -> 44.1 kHz export rate).
 *
 * Kaiser-windowed sinc interpolation (beta 8.6, 32 taps per side) with the low-pass cutoff at
 * 0.95 * min(inRate, outRate) / 2 for anti-aliasing / anti-imaging. When downsampling the kernel
 * is stretched by the cutoff ratio so it always spans 32 zero crossings of the low-pass per side
 * (about 37 input samples per side for 48 kHz -> 44.1 kHz).
 *
 * The kernel is tabulated at PHASES fractional offsets (each row normalised to unit DC gain)
 * and linearly interpolated between neighbouring phases. Output sample k sits at input time
 * k * inRate / outRate, computed from k directly (no accumulated phase error), and every output
 * depends only on the input samples around that time, so splitting the input into arbitrary
 * blocks yields bit-identical output.
 *
 * The stream is treated as zero before its first sample and after its last (added on flush()).
 * There is no latency offset: output k is time-aligned with input sample k * inRate / outRate.
 */

const TAPS_PER_SIDE = 32;
const KAISER_BETA = 8.6;
const PHASES = 512;
const CUTOFF = 0.95;

/** Modified Bessel function of the first kind, order 0 (power series). */
function besselI0(x: number): number {
  const q = (x * x) / 4;
  let term = 1;
  let sum = 1;
  for (let k = 1; k < 200; k++) {
    term *= q / (k * k);
    sum += term;
    if (term < sum * 1e-17) break;
  }
  return sum;
}

function sinc(y: number): number {
  if (y === 0) return 1;
  const a = Math.PI * y;
  return Math.sin(a) / a;
}

export class StreamingResampler {
  private readonly passthrough: boolean;
  private readonly step: number; // input samples per output sample
  private readonly half: number; // kernel support, input samples per side
  private readonly taps: number; // = 2 * half
  private readonly table: Float64Array; // (PHASES + 1) rows of `taps` coefficients
  private readonly coef: Float64Array; // scratch: interpolated coefficients for one output sample

  // Stream state. histL/histR hold the input from absolute index `base` upward; `outIndex` is the
  // index of the next output sample to produce.
  private histL = new Float32Array(0);
  private histR = new Float32Array(0);
  private base = 0;
  private outIndex = 0;

  constructor(inRate: number, outRate: number, channels: 2 = 2) {
    if (!(Number.isFinite(inRate) && inRate > 0) || !(Number.isFinite(outRate) && outRate > 0)) {
      throw new Error(`StreamingResampler: invalid rates ${inRate} -> ${outRate}`);
    }
    if (channels !== 2) throw new Error('StreamingResampler: only stereo is supported');

    this.passthrough = inRate === outRate;
    this.step = inRate / outRate;

    // Normalised cutoff s: low-pass edge = s / 2 cycles per input sample = CUTOFF * min(in, out) / 2.
    const s = CUTOFF * Math.min(1, outRate / inRate);
    const halfWidth = TAPS_PER_SIDE / s;
    this.half = Math.ceil(halfWidth);
    this.taps = 2 * this.half;
    this.coef = new Float64Array(this.taps);

    const invI0 = 1 / besselI0(KAISER_BETA);
    this.table = new Float64Array((PHASES + 1) * this.taps);
    for (let j = 0; j <= PHASES; j++) {
      const frac = j / PHASES;
      const row = j * this.taps;
      let sum = 0;
      for (let m = 0; m < this.taps; m++) {
        const x = m - this.half + 1 - frac; // tap position relative to the output sample
        const u = x / halfWidth;
        const w = Math.abs(u) < 1 ? besselI0(KAISER_BETA * Math.sqrt(1 - u * u)) * invI0 : 0;
        const h = s * sinc(s * x) * w;
        this.table[row + m] = h;
        sum += h;
      }
      for (let m = 0; m < this.taps; m++) this.table[row + m] /= sum; // unit DC gain at every phase
    }
    this.reset();
  }

  private reset(): void {
    // Zeros before the first sample, so the first output has a full kernel's worth of history.
    this.histL = new Float32Array(this.half);
    this.histR = new Float32Array(this.half);
    this.base = -this.half;
    this.outIndex = 0;
  }

  /** Feeds a block of input and returns every output sample that is now fully determined. */
  push(L: Float32Array, R: Float32Array): [Float32Array, Float32Array] {
    if (L.length !== R.length) throw new Error('StreamingResampler.push: channel lengths differ');
    if (this.passthrough) return [L.slice(), R.slice()];

    const oldLen = this.histL.length;
    const histL = new Float32Array(oldLen + L.length);
    const histR = new Float32Array(oldLen + R.length);
    histL.set(this.histL, 0);
    histL.set(L, oldLen);
    histR.set(this.histR, 0);
    histR.set(R, oldLen);

    const end = this.base + histL.length;
    const out = this.render(histL, histR, end, Infinity);

    // Drop input no later output can reach.
    const keepFrom = Math.max(this.base, Math.floor(this.outIndex * this.step) - this.half + 1);
    const drop = Math.min(keepFrom - this.base, histL.length);
    this.histL = histL.slice(drop);
    this.histR = histR.slice(drop);
    this.base += drop;
    return out;
  }

  /** Ends the stream: emits the tail (input is zero-extended) and resets for a new stream. */
  flush(): [Float32Array, Float32Array] {
    if (this.passthrough) return [new Float32Array(0), new Float32Array(0)];

    const totalIn = this.base + this.histL.length;
    const histL = new Float32Array(this.histL.length + this.half);
    const histR = new Float32Array(this.histR.length + this.half);
    histL.set(this.histL, 0);
    histR.set(this.histR, 0);

    const out = this.render(histL, histR, this.base + histL.length, totalIn);
    this.reset();
    return out;
  }

  /**
   * Produces outputs from `outIndex` while their kernel fits inside the buffer (hist covers
   * absolute indices [base, end)) and their time is below `limit` (stream length when flushing).
   */
  private render(histL: Float32Array, histR: Float32Array, end: number, limit: number): [Float32Array, Float32Array] {
    const { step, half, taps, table, coef, base } = this;
    const capacity = Math.max(0, Math.ceil((Math.min(end - half, limit)) / step) - this.outIndex + 1);
    const outL = new Float32Array(capacity);
    const outR = new Float32Array(capacity);

    let count = 0;
    let k = this.outIndex;
    for (;;) {
      const pos = k * step;
      if (pos >= limit) break;
      const i = Math.floor(pos);
      if (i + half >= end) break; // not enough lookahead yet
      const f = (pos - i) * PHASES;
      const j = Math.floor(f);
      const w = f - j;

      const r0 = j * taps;
      const r1 = r0 + taps;
      for (let t = 0; t < taps; t++) coef[t] = table[r0 + t] + w * (table[r1 + t] - table[r0 + t]);

      const start = i - half + 1 - base;
      let accL = 0;
      let accR = 0;
      for (let t = 0; t < taps; t++) {
        const c = coef[t];
        accL += c * histL[start + t];
        accR += c * histR[start + t];
      }
      outL[count] = accL;
      outR[count] = accR;
      count++;
      k++;
    }
    this.outIndex = k;
    return [outL.slice(0, count), outR.slice(0, count)];
  }
}
