/**
 * RBJ "Audio EQ Cookbook" biquads (transposed direct form II, double-precision state).
 *
 * Audio-thread code: nothing here allocates after construction. The coefficient setters only assign numbers, and
 * `process` works in place on the caller's buffer. State is flushed to zero once it falls below FLUSH, so a decaying
 * filter never grinds through denormal doubles.
 */

/** State and output values smaller than this (-400 dBFS) are replaced by 0, which keeps decaying tails out of denormal range. */
export const FLUSH = 1e-20;

export class Biquad {
  private b0 = 1; private b1 = 0; private b2 = 0; private a1 = 0; private a2 = 0;
  private z1 = 0; private z2 = 0;
  /** Scratch for the setters: cos / sin of the corner angle and the cookbook's alpha = sin / 2Q. */
  private c = 0; private s = 0; private alpha = 0;

  /** Passes the signal unchanged. */
  identity(): void { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; }

  lowpass(sr: number, f: number, q: number): void {
    this.prep(sr, f, q);
    const c = this.c, alpha = this.alpha;
    this.set((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + alpha, -2 * c, 1 - alpha);
  }

  highpass(sr: number, f: number, q: number): void {
    this.prep(sr, f, q);
    const c = this.c, alpha = this.alpha;
    this.set((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + alpha, -2 * c, 1 - alpha);
  }

  /** Peaking band: `gainDb` at the centre `f`, bandwidth set by `q`. */
  peaking(sr: number, f: number, q: number, gainDb: number): void {
    this.prep(sr, f, q);
    const c = this.c, alpha = this.alpha;
    const A = Math.pow(10, gainDb / 40);
    this.set(1 + alpha * A, -2 * c, 1 - alpha * A, 1 + alpha / A, -2 * c, 1 - alpha / A);
  }

  /** Low shelf with the cookbook's shelf slope S (1 = steepest without overshoot). */
  lowShelf(sr: number, f: number, gainDb: number, slope = 1): void {
    this.prep(sr, f, 1);
    const c = this.c, s = this.s;
    const A = Math.pow(10, gainDb / 40);
    const beta = 2 * Math.sqrt(A) * (s / 2) * Math.sqrt((A + 1 / A) * (1 / slope - 1) + 2);
    this.set(
      A * ((A + 1) - (A - 1) * c + beta), 2 * A * ((A - 1) - (A + 1) * c), A * ((A + 1) - (A - 1) * c - beta),
      (A + 1) + (A - 1) * c + beta, -2 * ((A - 1) + (A + 1) * c), (A + 1) + (A - 1) * c - beta,
    );
  }

  highShelf(sr: number, f: number, gainDb: number, slope = 1): void {
    this.prep(sr, f, 1);
    const c = this.c, s = this.s;
    const A = Math.pow(10, gainDb / 40);
    const beta = 2 * Math.sqrt(A) * (s / 2) * Math.sqrt((A + 1 / A) * (1 / slope - 1) + 2);
    this.set(
      A * ((A + 1) + (A - 1) * c + beta), -2 * A * ((A - 1) + (A + 1) * c), A * ((A + 1) + (A - 1) * c - beta),
      (A + 1) - (A - 1) * c + beta, 2 * ((A - 1) - (A + 1) * c), (A + 1) - (A - 1) * c - beta,
    );
  }

  reset(): void { this.z1 = 0; this.z2 = 0; }

  /** Filters `buf[0..n)` in place. */
  process(buf: Float32Array, n: number): void {
    const b0 = this.b0, b1 = this.b1, b2 = this.b2, a1 = this.a1, a2 = this.a2;
    let z1 = this.z1, z2 = this.z2;
    for (let i = 0; i < n; i++) {
      const x = buf[i]!;
      let y = b0 * x + z1;
      z1 = b1 * x - a1 * y + z2;
      z2 = b2 * x - a2 * y;
      if (z1 < FLUSH && z1 > -FLUSH) z1 = 0;
      if (z2 < FLUSH && z2 > -FLUSH) z2 = 0;
      if (y < FLUSH && y > -FLUSH) y = 0;
      buf[i] = y;
    }
    this.z1 = z1; this.z2 = z2;
  }

  /** Fills c, s and alpha for a corner at `f` (clamped to stay below Nyquist). */
  private prep(sr: number, f: number, q: number): void {
    const fc = Math.min(Math.max(f, 1), sr * 0.45);
    const w0 = (2 * Math.PI * fc) / sr;
    this.s = Math.sin(w0);
    this.c = Math.cos(w0);
    this.alpha = this.s / (2 * q);
  }

  private set(b0: number, b1: number, b2: number, a0: number, a1: number, a2: number): void {
    const inv = 1 / a0;
    this.b0 = b0 * inv; this.b1 = b1 * inv; this.b2 = b2 * inv; this.a1 = a1 * inv; this.a2 = a2 * inv;
  }
}
