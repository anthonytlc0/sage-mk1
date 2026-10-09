/** Shared helpers for the DSP tests. Not a test file (vitest only picks up *.test.ts). */

export const SR = 48000;

export const dbToLin = (db: number): number => 10 ** (db / 20);
export const linToDb = (x: number): number => 20 * Math.log10(x);

/** A sine of `n` samples at `freq` Hz and `peakDb` dBFS peak. */
export function sine(n: number, freq: number, peakDb: number, sr = SR): Float32Array {
  const out = new Float32Array(n);
  const a = dbToLin(peakDb);
  for (let i = 0; i < n; i++) out[i] = a * Math.sin((2 * Math.PI * freq * i) / sr);
  return out;
}

/** Deterministic white noise (xorshift32) at the given RMS in dBFS. */
export function noise(n: number, rmsDb: number, seed = 12345): Float32Array {
  const out = new Float32Array(n);
  let s = seed >>> 0 || 1;
  const sigma = dbToLin(rmsDb);
  for (let i = 0; i < n; i++) {
    // sum of 4 uniforms, roughly Gaussian with variance 4/12 = 1/3
    let acc = 0;
    for (let k = 0; k < 4; k++) {
      s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
      acc += s / 0xffffffff - 0.5;
    }
    out[i] = (acc / Math.sqrt(4 / 12)) * sigma;
  }
  return out;
}

export function fill(n: number, v: number): Float32Array {
  return new Float32Array(n).fill(v);
}

export function rms(buf: Float32Array, from = 0, to = buf.length): number {
  let acc = 0;
  for (let i = from; i < to; i++) acc += buf[i]! * buf[i]!;
  return Math.sqrt(acc / (to - from));
}

export function peak(buf: Float32Array, from = 0, to = buf.length): number {
  let m = 0;
  for (let i = from; i < to; i++) m = Math.max(m, Math.abs(buf[i]!));
  return m;
}

export function allFinite(buf: Float32Array): boolean {
  for (let i = 0; i < buf.length; i++) if (!Number.isFinite(buf[i]!)) return false;
  return true;
}

/** Runs `fn(chunk, offset, len)` over `buf` in blocks of `block` frames (the worklet's block size by default). */
export function inBlocks(total: number, fn: (offset: number, len: number) => void, block = 128): void {
  for (let o = 0; o < total; o += block) fn(o, Math.min(block, total - o));
}

/** Copies are views, so processors that work in place see the same memory as the source array. */
export function view(buf: Float32Array, offset: number, len: number): Float32Array {
  return buf.subarray(offset, offset + len);
}
