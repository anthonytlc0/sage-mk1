import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../../src/storage/db';
import { Takes } from '../../src/storage/takes';
import { EXPORT_RATE } from '../../src/shared/constants';

// The tsconfig has no node types; this is the one process API the unhandled-rejection test needs.
declare const process: {
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
  off(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
};

let seq = 0;
let db: IDBDatabase;
let takes: Takes;

beforeEach(async () => {
  db = await openDb(`take-test-${seq++}`);
  takes = new Takes(db);
});
afterEach(() => db.close());

const bytes = (n: number, start: number) => Uint8Array.from({ length: n }, (_, i) => (start + i) & 0xff);
const ascii = (b: Uint8Array, off: number) => String.fromCharCode(...b.subarray(off, off + 4));

async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

async function chunkCount(): Promise<number> {
  return new Promise((res, rej) => {
    const r = db.transaction('takeChunks', 'readonly').objectStore('takeChunks').count();
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

describe('Takes', () => {
  it('blob is a 44-byte pcm24 header plus the appended chunks, in order', async () => {
    const id = await takes.create();
    const a = bytes(600, 0);
    const b = bytes(1200, 50);
    const c = bytes(300, 200);
    await takes.append(id, a);
    await takes.append(id, b);
    await takes.append(id, c);

    const blob = await takes.blob(id);
    expect(blob.type).toBe('audio/wav');
    expect(blob.size).toBe(44 + 2100);

    const out = await bytesOf(blob);
    const v = new DataView(out.buffer);
    expect(ascii(out, 0)).toBe('RIFF');
    expect(v.getUint32(4, true)).toBe(36 + 2100);
    expect(ascii(out, 8)).toBe('WAVE');
    expect(ascii(out, 36)).toBe('data');
    expect(v.getUint32(40, true)).toBe(2100); // data size matches
    expect(v.getUint16(20, true)).toBe(1); // PCM
    expect(v.getUint16(22, true)).toBe(2); // stereo
    expect(v.getUint32(24, true)).toBe(EXPORT_RATE);
    expect(v.getUint16(34, true)).toBe(24);
    expect(Array.from(out.subarray(44))).toEqual([...a, ...b, ...c]);
  });

  it('keeps append order when appends are issued without awaiting each one', async () => {
    const id = await takes.create();
    const chunks = Array.from({ length: 12 }, (_, i) => bytes(6, i * 10));
    await Promise.all(chunks.map((c) => takes.append(id, c)));
    const out = await bytesOf(await takes.blob(id));
    expect(Array.from(out.subarray(44))).toEqual(chunks.flatMap((c) => Array.from(c)));
  });

  it('walks the chunks with a cursor and wraps each in a Blob as it goes, never reading them all at once with getAll', async () => {
    const id = await takes.create();
    const chunks = Array.from({ length: 300 }, (_, i) => bytes(30, i));
    for (let i = 0; i < chunks.length; i += 50) await Promise.all(chunks.slice(i, i + 50).map((c) => takes.append(id, c)));
    const getAll = vi.spyOn(IDBIndex.prototype, 'getAll');
    const openCursor = vi.spyOn(IDBIndex.prototype, 'openCursor');
    try {
      const blob = await takes.blob(id);
      expect(getAll).not.toHaveBeenCalled();
      expect(openCursor).toHaveBeenCalledTimes(1);
      const out = await bytesOf(blob);
      expect(out.length).toBe(44 + 300 * 30);
      expect(new DataView(out.buffer).getUint32(40, true)).toBe(300 * 30);
      expect(Array.from(out.subarray(44))).toEqual(chunks.flatMap((c) => Array.from(c))); // every chunk, in append order
    } finally {
      getAll.mockRestore();
      openCursor.mockRestore();
    }
  });

  it('only walks the chunks of its own take', async () => {
    const a = await takes.create();
    const b = await takes.create();
    await takes.append(a, bytes(6, 1));
    await takes.append(b, bytes(6, 100));
    await takes.append(a, bytes(6, 2));
    expect(Array.from((await bytesOf(await takes.blob(a))).subarray(44))).toEqual([...bytes(6, 1), ...bytes(6, 2)]);
    expect(Array.from((await bytesOf(await takes.blob(b))).subarray(44))).toEqual([...bytes(6, 100)]);
  });

  it('stores only the bytes of a subarray view, not its whole backing buffer', async () => {
    const id = await takes.create();
    const backing = bytes(100, 0);
    await takes.append(id, backing.subarray(10, 16));
    const out = await bytesOf(await takes.blob(id));
    expect(out.length).toBe(44 + 6);
    expect(Array.from(out.subarray(44))).toEqual([10, 11, 12, 13, 14, 15]);
  });

  it('copies the bytes at call time: mutating or reusing the source after a non-awaited append changes nothing', async () => {
    const id = await takes.create();
    const scratch = bytes(12, 1); // a full-span view, like a recorder's reusable block buffer
    const first = Array.from(scratch);
    const p1 = takes.append(id, scratch);
    scratch.fill(9);
    const second = Array.from(scratch);
    const p2 = takes.append(id, scratch);
    scratch.fill(7);
    await Promise.all([p1, p2]);
    const out = await bytesOf(await takes.blob(id));
    expect(Array.from(out.subarray(44))).toEqual([...first, ...second]);
  });

  it('blob rejects with the transaction error and leaves no unhandled rejection behind', async () => {
    const failing = (message: string) => {
      const req: Record<string, unknown> = { error: new Error(message) };
      Object.defineProperty(req, 'onsuccess', { set() {} });
      Object.defineProperty(req, 'onerror', { set(fn: () => void) { queueMicrotask(fn); } });
      return req;
    };
    const fakeDb = {
      transaction: () => ({
        objectStore: (name: string) =>
          name === 'takes'
            ? { count: () => failing('count failed') }
            : { index: () => ({ getAll: () => failing('getAll failed'), openCursor: () => failing('cursor failed') }) },
      }),
    } as unknown as IDBDatabase;

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      await expect(new Takes(fakeDb).blob(1)).rejects.toThrow('count failed');
      await new Promise((r) => setTimeout(r, 20)); // unhandledRejection fires after the microtask queue drains
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });

  it('pads an odd data length to a word boundary, as the RIFF size says', async () => {
    const id = await takes.create();
    await takes.append(id, bytes(7, 1));
    const out = await bytesOf(await takes.blob(id));
    const v = new DataView(out.buffer);
    expect(v.getUint32(40, true)).toBe(7);
    expect(v.getUint32(4, true)).toBe(36 + 7 + 1);
    expect(out.length).toBe(44 + 7 + 1);
  });

  it('an empty take is just the header', async () => {
    const id = await takes.create();
    const out = await bytesOf(await takes.blob(id));
    expect(out.length).toBe(44);
    expect(new DataView(out.buffer).getUint32(40, true)).toBe(0);
  });

  it('keeps takes separate, with distinct ids', async () => {
    const a = await takes.create();
    const b = await takes.create();
    expect(b).not.toBe(a);
    await takes.append(a, bytes(10, 1));
    await takes.append(b, bytes(20, 2));
    await takes.append(a, bytes(10, 3));
    expect((await takes.blob(a)).size).toBe(44 + 20);
    expect((await takes.blob(b)).size).toBe(44 + 20);
    expect(Array.from((await bytesOf(await takes.blob(b))).subarray(44))).toEqual(Array.from(bytes(20, 2)));
  });

  it('list reports frames after finish, null before', async () => {
    const a = await takes.create();
    const b = await takes.create();
    await takes.finish(a, 123456);
    const list = await takes.list();
    expect(list.map((t) => t.id)).toEqual([a, b]);
    expect(list[0].frames).toBe(123456);
    expect(list[1].frames).toBeNull();
    expect(typeof list[0].createdAt).toBe('number');
  });

  it('remove deletes the take and its chunks only', async () => {
    const a = await takes.create();
    const b = await takes.create();
    await takes.append(a, bytes(10, 1));
    await takes.append(a, bytes(10, 2));
    await takes.append(b, bytes(10, 3));
    await takes.remove(a);
    expect((await takes.list()).map((t) => t.id)).toEqual([b]);
    expect(await chunkCount()).toBe(1);
    await expect(takes.blob(a)).rejects.toThrow();
    expect((await takes.blob(b)).size).toBe(44 + 10);
  });

  it('rejects operations on a take that does not exist, without storing orphan chunks', async () => {
    await expect(takes.append(99, bytes(4, 0))).rejects.toThrow(/does not exist/);
    await expect(takes.finish(99, 1)).rejects.toThrow(/does not exist/);
    await expect(takes.blob(99)).rejects.toThrow(/does not exist/);
    expect(await chunkCount()).toBe(0);
  });

  it('survives reopening the database', async () => {
    const id = await takes.create();
    await takes.append(id, bytes(30, 5));
    const name = db.name;
    db.close();
    db = await openDb(name);
    expect((await new Takes(db).blob(id)).size).toBe(44 + 30);
  });
});
