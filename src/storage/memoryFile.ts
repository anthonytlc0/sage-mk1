/**
 * `.sagemk1` memory files and full backups.
 *
 * A memory file is a zip: `memory.json` (`{ format: 'sage-mk1-memory', version: 1, settings, tracks }`, where `tracks` has
 * five entries, `{ recordedTempo, measures, sampleRate }` or null) plus `trackN.wav` (N = 1-5, 32-bit float stereo at the
 * rate the loop was recorded at) for each track with audio. It lets a loop made on the iPad continue on the PC.
 *
 * A backup is a zip too: `backup.json` (`{ format: 'sage-mk1-backup', version: 1, system, memories: [{ slot, present }] }`)
 * plus, for each present slot, `mNN/memory.json` and `mNN/trackN.wav` (NN = 01-99) laid out exactly like a memory file.
 *
 * FILES ARE UNTRUSTED. Everything read back is validated and nothing is trusted to be the size it says:
 *  - anything that is not a well formed file of this format and version <= 1 throws `UnsupportedFile` (the LCD shows
 *    UNSUPPORTED FILE), an oversized memory.json / backup.json included; audio over this device's cap throws
 *    `FileTooLarge` instead (FILE TOO LARGE: the file is fine, the device is too small for it); entries the format
 *    does not define (track0.wav, track6.wav, folders, notes) are ignored;
 *  - settings go through `reconcileMemory` / `reconcileSystem`, so missing keys take their defaults and out-of-range or
 *    wrong-typed values are corrected exactly as if they had been set through the schema;
 *  - a track's `memory.json` entry must be null (the track is absent, whatever `trackN.wav` holds) or well formed (a
 *    finite `recordedTempo`, clamped to the tempo range; `measures` null or a positive number; a `sampleRate` that is
 *    the WAV's own). The WAV must be stereo 32-bit float, the only format the app writes, at 8-384 kHz. It is judged
 *    from its header before anything is decoded (pcm16 / pcm24 would decode to 2x / 1.33x their size, past the cap);
 *  - the zip is read with a filter: only the entries the format defines are inflated, a name that appears twice is
 *    refused, JSON entries are capped, and the uncompressed sizes of the WAV entries are capped before anything is
 *    inflated (a zip bomb); sizes are taken from the archive and bound the inflate buffer, they are not trusted past that;
 *  - the decoded audio of the whole file (frames x 2 channels x 4 bytes, counted at the larger of the file's and the
 *    target rate, so a resample that grows a track counts as grown) may not exceed the cap, to keep a bad file from
 *    taking the iPad's memory down (`FileTooLarge`; so is a zip whose declared WAV sizes are already over it). The cap
 *    is taken from the header's frame count and charged BEFORE `decodeWav` allocates. It is `defaultMaxDecodedBytes()`:
 *    384 MiB on a touch device (the iPad budget), 1 GiB elsewhere.
 *    `packMemory` / `packBackup` enforce the same cap (`FileTooLarge`), so the app never writes a file its own unpack
 *    would refuse. A restore holds every memory in RAM; restoring slot by slot would lift that limit.
 */

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import type { UnzipFileInfo, Zippable } from 'fflate';
import { reconcileMemory, reconcileSystem } from '../schema/params';
import type { MemorySettings, SystemSettings } from '../schema/types';
import { TEMPO_MAX, TEMPO_MIN } from '../shared/constants';
import { TRACKS } from '../shared/ids';
import type { TrackAudio } from '../shared/protocol';
import { SLOT_COUNT } from './memoryStore';
import { StreamingResampler } from './resample';
import { isTouchDevice } from './share';
import { decodeWav, encodeWav } from './wav';

export const MEMORY_FORMAT = 'sage-mk1-memory';
export const BACKUP_FORMAT = 'sage-mk1-backup';
/** The newest file version this build writes and reads. A newer file is refused rather than half understood. */
export const FILE_VERSION = 1;

/** Cap on the decoded audio of one file on a desktop: summed track frames x 2 channels x 4 bytes. */
export const MAX_DECODED_BYTES = 1024 * 1024 * 1024;
/** The same cap on a touch device (iPad): the 384 MiB memory budget. */
export const TOUCH_MAX_DECODED_BYTES = 384 * 1024 * 1024;
/**
 * Slack on the zip-bomb check of the WAV entries: it compares file bytes (frames x 8 plus a header, at most 495 entries)
 * where the real cap compares frames x 8, so it must not trip on headers alone.
 */
const WAV_ENTRY_SLACK = 64 * 1024;
/** Cap on one JSON entry (a real memory.json is about 3 kB, a backup.json about 8 kB). */
export const MAX_JSON_BYTES = 2 * 1024 * 1024;
/** Sample rates a track WAV may have. Anything else is not a recording this app made (and would resample to absurd sizes). */
export const MIN_FILE_RATE = 8000;
export const MAX_FILE_RATE = 384000;

const BYTES_PER_FRAME = 2 * 4;
const RESAMPLE_BLOCK = 65536;

/** The cap on decoded audio for this device: `TOUCH_MAX_DECODED_BYTES` when `maxTouchPoints > 1`, else `MAX_DECODED_BYTES`. */
export function defaultMaxDecodedBytes(nav: { maxTouchPoints?: number } | undefined = globalThis.navigator): number {
  return isTouchDevice(nav) ? TOUCH_MAX_DECODED_BYTES : MAX_DECODED_BYTES;
}

/**
 * The file is not a memory file / backup this build can read (malformed, another format, a newer version, an oversized
 * JSON entry). The LCD shows UNSUPPORTED FILE; `reason` says why. Audio over the cap is `FileTooLarge`, not this.
 */
export class UnsupportedFile extends Error {
  readonly reason: string;
  constructor(reason: string, options?: { cause?: unknown }) {
    super('UNSUPPORTED FILE', options);
    this.name = 'UnsupportedFile';
    this.reason = reason;
  }
}

export interface MemoryContents {
  settings: MemorySettings;
  /** Always 5 entries; null for a track with no audio. */
  tracks: (TrackAudio | null)[];
}

export interface BackupContents {
  system: SystemSettings;
  /** Always 99 entries, index = slot - 1; null for an empty slot. */
  memories: (MemoryContents | null)[];
}

/**
 * The audio is more than this device can hold (the cap of `defaultMaxDecodedBytes`): `packMemory` / `packBackup` will
 * not write such a file and `unpackMemory` / `unpackBackup` will not read one. The LCD shows FILE TOO LARGE.
 */
export class FileTooLarge extends Error {
  constructor(
    /** Decoded audio of the file (summed frames x 8 bytes), or the declared WAV entry sizes, as far as counted. */
    readonly bytes: number,
    /** The cap it exceeded. */
    readonly limit: number,
  ) {
    super('FILE TOO LARGE');
    this.name = 'FileTooLarge';
  }
}

export interface SizeOptions {
  /** The cap on decoded audio. Default: `defaultMaxDecodedBytes(nav)`. */
  maxDecodedBytes?: number;
  /** What to read `maxTouchPoints` from for the default cap. Default: the global `navigator`. */
  nav?: { maxTouchPoints?: number };
}
export type UnpackOptions = SizeOptions;
export type PackOptions = SizeOptions;

const capFor = (options: SizeOptions): number => options.maxDecodedBytes ?? defaultMaxDecodedBytes(options.nav);

// ---------------------------------------------------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------------------------------------------------

const pad2 = (n: number): string => String(n).padStart(2, '0');
const jsonBytes = (value: unknown): Uint8Array => strToU8(JSON.stringify(value));

/** The files of one memory under `prefix` ('' or 'mNN/'): memory.json first, then a float32 WAV per track with audio. */
function memoryFiles(prefix: string, settings: MemorySettings, tracks: (TrackAudio | null)[]): Zippable {
  if (tracks.length > TRACKS.length) throw new RangeError(`at most ${TRACKS.length} tracks, got ${tracks.length}`);
  const wavs: Zippable = {};
  const metas = TRACKS.map((i) => {
    const t = tracks[i];
    if (!t || t.L.length === 0) return null;
    if (t.R.length !== t.L.length) throw new RangeError(`track ${i + 1}: L and R lengths differ`);
    if (!Number.isFinite(t.sampleRate) || t.sampleRate < MIN_FILE_RATE || t.sampleRate > MAX_FILE_RATE) {
      throw new RangeError(`track ${i + 1}: sample rate ${t.sampleRate} is outside ${MIN_FILE_RATE}-${MAX_FILE_RATE}`);
    }
    if (!Number.isFinite(t.recordedTempo) || t.recordedTempo < TEMPO_MIN || t.recordedTempo > TEMPO_MAX) {
      throw new RangeError(`track ${i + 1}: recorded tempo ${t.recordedTempo} is outside ${TEMPO_MIN}-${TEMPO_MAX}`);
    }
    if (t.measures !== null && !(Number.isFinite(t.measures) && t.measures > 0)) {
      throw new RangeError(`track ${i + 1}: measures must be null or a positive number`);
    }
    wavs[`${prefix}track${i + 1}.wav`] = [encodeWav([t.L, t.R], t.sampleRate, 'float32'), { level: 0 }];
    return { recordedTempo: t.recordedTempo, measures: t.measures, sampleRate: t.sampleRate };
  });
  const doc = { format: MEMORY_FORMAT, version: FILE_VERSION, settings, tracks: metas };
  return { [`${prefix}memory.json`]: [jsonBytes(doc), { level: 6 }], ...wavs };
}

/** Throws `FileTooLarge` when the tracks' summed frames x 8 bytes exceed the cap (at the rate they are written at). */
function checkPackSize(memories: (readonly (TrackAudio | null)[])[], options: PackOptions): void {
  const limit = capFor(options);
  let bytes = 0;
  for (const tracks of memories) for (const t of tracks) if (t) bytes += t.L.length * BYTES_PER_FRAME;
  if (bytes > limit) throw new FileTooLarge(bytes, limit);
}

/**
 * Packs one memory (settings and up to 5 tracks) as the bytes of a `.sagemk1` file.
 * Throws `FileTooLarge` when the audio is more than `unpackMemory` would accept on this device.
 */
export function packMemory(settings: MemorySettings, tracks: (TrackAudio | null)[], options: PackOptions = {}): Uint8Array {
  checkPackSize([tracks], options);
  return zipSync(memoryFiles('', settings, tracks));
}

/**
 * Packs a backup: `memories[i]` is slot i + 1 (null = an empty slot) and there are at most 99.
 * `backup.json` lists every slot given, so a restore can tell an empty slot from one past the end.
 * Throws `FileTooLarge` when the audio of all memories together is more than `unpackBackup` would accept on this device.
 */
export function packBackup(memories: (MemoryContents | null)[], system: SystemSettings, options: PackOptions = {}): Uint8Array {
  if (memories.length > SLOT_COUNT) throw new RangeError(`at most ${SLOT_COUNT} memories, got ${memories.length}`);
  checkPackSize(memories.map((m) => m?.tracks ?? []), options);
  const files: Zippable = {};
  const slots = memories.map((m, i) => {
    if (m) Object.assign(files, memoryFiles(`m${pad2(i + 1)}/`, m.settings, m.tracks));
    return { slot: i + 1, present: m !== null };
  });
  const doc = { format: BACKUP_FORMAT, version: FILE_VERSION, system, memories: slots };
  return zipSync({ 'backup.json': [jsonBytes(doc), { level: 6 }], ...files });
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------------------------------

type Kind = 'json' | 'wav';

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function checkTargetRate(rate: number): void {
  if (!Number.isFinite(rate) || rate <= 0) throw new RangeError(`target sample rate must be a positive number, got ${rate}`);
}

/**
 * Unzips only the entries `kindOf` names. Entries it does not name are neither inflated nor kept. The sizes come from
 * the archive's directory: they are checked before anything is inflated, and fflate inflates into a buffer of exactly
 * the declared size, so an entry that claims to be small cannot expand past its claim.
 *
 * A name that appears twice anywhere in the archive is refused: no zip tool writes one, which entry should win is
 * ambiguous, and thousands of copies of one name would each be inflated. fflate calls the filter for an entry just
 * before inflating it, so the second copy is refused before it costs anything.
 */
function unzipEntries(bytes: Uint8Array, kindOf: (name: string) => Kind | null, maxWavBytes: number): Record<string, Uint8Array> {
  let wavBytes = 0;
  const seen = new Set<string>();
  const filter = (file: UnzipFileInfo): boolean => {
    if (seen.has(file.name)) throw new UnsupportedFile(`${file.name} appears twice in the archive`);
    seen.add(file.name);
    const kind = kindOf(file.name);
    if (!kind) return false;
    const size = Math.max(file.originalSize, file.size);
    if (kind === 'json') {
      if (size > MAX_JSON_BYTES) throw new UnsupportedFile(`${file.name} is too large`);
    } else {
      wavBytes += size;
      if (wavBytes > maxWavBytes) throw new FileTooLarge(wavBytes, maxWavBytes);
    }
    return true;
  };
  try {
    return unzipSync(bytes, { filter });
  } catch (e) {
    throw e instanceof UnsupportedFile || e instanceof FileTooLarge ? e : new UnsupportedFile('not a readable zip archive', { cause: e });
  }
}

function parseJson(file: Uint8Array | undefined, name: string): unknown {
  if (!file) throw new UnsupportedFile(`${name} is missing`);
  try {
    return JSON.parse(strFromU8(file));
  } catch (e) {
    throw new UnsupportedFile(`${name} is not valid JSON`, { cause: e });
  }
}

/** The document, once it is an object of the expected format and a version this build can read. */
function checkHeader(doc: unknown, format: string, name: string): Record<string, unknown> {
  if (!isObject(doc)) throw new UnsupportedFile(`${name} is not an object`);
  if (doc.format !== format) throw new UnsupportedFile(`${name} is not a ${format} document`);
  const v = doc.version;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw new UnsupportedFile(`${name} has no valid version`);
  if (v > FILE_VERSION) throw new UnsupportedFile(`${name} is version ${v}, newer than this build reads (${FILE_VERSION})`);
  return doc;
}

/** The decoded-audio allowance of one file; every track of every memory takes from the same one. */
/** The decoded-audio allowance of one file: `take` throws `FileTooLarge` once the total passes the cap. */
class Budget {
  private used = 0;
  constructor(private readonly limit: number) {}
  take(bytes: number): void {
    this.used += bytes;
    if (this.used > this.limit) throw new FileTooLarge(this.used, this.limit);
  }
}

interface TrackMeta {
  recordedTempo: number;
  measures: number | null;
  sampleRate: number;
}

function readMeta(raw: unknown, n: number): TrackMeta {
  const bad = (what: string) => new UnsupportedFile(`track ${n}: ${what}`);
  if (!isObject(raw)) throw bad('metadata is not an object');
  const { recordedTempo, measures, sampleRate } = raw;
  if (typeof recordedTempo !== 'number' || !Number.isFinite(recordedTempo)) throw bad('recorded tempo is not a number');
  if (measures !== null && !(typeof measures === 'number' && Number.isFinite(measures) && measures > 0)) {
    throw bad('measures is not null or a positive number');
  }
  if (typeof sampleRate !== 'number' || !Number.isFinite(sampleRate)) throw bad('sample rate is not a number');
  return {
    recordedTempo: Math.min(TEMPO_MAX, Math.max(TEMPO_MIN, recordedTempo)),
    measures,
    sampleRate,
  };
}

function concat(parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Streams the track through a `StreamingResampler` in blocks (the output does not depend on the block size). */
function resample(L: Float32Array, R: Float32Array, from: number, to: number): [Float32Array, Float32Array] {
  const rs = new StreamingResampler(from, to, 2);
  const outL: Float32Array[] = [];
  const outR: Float32Array[] = [];
  for (let i = 0; i < L.length; i += RESAMPLE_BLOCK) {
    const [a, b] = rs.push(L.subarray(i, i + RESAMPLE_BLOCK), R.subarray(i, i + RESAMPLE_BLOCK));
    outL.push(a);
    outR.push(b);
  }
  const [a, b] = rs.flush();
  outL.push(a);
  outR.push(b);
  return [concat(outL), concat(outR)];
}

/** What a WAV header says about its audio; see `peekWav`. */
interface WavInfo {
  tag: number;
  channels: number;
  bits: number;
  sr: number;
  /** Frames `decodeWav` will return per channel. */
  frames: number;
}

const WAV_FORMAT_IEEE_FLOAT = 3;
const WAV_FORMAT_EXTENSIBLE = 0xfffe;

const tagAt = (v: DataView, off: number): string =>
  String.fromCharCode(v.getUint8(off), v.getUint8(off + 1), v.getUint8(off + 2), v.getUint8(off + 3));

/**
 * Reads format, channel count, rate, bit depth and frame count from a WAV's header without decoding it, walking the
 * chunks exactly as `decodeWav` does (last `fmt ` before the first `data`, odd chunks padded, a data chunk cut short by
 * the end of the file counts as what is there), so the frame count is the one `decodeWav` will allocate for.
 */
function peekWav(bytes: Uint8Array, n: number): WavInfo {
  const bad = (what: string) => new UnsupportedFile(`track ${n}: ${what}`);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 12 || tagAt(v, 0) !== 'RIFF' || tagAt(v, 8) !== 'WAVE') throw bad('not a RIFF/WAVE file');
  let fmt: { tag: number; channels: number; bits: number; sr: number } | null = null;
  let dataLen = -1;
  let off = 12;
  while (off + 8 <= bytes.length) {
    const id = tagAt(v, off);
    const size = v.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 'fmt ') {
      const avail = Math.min(size, bytes.length - body);
      if (avail < 16) throw bad('fmt chunk too short');
      let tag = v.getUint16(body, true);
      if (tag === WAV_FORMAT_EXTENSIBLE) {
        if (avail < 26) throw bad('extensible fmt chunk too short');
        tag = v.getUint16(body + 24, true);
      }
      fmt = { tag, channels: v.getUint16(body + 2, true), sr: v.getUint32(body + 4, true), bits: v.getUint16(body + 14, true) };
    } else if (id === 'data') {
      dataLen = Math.min(size, bytes.length - body);
      break;
    }
    off = body + size + (size & 1);
  }
  if (!fmt) throw bad('no fmt chunk');
  if (dataLen < 0) throw bad('no data chunk');
  if (fmt.tag !== WAV_FORMAT_IEEE_FLOAT || fmt.bits !== 32) throw bad('the WAV is not 32-bit float');
  if (fmt.channels !== 2) throw bad('the WAV is not stereo');
  return { ...fmt, frames: Math.floor(dataLen / (4 * fmt.channels)) };
}

/**
 * One track. Everything that can be judged from the header is, and the audio is charged to the budget, BEFORE
 * `decodeWav` allocates anything. Only float32 passes: it decodes 1:1, so the header's frame count is the allocation.
 */
function readTrack(wav: Uint8Array, meta: TrackMeta, n: number, targetRate: number, budget: Budget): TrackAudio | null {
  const { sr, frames } = peekWav(wav, n);
  if (!Number.isInteger(sr) || sr < MIN_FILE_RATE || sr > MAX_FILE_RATE) throw new UnsupportedFile(`track ${n}: sample rate ${sr} is not supported`);
  if (sr !== meta.sampleRate) throw new UnsupportedFile(`track ${n}: the WAV rate ${sr} disagrees with memory.json (${meta.sampleRate})`);
  if (frames === 0) return null;

  const outFrames = sr === targetRate ? frames : Math.ceil((frames * targetRate) / sr) + 1;
  budget.take(Math.max(frames, outFrames) * BYTES_PER_FRAME);

  let decoded: ReturnType<typeof decodeWav>;
  try {
    decoded = decodeWav(wav);
  } catch (e) {
    throw new UnsupportedFile(`track ${n}: the WAV cannot be decoded`, { cause: e });
  }
  const { chs } = decoded;
  if (chs.length !== 2) throw new UnsupportedFile(`track ${n}: the WAV is not stereo`);
  const [L, R] = chs as [Float32Array, Float32Array];
  if (L.length !== R.length) throw new UnsupportedFile(`track ${n}: the WAV channels differ in length`);
  if (L.length !== frames) throw new UnsupportedFile(`track ${n}: the WAV decoded to ${L.length} frames, its header said ${frames}`);

  const [outL, outR] = sr === targetRate ? [L, R] : resample(L, R, sr, targetRate);
  return { L: outL, R: outR, sampleRate: targetRate, recordedTempo: meta.recordedTempo, measures: meta.measures };
}

/** One memory out of unzipped entries: `doc` is its checked memory.json, `prefix` is '' or 'mNN/'. */
function readMemory(doc: Record<string, unknown>, files: Record<string, Uint8Array>, prefix: string, targetRate: number, budget: Budget): MemoryContents {
  if (!isObject(doc.settings)) throw new UnsupportedFile('settings is not an object');
  const metas = doc.tracks;
  if (!Array.isArray(metas)) throw new UnsupportedFile('tracks is not a list');
  const settings = reconcileMemory(doc.settings);
  const tracks = TRACKS.map((i): TrackAudio | null => {
    const raw: unknown = metas[i];
    if (raw === null || raw === undefined) return null; // no metadata: absent, whatever else the zip holds
    const meta = readMeta(raw, i + 1);
    const name = `${prefix}track${i + 1}.wav`;
    const wav = files[name];
    if (!wav) return null;
    try {
      return readTrack(wav, meta, i + 1, targetRate, budget);
    } finally {
      delete files[name]; // the inflated bytes are dead once decoded: do not hold every WAV of a backup next to the audio
    }
  });
  return { settings, tracks };
}

const MEMORY_ENTRY = /^track[1-5]\.wav$/;
const BACKUP_JSON = /^m(0[1-9]|[1-9]\d)\/memory\.json$/;
const BACKUP_WAV = /^m(0[1-9]|[1-9]\d)\/track[1-5]\.wav$/;

/**
 * Reads the bytes of a `.sagemk1` file. Rates that differ from `targetRate` (the AudioContext's) are resampled, and
 * each returned track has `sampleRate === targetRate`; `recordedTempo` and `measures` are kept as recorded.
 * Throws `UnsupportedFile` for anything that is not a readable memory file.
 */
export function unpackMemory(bytes: Uint8Array, targetRate: number, options: UnpackOptions = {}): MemoryContents {
  checkTargetRate(targetRate);
  const cap = capFor(options);
  const files = unzipEntries(bytes, (name) => (name === 'memory.json' ? 'json' : MEMORY_ENTRY.test(name) ? 'wav' : null), cap + WAV_ENTRY_SLACK);
  const doc = checkHeader(parseJson(files['memory.json'], 'memory.json'), MEMORY_FORMAT, 'memory.json');
  return readMemory(doc, files, '', targetRate, new Budget(cap));
}

/**
 * Reads a backup. The result always has 99 memories (null where the backup has none). One decoded-audio allowance is
 * shared by every memory, and a present slot that cannot be read fails the whole backup, so a restore never half applies.
 */
export function unpackBackup(bytes: Uint8Array, targetRate: number, options: UnpackOptions = {}): BackupContents {
  checkTargetRate(targetRate);
  const cap = capFor(options);

  const index = unzipEntries(bytes, (name) => (name === 'backup.json' ? 'json' : null), cap);
  const doc = checkHeader(parseJson(index['backup.json'], 'backup.json'), BACKUP_FORMAT, 'backup.json');
  if (!isObject(doc.system)) throw new UnsupportedFile('system is not an object');
  if (!Array.isArray(doc.memories)) throw new UnsupportedFile('memories is not a list');
  const system = reconcileSystem(doc.system);

  // The first entry for a slot decides it; entries with a slot outside 1-99 are ignored.
  const decided = new Set<number>();
  const present: number[] = [];
  for (const entry of doc.memories as unknown[]) {
    if (!isObject(entry)) continue;
    const slot = entry.slot;
    if (typeof slot !== 'number' || !Number.isInteger(slot) || slot < 1 || slot > SLOT_COUNT || decided.has(slot)) continue;
    decided.add(slot);
    if (entry.present === true) present.push(slot);
  }

  const wanted = new Set(present.map((slot) => `m${pad2(slot)}/`));
  const files = unzipEntries(
    bytes,
    (name) => {
      const folder = name.slice(0, 4);
      if (!wanted.has(folder)) return null;
      return BACKUP_JSON.test(name) ? 'json' : BACKUP_WAV.test(name) ? 'wav' : null;
    },
    cap + WAV_ENTRY_SLACK,
  );

  const budget = new Budget(cap);
  const memories: (MemoryContents | null)[] = Array.from({ length: SLOT_COUNT }, () => null);
  for (const slot of present) {
    const prefix = `m${pad2(slot)}/`;
    const memDoc = checkHeader(parseJson(files[`${prefix}memory.json`], `${prefix}memory.json`), MEMORY_FORMAT, `${prefix}memory.json`);
    delete files[`${prefix}memory.json`];
    memories[slot - 1] = readMemory(memDoc, files, prefix, targetRate, budget);
  }
  return { system, memories };
}
