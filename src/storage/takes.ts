/**
 * Recorder takes. The recorder appends already-encoded pcm24 stereo bytes as it goes; this store only saves the byte
 * chunks in order and, on demand, joins them behind a 44-byte WAV header at 44.1 kHz.
 *
 * `takes` holds one record per take (`{ id, createdAt, frames }`, frames null until `finish`); `takeChunks` holds the
 * chunks with an auto-increment key, so concurrent appends keep their call order without a read-modify-write counter.
 */

import { EXPORT_RATE } from '../shared/constants';
import { BY_TAKE, TAKES, TAKE_CHUNKS, reqP, toStorageError, writeTx } from './db';
import { wavHeader } from './wav';

interface TakeRecord {
  id: number;
  createdAt: number;
  /** Sample frames recorded; null until `finish`. */
  frames: number | null;
}

interface TakeChunkRecord {
  seq?: number;
  id: number;
  data: ArrayBuffer;
}

export interface TakeInfo {
  id: number;
  createdAt: number;
  frames: number | null;
}

const CHANNELS = 2;

export class Takes {
  constructor(private readonly db: IDBDatabase) {}

  /** Starts a take and returns its id (once the record is committed). */
  async create(): Promise<number> {
    let id = 0;
    await writeTx(this.db, [TAKES], (tx) => {
      const record: Omit<TakeRecord, 'id'> = { createdAt: Date.now(), frames: null };
      const added = tx.objectStore(TAKES).add(record);
      added.onsuccess = () => {
        id = added.result as number;
      };
    });
    return id;
  }

  /**
   * Appends one chunk of encoded bytes. Rejects (`QuotaError` on a full disk) if the take does not exist.
   * The bytes are copied before this returns, so the caller may reuse or overwrite `bytes` right away.
   */
  append(id: number, bytes: Uint8Array): Promise<void> {
    const data = bytes.slice().buffer; // synchronous copy: the stored put happens later, in a request callback
    return writeTx(this.db, [TAKES, TAKE_CHUNKS], (tx, fail) => {
      const exists = tx.objectStore(TAKES).count(id);
      exists.onsuccess = () => {
        if (exists.result === 0) return fail(new Error(`take ${id} does not exist`));
        const chunk: TakeChunkRecord = { id, data };
        tx.objectStore(TAKE_CHUNKS).add(chunk);
      };
    });
  }

  /** Records the final length in sample frames. */
  finish(id: number, frames: number): Promise<void> {
    return writeTx(this.db, [TAKES], (tx, fail) => {
      const store = tx.objectStore(TAKES);
      const get = store.get(id);
      get.onsuccess = () => {
        const record = get.result as TakeRecord | undefined;
        if (!record) return fail(new Error(`take ${id} does not exist`));
        store.put({ ...record, frames });
      };
    });
  }

  async list(): Promise<TakeInfo[]> {
    const records = await reqP<TakeRecord[]>(this.db.transaction(TAKES, 'readonly').objectStore(TAKES).getAll());
    return records.map((r) => ({ id: r.id, createdAt: r.createdAt, frames: r.frames }));
  }

  /**
   * The take as a 44.1 kHz stereo pcm24 WAV: header, then the chunks in append order.
   *
   * The chunks are walked with a cursor and each is wrapped in a Blob as soon as it is read, so the take never exists
   * as one big byte array (or as `getAll`'s array of every chunk) in script memory: at any moment only the chunk in
   * hand is plain memory, and the browser owns the Blobs (and may keep them off the heap). The result is assembled from
   * those Blobs behind the header.
   */
  async blob(id: number): Promise<Blob> {
    const tx = this.db.transaction([TAKES, TAKE_CHUNKS], 'readonly');
    const exists = reqP<number>(tx.objectStore(TAKES).count(id));
    const parts: Blob[] = [];
    let total = 0;
    const walked = new Promise<void>((resolve, reject) => {
      // Equal index keys come back in primary-key (seq) order, which is append order.
      const req = tx.objectStore(TAKE_CHUNKS).index(BY_TAKE).openCursor(IDBKeyRange.only(id));
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return resolve();
        const data = (cursor.value as TakeChunkRecord).data;
        parts.push(new Blob([data])); // copies the chunk out of the cursor's value; `data` is garbage right after
        total += data.byteLength;
        cursor.continue();
      };
      req.onerror = () => reject(toStorageError(req.error));
    });
    const [count] = await Promise.all([exists, walked]); // both settled, so a failed tx leaves nothing unhandled
    if (count === 0) throw new Error(`take ${id} does not exist`);
    const pad = total & 1 ? [new Uint8Array(1)] : []; // RIFF chunks are word aligned; wavHeader counts this byte
    const header = wavHeader(total, EXPORT_RATE, CHANNELS, 'pcm24') as Uint8Array<ArrayBuffer>; // wavHeader allocates a plain ArrayBuffer
    return new Blob([header, ...parts, ...pad], { type: 'audio/wav' });
  }

  /** Deletes the take and all its chunks. */
  remove(id: number): Promise<void> {
    return writeTx(this.db, [TAKES, TAKE_CHUNKS], (tx) => {
      tx.objectStore(TAKES).delete(id);
      const chunks = tx.objectStore(TAKE_CHUNKS);
      const keys = chunks.index(BY_TAKE).getAllKeys(IDBKeyRange.only(id));
      keys.onsuccess = () => {
        for (const key of keys.result) chunks.delete(key);
      };
    });
  }
}
