/**
 * Track audio as 10-second IndexedDB chunks, shared by the memory slots and the crash-recovery checkpoint.
 *
 * A chunk is `{ L: ArrayBuffer, R: ArrayBuffer }` (float32 samples) stored in the `audio` store under
 * `{prefix}t{track}/c{index}`. The prefix is `m{slot}/` for a memory slot and `recovery/` for the checkpoint.
 * Per-track metadata lives in the owning record (`TrackMeta`), so a prefix range delete inside the same
 * transaction replaces a slot's audio atomically, surplus chunks of a longer old recording included.
 */

import type { TrackAudio } from '../shared/protocol';
import { TRACKS } from '../shared/ids';
import { AUDIO, toStorageError } from './db';

export const CHUNK_SECONDS = 10;

export interface TrackMeta {
  sampleRate: number;
  recordedTempo: number;
  measures: number | null;
  /** Frames per channel. */
  length: number;
  chunkCount: number;
}

interface AudioChunk {
  L: ArrayBuffer;
  R: ArrayBuffer;
}

export const memoryPrefix = (slot: number): string => `m${slot}/`;
export const RECOVERY_PREFIX = 'recovery/';

const chunkKey = (prefix: string, track: number, index: number): string => `${prefix}t${track}/c${index}`;
const chunkFrames = (sampleRate: number): number => Math.max(1, Math.round(CHUNK_SECONDS * sampleRate));

/** Every key that starts with `prefix` (prefixes end in '/', so `m7/` never matches `m70/`). */
function prefixRange(prefix: string): IDBKeyRange {
  return IDBKeyRange.bound(prefix, prefix + '￿');
}

/** Queues deletion of every chunk under `prefix`. Call inside the transaction that then writes the new chunks. */
export function deleteChunks(audio: IDBObjectStore, prefix: string): void {
  audio.delete(prefixRange(prefix));
}

/**
 * Queues the puts for every non-empty track and returns the metadata to store with them: always one entry per
 * track (5), null for an absent or empty track. Samples are copied out per chunk (`slice`) because structured clone of a view would store its whole buffer.
 */
export function writeChunks(audio: IDBObjectStore, prefix: string, tracks: (TrackAudio | null)[]): (TrackMeta | null)[] {
  if (tracks.length > TRACKS.length) throw new RangeError(`at most ${TRACKS.length} tracks, got ${tracks.length}`);
  return TRACKS.map((track) => {
    const t = tracks[track];
    if (!t || t.L.length === 0) return null;
    const length = t.L.length;
    if (t.R.length !== length) throw new RangeError(`track ${track}: L and R lengths differ`);
    const per = chunkFrames(t.sampleRate);
    const chunkCount = Math.ceil(length / per);
    for (let c = 0; c < chunkCount; c++) {
      const from = c * per;
      const to = Math.min(from + per, length);
      const chunk: AudioChunk = { L: t.L.slice(from, to).buffer, R: t.R.slice(from, to).buffer };
      audio.put(chunk, chunkKey(prefix, track, c));
    }
    return { sampleRate: t.sampleRate, recordedTempo: t.recordedTempo, measures: t.measures, length, chunkCount };
  });
}

/**
 * Reads the chunks under `prefix` with a cursor (one chunk alive at a time) into freshly allocated tracks.
 * Issues its request synchronously, so call it inside a live transaction. `done` runs once, with an error
 * if a chunk is missing or inconsistent.
 */
export function readChunks(
  audio: IDBObjectStore,
  prefix: string,
  metas: (TrackMeta | null)[],
  done: (err: unknown, tracks?: (TrackAudio | null)[]) => void,
): void {
  const out: (TrackAudio | null)[] = metas.map((m) =>
    m
      ? {
          L: new Float32Array(m.length),
          R: new Float32Array(m.length),
          sampleRate: m.sampleRate,
          recordedTempo: m.recordedTempo,
          measures: m.measures,
        }
      : null,
  );
  const seen = metas.map(() => 0);
  const req = audio.openCursor(prefixRange(prefix));
  req.onerror = () => done(toStorageError(req.error));
  req.onsuccess = () => {
    const cur = req.result;
    try {
      if (!cur) {
        metas.forEach((m, t) => {
          if (m && seen[t] !== m.chunkCount) {
            throw new Error(`corrupt audio: track ${t} has ${seen[t]} of ${m.chunkCount} chunks`);
          }
        });
        done(null, out);
        return;
      }
      const match = /t(\d+)\/c(\d+)$/.exec(String(cur.key));
      if (!match) throw new Error(`corrupt audio: unexpected key ${String(cur.key)}`);
      const t = Number(match[1]);
      const c = Number(match[2]);
      const meta = metas[t];
      const dest = out[t];
      if (meta && dest) {
        const chunk = cur.value as AudioChunk;
        const at = c * chunkFrames(meta.sampleRate);
        dest.L.set(new Float32Array(chunk.L), at);
        dest.R.set(new Float32Array(chunk.R), at);
        seen[t]++;
      }
      cur.continue();
    } catch (e) {
      done(e);
    }
  };
}

/**
 * Reads `record` from `recordStore` and, in the same read transaction, the audio under `prefix` described by
 * its `tracks` metadata. Resolves null when there is no record.
 */
export function readRecordWithAudio<R extends { tracks: (TrackMeta | null)[] }>(
  db: IDBDatabase,
  recordStore: string,
  recordKey: IDBValidKey,
  prefix: string,
): Promise<{ record: R; tracks: (TrackAudio | null)[] } | null> {
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction([recordStore, AUDIO], 'readonly');
    } catch (e) {
      reject(toStorageError(e));
      return;
    }
    let result: { record: R; tracks: (TrackAudio | null)[] } | null = null;
    let failure: unknown = null;
    tx.oncomplete = () => (failure ? reject(failure) : resolve(result));
    tx.onabort = () => reject(failure ?? toStorageError(tx.error));
    const get = tx.objectStore(recordStore).get(recordKey);
    get.onsuccess = () => {
      const record = get.result as R | undefined;
      if (!record) return;
      readChunks(tx.objectStore(AUDIO), prefix, record.tracks, (err, tracks) => {
        if (err) failure = err;
        else result = { record, tracks: tracks! };
      });
    };
  });
}
