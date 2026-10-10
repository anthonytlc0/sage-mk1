/**
 * Crash recovery. While the app runs it keeps `running: true`; a clean shutdown flips it to false. If the app starts
 * and finds `running` still true together with a checkpoint, the last session ended abnormally and the checkpoint
 * (settings plus tracks, audio chunked under the `recovery/` prefix) can be offered back.
 *
 * A clean shutdown discards the checkpoint in the same transaction that clears the flag: a deliberate power-off
 * throws away unsaved work, as on the hardware, so a later crash never offers a checkpoint from an earlier session.
 */

import { reconcileMemory } from '../schema/params';
import type { MemorySettings } from '../schema/types';
import type { TrackAudio } from '../shared/protocol';
import { AUDIO, RECOVERY, reqP, writeTx } from './db';
import {
  RECOVERY_PREFIX,
  deleteChunks,
  readRecordWithAudio,
  writeChunks,
  type TrackMeta,
} from './audioChunks';

const STATE = 'state';
const CHECKPOINT = 'checkpoint';

interface CheckpointRecord {
  slot: number;
  settings: MemorySettings;
  tracks: (TrackMeta | null)[];
  savedAt: number;
}

export class Recovery {
  constructor(private readonly db: IDBDatabase) {}

  markRunning(): Promise<void> {
    return writeTx(this.db, [RECOVERY], (tx) => {
      tx.objectStore(RECOVERY).put({ running: true }, STATE);
    });
  }

  /** Clears the running flag and deletes the checkpoint (record and audio chunks), atomically. */
  markCleanShutdown(): Promise<void> {
    return writeTx(this.db, [RECOVERY, AUDIO], (tx) => {
      deleteChunks(tx.objectStore(AUDIO), RECOVERY_PREFIX);
      const recovery = tx.objectStore(RECOVERY);
      recovery.delete(CHECKPOINT);
      recovery.put({ running: false }, STATE);
    });
  }

  /** True only when the last session never marked a clean shutdown AND a checkpoint exists to restore. */
  async needsRecovery(): Promise<boolean> {
    const tx = this.db.transaction(RECOVERY, 'readonly');
    const store = tx.objectStore(RECOVERY);
    const [state, checkpoints] = await Promise.all([
      reqP<{ running?: boolean } | undefined>(store.get(STATE)),
      reqP<number>(store.count(CHECKPOINT)),
    ]);
    return state?.running === true && checkpoints > 0;
  }

  /** Replaces the checkpoint atomically (older chunks are removed in the same transaction). */
  checkpoint(slot: number, settings: MemorySettings, tracks: (TrackAudio | null)[]): Promise<void> {
    return writeTx(this.db, [RECOVERY, AUDIO], (tx) => {
      const audio = tx.objectStore(AUDIO);
      deleteChunks(audio, RECOVERY_PREFIX);
      const metas = writeChunks(audio, RECOVERY_PREFIX, tracks);
      const record: CheckpointRecord = { slot, settings, tracks: metas, savedAt: Date.now() };
      tx.objectStore(RECOVERY).put(record, CHECKPOINT);
    });
  }

  /** The checkpoint, or null. Does not remove it. */
  async take(): Promise<{ slot: number; settings: MemorySettings; tracks: (TrackAudio | null)[] } | null> {
    const found = await readRecordWithAudio<CheckpointRecord>(this.db, RECOVERY, CHECKPOINT, RECOVERY_PREFIX);
    return found && { slot: found.record.slot, settings: reconcileMemory(found.record.settings), tracks: found.tracks };
  }

  discard(): Promise<void> {
    return writeTx(this.db, [RECOVERY, AUDIO], (tx) => {
      deleteChunks(tx.objectStore(AUDIO), RECOVERY_PREFIX);
      tx.objectStore(RECOVERY).delete(CHECKPOINT);
    });
  }
}
