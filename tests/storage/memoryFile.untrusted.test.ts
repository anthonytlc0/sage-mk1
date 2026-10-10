import { describe, it, expect, vi } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import type { Zippable } from 'fflate';
import { defaultMemory, defaultSystem } from '../../src/schema/params';
import {
  MAX_DECODED_BYTES,
  UnsupportedFile,
  packBackup,
  packMemory,
  unpackBackup,
  unpackMemory,
} from '../../src/storage/memoryFile';
import { decodeWav, encodeWav } from '../../src/storage/wav';

// Pass-through spy so one test can make decodeWav return something it never does for a real file.
vi.mock('../../src/storage/wav', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/storage/wav')>();
  return { ...real, decodeWav: vi.fn(real.decodeWav) };
});

// ---------------------------------------------------------------------------------------------------------------------
// Builders: memory files are assembled by hand so each test can break exactly one thing.
// ---------------------------------------------------------------------------------------------------------------------

const goodMeta = { recordedTempo: 120, measures: 4, sampleRate: 48000 };

function ramp(n: number, k: number): Float32Array {
  return Float32Array.from({ length: n }, (_, i) => ((i * 7 + k) % 200) / 100 - 1);
}

const goodWav = (n = 100, sr = 48000): Uint8Array => encodeWav([ramp(n, 1), ramp(n, 2)], sr, 'float32');

/** A WAV with an arbitrary format: `data` is the raw payload. */
function rawWav(tag: number, channels: number, sr: number, bits: number, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(44 + data.length);
  const v = new DataView(out.buffer);
  out.set(strToU8('RIFF'), 0);
  v.setUint32(4, 36 + data.length, true);
  out.set(strToU8('WAVEfmt '), 8);
  v.setUint32(16, 16, true);
  v.setUint16(20, tag, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, (sr * channels * bits) / 8, true);
  v.setUint16(32, (channels * bits) / 8, true);
  v.setUint16(34, bits, true);
  out.set(strToU8('data'), 36);
  v.setUint32(40, data.length, true);
  out.set(data, 44);
  return out;
}

function pcm16Stereo(frames: number, sr: number, value = 16384): Uint8Array {
  const data = new Uint8Array(frames * 4);
  const v = new DataView(data.buffer);
  for (let i = 0; i < frames * 2; i++) v.setInt16(i * 2, value, true);
  return rawWav(1, 2, sr, 16, data);
}

type Doc = Record<string, unknown>;
const memDoc = (over: Doc = {}): Doc => ({
  format: 'sage-mk1-memory',
  version: 1,
  settings: defaultMemory(),
  tracks: [goodMeta, null, null, null, null],
  ...over,
});
const json = (doc: unknown): Uint8Array => strToU8(JSON.stringify(doc));
const zipMem = (doc: unknown, wavs: Record<string, Uint8Array> = {}, extra: Zippable = {}): Uint8Array =>
  zipSync({ 'memory.json': json(doc), ...wavs, ...extra });

const reject = (bytes: Uint8Array, rate = 48000): void => {
  expect(() => unpackMemory(bytes, rate)).toThrow(UnsupportedFile);
};

// ---------------------------------------------------------------------------------------------------------------------

describe('unpackMemory: memory.json', () => {
  it('accepts the hand-built baseline (so the rejection tests below break only one thing)', () => {
    const out = unpackMemory(zipMem(memDoc(), { 'track1.wav': goodWav() }), 48000);
    expect(out.tracks[0]!.L).toHaveLength(100);
  });

  it('rejects a file with no memory.json', () => {
    reject(zipSync({ 'track1.wav': goodWav() }));
    reject(zipSync({ 'readme.txt': strToU8('hi') }));
  });

  it('only looks for memory.json at the root, by exact name', () => {
    for (const name of ['sub/memory.json', '../memory.json', 'MEMORY.JSON', 'memory.json.bak', '/memory.json']) {
      reject(zipSync({ [name]: json(memDoc()) }));
    }
  });

  it('rejects a memory.json that is not JSON or not an object', () => {
    for (const text of ['{{{ nope', '', '[]', 'null', '5', '"x"', 'true']) {
      reject(zipSync({ 'memory.json': strToU8(text) }));
    }
    reject(zipSync({ 'memory.json': new Uint8Array([0xff, 0xfe, 0x00, 0x80]) }));
  });

  it('rejects a wrong or missing format', () => {
    for (const format of ['sage-mk1-backup', 'sage-mk1', '', 5, null]) reject(zipMem(memDoc({ format })));
    const { format: _gone, ...noFormat } = memDoc();
    reject(zipMem(noFormat));
  });

  it('rejects a version newer than 1, and a version that is not a positive integer', () => {
    for (const version of [2, 3, 99, 1.0000001, 0, -1, '1', null, true, 1e999]) reject(zipMem(memDoc({ version })));
    const { version: _gone, ...noVersion } = memDoc();
    reject(zipMem(noVersion));
  });

  it('rejects settings that are not an object, and tracks that are not an array', () => {
    for (const settings of [undefined, null, [], 'x', 5]) reject(zipMem(memDoc({ settings })));
    for (const tracks of [undefined, null, {}, 'x', 5]) reject(zipMem(memDoc({ tracks })));
  });

  it('rejects an oversized memory.json before inflating it', () => {
    const huge = strToU8(JSON.stringify(memDoc()) + ' '.repeat(5_000_000));
    reject(zipSync({ 'memory.json': [huge, { level: 6 }] }));
  });

  it('rejects an invalid targetRate (a caller bug, not a bad file)', () => {
    const file = zipMem(memDoc());
    for (const rate of [0, -44100, NaN, Infinity]) expect(() => unpackMemory(file, rate)).toThrow(RangeError);
  });
});

describe('unpackMemory: tracks', () => {
  const metas = (n = 5) => Array.from({ length: n }, () => goodMeta);

  it('maps trackN.wav to track N for N in 1-5', () => {
    const wavs: Record<string, Uint8Array> = {};
    for (let n = 1; n <= 5; n++) wavs[`track${n}.wav`] = goodWav(10 * n);
    const out = unpackMemory(zipMem(memDoc({ tracks: metas() }), wavs), 48000);
    expect(out.tracks.map((t) => t!.L.length)).toEqual([10, 20, 30, 40, 50]);
  });

  it('ignores trackN.wav entries outside 1-5 (even garbage ones) and look-alike names', () => {
    const junk = new Uint8Array([1, 2, 3]);
    const out = unpackMemory(
      zipMem(memDoc({ tracks: metas() }), {}, {
        'track0.wav': junk, 'track6.wav': junk, 'track10.wav': junk, 'track01.wav': junk, 'track-1.wav': junk,
        'sub/track1.wav': junk, 'TRACK2.WAV': junk, 'track3.wav.bak': junk,
      }),
      48000,
    );
    expect(out.tracks).toEqual([null, null, null, null, null]);
  });

  it('ignores unknown entries (folders, resource forks, notes)', () => {
    const out = unpackMemory(
      zipMem(memDoc(), { 'track1.wav': goodWav() }, { 'notes.txt': strToU8('x'), '__MACOSX/._track1.wav': new Uint8Array(10), 'folder/': new Uint8Array(0) }),
      48000,
    );
    expect(out.tracks[0]).not.toBeNull();
  });

  it('treats a track whose memory.json entry is null as absent, even when its WAV exists (or is garbage)', () => {
    const out = unpackMemory(
      zipMem(memDoc({ tracks: [goodMeta, null, goodMeta, null, null] }), {
        'track1.wav': goodWav(),
        'track2.wav': goodWav(),
        'track3.wav': goodWav(),
        'track4.wav': new Uint8Array([9, 9, 9]),
      }),
      48000,
    );
    expect(out.tracks.map((t) => t !== null)).toEqual([true, false, true, false, false]);
  });

  it('treats a track that has metadata but no WAV as absent', () => {
    const out = unpackMemory(zipMem(memDoc({ tracks: metas() }), { 'track2.wav': goodWav() }), 48000);
    expect(out.tracks.map((t) => t !== null)).toEqual([false, true, false, false, false]);
  });

  it('ignores track metadata beyond the fifth entry and tolerates a short list', () => {
    const out = unpackMemory(zipMem(memDoc({ tracks: [...metas(5), goodMeta, goodMeta, 'junk'] }), { 'track1.wav': goodWav() }), 48000);
    expect(out.tracks).toHaveLength(5);
    expect(unpackMemory(zipMem(memDoc({ tracks: [] }), { 'track1.wav': goodWav() }), 48000).tracks).toEqual([null, null, null, null, null]);
  });

  it('treats a WAV with no frames as an absent track', () => {
    const out = unpackMemory(zipMem(memDoc(), { 'track1.wav': encodeWav([new Float32Array(0), new Float32Array(0)], 48000, 'float32') }), 48000);
    expect(out.tracks[0]).toBeNull();
  });

  it('rejects a WAV that is garbage, not stereo, or not float32 / pcm16 / pcm24', () => {
    const f32 = (n: number) => new Uint8Array(new Float32Array(n).buffer);
    const bad: Uint8Array[] = [
      new Uint8Array([1, 2, 3, 4]),                                  // not a WAV
      strToU8('RIFF....WAVE'),                                        // header only
      encodeWav([ramp(50, 1)], 48000, 'float32'),                     // mono float32
      encodeWav([ramp(50, 1)], 48000, 'pcm24'),                       // mono pcm24
      rawWav(3, 6, 48000, 32, f32(60)),                               // six channels
      rawWav(1, 2, 48000, 8, new Uint8Array(100)),                    // 8-bit PCM
      rawWav(1, 2, 48000, 32, new Uint8Array(400)),                   // 32-bit integer PCM
      rawWav(3, 2, 48000, 64, new Uint8Array(400)),                   // 64-bit float
    ];
    for (const wav of bad) reject(zipMem(memDoc(), { 'track1.wav': wav }));
  });

  it('accepts a stereo pcm16 or pcm24 WAV', () => {
    const p16 = unpackMemory(zipMem(memDoc(), { 'track1.wav': pcm16Stereo(50, 48000, 16384) }), 48000).tracks[0]!;
    expect(p16.L).toHaveLength(50);
    expect(p16.L[0]).toBeCloseTo(0.5, 5);
    const p24 = unpackMemory(zipMem(memDoc(), { 'track1.wav': encodeWav([ramp(50, 1), ramp(50, 2)], 48000, 'pcm24') }), 48000).tracks[0]!;
    expect(p24.R[3]).toBeCloseTo(ramp(50, 2)[3]!, 5);
  });

  it('rejects a WAV whose decoded channels differ in length', () => {
    vi.mocked(decodeWav).mockReturnValueOnce({ sr: 48000, chs: [new Float32Array(10), new Float32Array(9)] });
    reject(zipMem(memDoc(), { 'track1.wav': goodWav() }));
  });

  it('rejects track metadata that is not an object, or whose tempo / measures / rate are not sane', () => {
    const wav = { 'track1.wav': goodWav() };
    const tracks = (meta: unknown) => memDoc({ tracks: [meta, null, null, null, null] });
    for (const meta of [5, 'x', true, [], [goodMeta]]) reject(zipMem(tracks(meta), wav));
    for (const recordedTempo of [null, '120', 1e999, undefined, true, {}]) reject(zipMem(tracks({ ...goodMeta, recordedTempo }), wav));
    for (const measures of ['4', 0, -1, undefined, true, {}]) reject(zipMem(tracks({ ...goodMeta, measures }), wav));
    for (const sampleRate of [null, '48000', 44100, 0, undefined]) reject(zipMem(tracks({ ...goodMeta, sampleRate }), wav));
  });

  it('rejects infinite numbers written as literals in the JSON text (JSON.stringify cannot produce them)', () => {
    const text = (meta: string) => `{"format":"sage-mk1-memory","version":1,"settings":{},"tracks":[${meta},null,null,null,null]}`;
    const wav = { 'track1.wav': goodWav() };
    for (const meta of [
      '{"recordedTempo":120,"measures":1e999,"sampleRate":48000}',
      '{"recordedTempo":1e999,"measures":4,"sampleRate":48000}',
      '{"recordedTempo":120,"measures":4,"sampleRate":1e999}',
    ]) {
      reject(zipSync({ 'memory.json': strToU8(text(meta)), ...wav }));
    }
  });

  it('clamps a recorded tempo outside the tempo range, like the memory tempo', () => {
    const wav = { 'track1.wav': goodWav() };
    const tempoOf = (recordedTempo: number) =>
      unpackMemory(zipMem(memDoc({ tracks: [{ ...goodMeta, recordedTempo }, null, null, null, null] }), wav), 48000).tracks[0]!.recordedTempo;
    expect(tempoOf(10000)).toBe(300);
    expect(tempoOf(39)).toBe(40);
    expect(tempoOf(0)).toBe(40);
    expect(tempoOf(-3)).toBe(40);
    expect(tempoOf(133.3)).toBe(133.3);
  });

  it('keeps fractional measures (a note-length loop is 0.25 measures) and null', () => {
    const wav = { 'track1.wav': goodWav(), 'track2.wav': goodWav() };
    const out = unpackMemory(zipMem(memDoc({ tracks: [{ ...goodMeta, measures: 0.25 }, { ...goodMeta, measures: null }, null, null, null] }), wav), 48000);
    expect(out.tracks[0]!.measures).toBe(0.25);
    expect(out.tracks[1]!.measures).toBeNull();
  });

  it('rejects a WAV whose sample rate is absurd (it would explode when resampled)', () => {
    for (const sr of [1, 100, 7999, 384001, 1e9]) {
      const wav = encodeWav([ramp(50, 1), ramp(50, 2)], sr, 'float32');
      reject(zipMem(memDoc({ tracks: [{ ...goodMeta, sampleRate: sr }, null, null, null, null] }), { 'track1.wav': wav }));
    }
  });
});

describe('unpackMemory: size cap', () => {
  it('has a default cap of 1 GiB', () => {
    expect(MAX_DECODED_BYTES).toBe(1024 * 1024 * 1024);
  });

  it('does not count, or even inflate, entries the format does not define', () => {
    const big = new Uint8Array(200_000); // would blow a 20 kB cap if it were read
    const small = goodWav(100); // 858 bytes
    const mem = zipMem(memDoc(), { 'track1.wav': small }, { 'track6.wav': big, 'track0.wav': big, 'notes.bin': big });
    expect(() => unpackMemory(mem, 48000, { maxDecodedBytes: 20_000 })).not.toThrow();
    const backup = zipSync({
      'backup.json': json({ format: 'sage-mk1-backup', version: 1, system: defaultSystem(), memories: [{ slot: 1, present: true }, { slot: 2, present: false }] }),
      'm01/memory.json': json(memDoc()),
      'm01/track1.wav': small,
      'm01/track9.wav': big,
      'm02/memory.json': json(memDoc()),
      'm02/track1.wav': big, // a slot not marked present
    });
    expect(() => unpackBackup(backup, 48000, { maxDecodedBytes: 20_000 })).not.toThrow();
  });

  it('accepts a file up to the cap and rejects one over it (frames x 2 channels x 4 bytes)', () => {
    const file = zipMem(memDoc(), { 'track1.wav': pcm16Stereo(1000, 48000) }); // 1000 frames: 8000 bytes decoded
    expect(() => unpackMemory(file, 48000, { maxDecodedBytes: 8000 })).not.toThrow();
    expect(() => unpackMemory(file, 48000, { maxDecodedBytes: 7999 })).toThrow(UnsupportedFile);
  });

  it('rejects before inflating when the WAV entries alone are over the cap', () => {
    const file = zipMem(memDoc(), { 'track1.wav': goodWav(10_000) });
    expect(() => unpackMemory(file, 48000, { maxDecodedBytes: 1000 })).toThrow(UnsupportedFile);
  });

  it('counts decoded samples, not file bytes: pcm16 decodes to twice its size', () => {
    const file = zipMem(memDoc(), { 'track1.wav': pcm16Stereo(1000, 48000) }); // ~4 KB of WAV, 8 KB decoded
    expect(() => unpackMemory(file, 48000, { maxDecodedBytes: 9000 })).not.toThrow();
    expect(() => unpackMemory(file, 48000, { maxDecodedBytes: 6000 })).toThrow(UnsupportedFile);
  });

  it('sums the tracks of a file', () => {
    const file = zipMem(memDoc({ tracks: [goodMeta, goodMeta, null, null, null] }), { 'track1.wav': pcm16Stereo(1000, 48000), 'track2.wav': pcm16Stereo(1000, 48000) });
    expect(() => unpackMemory(file, 48000, { maxDecodedBytes: 16000 })).not.toThrow();
    expect(() => unpackMemory(file, 48000, { maxDecodedBytes: 12000 })).toThrow(UnsupportedFile);
  });

  it('counts the resampled size when upsampling would grow a track past the cap', () => {
    const wav = encodeWav([ramp(1000, 1), ramp(1000, 2)], 8000, 'float32');          // 8 KB decoded; 48 KB at 48 kHz
    const file = zipMem(memDoc({ tracks: [{ ...goodMeta, sampleRate: 8000 }, null, null, null, null] }), { 'track1.wav': wav });
    expect(() => unpackMemory(file, 8000, { maxDecodedBytes: 20_000 })).not.toThrow();
    expect(() => unpackMemory(file, 48000, { maxDecodedBytes: 20_000 })).toThrow(UnsupportedFile);
    expect(() => unpackMemory(file, 48000, { maxDecodedBytes: 100_000 })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('unpackBackup: untrusted files', () => {
  const memFiles = (prefix: string, wav = goodWav()): Zippable => ({
    [`${prefix}memory.json`]: json(memDoc()),
    [`${prefix}track1.wav`]: wav,
  });
  const backupDoc = (over: Doc = {}): Doc => ({
    format: 'sage-mk1-backup',
    version: 1,
    system: defaultSystem(),
    memories: [{ slot: 1, present: true }],
    ...over,
  });
  const zipBackup = (doc: unknown, files: Zippable = memFiles('m01/')): Uint8Array => zipSync({ 'backup.json': json(doc), ...files });
  const rejectB = (bytes: Uint8Array, rate = 48000): void => {
    expect(() => unpackBackup(bytes, rate)).toThrow(UnsupportedFile);
  };

  it('accepts the hand-built baseline', () => {
    const out = unpackBackup(zipBackup(backupDoc()), 48000);
    expect(out.memories[0]!.tracks[0]!.L).toHaveLength(100);
    expect(out.system).toEqual(defaultSystem());
  });

  it('rejects a missing or garbage backup.json, a wrong format, and a version newer than 1', () => {
    rejectB(zipSync(memFiles('m01/')));
    rejectB(zipSync({ 'backup.json': strToU8('{{{') }));
    rejectB(zipSync({ 'backup.json': strToU8('[]') }));
    for (const format of ['sage-mk1-memory', '', null, 7]) rejectB(zipBackup(backupDoc({ format })));
    for (const version of [2, 100, 0, -1, '1', null, 1.5]) rejectB(zipBackup(backupDoc({ version })));
  });

  it('rejects a system that is not an object and a memories list that is not an array', () => {
    for (const system of [undefined, null, [], 'x', 3]) rejectB(zipBackup(backupDoc({ system })));
    for (const memories of [undefined, null, {}, 'x']) rejectB(zipBackup(backupDoc({ memories })));
  });

  it('rejects the whole backup when a slot marked present has a missing or broken memory.json', () => {
    rejectB(zipBackup(backupDoc(), { 'm01/track1.wav': goodWav() }));
    rejectB(zipBackup(backupDoc(), { 'm01/memory.json': strToU8('nope') }));
    rejectB(zipBackup(backupDoc(), { 'm01/memory.json': json(memDoc({ version: 2 })) }));
    rejectB(zipBackup(backupDoc(), { 'm01/memory.json': json(memDoc()), 'm01/track1.wav': new Uint8Array([1, 2]) }));
  });

  it('ignores the files of a slot not marked present', () => {
    const out = unpackBackup(zipBackup(backupDoc({ memories: [{ slot: 1, present: false }, { slot: 2, present: true }] }), { ...memFiles('m01/'), ...memFiles('m02/') }), 48000);
    expect(out.memories[0]).toBeNull();
    expect(out.memories[1]).not.toBeNull();
  });

  it('skips entries with a slot outside 1-99, a non-integer slot, or a malformed entry; the first entry of a slot wins', () => {
    const memories = [
      { slot: 0, present: true }, { slot: 100, present: true }, { slot: -3, present: true }, { slot: 1.5, present: true },
      { slot: '2', present: true }, null, 7, 'x', { present: true }, { slot: 3 },
      { slot: 4, present: true }, { slot: 4, present: true },
    ];
    const files: Zippable = { ...memFiles('m04/') };
    const out = unpackBackup(zipBackup(backupDoc({ memories }), files), 48000);
    expect(out.memories.map((m, i) => (m ? i + 1 : 0)).filter(Boolean)).toEqual([4]);
  });

  it('only reads mNN folders with two digits 01-99', () => {
    const out = unpackBackup(
      zipBackup(backupDoc({ memories: [{ slot: 1, present: true }] }), { ...memFiles('m01/'), ...memFiles('m00/'), ...memFiles('m100/'), ...memFiles('m1/'), ...memFiles('x/m01/') }),
      48000,
    );
    expect(out.memories.filter(Boolean)).toHaveLength(1);
  });

  it('applies the track rules inside a backup (slots 1-5 only, null entry means absent)', () => {
    const doc = memDoc({ tracks: [null, goodMeta, null, null, null] });
    const files: Zippable = { 'm05/memory.json': json(doc), 'm05/track1.wav': goodWav(), 'm05/track2.wav': goodWav(20), 'm05/track7.wav': new Uint8Array([1]) };
    const out = unpackBackup(zipBackup(backupDoc({ memories: [{ slot: 5, present: true }] }), files), 48000);
    expect(out.memories[4]!.tracks.map((t) => t?.L.length ?? null)).toEqual([null, 20, null, null, null]);
  });

  it('shares one size cap across all memories of a backup', () => {
    const two = zipBackup(backupDoc({ memories: [{ slot: 1, present: true }, { slot: 2, present: true }] }), {
      ...memFiles('m01/', pcm16Stereo(1000, 48000)), ...memFiles('m02/', pcm16Stereo(1000, 48000)),
    });
    expect(() => unpackBackup(two, 48000, { maxDecodedBytes: 16000 })).not.toThrow();
    expect(() => unpackBackup(two, 48000, { maxDecodedBytes: 12000 })).toThrow(UnsupportedFile);
  });

  it('corrects the stored system settings like a stored memory', () => {
    const system = defaultSystem() as unknown as Record<string, Record<string, unknown>>;
    system.setup!.contrast = 500;
    delete system.midi;
    const out = unpackBackup(zipBackup(backupDoc({ system })), 48000);
    expect(out.system.setup.contrast).toBe(10);
    expect(out.system.midi).toEqual(defaultSystem().midi);
  });

  it('round-trips through packBackup after all the checks', () => {
    const out = unpackBackup(packBackup([{ settings: defaultMemory(), tracks: [] }], defaultSystem()), 48000);
    expect(out.memories[0]!.settings).toEqual(defaultMemory());
  });
});

describe('a memory file handed over as a backup entry stays consistent with packMemory', () => {
  it('packMemory output is accepted by the hand-built rules', () => {
    const bytes = packMemory(defaultMemory(), [{ L: ramp(30, 1), R: ramp(30, 2), sampleRate: 48000, recordedTempo: 100, measures: 2 }]);
    expect(unpackMemory(bytes, 48000).tracks[0]!.L).toHaveLength(30);
  });
});
