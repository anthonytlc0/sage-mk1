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
 *    UNSUPPORTED FILE); entries the format does not define (track0.wav, track6.wav, folders, notes) are ignored;
 *  - settings go through `reconcileMemory` / `reconcileSystem`, so missing keys take their defaults and out-of-range or
 *    wrong-typed values are corrected exactly as if they had been set through the schema;
 *  - a track's `memory.json` entry must be null (the track is absent, whatever `trackN.wav` holds) or well formed (a
 *    finite `recordedTempo`, clamped to the tempo range; `measures` null or a positive number; a `sampleRate` that is
 *    the WAV's own). The WAV must be stereo float32 / pcm16 / pcm24 with channels of equal length, at 8-384 kHz;
 *  - the zip is read with a filter: only the entries the format defines are inflated, JSON entries are capped, and the
 *    uncompressed sizes of the WAV entries are capped before anything is inflated (a zip bomb); sizes are taken from the
 *    archive and bound the inflate buffer, they are not trusted past that;
 *  - the decoded audio of the whole file (frames x 2 channels x 4 bytes, counted at the larger of the file's and the
 *    target rate, so a resample that grows a track counts as grown) may not exceed `MAX_DECODED_BYTES`, to keep a bad
 *    file from taking the iPad's memory down. A restore holds every memory in RAM, so a backup this big is also near what
 *    a tablet can load.
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
import { decodeWav, encodeWav } from './wav';

export const MEMORY_FORMAT = 'sage-mk1-memory';
export const BACKUP_FORMAT = 'sage-mk1-backup';
/** The newest file version this build writes and reads. A newer file is refused rather than half understood. */
export const FILE_VERSION = 1;

/** Default cap on the decoded audio of one file: summed track frames x 2 channels x 4 bytes. */
export const MAX_DECODED_BYTES = 1024 * 1024 * 1024;
/** Cap on one JSON entry (a real memory.json is about 3 kB, a backup.json about 8 kB). */
export const MAX_JSON_BYTES = 2 * 1024 * 1024;
/** Sample rates a track WAV may have. Anything else is not a recording this app made (and would resample to absurd sizes). */
export const MIN_FILE_RATE = 8000;
export const MAX_FILE_RATE = 384000;

const BYTES_PER_FRAME = 2 * 4;
const RESAMPLE_BLOCK = 65536;

/** The file is not a memory file / backup this build can read. The LCD shows UNSUPPORTED FILE; `reason` says why. */
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

export interface UnpackOptions {
  /** Overrides `MAX_DECODED_BYTES` (tests; a device with less memory). */
  maxDecodedBytes?: number;
}

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
    if (!Number.isFinite(t.recordedTempo)) throw new RangeError(`track ${i + 1}: recorded tempo is not a number`);
    if (t.measures !== null && !(Number.isFinite(t.measures) && t.measures > 0)) {
      throw new RangeError(`track ${i + 1}: measures must be null or a positive number`);
    }
    wavs[`${prefix}track${i + 1}.wav`] = [encodeWav([t.L, t.R], t.sampleRate, 'float32'), { level: 0 }];
    return { recordedTempo: t.recordedTempo, measures: t.measures, sampleRate: t.sampleRate };
  });
  const doc = { format: MEMORY_FORMAT, version: FILE_VERSION, settings, tracks: metas };
  return { [`${prefix}memory.json`]: [jsonBytes(doc), { level: 6 }], ...wavs };
}

/** Packs one memory (settings and up to 5 tracks) as the bytes of a `.sagemk1` file. */
export function packMemory(settings: MemorySettings, tracks: (TrackAudio | null)[]): Uint8Array {
  return zipSync(memoryFiles('', settings, tracks));
}

/**
 * Packs a backup: `memories[i]` is slot i + 1 (null = an empty slot) and there are at most 99.
 * `backup.json` lists every slot given, so a restore can tell an empty slot from one past the end.
 */
export function packBackup(memories: (MemoryContents | null)[], system: SystemSettings): Uint8Array {
  if (memories.length > SLOT_COUNT) throw new RangeError(`at most ${SLOT_COUNT} memories, got ${memories.length}`);
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
 */
function unzipEntries(bytes: Uint8Array, kindOf: (name: string) => Kind | null, maxWavBytes: number): Record<string, Uint8Array> {
  let wavBytes = 0;
  const filter = (file: UnzipFileInfo): boolean => {
    const kind = kindOf(file.name);
    if (!kind) return false;
    const size = Math.max(file.originalSize, file.size);
    if (kind === 'json') {
      if (size > MAX_JSON_BYTES) throw new UnsupportedFile(`${file.name} is too large`);
    } else {
      wavBytes += size;
      if (wavBytes > maxWavBytes) throw new UnsupportedFile('the audio in the file is too large');
    }
    return true;
  };
  try {
    return unzipSync(bytes, { filter });
  } catch (e) {
    throw e instanceof UnsupportedFile ? e : new UnsupportedFile('not a readable zip archive', { cause: e });
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
class Budget {
  constructor(private left: number) {}
  take(bytes: number): void {
    if (bytes > this.left) throw new UnsupportedFile('the audio in the file is too large');
    this.left -= bytes;
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

function readTrack(wav: Uint8Array, meta: TrackMeta, n: number, targetRate: number, budget: Budget): TrackAudio | null {
  let decoded: ReturnType<typeof decodeWav>;
  try {
    decoded = decodeWav(wav);
  } catch (e) {
    throw new UnsupportedFile(`track ${n}: the WAV cannot be decoded`, { cause: e });
  }
  const { sr, chs } = decoded;
  if (chs.length !== 2) throw new UnsupportedFile(`track ${n}: the WAV is not stereo`);
  const [L, R] = chs as [Float32Array, Float32Array];
  if (L.length !== R.length) throw new UnsupportedFile(`track ${n}: the WAV channels differ in length`);
  if (!Number.isInteger(sr) || sr < MIN_FILE_RATE || sr > MAX_FILE_RATE) throw new UnsupportedFile(`track ${n}: sample rate ${sr} is not supported`);
  if (sr !== meta.sampleRate) throw new UnsupportedFile(`track ${n}: the WAV rate ${sr} disagrees with memory.json (${meta.sampleRate})`);
  const frames = L.length;
  if (frames === 0) return null;

  const outFrames = sr === targetRate ? frames : Math.ceil((frames * targetRate) / sr) + 1;
  budget.take(Math.max(frames, outFrames) * BYTES_PER_FRAME);

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
    const wav = files[`${prefix}track${i + 1}.wav`];
    return wav ? readTrack(wav, meta, i + 1, targetRate, budget) : null;
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
  const cap = options.maxDecodedBytes ?? MAX_DECODED_BYTES;
  const files = unzipEntries(bytes, (name) => (name === 'memory.json' ? 'json' : MEMORY_ENTRY.test(name) ? 'wav' : null), cap);
  const doc = checkHeader(parseJson(files['memory.json'], 'memory.json'), MEMORY_FORMAT, 'memory.json');
  return readMemory(doc, files, '', targetRate, new Budget(cap));
}

/**
 * Reads a backup. The result always has 99 memories (null where the backup has none). One decoded-audio allowance is
 * shared by every memory, and a present slot that cannot be read fails the whole backup, so a restore never half applies.
 */
export function unpackBackup(bytes: Uint8Array, targetRate: number, options: UnpackOptions = {}): BackupContents {
  checkTargetRate(targetRate);
  const cap = options.maxDecodedBytes ?? MAX_DECODED_BYTES;

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
    cap,
  );

  const budget = new Budget(cap);
  const memories: (MemoryContents | null)[] = Array.from({ length: SLOT_COUNT }, () => null);
  for (const slot of present) {
    const prefix = `m${pad2(slot)}/`;
    const memDoc = checkHeader(parseJson(files[`${prefix}memory.json`], `${prefix}memory.json`), MEMORY_FORMAT, `${prefix}memory.json`);
    memories[slot - 1] = readMemory(memDoc, files, prefix, targetRate, budget);
  }
  return { system, memories };
}
