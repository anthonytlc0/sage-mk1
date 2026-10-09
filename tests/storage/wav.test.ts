import { describe, it, expect } from 'vitest';
import { encodeWav, decodeWav, wavHeader, pcm24Bytes, createDither } from '../../src/storage/wav';
import { EXPORT_RATE } from '../../src/shared/constants';

const ascii = (b: Uint8Array, off: number, len = 4) => String.fromCharCode(...b.subarray(off, off + len));
const dv = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

/** Small deterministic generator for test signals (independent of the codec's dither PRNG). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function sine(n: number, freq: number, sr: number, amp: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function chunk(id: string, body: Uint8Array): Uint8Array {
  const pad = body.length & 1 ? 1 : 0;
  const out = new Uint8Array(8 + body.length + pad);
  for (let i = 0; i < 4; i++) out[i] = id.charCodeAt(i);
  dv(out).setUint32(4, body.length, true);
  out.set(body, 8);
  return out;
}

function riff(...chunks: Uint8Array[]): Uint8Array {
  const body = concat(...chunks);
  const out = new Uint8Array(12 + body.length);
  out.set([0x52, 0x49, 0x46, 0x46], 0);
  dv(out).setUint32(4, 4 + body.length, true);
  out.set([0x57, 0x41, 0x56, 0x45], 8);
  out.set(body, 12);
  return out;
}

function fmtBody(tag: number, ch: number, sr: number, bits: number): Uint8Array {
  const b = new Uint8Array(16);
  const v = dv(b);
  v.setUint16(0, tag, true);
  v.setUint16(2, ch, true);
  v.setUint32(4, sr, true);
  v.setUint32(8, (sr * ch * bits) / 8, true);
  v.setUint16(12, (ch * bits) / 8, true);
  v.setUint16(14, bits, true);
  return b;
}

describe('wavHeader', () => {
  it('pcm24 header is exactly 44 bytes with RIFF/WAVE/fmt markers and byte rate 44100*2*3', () => {
    const h = wavHeader(1000 * 6, EXPORT_RATE, 2, 'pcm24');
    expect(h.length).toBe(44);
    expect(ascii(h, 0)).toBe('RIFF');
    expect(ascii(h, 8)).toBe('WAVE');
    expect(ascii(h, 12)).toBe('fmt ');
    const v = dv(h);
    expect(v.getUint32(4, true)).toBe(36 + 6000);
    expect(v.getUint32(16, true)).toBe(16);
    expect(v.getUint16(20, true)).toBe(1);
    expect(v.getUint16(22, true)).toBe(2);
    expect(v.getUint32(24, true)).toBe(44100);
    expect(v.getUint32(28, true)).toBe(44100 * 2 * 3);
    expect(v.getUint16(32, true)).toBe(6);
    expect(v.getUint16(34, true)).toBe(24);
    expect(ascii(h, 36)).toBe('data');
    expect(v.getUint32(40, true)).toBe(6000);
  });

  it('float32 header is 58 bytes: format tag 3, fact chunk, then data', () => {
    const h = wavHeader(400 * 8, 48000, 2, 'float32');
    expect(h.length).toBe(58);
    const v = dv(h);
    expect(ascii(h, 0)).toBe('RIFF');
    expect(v.getUint32(4, true)).toBe(50 + 3200);
    expect(ascii(h, 8)).toBe('WAVE');
    expect(ascii(h, 12)).toBe('fmt ');
    expect(v.getUint32(16, true)).toBe(18);
    expect(v.getUint16(20, true)).toBe(3);
    expect(v.getUint16(22, true)).toBe(2);
    expect(v.getUint32(24, true)).toBe(48000);
    expect(v.getUint32(28, true)).toBe(48000 * 2 * 4);
    expect(v.getUint16(32, true)).toBe(8);
    expect(v.getUint16(34, true)).toBe(32);
    expect(v.getUint16(36, true)).toBe(0);
    expect(ascii(h, 38)).toBe('fact');
    expect(v.getUint32(42, true)).toBe(4);
    expect(v.getUint32(46, true)).toBe(400);
    expect(ascii(h, 50)).toBe('data');
    expect(v.getUint32(54, true)).toBe(3200);
  });

  it('accounts for the pad byte of an odd-sized data chunk in the RIFF size', () => {
    const h = wavHeader(9, EXPORT_RATE, 1, 'pcm24');
    expect(dv(h).getUint32(4, true)).toBe(36 + 9 + 1);
    expect(dv(h).getUint32(40, true)).toBe(9);
  });
});

describe('encodeWav / decodeWav', () => {
  it('float32 round trip is bit-exact', () => {
    const rnd = lcg(7);
    const n = 5000;
    const L = new Float32Array(n);
    const R = new Float32Array(n);
    for (let i = 0; i < n; i++) { L[i] = (rnd() * 2 - 1) * 1.7; R[i] = Math.fround(Math.sin(i * 0.01)); }
    L[0] = 0; L[1] = -0; L[2] = 1e-30; L[3] = -3.4e38; L[4] = 1.4e-45;
    const bytes = encodeWav([L, R], 48000, 'float32');
    expect(bytes.length).toBe(58 + n * 8);
    const out = decodeWav(bytes);
    expect(out.sr).toBe(48000);
    expect(out.chs.length).toBe(2);
    expect(new Uint32Array(out.chs[0].buffer, out.chs[0].byteOffset, n)).toEqual(new Uint32Array(L.buffer));
    expect(new Uint32Array(out.chs[1].buffer, out.chs[1].byteOffset, n)).toEqual(new Uint32Array(R.buffer));
  });

  it('pcm24 round trip has error <= 2^-22', () => {
    const n = 20000;
    const L = sine(n, 440, EXPORT_RATE, 0.9);
    const R = sine(n, 1234, EXPORT_RATE, -0.8);
    const bytes = encodeWav([L, R], EXPORT_RATE, 'pcm24');
    expect(bytes.length).toBe(44 + n * 6);
    const out = decodeWav(bytes);
    expect(out.sr).toBe(EXPORT_RATE);
    let worst = 0;
    for (let i = 0; i < n; i++) {
      worst = Math.max(worst, Math.abs(out.chs[0][i] - L[i]), Math.abs(out.chs[1][i] - R[i]));
    }
    expect(worst).toBeLessThanOrEqual(2 ** -22);
    expect(worst).toBeGreaterThan(0); // dither/quantisation actually happened
  });

  it('pcm24 mono with an odd data size is padded and decodes', () => {
    const x = sine(101, 300, EXPORT_RATE, 0.5);
    const bytes = encodeWav([x], EXPORT_RATE, 'pcm24');
    expect(bytes.length).toBe(44 + 303 + 1);
    expect(dv(bytes).getUint32(4, true)).toBe(bytes.length - 8);
    const out = decodeWav(bytes);
    expect(out.chs.length).toBe(1);
    expect(out.chs[0].length).toBe(101);
    for (let i = 0; i < 101; i++) expect(Math.abs(out.chs[0][i] - x[i])).toBeLessThanOrEqual(2 ** -22);
  });

  it('is deterministic: the same input encodes to identical bytes', () => {
    const x = sine(3000, 500, EXPORT_RATE, 0.3);
    const a = encodeWav([x, x], EXPORT_RATE, 'pcm24');
    const b = encodeWav([x, x], EXPORT_RATE, 'pcm24');
    expect(a).toEqual(b);
  });

  it('decodes pcm16', () => {
    const samples = [0, 16384, -16384, 32767, -32768];
    const data = new Uint8Array(samples.length * 2);
    samples.forEach((s, i) => dv(data).setInt16(i * 2, s, true));
    const wav = riff(chunk('fmt ', fmtBody(1, 1, 22050, 16)), chunk('data', data));
    const out = decodeWav(wav);
    expect(out.sr).toBe(22050);
    expect(out.chs.length).toBe(1);
    expect(Array.from(out.chs[0])).toEqual([0, 0.5, -0.5, 32767 / 32768, -1]);
  });

  it('skips unknown chunks, honouring odd-size padding', () => {
    const data = new Uint8Array(8);
    dv(data).setInt16(0, 8192, true);
    dv(data).setInt16(2, -8192, true);
    dv(data).setInt16(4, 16384, true);
    dv(data).setInt16(6, -16384, true);
    const wav = riff(
      chunk('LIST', new Uint8Array([1, 2, 3, 4, 5])), // odd size -> pad byte follows
      chunk('fmt ', fmtBody(1, 2, 44100, 16)),
      chunk('junk', new Uint8Array([9, 9, 9])), // odd again
      chunk('data', data),
      chunk('id3 ', new Uint8Array([1, 2, 3])), // trailing chunk after data is ignored
    );
    const out = decodeWav(wav);
    expect(out.sr).toBe(44100);
    expect(out.chs.length).toBe(2);
    expect(Array.from(out.chs[0])).toEqual([0.25, 0.5]);
    expect(Array.from(out.chs[1])).toEqual([-0.25, -0.5]);
  });

  it('decodes a view into a larger buffer (non-zero byteOffset)', () => {
    const x = Float32Array.from([0.5, -0.25, 0.125]);
    const wav = encodeWav([x], 48000, 'float32');
    const padded = new Uint8Array(wav.length + 7);
    padded.set(wav, 7);
    const out = decodeWav(padded.subarray(7));
    expect(Array.from(out.chs[0])).toEqual([0.5, -0.25, 0.125]);
  });

  it('reads the subformat of WAVE_FORMAT_EXTENSIBLE (float32 and pcm24)', () => {
    const ext = (sub: number, bits: number, ch: number, sr: number): Uint8Array => {
      const b = new Uint8Array(40);
      const v = dv(b);
      v.setUint16(0, 0xfffe, true);
      v.setUint16(2, ch, true);
      v.setUint32(4, sr, true);
      v.setUint32(8, (sr * ch * bits) / 8, true);
      v.setUint16(12, (ch * bits) / 8, true);
      v.setUint16(14, bits, true);
      v.setUint16(16, 22, true); // cbSize
      v.setUint16(18, bits, true); // valid bits
      v.setUint32(20, 3, true); // channel mask
      // subformat GUID: first two bytes are the format tag, rest is the fixed KSDATAFORMAT tail
      v.setUint16(24, sub, true);
      b.set([0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71], 26);
      return b;
    };
    const fdata = new Uint8Array(8);
    dv(fdata).setFloat32(0, 0.75, true);
    dv(fdata).setFloat32(4, -0.5, true);
    const f = decodeWav(riff(chunk('fmt ', ext(3, 32, 2, 96000)), chunk('data', fdata)));
    expect(f.sr).toBe(96000);
    expect(Array.from(f.chs[0])).toEqual([0.75]);
    expect(Array.from(f.chs[1])).toEqual([-0.5]);

    const pdata = new Uint8Array(6); // two mono samples: +0.5 (0x400000) and -0.5 (0xC00000)
    pdata.set([0x00, 0x00, 0x40, 0x00, 0x00, 0xc0]);
    const p = decodeWav(riff(chunk('fmt ', ext(1, 24, 1, 44100)), chunk('data', pdata)));
    expect(Array.from(p.chs[0])).toEqual([0.5, -0.5]);
  });

  it('tolerates a data chunk whose size overruns the file', () => {
    const wav = encodeWav([Float32Array.from([1, 2, 3, 4])], 48000, 'float32');
    const cut = wav.slice(0, wav.length - 6); // chops 1.5 samples off the end
    const out = decodeWav(cut);
    expect(Array.from(out.chs[0])).toEqual([1, 2]);
  });

  it('rejects non-WAV input, missing fmt, and unsupported formats', () => {
    expect(() => decodeWav(new Uint8Array(4))).toThrow();
    expect(() => decodeWav(new Uint8Array(64))).toThrow(/RIFF/);
    expect(() => decodeWav(riff(chunk('data', new Uint8Array(4))))).toThrow(/fmt/);
    expect(() => decodeWav(riff(chunk('fmt ', fmtBody(2, 1, 8000, 4)), chunk('data', new Uint8Array(4))))).toThrow(/unsupported/i);
  });
});

describe('pcm24Bytes', () => {
  it('is headerless, interleaved little-endian: 6 bytes per frame', () => {
    const L = Float32Array.from([0.5, -0.5]);
    const R = Float32Array.from([0.25, 0]);
    const b = pcm24Bytes(L, R, 2);
    expect(b.length).toBe(12);
    // within a few LSB of expected 24-bit integers (dither is +-1 LSB)
    const rd = (o: number) => ((b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) << 8) >> 8;
    expect(Math.abs(rd(0) - 0x400000)).toBeLessThanOrEqual(2);
    expect(Math.abs(rd(3) - 0x200000)).toBeLessThanOrEqual(2);
    expect(Math.abs(rd(6) - -0x400000)).toBeLessThanOrEqual(2);
    expect(Math.abs(rd(9) - 0)).toBeLessThanOrEqual(2);
  });

  it('only encodes the first n frames', () => {
    const L = new Float32Array(10);
    const R = new Float32Array(10);
    expect(pcm24Bytes(L, R, 4).length).toBe(24);
    expect(pcm24Bytes(L, R, 0).length).toBe(0);
  });

  it('clips out-of-range samples without wrapping', () => {
    const L = Float32Array.from([2, -2, 1e9, -1e9, Infinity, -Infinity]);
    const R = Float32Array.from([1, -1, NaN, 0.99999, -0.99999, 5]);
    const out = decodeWav(concat(wavHeader(6 * 6, EXPORT_RATE, 2, 'pcm24'), pcm24Bytes(L, R, 6)));
    for (const i of [0, 2, 4]) expect(out.chs[0][i]).toBeGreaterThan(1 - 2 ** -22);
    for (const i of [1, 3, 5]) expect(out.chs[0][i]).toBeLessThan(-1 + 2 ** -22);
    expect(out.chs[0].every((v) => v >= -1 && v < 1)).toBe(true);
    expect(out.chs[1].every((v) => v >= -1 && v < 1)).toBe(true);
    expect(Math.abs(out.chs[1][2])).toBeLessThanOrEqual(2 ** -22); // NaN -> silence
  });

  it('applies TPDF dither: a DC level of 0.3 LSB survives on average', () => {
    const n = 200000;
    const lsb = 2 ** -23;
    const L = new Float32Array(n).fill(0.3 * lsb);
    const R = new Float32Array(n).fill(-0.3 * lsb);
    const out = decodeWav(concat(wavHeader(n * 6, EXPORT_RATE, 2, 'pcm24'), pcm24Bytes(L, R, n)));
    let sl = 0, sr = 0, maxAbs = 0;
    for (let i = 0; i < n; i++) {
      sl += out.chs[0][i] / lsb;
      sr += out.chs[1][i] / lsb;
      maxAbs = Math.max(maxAbs, Math.abs(out.chs[0][i] / lsb));
    }
    expect(sl / n).toBeGreaterThan(0.27);
    expect(sl / n).toBeLessThan(0.33);
    expect(sr / n).toBeGreaterThan(-0.33);
    expect(sr / n).toBeLessThan(-0.27);
    expect(maxAbs).toBeLessThanOrEqual(2); // dither is +-1 LSB around rounding
  });

  it('is reproducible with a seeded dither and equals encodeWav payload', () => {
    const x = sine(2000, 700, EXPORT_RATE, 0.4);
    const y = sine(2000, 900, EXPORT_RATE, 0.4);
    const a = pcm24Bytes(x, y, 2000, createDither(1234));
    const b = pcm24Bytes(x, y, 2000, createDither(1234));
    const c = pcm24Bytes(x, y, 2000, createDither(99));
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    const wav = encodeWav([x, y], EXPORT_RATE, 'pcm24');
    const viaParts = concat(wavHeader(2000 * 6, EXPORT_RATE, 2, 'pcm24'), pcm24Bytes(x, y, 2000, createDither()));
    expect(viaParts).toEqual(wav);
  });

  it('continues the dither stream across chunked calls', () => {
    const x = sine(1000, 700, EXPORT_RATE, 0.4);
    const d1 = createDither(5);
    const whole = pcm24Bytes(x, x, 1000, d1);
    const d2 = createDither(5);
    const parts = concat(
      pcm24Bytes(x.subarray(0, 300), x.subarray(0, 300), 300, d2),
      pcm24Bytes(x.subarray(300), x.subarray(300), 700, d2),
    );
    expect(parts).toEqual(whole);
  });
});
