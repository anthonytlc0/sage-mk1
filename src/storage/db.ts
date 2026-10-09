/**
 * IndexedDB plumbing for Sage MK1: database layout, promise helpers and error mapping.
 *
 * Plain IndexedDB, no wrapper library, no OPFS. Safari (iPad, Home Screen web app) is the tightest target, so two rules:
 *  - every request of a transaction is issued synchronously or from a request callback, never after an `await`
 *    (keeps the transaction alive on every engine);
 *  - quota failures surface as `QuotaError`, which the UI shows as MEMORY FULL.
 */

export const DB_NAME = 'sage-mk1';
export const DB_VERSION = 1;

export const MEMORIES = 'memories';       // key: slot 1-99 (inline `slot`)
export const AUDIO = 'audio';             // key: `m{slot}/t{track}/c{index}` or `recovery/t{track}/c{index}`
export const SYSTEM = 'system';           // key: 'settings'
export const RECOVERY = 'recovery';       // keys: 'state', 'checkpoint'
export const TAKES = 'takes';             // key: auto-increment `id`
export const TAKE_CHUNKS = 'takeChunks';  // key: auto-increment `seq`; index BY_TAKE on `id`
export const BY_TAKE = 'byTake';

/** The device's MEMORY FULL: the browser refused the write because storage is exhausted. */
export class QuotaError extends Error {
  constructor(message = 'MEMORY FULL', options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'QuotaError';
  }
}

/** Maps an IndexedDB `QuotaExceededError` to `QuotaError`; every other value passes through unchanged. */
export function toStorageError(e: unknown): unknown {
  if (e instanceof QuotaError) return e;
  if (typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'QuotaExceededError') {
    return new QuotaError('MEMORY FULL', { cause: e });
  }
  return e;
}

function upgrade(db: IDBDatabase): void {
  const has = (n: string) => db.objectStoreNames.contains(n);
  if (!has(MEMORIES)) db.createObjectStore(MEMORIES, { keyPath: 'slot' });
  if (!has(AUDIO)) db.createObjectStore(AUDIO);
  if (!has(SYSTEM)) db.createObjectStore(SYSTEM);
  if (!has(RECOVERY)) db.createObjectStore(RECOVERY);
  if (!has(TAKES)) db.createObjectStore(TAKES, { keyPath: 'id', autoIncrement: true });
  if (!has(TAKE_CHUNKS)) {
    const chunks = db.createObjectStore(TAKE_CHUNKS, { keyPath: 'seq', autoIncrement: true });
    chunks.createIndex(BY_TAKE, 'id');
  }
}

/** Opens (creating on first use) the database. Pass a `name` to get an isolated database, e.g. in tests. */
export function openDb(name: string = DB_NAME): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, DB_VERSION);
    req.onupgradeneeded = () => upgrade(req.result);
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close(); // never block a later upgrade or delete from another tab
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
}

/** Deletes a database. Close every connection to it first. */
export function deleteDb(name: string = DB_NAME): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/** Resolves with a request's result. Only await it outside a transaction, or use it on the last request issued. */
export function reqP<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(toStorageError(req.error));
  });
}

/** Resolves on commit; rejects (quota mapped to `QuotaError`) when the transaction aborts. */
export function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    let requestError: unknown = null;
    tx.oncomplete = () => resolve();
    tx.onerror = (ev) => {
      requestError = (ev.target as IDBRequest | null)?.error ?? null;
    };
    tx.onabort = () => {
      reject(toStorageError(tx.error ?? requestError ?? new DOMException('Transaction aborted', 'AbortError')));
    };
  });
}

/**
 * Runs `fn` inside one readwrite transaction over `stores`. `fn` must issue its requests synchronously (or from
 * request callbacks); it is not async. If `fn` throws, or calls `fail(err)`, the whole transaction is rolled back and the
 * returned promise rejects with that error (quota errors mapped to `QuotaError`).
 */
export function writeTx(
  db: IDBDatabase,
  stores: string[],
  fn: (tx: IDBTransaction, fail: (err: unknown) => void) => void,
): Promise<void> {
  let tx: IDBTransaction;
  try {
    tx = db.transaction(stores, 'readwrite');
  } catch (e) {
    return Promise.reject(toStorageError(e));
  }
  let failure: unknown;
  let failed = false;
  const abort = () => {
    try {
      tx.abort();
    } catch {
      // already finished
    }
  };
  const fail = (err: unknown) => {
    if (failed) return;
    failed = true;
    failure = toStorageError(err);
    abort();
  };
  const done = txDone(tx).catch((e) => {
    throw failed ? failure : e;
  });
  try {
    fn(tx, fail);
  } catch (e) {
    fail(e);
  }
  return done;
}

/**
 * Asks the browser not to evict this origin's storage. Safari 15.2+ has `navigator.storage.persist()` and grants it
 * heuristically, mainly to Home Screen web apps. Never throws; false when unavailable or refused.
 */
export async function requestPersistence(): Promise<boolean> {
  try {
    const storage = typeof navigator === 'undefined' ? undefined : navigator.storage;
    if (!storage || typeof storage.persist !== 'function') return false;
    if (typeof storage.persisted === 'function' && (await storage.persisted())) return true;
    return (await storage.persist()) === true;
  } catch {
    return false;
  }
}
