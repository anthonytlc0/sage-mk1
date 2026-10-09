import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../../src/storage/db';
import { MemoryStore } from '../../src/storage/memoryStore';
import { Recovery } from '../../src/storage/recovery';
import { defaultMemory } from '../../src/schema/params';
import type { TrackAudio } from '../../src/shared/protocol';

let seq = 0;
let name: string;
let db: IDBDatabase;
let recovery: Recovery;

beforeEach(async () => {
  name = `rec-test-${seq++}`;
  db = await openDb(name);
  recovery = new Recovery(db);
});
afterEach(() => db.close());

function track(seconds: number, seed: number): TrackAudio {
  const n = Math.round(seconds * 44100);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    L[i] = Math.sin(i * 0.013 + seed) * 0.4;
    R[i] = Math.cos(i * 0.017 + seed) * 0.4;
  }
  return { L, R, sampleRate: 44100, recordedTempo: 110, measures: 4 };
}

/** Bit-exact comparison of two sample arrays. */
function identical(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false;
  const x = new Uint32Array(a.buffer, a.byteOffset, a.length);
  const y = new Uint32Array(b.buffer, b.byteOffset, b.length);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

function settings(label: string) {
  const s = defaultMemory();
  s.name = label;
  return s;
}

async function reopen(): Promise<Recovery> {
  db.close();
  db = await openDb(name);
  return new Recovery(db);
}

async function audioKeys(): Promise<string[]> {
  const keys = await new Promise<IDBValidKey[]>((res, rej) => {
    const r = db.transaction('audio', 'readonly').objectStore('audio').getAllKeys();
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return keys.map(String).sort();
}

describe('Recovery', () => {
  it('needs recovery after a crash: running flag never cleared, checkpoint present, DB reopened', async () => {
    await recovery.markRunning();
    await recovery.checkpoint(4, settings('CRASHED'), [track(2, 1)]);
    const reopened = await reopen();
    expect(await reopened.needsRecovery()).toBe(true);
  });

  it('does not need recovery after a clean shutdown', async () => {
    await recovery.markRunning();
    await recovery.checkpoint(4, settings('X'), [track(1, 1)]);
    await recovery.markCleanShutdown();
    expect(await recovery.needsRecovery()).toBe(false);
    expect(await (await reopen()).needsRecovery()).toBe(false);
  });

  it('needs both the running flag and a checkpoint', async () => {
    expect(await recovery.needsRecovery()).toBe(false); // fresh database

    await recovery.markRunning(); // flag only
    expect(await recovery.needsRecovery()).toBe(false);

    await recovery.markCleanShutdown();
    await recovery.checkpoint(1, settings('X'), [track(1, 1)]); // checkpoint only
    expect(await recovery.needsRecovery()).toBe(false);

    await recovery.markRunning(); // both
    expect(await recovery.needsRecovery()).toBe(true);

    await recovery.discard(); // flag only again
    expect(await recovery.needsRecovery()).toBe(false);
  });

  it('take returns the checkpoint with identical samples, and keeps it', async () => {
    const t0 = track(25, 1); // 3 chunks
    const t2 = track(4, 2);
    await recovery.checkpoint(9, settings('WIP'), [t0, null, t2, null, null]);

    const got = await recovery.take();
    expect(got).not.toBeNull();
    expect(got!.slot).toBe(9);
    expect(got!.settings).toEqual(settings('WIP'));
    expect(got!.tracks.map((t) => t !== null)).toEqual([true, false, true, false, false]);
    expect(identical(got!.tracks[0]!.L, t0.L)).toBe(true);
    expect(identical(got!.tracks[0]!.R, t0.R)).toBe(true);
    expect(Array.from(got!.tracks[2]!.R)).toEqual(Array.from(t2.R));
    expect(got!.tracks[2]!.recordedTempo).toBe(110);
    expect(await audioKeys()).toEqual(['recovery/t0/c0', 'recovery/t0/c1', 'recovery/t0/c2', 'recovery/t2/c0']);
    expect(await recovery.take()).not.toBeNull();
  });

  it('take is null when there is no checkpoint', async () => {
    expect(await recovery.take()).toBeNull();
  });

  it('a new checkpoint replaces the old one without orphan chunks', async () => {
    await recovery.checkpoint(1, settings('OLD'), [track(25, 1), track(25, 2)]);
    await recovery.checkpoint(2, settings('NEW'), [track(3, 3), null, null, null, null]);
    expect(await audioKeys()).toEqual(['recovery/t0/c0']);
    const got = await recovery.take();
    expect(got!.slot).toBe(2);
    expect(got!.settings.name).toBe('NEW');
    expect(got!.tracks[1]).toBeNull();
  });

  it('discard deletes the checkpoint and its chunks but leaves memory slots alone', async () => {
    const memories = new MemoryStore(db);
    await memories.save(7, settings('SLOT7'), [track(25, 5)]);
    await recovery.checkpoint(7, settings('WIP'), [track(25, 6)]);
    expect(await audioKeys()).toHaveLength(6);

    await recovery.discard();
    expect(await recovery.take()).toBeNull();
    expect(await audioKeys()).toEqual(['m7/t0/c0', 'm7/t0/c1', 'm7/t0/c2']);
    expect((await memories.load(7))!.settings.name).toBe('SLOT7');
  });

  it('a checkpoint does not disturb the memory slot it was taken from', async () => {
    const memories = new MemoryStore(db);
    await memories.save(7, settings('SAVED'), [track(2, 1)]);
    await recovery.checkpoint(7, settings('UNSAVED'), [track(2, 2)]);
    expect((await memories.load(7))!.settings.name).toBe('SAVED');
    expect((await recovery.take())!.settings.name).toBe('UNSAVED');
  });
});
