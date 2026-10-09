import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DB_NAME, QuotaError, deleteDb, openDb, requestPersistence, toStorageError } from '../../src/storage/db';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('openDb', () => {
  it('creates sage-mk1 v1 with the six stores', async () => {
    const db = await openDb();
    try {
      expect(db.name).toBe(DB_NAME);
      expect(db.name).toBe('sage-mk1');
      expect(db.version).toBe(1);
      expect(Array.from(db.objectStoreNames).sort()).toEqual(['audio', 'memories', 'recovery', 'system', 'takeChunks', 'takes']);
    } finally {
      db.close();
      await deleteDb();
    }
  });

  it('reopens an existing database without recreating it', async () => {
    const db = await openDb('reopen-test');
    db.transaction('system', 'readwrite').objectStore('system').put('kept', 'k');
    await new Promise((r) => setTimeout(r, 0));
    db.close();
    const again = await openDb('reopen-test');
    const v = await new Promise((res) => {
      const r = again.transaction('system', 'readonly').objectStore('system').get('k');
      r.onsuccess = () => res(r.result);
    });
    expect(v).toBe('kept');
    again.close();
    await deleteDb('reopen-test');
  });
});

describe('toStorageError', () => {
  it('maps QuotaExceededError to QuotaError (MEMORY FULL) and keeps the cause', () => {
    const cause = new DOMException('x', 'QuotaExceededError');
    const e = toStorageError(cause);
    expect(e).toBeInstanceOf(QuotaError);
    expect(e).toBeInstanceOf(Error);
    expect((e as QuotaError).message).toBe('MEMORY FULL');
    expect((e as QuotaError).cause).toBe(cause);
  });

  it('passes everything else through', () => {
    const other = new DOMException('x', 'ConstraintError');
    expect(toStorageError(other)).toBe(other);
    expect(toStorageError(null)).toBeNull();
    expect(toStorageError('str')).toBe('str');
  });
});

describe('requestPersistence', () => {
  it('returns false when navigator.storage is missing', async () => {
    vi.stubGlobal('navigator', {});
    expect(await requestPersistence()).toBe(false);
  });

  it('returns false when persist is not a function', async () => {
    vi.stubGlobal('navigator', { storage: {} });
    expect(await requestPersistence()).toBe(false);
  });

  it('returns false when there is no navigator at all', async () => {
    vi.stubGlobal('navigator', undefined);
    expect(await requestPersistence()).toBe(false);
  });

  it('returns what persist() reports', async () => {
    vi.stubGlobal('navigator', { storage: { persist: async () => true } });
    expect(await requestPersistence()).toBe(true);
    vi.stubGlobal('navigator', { storage: { persist: async () => false } });
    expect(await requestPersistence()).toBe(false);
  });

  it('does not ask again when storage is already persisted', async () => {
    const persist = vi.fn(async () => false);
    vi.stubGlobal('navigator', { storage: { persisted: async () => true, persist } });
    expect(await requestPersistence()).toBe(true);
    expect(persist).not.toHaveBeenCalled();
  });

  it('never throws', async () => {
    vi.stubGlobal('navigator', {
      storage: {
        persist: () => {
          throw new Error('denied');
        },
      },
    });
    expect(await requestPersistence()).toBe(false);
    vi.stubGlobal('navigator', { storage: { persist: () => Promise.reject(new Error('denied')) } });
    expect(await requestPersistence()).toBe(false);
  });
});
