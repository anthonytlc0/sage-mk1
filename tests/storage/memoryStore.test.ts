import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, QuotaError } from '../../src/storage/db';
import { MemoryStore } from '../../src/storage/memoryStore';
import { defaultMemory } from '../../src/schema/params';
import type { TrackAudio } from '../../src/shared/protocol';
import type { MemorySettings } from '../../src/schema/types';

let seq = 0;
let db: IDBDatabase;
let store: MemoryStore;

beforeEach(async () => {
  db = await openDb(`mem-test-${seq++}`); // a fresh database per test
  store = new MemoryStore(db);
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

/** Deterministic, non-repeating samples so a misplaced chunk cannot pass. */
function signal(n: number, seed: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin(i * 0.01 + seed) * 0.5 + ((i * 2654435761 + seed) % 1000) / 4000;
  return out;
}

function track(seconds: number, seed = 1, sampleRate = 44100, measures: number | null = 4, recordedTempo = 120): TrackAudio {
  const n = Math.round(seconds * sampleRate);
  return { L: signal(n, seed), R: signal(n, seed + 100), sampleRate, recordedTempo, measures };
}

/** Bit-exact comparison of two sample arrays. */
function identical(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false;
  const x = new Uint32Array(a.buffer, a.byteOffset, a.length);
  const y = new Uint32Array(b.buffer, b.byteOffset, b.length);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

function settings(name: string) {
  const s = defaultMemory();
  s.name = name;
  return s;
}

async function audioKeys(): Promise<string[]> {
  const keys = await new Promise<IDBValidKey[]>((res, rej) => {
    const r = db.transaction('audio', 'readonly').objectStore('audio').getAllKeys();
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return keys.map(String).sort();
}

describe('MemoryStore', () => {
  it('round-trips slot 7 with a 25 s track as 3 chunks', async () => {
    const t = track(25, 3, 44100, 8, 97.5);
    await store.save(7, settings('SONG'), [t, null, null, null, null]);

    expect(await audioKeys()).toEqual(['m7/t0/c0', 'm7/t0/c1', 'm7/t0/c2']);

    const loaded = await store.load(7);
    expect(loaded).not.toBeNull();
    expect(loaded!.settings).toEqual(settings('SONG'));
    expect(loaded!.tracks).toHaveLength(5);
    expect(loaded!.tracks.slice(1)).toEqual([null, null, null, null]);
    const got = loaded!.tracks[0]!;
    expect(got.sampleRate).toBe(44100);
    expect(got.recordedTempo).toBe(97.5);
    expect(got.measures).toBe(8);
    expect(got.L.length).toBe(t.L.length);
    expect(identical(got.L, t.L)).toBe(true);
    expect(identical(got.R, t.R)).toBe(true);
  });

  it('keeps several tracks, a null measures count and a non-44.1k rate intact', async () => {
    const a = track(3, 1, 48000, null, 140);
    const b = track(12, 2, 48000, 2, 90);
    await store.save(1, settings('A'), [null, a, null, b, null]);
    const loaded = await store.load(1);
    expect(loaded!.tracks[0]).toBeNull();
    expect(loaded!.tracks[1]!.measures).toBeNull();
    expect(loaded!.tracks[1]!.sampleRate).toBe(48000);
    expect(Array.from(loaded!.tracks[1]!.L)).toEqual(Array.from(a.L));
    expect(Array.from(loaded!.tracks[3]!.R)).toEqual(Array.from(b.R)); // 12 s at 48 kHz: 2 chunks
    expect(await audioKeys()).toEqual(['m1/t1/c0', 'm1/t3/c0', 'm1/t3/c1']);
  });

  it('stores only the samples of a chunk, not the whole source buffer', async () => {
    const t = track(25);
    await store.save(2, settings('X'), [t]);
    const rows = await new Promise<{ L: ArrayBuffer }[]>((res, rej) => {
      const r = db.transaction('audio', 'readonly').objectStore('audio').getAll();
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    expect(rows.map((c) => c.L.byteLength).sort((x, y) => x - y)).toEqual([
      (t.L.length - 2 * 441000) * 4,
      441000 * 4,
      441000 * 4,
    ]);
  });

  it('always loads 5 tracks, and rejects more than 5', async () => {
    await store.save(4, settings('SHORTLIST'), [track(1)]);
    const loaded = await store.load(4);
    expect(loaded!.tracks).toHaveLength(5);
    expect(loaded!.tracks[0]).not.toBeNull();
    expect(loaded!.tracks.slice(1)).toEqual([null, null, null, null]);
    await expect(store.save(4, settings('TOOMANY'), Array(6).fill(null))).rejects.toThrow(RangeError);
    expect((await store.load(4))!.settings.name).toBe('SHORTLIST');
  });

  it('completes settings stored by an older schema, keeping the values that are still valid', async () => {
    const old = { name: 'OLD', tempo: 91, retired: 1 } as unknown as MemorySettings;
    await store.save(8, old, []);
    const expected = defaultMemory();
    expected.name = 'OLD';
    expected.tempo = 91;
    expect((await store.load(8))!.settings).toEqual(expected);

    const rich = defaultMemory();
    rich.name = 'RICH';
    rich.track[1]!.measure = { note: '1/4' };
    rich.play.loopLength = 12;
    await store.save(9, rich, []);
    expect((await store.load(9))!.settings).toEqual(rich);
  });

  it('returns null for a slot that was never saved', async () => {
    expect(await store.load(12)).toBeNull();
  });

  it('hasAudio answers from the slot record alone and never opens the audio store', async () => {
    await store.save(4, settings('PHRASE'), [null, track(1)]);
    await store.save(5, settings('SETTINGS ONLY'), [null, null, null, null, null]);
    const tx = vi.spyOn(db, 'transaction');
    const cursor = vi.spyOn(IDBObjectStore.prototype, 'openCursor');
    expect(await store.hasAudio(4)).toBe(true);
    expect(await store.hasAudio(5)).toBe(false);
    expect(await store.hasAudio(6)).toBe(false); // never saved
    expect(cursor).not.toHaveBeenCalled();
    expect(tx).toHaveBeenCalledTimes(3);
    for (const [scope] of tx.mock.calls) expect([scope].flat()).toEqual(['memories']);
    await expect(store.hasAudio(100)).rejects.toThrow(RangeError);
  });

  it('clear empties the slot and removes its chunks', async () => {
    await store.save(7, settings('SONG'), [track(25)]);
    expect(await store.isEmpty(7)).toBe(false);
    await store.clear(7);
    expect(await store.isEmpty(7)).toBe(true);
    expect(await store.load(7)).toBeNull();
    expect(await audioKeys()).toEqual([]);
  });

  it('clear and save leave neighbouring slots alone (m7/ is not a prefix of m70/)', async () => {
    await store.save(7, settings('SEVEN'), [track(2, 1)]);
    await store.save(70, settings('SEVENTY'), [track(2, 2)]);
    await store.clear(7);
    expect(await audioKeys()).toEqual(['m70/t0/c0']);
    await store.save(7, settings('SEVEN'), [track(2, 3)]);
    expect(await audioKeys()).toEqual(['m7/t0/c0', 'm70/t0/c0']);
    expect((await store.load(70))!.settings.name).toBe('SEVENTY');
  });

  it('list has 99 entries, slots 1-99, empty flags and stored names', async () => {
    await store.save(7, settings('SONG'), [track(1)]);
    await store.save(99, settings('LAST'), []);
    const list = await store.list();
    expect(list).toHaveLength(99);
    expect(list.map((e) => e.slot)).toEqual(Array.from({ length: 99 }, (_, i) => i + 1));
    expect(list[6]).toEqual({ slot: 7, name: 'SONG', empty: false });
    expect(list[98]).toEqual({ slot: 99, name: 'LAST', empty: false });
    expect(list[0]).toEqual({ slot: 1, name: '', empty: true });
    expect(list.filter((e) => !e.empty)).toHaveLength(2);
  });

  it('rejects slots outside 1-99', async () => {
    await expect(store.save(0, settings('A'), [])).rejects.toThrow(RangeError);
    await expect(store.save(100, settings('A'), [])).rejects.toThrow(RangeError);
    await expect(store.load(1.5)).rejects.toThrow(RangeError);
    await expect(store.clear(-1)).rejects.toThrow(RangeError);
    await expect(store.isEmpty(100)).rejects.toThrow(RangeError);
  });

  describe('replacing a recording', () => {
    it('leaves no orphan chunks when the new recording is shorter', async () => {
      await store.save(7, settings('LONG'), [track(25, 1), track(25, 2), null, null, null]);
      expect(await audioKeys()).toHaveLength(6);

      const shorter = track(5, 9);
      await store.save(7, settings('SHORT'), [shorter, null, null, null, null]);

      expect(await audioKeys()).toEqual(['m7/t0/c0']);
      const loaded = await store.load(7);
      expect(loaded!.settings.name).toBe('SHORT');
      expect(loaded!.tracks[1]).toBeNull();
      expect(Array.from(loaded!.tracks[0]!.L)).toEqual(Array.from(shorter.L));
    });

    it('leaves no chunks when every track is dropped', async () => {
      await store.save(7, settings('LONG'), [track(25)]);
      await store.save(7, settings('EMPTYTRACKS'), [null, null, null, null, null]);
      expect(await audioKeys()).toEqual([]);
      expect((await store.load(7))!.tracks).toEqual([null, null, null, null, null]);
    });
  });

  describe('QuotaError (MEMORY FULL)', () => {
    it('is thrown when a put fails synchronously with QuotaExceededError, and the old slot survives', async () => {
      const old = track(25, 1);
      await store.save(7, settings('OLD'), [old]);

      vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
        throw new DOMException('x', 'QuotaExceededError');
      });
      const failure = await store.save(7, settings('NEW'), [track(25, 2)]).then(
        () => null,
        (e: unknown) => e,
      );
      vi.restoreAllMocks();

      expect(failure).toBeInstanceOf(QuotaError);
      expect((failure as Error).message).toBe('MEMORY FULL');
      const kept = await store.load(7);
      expect(kept!.settings.name).toBe('OLD'); // the delete and partial puts were rolled back
      expect(Array.from(kept!.tracks[0]!.L)).toEqual(Array.from(old.L));
      expect(await audioKeys()).toHaveLength(3);
    });

    it('is thrown when the browser aborts the transaction with QuotaExceededError', async () => {
      // Fail the stored operation the way a full disk does: the request errors, the transaction aborts.
      const realPut = IDBObjectStore.prototype.put;
      vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
        const raw = (this as unknown as { _rawObjectStore: { storeRecord: () => never } })._rawObjectStore;
        const original = raw.storeRecord;
        raw.storeRecord = () => {
          throw new DOMException('x', 'QuotaExceededError');
        };
        try {
          return realPut.apply(this, args as Parameters<typeof realPut>);
        } finally {
          raw.storeRecord = original;
        }
      });
      await expect(store.save(3, settings('NEW'), [track(1)])).rejects.toBeInstanceOf(QuotaError);
      vi.restoreAllMocks();
      expect(await store.isEmpty(3)).toBe(true);
      expect(await audioKeys()).toEqual([]);
    });

    it('does not wrap other errors', async () => {
      vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
        throw new TypeError('boom');
      });
      const failure = await store.save(5, settings('A'), [track(1)]).then(
        () => null,
        (e: unknown) => e,
      );
      expect(failure).toBeInstanceOf(TypeError);
      expect(failure).not.toBeInstanceOf(QuotaError);
    });
  });
});
