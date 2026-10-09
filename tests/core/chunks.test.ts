import { describe, expect, it } from 'vitest';
import { AudioTake, ChunkPool } from '../../src/core/chunks';

const SR = 1000; // 1 s chunks of 1000 frames keep the arithmetic readable
const CHUNK_BYTES = SR * 2 * 4;
const BIG = 1000 * CHUNK_BYTES;

/** A left ramp `start, start + 1, ...` (exact in float32 well past these sizes). */
function ramp(n: number, start = 0): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = start + i;
  return out;
}

/** The right channel carries the negated ramp so a channel mix-up cannot pass. */
function negRamp(n: number, start = 0): Float32Array {
  return ramp(n, start).map((v) => -v);
}

function filled(n: number, value: number): Float32Array {
  return new Float32Array(n).fill(value);
}

/** A take holding `n` frames of ramp (L) / negated ramp (R). */
function takeOf(pool: ChunkPool, n: number): AudioTake {
  const t = new AudioTake(pool);
  expect(t.append(ramp(n), negRamp(n), n)).toBe(true);
  return t;
}

function readAll(t: AudioTake): { L: Float32Array; R: Float32Array } {
  return t.toArrays();
}

describe('ChunkPool', () => {
  it('uses 1 s chunks and counts each as chunkFrames * 2 channels * 4 bytes', () => {
    const pool = new ChunkPool(SR, BIG);
    expect(pool.chunkFrames).toBe(SR);
    expect(pool.chunkBytes).toBe(CHUNK_BYTES);
    expect(pool.usedBytes()).toBe(0);
    const c = pool.alloc();
    expect(c).not.toBeNull();
    expect(c!.L.length).toBe(SR);
    expect(c!.R.length).toBe(SR);
    expect(c!.refs).toBe(1);
    expect(pool.usedBytes()).toBe(CHUNK_BYTES);
  });

  it('recycles a released chunk before allocating a new one', () => {
    const pool = new ChunkPool(SR, BIG);
    const a = pool.alloc()!;
    pool.release(a);
    expect(pool.usedBytes()).toBe(0);
    const b = pool.alloc()!;
    expect(b).toBe(a);
    expect(b.refs).toBe(1);
    expect(pool.usedBytes()).toBe(CHUNK_BYTES);
  });

  it('keeps a chunk alive until its last reference is released', () => {
    const pool = new ChunkPool(SR, BIG);
    const c = pool.alloc()!;
    pool.retain(c);
    expect(c.refs).toBe(2);
    pool.release(c);
    expect(pool.usedBytes()).toBe(CHUNK_BYTES);
    pool.release(c);
    expect(pool.usedBytes()).toBe(0);
  });

  it('ignores a release of a chunk that is already free (no double-pooling)', () => {
    const pool = new ChunkPool(SR, BIG);
    const c = pool.alloc()!;
    pool.release(c);
    pool.release(c);
    expect(c.refs).toBe(0); // not driven negative
    expect(pool.usedBytes()).toBe(0);
    const x = pool.alloc()!;
    const y = pool.alloc()!;
    expect(x).not.toBe(y);
  });

  it('rejects a sample rate that cannot give whole-frame chunks', () => {
    expect(() => new ChunkPool(0, BIG)).toThrow(RangeError);
    expect(() => new ChunkPool(44100.5, BIG)).toThrow(RangeError);
    expect(() => new ChunkPool(-1, BIG)).toThrow(RangeError);
  });
});

describe('AudioTake append and read', () => {
  it('appends 2.5 s at sr 1000 into 3 chunks', () => {
    const pool = new ChunkPool(SR, BIG);
    const t = takeOf(pool, 2500);
    expect(t.length).toBe(2500);
    expect(pool.usedBytes()).toBe(3 * CHUNK_BYTES);
  });

  it('reads across a chunk boundary and returns the appended ramp exactly', () => {
    const pool = new ChunkPool(SR, BIG);
    const t = takeOf(pool, 2500);
    const outL = new Float32Array(20);
    const outR = new Float32Array(20);
    t.read(990, outL, outR, 0, 20);
    expect(Array.from(outL)).toEqual(Array.from(ramp(20, 990)));
    expect(Array.from(outR)).toEqual(Array.from(negRamp(20, 990)));
  });

  it('reads a span covering several chunks', () => {
    const pool = new ChunkPool(SR, BIG);
    const t = takeOf(pool, 2500);
    const { L, R } = readAll(t);
    expect(Array.from(L)).toEqual(Array.from(ramp(2500)));
    expect(Array.from(R)).toEqual(Array.from(negRamp(2500)));
  });

  it('honours outOffset when reading and leaves the rest of the output alone', () => {
    const pool = new ChunkPool(SR, BIG);
    const t = takeOf(pool, 100);
    const outL = filled(10, 7);
    const outR = filled(10, 7);
    t.read(50, outL, outR, 3, 4);
    expect(Array.from(outL)).toEqual([7, 7, 7, 50, 51, 52, 53, 7, 7, 7]);
    expect(Array.from(outR)).toEqual([7, 7, 7, -50, -51, -52, -53, 7, 7, 7]);
  });

  it('appends from an offset into the source buffers', () => {
    const pool = new ChunkPool(SR, BIG);
    const t = new AudioTake(pool);
    expect(t.append(ramp(10), negRamp(10), 4, 3)).toBe(true);
    expect(t.length).toBe(4);
    const { L, R } = readAll(t);
    expect(Array.from(L)).toEqual([3, 4, 5, 6]);
    expect(Array.from(R)).toEqual([-3, -4, -5, -6]);
  });

  it('builds the same take from many small appends as from one big one', () => {
    const pool = new ChunkPool(SR, BIG);
    const t = new AudioTake(pool);
    const srcL = ramp(2500);
    const srcR = negRamp(2500);
    for (let off = 0; off < 2500; off += 128) {
      const n = Math.min(128, 2500 - off);
      expect(t.append(srcL, srcR, n, off)).toBe(true);
    }
    expect(t.length).toBe(2500);
    const { L, R } = readAll(t);
    expect(Array.from(L)).toEqual(Array.from(srcL));
    expect(Array.from(R)).toEqual(Array.from(srcR));
    expect(pool.usedBytes()).toBe(3 * CHUNK_BYTES);
  });

  it('appending zero frames is a successful no-op', () => {
    const pool = new ChunkPool(SR, BIG);
    const t = new AudioTake(pool);
    expect(t.append(ramp(4), negRamp(4), 0)).toBe(true);
    expect(t.length).toBe(0);
    expect(pool.usedBytes()).toBe(0);
  });

  it('writes zeros for everything read beyond length', () => {
    const pool = new ChunkPool(SR, BIG);
    const t = takeOf(pool, 1500);
    const outL = filled(10, 9);
    const outR = filled(10, 9);
    // 5 real frames (1495..1499), then 5 past the end.
    t.read(1495, outL, outR, 0, 10);
    expect(Array.from(outL)).toEqual([1495, 1496, 1497, 1498, 1499, 0, 0, 0, 0, 0]);
    expect(Array.from(outR)).toEqual([-1495, -1496, -1497, -1498, -1499, 0, 0, 0, 0, 0]);
  });

  it('writes zeros when the whole read lies past the end, including a chunk-aligned end', () => {
    const pool = new ChunkPool(SR, BIG);
    const t = takeOf(pool, 2000); // ends exactly on a chunk boundary
    const outL = filled(8, 9);
    const outR = filled(8, 9);
    t.read(2000, outL, outR, 0, 8);
    expect(Array.from(outL)).toEqual(new Array(8).fill(0));
    expect(Array.from(outR)).toEqual(new Array(8).fill(0));
    outL.fill(9);
    outR.fill(9);
    t.read(5000, outL, outR, 0, 8);
    expect(Array.from(outL)).toEqual(new Array(8).fill(0));
    expect(Array.from(outR)).toEqual(new Array(8).fill(0));
  });

  it('reads an empty take as silence', () => {
    const pool = new ChunkPool(SR, BIG);
    const t = new AudioTake(pool);
    const outL = filled(4, 9);
    const outR = filled(4, 9);
    t.read(0, outL, outR, 0, 4);
    expect(Array.from(outL)).toEqual([0, 0, 0, 0]);
    expect(Array.from(outR)).toEqual([0, 0, 0, 0]);
  });

  it('reads zeros for frames before the start', () => {
    const pool = new ChunkPool(SR, BIG);
    const t = takeOf(pool, 100);
    const outL = filled(6, 9);
    const outR = filled(6, 9);
    t.read(-2, outL, outR, 0, 6);
    expect(Array.from(outL)).toEqual([0, 0, 0, 1, 2, 3]);
    // Frame 0 of the negated ramp is -0, which toEqual tells apart from +0.
    expect(Array.from(outR)).toEqual([0, 0, -0, -1, -2, -3]);
  });
});

describe('AudioTake write', () => {
  it('replace overwrites with gain * input, add sums gain * input, gain defaults to 1', () => {
    const pool = new ChunkPool(SR, BIG);
    const t = takeOf(pool, 100);
    t.write(10, filled(3, 100), filled(3, 200), 3, 'replace');
    t.write(20, filled(3, 100), filled(3, 200), 3, 'add');
    t.write(30, filled(3, 100), filled(3, 200), 3, 'replace', 0.5);
    t.write(40, filled(3, 100), filled(3, 200), 3, 'add', 0.5);
    const { L, R } = readAll(t);
    expect(Array.from(L.subarray(10, 13))).toEqual([100, 100, 100]);
    expect(Array.from(R.subarray(10, 13))).toEqual([200, 200, 200]);
    expect(Array.from(L.subarray(20, 23))).toEqual([120, 121, 122]);
    expect(Array.from(R.subarray(20, 23))).toEqual([180, 179, 178]);
    expect(Array.from(L.subarray(30, 33))).toEqual([50, 50, 50]);
    expect(Array.from(R.subarray(30, 33))).toEqual([100, 100, 100]);
    expect(Array.from(L.subarray(40, 43))).toEqual([90, 91, 92]);
    expect(Array.from(R.subarray(40, 43))).toEqual([60, 59, 58]);
    // Neighbours untouched.
    expect(L[9]).toBe(9);
    expect(L[13]).toBe(13);
  });

  it('a write that crosses a chunk boundary lands on both sides', () => {
    const pool = new ChunkPool(SR, BIG);
    const t = takeOf(pool, 2500);
    t.write(995, filled(10, 1), filled(10, 2), 10, 'add');
    const { L, R } = readAll(t);
    for (let i = 990; i < 1005; i++) {
      const hit = i >= 995 && i < 1005;
      expect(L[i]).toBe(i + (hit ? 1 : 0));
      expect(R[i]).toBe(-i + (hit ? 2 : 0));
    }
  });

  it('snapshot then add-write on the original: the snapshot is unchanged', () => {
    const pool = new ChunkPool(SR, BIG);
    const t = takeOf(pool, 2500);
    const snap = t.snapshot();
    t.write(10, filled(5, 100), filled(5, 100), 5, 'add');
    const orig = readAll(t);
    const frozen = readAll(snap);
    expect(Array.from(frozen.L)).toEqual(Array.from(ramp(2500)));
    expect(Array.from(frozen.R)).toEqual(Array.from(negRamp(2500)));
    expect(Array.from(orig.L.subarray(10, 15))).toEqual([110, 111, 112, 113, 114]);
    expect(Array.from(orig.R.subarray(10, 15))).toEqual([90, 89, 88, 87, 86]);
    expect(orig.L[9]).toBe(9);
    expect(orig.L[15]).toBe(15);
  });

  it('copies only the touched chunk: pool usage grows by exactly one chunk', () => {
    const pool = new ChunkPool(SR, BIG);
    const t = takeOf(pool, 2500);
    const snap = t.snapshot();
    expect(pool.usedBytes()).toBe(3 * CHUNK_BYTES); // snapshot shares, copies nothing
    t.write(10, filled(5, 1), filled(5, 1), 5, 'add');
    expect(pool.usedBytes()).toBe(4 * CHUNK_BYTES);
    t.write(20, filled(5, 1), filled(5, 1), 5, 'add'); // same chunk, already exclusive
    expect(pool.usedBytes()).toBe(4 * CHUNK_BYTES);
    snap.release();
    expect(pool.usedBytes()).toBe(3 * CHUNK_BYTES);
  });

  it('a write across a chunk boundary copies both touched chunks and nothing else', () => {
    const pool = new ChunkPool(SR, BIG);
    const t = takeOf(pool, 3000);
    const snap = t.snapshot();
    t.write(995, filled(10, 1), filled(10, 1), 10, 'replace');
    expect(pool.usedBytes()).toBe(5 * CHUNK_BYTES);
    const frozen = readAll(snap);
    expect(Array.from(frozen.L)).toEqual(Array.from(ramp(3000)));
    expect(Array.from(frozen.R)).toEqual(Array.from(negRamp(3000)));
    const orig = readAll(t);
    for (let i = 990; i < 1005; i++) {
      const hit = i >= 995 && i < 1005;
      expect(orig.L[i]).toBe(hit ? 1 : i);
      expect(orig.R[i]).toBe(hit ? 1 : -i);
    }
  });

  it('writing the snapshot leaves the original alone, and the original then owns its chunk again', () => {
    const pool = new ChunkPool(SR, BIG);
    const t = takeOf(pool, 1500);
    const snap = t.snapshot();
    snap.write(5, filled(3, 50), filled(3, 50), 3, 'replace');
    expect(pool.usedBytes()).toBe(3 * CHUNK_BYTES);
    expect(Array.from(readAll(t).L.subarray(5, 8))).toEqual([5, 6, 7]);
    expect(Array.from(readAll(snap).L.subarray(5, 8))).toEqual([50, 50, 50]);
    // The original's first chunk is no longer shared, so writing it copies nothing.
    t.write(6, filled(1, 9), filled(1, 9), 1, 'replace');
    expect(pool.usedBytes()).toBe(3 * CHUNK_BYTES);
  });

  it('clamps writes that run past length: nothing is added past the end and length does not grow', () => {
    const pool = new ChunkPool(SR, BIG);
    const t = takeOf(pool, 1500);
    t.write(1495, filled(10, 100), filled(10, 100), 10, 'replace');
    expect(t.length).toBe(1500);
    const outL = filled(10, 9);
    const outR = filled(10, 9);
    t.read(1495, outL, outR, 0, 10);
    expect(Array.from(outL)).toEqual([100, 100, 100, 100, 100, 0, 0, 0, 0, 0]);
    t.write(1600, filled(4, 100), filled(4, 100), 4, 'replace'); // wholly past the end
    expect(t.length).toBe(1500);
    expect(pool.usedBytes()).toBe(2 * CHUNK_BYTES);
  });

  it('clamps writes that start before frame 0, keeping input aligned to the frames that land', () => {
    const pool = new ChunkPool(SR, BIG);
    const t = takeOf(pool, 100);
    t.write(-2, ramp(5, 1000), ramp(5, 2000), 5, 'replace');
    const { L, R } = readAll(t);
    expect(Array.from(L.subarray(0, 4))).toEqual([1002, 1003, 1004, 3]);
    expect(Array.from(R.subarray(0, 4))).toEqual([2002, 2003, 2004, -3]);
  });

  it('a write of zero frames changes and copies nothing', () => {
    const pool = new ChunkPool(SR, BIG);
    const t = takeOf(pool, 1500);
    const snap = t.snapshot();
    expect(t.write(10, filled(4, 1), filled(4, 1), 0, 'add')).toBe(true);
    expect(pool.usedBytes()).toBe(2 * CHUNK_BYTES);
    snap.release();
  });
});

describe('AudioTake append after a snapshot', () => {
  it('appending into a shared partial last chunk copies it and leaves the snapshot intact', () => {
    const pool = new ChunkPool(SR, BIG);
    const t = takeOf(pool, 1500);
    const snap = t.snapshot();
    expect(t.append(ramp(100, 1500), negRamp(100, 1500), 100)).toBe(true);
    expect(t.length).toBe(1600);
    expect(snap.length).toBe(1500);
    expect(pool.usedBytes()).toBe(3 * CHUNK_BYTES); // 2 shared + 1 copy of the partial chunk
    expect(Array.from(readAll(t).L)).toEqual(Array.from(ramp(1600)));
    expect(Array.from(readAll(snap).L)).toEqual(Array.from(ramp(1500)));
    // Two takes sharing a chunk can both append without trampling each other.
    expect(snap.append(filled(10, -1), filled(10, -1), 10)).toBe(true);
    expect(Array.from(readAll(t).L)).toEqual(Array.from(ramp(1600)));
    expect(Array.from(readAll(snap).L.subarray(1500))).toEqual(new Array(10).fill(-1));
  });

  it('appending into a chunk-aligned end of a snapshotted take needs a new chunk, not a copy', () => {
    const pool = new ChunkPool(SR, BIG);
    const t = takeOf(pool, 2000);
    const snap = t.snapshot();
    expect(t.append(ramp(10), negRamp(10), 10)).toBe(true);
    expect(pool.usedBytes()).toBe(3 * CHUNK_BYTES);
    expect(snap.length).toBe(2000);
  });
});

describe('AudioTake release', () => {
  it('returns its bytes to the pool', () => {
    const pool = new ChunkPool(SR, BIG);
    const t = takeOf(pool, 2500);
    expect(pool.usedBytes()).toBe(3 * CHUNK_BYTES);
    t.release();
    expect(pool.usedBytes()).toBe(0);
    expect(t.length).toBe(0);
  });

  it('frees shared chunks only when the last take holding them is released', () => {
    const pool = new ChunkPool(SR, BIG);
    const t = takeOf(pool, 2500);
    const snap = t.snapshot();
    t.release();
    expect(pool.usedBytes()).toBe(3 * CHUNK_BYTES);
    expect(Array.from(readAll(snap).L)).toEqual(Array.from(ramp(2500)));
    snap.release();
    expect(pool.usedBytes()).toBe(0);
  });

  it('is idempotent: releasing twice neither double-frees nor steals a sibling snapshot chunks', () => {
    const pool = new ChunkPool(SR, BIG);
    const t = takeOf(pool, 2500);
    const snap = t.snapshot();
    t.release();
    t.release();
    expect(pool.usedBytes()).toBe(3 * CHUNK_BYTES);
    expect(Array.from(readAll(snap).L)).toEqual(Array.from(ramp(2500)));
    snap.release();
    snap.release();
    expect(pool.usedBytes()).toBe(0);
    // The free list holds each chunk once: three allocations give three distinct chunks.
    const a = pool.alloc()!;
    const b = pool.alloc()!;
    const c = pool.alloc()!;
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('a released take refuses further appends instead of silently reviving', () => {
    const pool = new ChunkPool(SR, BIG);
    const t = takeOf(pool, 100);
    t.release();
    expect(t.append(ramp(4), negRamp(4), 4)).toBe(false);
    expect(t.length).toBe(0);
    expect(pool.usedBytes()).toBe(0);
  });

  it('a snapshot of a released take is empty', () => {
    const pool = new ChunkPool(SR, BIG);
    const t = takeOf(pool, 100);
    t.release();
    const snap = t.snapshot();
    expect(snap.length).toBe(0);
    expect(pool.usedBytes()).toBe(0);
  });
});

describe('AudioTake truncate', () => {
  it('releases the chunks wholly beyond the new length', () => {
    const pool = new ChunkPool(SR, BIG);
    const t = takeOf(pool, 2500);
    t.truncate(1200);
    expect(t.length).toBe(1200);
    expect(pool.usedBytes()).toBe(2 * CHUNK_BYTES);
    expect(Array.from(readAll(t).L)).toEqual(Array.from(ramp(1200)));
  });

  it('keeps a chunk that the new length only partly fills', () => {
    const pool = new ChunkPool(SR, BIG);
    const t = takeOf(pool, 2500);
    t.truncate(2001);
    expect(pool.usedBytes()).toBe(3 * CHUNK_BYTES);
  });

  it('truncating to an exact chunk boundary frees the chunk after it', () => {
    const pool = new ChunkPool(SR, BIG);
    const t = takeOf(pool, 2500);
    t.truncate(2000);
    expect(pool.usedBytes()).toBe(2 * CHUNK_BYTES);
  });

  it('truncating to 0 releases everything', () => {
    const pool = new ChunkPool(SR, BIG);
    const t = takeOf(pool, 2500);
    t.truncate(0);
    expect(t.length).toBe(0);
    expect(pool.usedBytes()).toBe(0);
  });

  it('is a no-op at or beyond the current length, and clamps negatives to 0', () => {
    const pool = new ChunkPool(SR, BIG);
    const t = takeOf(pool, 1500);
    t.truncate(1500);
    t.truncate(9999);
    expect(t.length).toBe(1500);
    expect(pool.usedBytes()).toBe(2 * CHUNK_BYTES);
    t.truncate(-5);
    expect(t.length).toBe(0);
    expect(pool.usedBytes()).toBe(0);
  });

  it('appends continue from the truncated length', () => {
    const pool = new ChunkPool(SR, BIG);
    const t = takeOf(pool, 2500);
    t.truncate(1200);
    expect(t.append(filled(5, 7), filled(5, 8), 5)).toBe(true);
    expect(t.length).toBe(1205);
    const { L, R } = readAll(t);
    expect(Array.from(L.subarray(1198, 1205))).toEqual([1198, 1199, 7, 7, 7, 7, 7]);
    expect(Array.from(R.subarray(1198, 1205))).toEqual([-1198, -1199, 8, 8, 8, 8, 8]);
  });

  it('truncating a snapshotted take never disturbs the snapshot, even when appending afterwards', () => {
    const pool = new ChunkPool(SR, BIG);
    const t = takeOf(pool, 2500);
    const snap = t.snapshot();
    t.truncate(1200);
    expect(pool.usedBytes()).toBe(3 * CHUNK_BYTES); // snapshot still holds the third chunk
    expect(t.append(filled(5, 7), filled(5, 7), 5)).toBe(true);
    expect(Array.from(readAll(snap).L)).toEqual(Array.from(ramp(2500)));
    expect(Array.from(readAll(snap).R)).toEqual(Array.from(negRamp(2500)));
  });
});

describe('AudioTake toArrays and fromArrays', () => {
  it('toArrays returns exactly length frames', () => {
    const pool = new ChunkPool(SR, BIG);
    const t = takeOf(pool, 2500);
    const { L, R } = t.toArrays();
    expect(L.length).toBe(2500);
    expect(R.length).toBe(2500);
  });

  it('fromArrays round-trips through toArrays', () => {
    const pool = new ChunkPool(SR, BIG);
    const srcL = ramp(2345, 0.5);
    const srcR = negRamp(2345, 0.5);
    const t = AudioTake.fromArrays(pool, srcL, srcR);
    expect(t).not.toBeNull();
    expect(t!.length).toBe(2345);
    const { L, R } = t!.toArrays();
    expect(Array.from(L)).toEqual(Array.from(srcL));
    expect(Array.from(R)).toEqual(Array.from(srcR));
    expect(pool.usedBytes()).toBe(3 * CHUNK_BYTES);
  });

  it('fromArrays of empty arrays gives an empty take', () => {
    const pool = new ChunkPool(SR, BIG);
    const t = AudioTake.fromArrays(pool, new Float32Array(0), new Float32Array(0));
    expect(t).not.toBeNull();
    expect(t!.length).toBe(0);
    expect(pool.usedBytes()).toBe(0);
  });

  it('fromArrays rejects channels of different length', () => {
    const pool = new ChunkPool(SR, BIG);
    expect(() => AudioTake.fromArrays(pool, new Float32Array(10), new Float32Array(9))).toThrow(RangeError);
  });
});
