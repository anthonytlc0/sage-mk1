/**
 * The 99 memory slots: settings plus up to 5 stereo tracks each.
 *
 * `memories` holds one record per used slot (`{ slot, settings, tracks: TrackMeta[], savedAt }`); the audio lives in
 * 10-second chunks in `audio` (see audioChunks.ts). `save` and `clear` are single readwrite transactions across both
 * stores, so a slot is never left half old, half new.
 */

import { reconcileMemory } from '../schema/params';
import type { MemorySettings } from '../schema/types';
import type { TrackAudio } from '../shared/protocol';
import { AUDIO, MEMORIES, reqP, writeTx } from './db';
import {
  deleteChunks,
  memoryPrefix,
  readRecordWithAudio,
  writeChunks,
  type TrackMeta,
} from './audioChunks';

export const SLOT_COUNT = 99;

interface MemoryRecord {
  slot: number;
  settings: MemorySettings;
  tracks: (TrackMeta | null)[];
  savedAt: number;
}

export interface MemoryListEntry {
  slot: number;
  name: string;
  empty: boolean;
}

function checkSlot(slot: number): void {
  if (!Number.isInteger(slot) || slot < 1 || slot > SLOT_COUNT) {
    throw new RangeError(`memory slot must be an integer 1-${SLOT_COUNT}, got ${slot}`);
  }
}

export class MemoryStore {
  constructor(private readonly db: IDBDatabase) {}

  /** All 99 slots in order; `empty` slots have an empty name. */
  async list(): Promise<MemoryListEntry[]> {
    const records = await reqP<MemoryRecord[]>(this.db.transaction(MEMORIES, 'readonly').objectStore(MEMORIES).getAll());
    const bySlot = new Map(records.map((r) => [r.slot, r]));
    return Array.from({ length: SLOT_COUNT }, (_, i) => {
      const slot = i + 1;
      const rec = bySlot.get(slot);
      return rec ? { slot, name: rec.settings.name, empty: false } : { slot, name: '', empty: true };
    });
  }

  async load(slot: number): Promise<{ settings: MemorySettings; tracks: (TrackAudio | null)[] } | null> {
    checkSlot(slot);
    const found = await readRecordWithAudio<MemoryRecord>(this.db, MEMORIES, slot, memoryPrefix(slot));
    return found && { settings: reconcileMemory(found.record.settings), tracks: found.tracks };
  }

  /** Replaces the slot atomically. Rejects with `QuotaError` (MEMORY FULL) when storage is exhausted; the old slot is kept. */
  save(slot: number, settings: MemorySettings, tracks: (TrackAudio | null)[]): Promise<void> {
    try {
      checkSlot(slot);
    } catch (e) {
      return Promise.reject(e);
    }
    const prefix = memoryPrefix(slot);
    return writeTx(this.db, [MEMORIES, AUDIO], (tx) => {
      const audio = tx.objectStore(AUDIO);
      deleteChunks(audio, prefix); // runs before the puts below, so a shorter recording leaves no orphan chunks
      const metas = writeChunks(audio, prefix, tracks);
      const record: MemoryRecord = { slot, settings, tracks: metas, savedAt: Date.now() };
      tx.objectStore(MEMORIES).put(record);
    });
  }

  clear(slot: number): Promise<void> {
    try {
      checkSlot(slot);
    } catch (e) {
      return Promise.reject(e);
    }
    return writeTx(this.db, [MEMORIES, AUDIO], (tx) => {
      deleteChunks(tx.objectStore(AUDIO), memoryPrefix(slot));
      tx.objectStore(MEMORIES).delete(slot);
    });
  }

  async isEmpty(slot: number): Promise<boolean> {
    checkSlot(slot);
    return (await reqP(this.db.transaction(MEMORIES, 'readonly').objectStore(MEMORIES).count(slot))) === 0;
  }
}
