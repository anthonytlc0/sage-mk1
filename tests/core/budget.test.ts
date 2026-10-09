import { describe, expect, it } from 'vitest';
import { AudioTake, ChunkPool } from '../../src/core/chunks';

const SR = 1000;
const CHUNK_BYTES = SR * 2 * 4;

function ramp(n: number, start = 0): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = start + i;
  return out;
}

function filled(n: number, value: number): Float32Array {
  return new Float32Array(n).fill(value);
}

describe('ChunkPool budget', () => {
  it('alloc returns null once the next chunk would exceed the budget', () => {
    const pool = new ChunkPool(SR, 2 * CHUNK_BYTES);
    expect(pool.alloc()).not.toBeNull();
    expect(pool.alloc()).not.toBeNull();
    expect(pool.usedBytes()).toBe(2 * CHUNK_BYTES);
    expect(pool.alloc()).toBeNull();
    expect(pool.usedBytes()).toBe(2 * CHUNK_BYTES);
  });

  it('a budget that is not a whole number of chunks rounds down', () => {
    const pool = new ChunkPool(SR, 2 * CHUNK_BYTES + CHUNK_BYTES - 1);
    expect(pool.alloc()).not.toBeNull();
    expect(pool.alloc()).not.toBeNull();
    expect(pool.alloc()).toBeNull();
  });

  it('a budget under one chunk allows none', () => {
    const pool = new ChunkPool(SR, CHUNK_BYTES - 1);
    expect(pool.alloc()).toBeNull();
    expect(new ChunkPool(SR, 0).alloc()).toBeNull();
  });

  it('released chunks are reusable at the budget limit', () => {
    const pool = new ChunkPool(SR, 2 * CHUNK_BYTES);
    const a = pool.alloc()!;
    pool.alloc()!;
    expect(pool.alloc()).toBeNull();
    pool.release(a);
    expect(pool.alloc()).toBe(a);
    expect(pool.alloc()).toBeNull();
  });

  it('a recycled chunk never takes the pool past its budget', () => {
    const pool = new ChunkPool(SR, 2 * CHUNK_BYTES);
    const a = pool.alloc()!;
    const b = pool.alloc()!;
    pool.release(a);
    pool.release(b);
    expect(pool.usedBytes()).toBe(0);
    expect(pool.alloc()).not.toBeNull();
    expect(pool.alloc()).not.toBeNull();
    expect(pool.alloc()).toBeNull();
  });
});

describe('AudioTake at the memory budget (MEMORY FULL)', () => {
  it('with a 2-chunk budget, a third append returns false and length stays at the 2-chunk boundary', () => {
    const pool = new ChunkPool(SR, 2 * CHUNK_BYTES);
    const t = new AudioTake(pool);
    expect(t.append(ramp(1000), ramp(1000), 1000)).toBe(true);
    expect(t.append(ramp(1000), ramp(1000), 1000)).toBe(true);
    expect(t.length).toBe(2000);
    expect(t.append(ramp(1000), ramp(1000), 1000)).toBe(false);
    expect(t.length).toBe(2000);
    expect(pool.usedBytes()).toBe(2 * CHUNK_BYTES);
  });

  it('a block that straddles the budget writes what fits, stops length at the last frame written, and returns false', () => {
    const pool = new ChunkPool(SR, 2 * CHUNK_BYTES);
    const t = new AudioTake(pool);
    expect(t.append(ramp(1500), ramp(1500), 1500)).toBe(true);
    // 1000 more would reach 2500, but only 500 frames of room remain in the two chunks.
    expect(t.append(ramp(1000, 1500), ramp(1000, 1500), 1000)).toBe(false);
    expect(t.length).toBe(2000);
    const { L, R } = t.toArrays();
    expect(Array.from(L)).toEqual(Array.from(ramp(2000)));
    expect(Array.from(R)).toEqual(Array.from(ramp(2000)));
  });

  it('a single block bigger than the whole budget writes the first chunks that fit', () => {
    const pool = new ChunkPool(SR, 2 * CHUNK_BYTES);
    const t = new AudioTake(pool);
    expect(t.append(ramp(3500), ramp(3500), 3500)).toBe(false);
    expect(t.length).toBe(2000);
    expect(Array.from(t.toArrays().L)).toEqual(Array.from(ramp(2000)));
  });

  it('a zero budget takes no frames at all', () => {
    const pool = new ChunkPool(SR, 0);
    const t = new AudioTake(pool);
    expect(t.append(ramp(10), ramp(10), 10)).toBe(false);
    expect(t.length).toBe(0);
  });

  it('keeps returning false while full, and recovers once another take frees memory', () => {
    const pool = new ChunkPool(SR, 2 * CHUNK_BYTES);
    const a = new AudioTake(pool);
    const b = new AudioTake(pool);
    expect(a.append(ramp(1000), ramp(1000), 1000)).toBe(true);
    expect(b.append(ramp(1000), ramp(1000), 1000)).toBe(true);
    expect(a.append(ramp(10), ramp(10), 10)).toBe(false);
    expect(a.append(ramp(10), ramp(10), 10)).toBe(false);
    expect(a.length).toBe(1000);
    b.release();
    expect(a.append(ramp(10, 1000), ramp(10, 1000), 10)).toBe(true);
    expect(a.length).toBe(1010);
  });

  it('snapshots share chunks, so they do not count against the budget until a write diverges', () => {
    const pool = new ChunkPool(SR, 2 * CHUNK_BYTES);
    const t = new AudioTake(pool);
    expect(t.append(ramp(2000), ramp(2000), 2000)).toBe(true);
    const snap = t.snapshot();
    expect(pool.usedBytes()).toBe(2 * CHUNK_BYTES);
    snap.release();
  });

  it('a copy-on-write write that cannot get a chunk returns false and changes nothing', () => {
    const pool = new ChunkPool(SR, 2 * CHUNK_BYTES);
    const t = new AudioTake(pool);
    expect(t.append(ramp(2000), ramp(2000), 2000)).toBe(true);
    const snap = t.snapshot();
    expect(t.write(10, filled(5, 100), filled(5, 100), 5, 'add')).toBe(false);
    expect(Array.from(t.toArrays().L)).toEqual(Array.from(ramp(2000)));
    expect(Array.from(snap.toArrays().L)).toEqual(Array.from(ramp(2000)));
    expect(pool.usedBytes()).toBe(2 * CHUNK_BYTES);
    // Once the snapshot is gone the original owns its chunks and the write goes through.
    snap.release();
    expect(t.write(10, filled(5, 100), filled(5, 100), 5, 'add')).toBe(true);
    expect(t.toArrays().L[10]).toBe(110);
  });

  it('a multi-chunk write that can only copy some chunks writes none of it', () => {
    const pool = new ChunkPool(SR, 3 * CHUNK_BYTES);
    const t = new AudioTake(pool);
    expect(t.append(ramp(2000), ramp(2000), 2000)).toBe(true);
    const snap = t.snapshot();
    // Crossing the 1000 boundary needs two copies but only one chunk of budget is left.
    expect(t.write(995, filled(10, 100), filled(10, 100), 10, 'replace')).toBe(false);
    expect(Array.from(t.toArrays().L)).toEqual(Array.from(ramp(2000)));
    expect(Array.from(snap.toArrays().L)).toEqual(Array.from(ramp(2000)));
  });

  it('an append that must copy a shared partial chunk but has no room returns false and writes nothing', () => {
    const pool = new ChunkPool(SR, 2 * CHUNK_BYTES);
    const t = new AudioTake(pool);
    expect(t.append(ramp(1500), ramp(1500), 1500)).toBe(true);
    const snap = t.snapshot();
    // Both chunks are shared and the pool is full, so the partial last chunk cannot be copied.
    expect(t.append(ramp(100, 1500), ramp(100, 1500), 100)).toBe(false);
    expect(t.length).toBe(1500);
    expect(snap.length).toBe(1500);
    expect(Array.from(snap.toArrays().L)).toEqual(Array.from(ramp(1500)));
    expect(pool.usedBytes()).toBe(2 * CHUNK_BYTES);
  });
});
