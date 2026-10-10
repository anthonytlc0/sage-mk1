/**
 * WAV codec for Sage MK1.
 *
 * - Exports are 44.1 kHz 24-bit PCM (`pcm24`, plain 44-byte header, TPDF dithered).
 * - Memory files are 32-bit float (`float32`, format tag 3 + `fact` chunk, 58-byte header)
 *   at the device's native rate and round-trip bit-exactly.
 *
 * `wavHeader` + raw `pcm24Bytes` chunks can be concatenated to build a pcm24 WAV
 * incrementally without holding every sample in memory.
 */

export type WavFormat = 'pcm24' | 'float32';

const FORMAT_PCM = 1;
const FORMAT_IEEE_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xfffe;

const PCM24_HEADER_BYTES = 44;
const FLOAT32_HEADER_BYTES = 58;

const PCM24_SCALE = 0x800000; // 2^23
const PCM24_MAX = 0x7fffff;
const PCM24_MIN = -0x800000;

/** Writes a 4-character ASCII tag. */
function putTag(v: DataView, off: number, tag: string): void {
  for (let i = 0; i < 4; i++) v.setUint8(off + i, tag.charCodeAt(i));
}

function getTag(v: DataView, off: number): string {
  return String.fromCharCode(v.getUint8(off), v.getUint8(off + 1), v.getUint8(off + 2), v.getUint8(off + 3));
}

function bytesPerSample(format: WavFormat): number {
  return format === 'pcm24' ? 3 : 4;
}

/**
 * Header for a WAV whose data chunk is `dataBytes` long.
 * pcm24 -> 44 bytes (format tag 1). float32 -> 58 bytes (format tag 3, fmt size 18, `fact` chunk).
 * An odd `dataBytes` is accounted for with the mandatory RIFF pad byte (the caller appends it).
 */
export function wavHeader(dataBytes: number, sr: number, channels: number, format: WavFormat): Uint8Array {
  const bps = bytesPerSample(format);
  const blockAlign = channels * bps;
  const isFloat = format === 'float32';
  const header = new Uint8Array(isFloat ? FLOAT32_HEADER_BYTES : PCM24_HEADER_BYTES);
  const v = new DataView(header.buffer);
  const riffSize = header.length - 8 + dataBytes + (dataBytes & 1);

  putTag(v, 0, 'RIFF');
  v.setUint32(4, riffSize, true);
  putTag(v, 8, 'WAVE');
  putTag(v, 12, 'fmt ');
  v.setUint32(16, isFloat ? 18 : 16, true);
  v.setUint16(20, isFloat ? FORMAT_IEEE_FLOAT : FORMAT_PCM, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * blockAlign, true);
  v.setUint16(32, blockAlign, true);
  v.setUint16(34, bps * 8, true);
  let o = 36;
  if (isFloat) {
    v.setUint16(o, 0, true); // cbSize
    o += 2;
    putTag(v, o, 'fact');
    v.setUint32(o + 4, 4, true);
    v.setUint32(o + 8, Math.floor(dataBytes / blockAlign), true); // sample frames
    o += 12;
  }
  putTag(v, o, 'data');
  v.setUint32(o + 4, dataBytes, true);
  return header;
}

/** A dither source: returns one TPDF sample in (-1, 1) 24-bit LSB per call. */
export type Dither = () => number;

/**
 * Deterministic TPDF dither (two uniform draws from a seeded mulberry32 PRNG,
 * so the triangular noise spans +-1 LSB of 24-bit). Same seed -> same stream.
 */
export function createDither(seed = 0x5a6e4d4b): Dither {
  let s = seed >>> 0;
  const uniform = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
  return () => uniform() - uniform();
}

/** Shared stream for callers that encode in chunks and do not manage their own dither. */
const sharedDither = createDither();

/** Clip, dither and round one sample to a signed 24-bit integer. NaN becomes 0. */
function quantize24(x: number, dither: Dither): number {
  const c = x > 1 ? 1 : x < -1 ? -1 : x === x ? x : 0;
  const q = Math.round(c * PCM24_SCALE + dither());
  return q > PCM24_MAX ? PCM24_MAX : q < PCM24_MIN ? PCM24_MIN : q;
}

function pcm24Interleave(chs: Float32Array[], n: number, dither: Dither): Uint8Array {
  const nch = chs.length;
  const out = new Uint8Array(n * nch * 3);
  let o = 0;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nch; c++) {
      const q = quantize24(chs[c][i], dither);
      out[o++] = q & 0xff;
      out[o++] = (q >> 8) & 0xff;
      out[o++] = (q >> 16) & 0xff;
    }
  }
  return out;
}

/**
 * Raw interleaved little-endian 24-bit stereo payload (no header) for the first `n` frames.
 * Samples are clipped to [-1, 1] and TPDF dithered; pass a `dither` to control the stream
 * (defaults to a shared deterministic stream that continues across calls).
 */
export function pcm24Bytes(L: Float32Array, R: Float32Array, n: number, dither: Dither = sharedDither): Uint8Array {
  return pcm24Interleave([L, R], n, dither);
}

function float32Interleave(chs: Float32Array[], n: number): Uint8Array {
  const nch = chs.length;
  const out = new Uint8Array(n * nch * 4);
  const v = new DataView(out.buffer);
  let o = 0;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nch; c++) {
      v.setFloat32(o, chs[c][i], true);
      o += 4;
    }
  }
  return out;
}

/** Encodes a complete WAV file. `pcm24` is dithered from a fresh seeded stream, so output is reproducible. */
export function encodeWav(chs: Float32Array[], sr: number, format: WavFormat): Uint8Array {
  if (chs.length === 0) throw new Error('encodeWav: at least one channel is required');
  const n = chs[0].length;
  for (const ch of chs) if (ch.length !== n) throw new Error('encodeWav: channel lengths differ');

  const data = format === 'pcm24' ? pcm24Interleave(chs, n, createDither()) : float32Interleave(chs, n);
  const header = wavHeader(data.length, sr, chs.length, format);
  const pad = data.length & 1;
  const out = new Uint8Array(header.length + data.length + pad);
  out.set(header, 0);
  out.set(data, header.length);
  return out;
}

interface Fmt {
  kind: 'pcm' | 'float';
  channels: number;
  sr: number;
  bits: number;
}

function parseFmt(v: DataView, body: number, size: number): Fmt {
  if (size < 16) throw new Error('decodeWav: fmt chunk too short');
  let tag = v.getUint16(body, true);
  const channels = v.getUint16(body + 2, true);
  const sr = v.getUint32(body + 4, true);
  const bits = v.getUint16(body + 14, true);
  if (tag === FORMAT_EXTENSIBLE) {
    if (size < 26) throw new Error('decodeWav: extensible fmt chunk too short');
    tag = v.getUint16(body + 24, true); // first two bytes of the subformat GUID are the format tag
  }
  if (channels < 1) throw new Error('decodeWav: no channels');
  if (tag === FORMAT_PCM && (bits === 16 || bits === 24)) return { kind: 'pcm', channels, sr, bits };
  if (tag === FORMAT_IEEE_FLOAT && bits === 32) return { kind: 'float', channels, sr, bits };
  throw new Error(`decodeWav: unsupported format (tag ${tag}, ${bits} bits)`);
}

/** Decodes pcm16, pcm24 or float32 WAV (including WAVE_FORMAT_EXTENSIBLE) to float channels. */
export function decodeWav(bytes: Uint8Array): { sr: number; chs: Float32Array[] } {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 12 || getTag(v, 0) !== 'RIFF' || getTag(v, 8) !== 'WAVE') {
    throw new Error('decodeWav: not a RIFF/WAVE file');
  }

  let fmt: Fmt | null = null;
  let dataOff = -1;
  let dataLen = 0;
  let off = 12;
  while (off + 8 <= bytes.length) {
    const id = getTag(v, off);
    const size = v.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 'fmt ') {
      fmt = parseFmt(v, body, Math.min(size, bytes.length - body));
    } else if (id === 'data') {
      dataOff = body;
      dataLen = Math.min(size, bytes.length - body); // tolerate truncated / oversized data chunks
      break;
    }
    off = body + size + (size & 1); // chunks are word aligned
  }
  if (!fmt) throw new Error('decodeWav: missing fmt chunk');
  if (dataOff < 0) throw new Error('decodeWav: missing data chunk');

  const bps = fmt.bits / 8;
  const frames = Math.floor(dataLen / (bps * fmt.channels));
  const chs: Float32Array[] = Array.from({ length: fmt.channels }, () => new Float32Array(frames));
  let p = dataOff;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < fmt.channels; c++) {
      let s: number;
      if (fmt.kind === 'float') {
        s = v.getFloat32(p, true);
      } else if (fmt.bits === 24) {
        s = (((v.getUint8(p) | (v.getUint8(p + 1) << 8) | (v.getUint8(p + 2) << 16)) << 8) >> 8) / PCM24_SCALE;
      } else {
        s = v.getInt16(p, true) / 0x8000;
      }
      chs[c][i] = s;
      p += bps;
    }
  }
  return { sr: fmt.sr, chs };
}
