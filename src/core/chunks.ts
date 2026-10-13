/**
 * Chunked audio store. Every track's recorded audio lives in an `AudioTake`: a list of fixed-size chunks (one second
 * each) drawn from a shared `ChunkPool`. Chunks are reference counted, so `snapshot()` (undo/redo, REC BACK, MARK) is
 * a copy of the chunk list, not of the audio. The first write to a shared chunk copies just that chunk
 * (copy-on-write), which keeps overdubbing under a held snapshot cheap.
 *
 * The pool enforces a byte budget: this is MEMORY FULL. iPad browsers get only about 1.5 to 4 GB of RAM per tab, so
 * the store has to refuse to grow rather than let the tab be killed.
 *
 * This runs on the audio thread. `read` never allocates. `write` and `append` allocate only when they need a chunk
 * the pool has no recycled one for: `append` at the start of each new second, `write` and `append` when a shared
 * chunk has to be copied. That one-second chunk is the only allocation they make, and the pool hands out recycled
 * chunks first, so it happens at most once per second recorded or per shared second dirtied.
 *
 * Invariants:
 *  - `take.chunks.length === ceil(take.length / chunkFrames)`.
 *  - A frame is only ever read below `take.length`, and every such frame was written by `append`, so a recycled chunk's
 *    stale contents (never cleared) are never audible.
 */

/** One second of stereo audio. `refs` is the number of takes holding it; 0 means it sits in the pool's free list. */
export interface Chunk {
  L: Float32Array;
  R: Float32Array;
  refs: number;
}

const BYTES_PER_SAMPLE = 4;
const CHANNELS = 2;

export class ChunkPool {
  /** Frames per chunk: one second of audio at the pool's sample rate. */
  readonly chunkFrames: number;
  /** What one chunk counts as against the budget: `chunkFrames * 2 channels * 4 bytes`. */
  readonly chunkBytes: number;
  readonly budgetBytes: number;

  /** Chunks with refs > 0. Chunks parked in `free` do not count; they are reused before anything new is allocated. */
  private live = 0;
  private readonly free: Chunk[] = [];

  constructor(sampleRate: number, budgetBytes: number) {
    if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
      throw new RangeError(`ChunkPool needs a positive whole sample rate, got ${sampleRate}`);
    }
    this.chunkFrames = sampleRate;
    this.chunkBytes = sampleRate * CHANNELS * BYTES_PER_SAMPLE;
    this.budgetBytes = budgetBytes;
  }

  /** Bytes held by live chunks. Recycled chunks waiting in the free list are not counted. */
  usedBytes(): number {
    return this.live * this.chunkBytes;
  }

  /**
   * A chunk with `refs = 1`, or null when the budget is exhausted (MEMORY FULL). Recycles a freed chunk when it can.
   * Contents are unspecified. A new allocation happens only when nothing is free, and then live chunks are all that
   * exist, so live plus free never exceeds the budget.
   */
  alloc(): Chunk | null {
    const recycled = this.free.pop();
    if (recycled !== undefined) {
      recycled.refs = 1;
      this.live++;
      return recycled;
    }
    if ((this.live + 1) * this.chunkBytes > this.budgetBytes) return null;
    this.live++;
    return { L: new Float32Array(this.chunkFrames), R: new Float32Array(this.chunkFrames), refs: 1 };
  }

  /** Another take now holds `chunk`. */
  retain(chunk: Chunk): void {
    chunk.refs++;
  }

  /** A take let go of `chunk`; at 0 refs it goes back to the pool. A chunk already free is ignored. */
  release(chunk: Chunk): void {
    if (chunk.refs <= 0) return;
    chunk.refs--;
    if (chunk.refs === 0) {
      this.live--;
      this.free.push(chunk);
    }
  }
}

export class AudioTake {
  private readonly pool: ChunkPool;
  private chunks: Chunk[] = [];
  private len = 0;
  private released = false;

  constructor(pool: ChunkPool) {
    this.pool = pool;
  }

  /** Frames recorded. Only `append` and `truncate` change it. */
  get length(): number {
    return this.len;
  }

  /** Frames per chunk (the pool's: one second). */
  get chunkFrames(): number {
    return this.pool.chunkFrames;
  }

  /**
   * Chunk `ci`'s left samples, for reads in tight loops (resampleRead.ts), where `read` per sample would cost too much.
   * Read only: writing through it would bypass copy-on-write. `ci` must be below `ceil(length / chunkFrames)`.
   */
  chunkL(ci: number): Float32Array {
    return this.chunks[ci].L;
  }

  /** Chunk `ci`'s right samples; see `chunkL`. */
  chunkR(ci: number): Float32Array {
    return this.chunks[ci].R;
  }

  /**
   * Add `n` frames from `L`/`R`, reading from `offset`. Returns false on MEMORY FULL: the frames that fit in the chunks
   * already held are still written, `length` stops at the last frame written, and nothing further is attempted. Also
   * returns false on a released take.
   *
   * Appending into a partial last chunk that a snapshot shares copies that chunk first, so two takes never write the
   * same frames.
   */
  append(L: Float32Array, R: Float32Array, n: number, offset = 0): boolean {
    if (this.released) return false;
    const cf = this.pool.chunkFrames;
    let done = 0;
    while (done < n) {
      const pos = this.len;
      const ci = Math.floor(pos / cf);
      const within = pos - ci * cf;
      let chunk: Chunk;
      if (ci === this.chunks.length) {
        const fresh = this.pool.alloc();
        if (fresh === null) return false;
        this.chunks.push(fresh);
        chunk = fresh;
      } else {
        const own = this.exclusive(ci);
        if (own === null) return false;
        chunk = own;
      }
      const run = Math.min(n - done, cf - within);
      const dstL = chunk.L;
      const dstR = chunk.R;
      for (let i = 0; i < run; i++) {
        dstL[within + i] = L[offset + done + i];
        dstR[within + i] = R[offset + done + i];
      }
      done += run;
      this.len = pos + run;
    }
    return true;
  }

  /**
   * Copy `n` frames starting at `pos` into `outL`/`outR` at `outOffset`. Frames outside the take (before 0 or at/after
   * `length`) are written as zeros. Never allocates.
   */
  read(pos: number, outL: Float32Array, outR: Float32Array, outOffset: number, n: number): void {
    const cf = this.pool.chunkFrames;
    const len = this.len;
    let done = 0;
    let p = pos;
    if (p < 0) {
      const lead = Math.min(n, -p);
      outL.fill(0, outOffset, outOffset + lead);
      outR.fill(0, outOffset, outOffset + lead);
      done = lead;
      p += lead;
    }
    while (done < n && p < len) {
      const ci = Math.floor(p / cf);
      const within = p - ci * cf;
      const run = Math.min(n - done, cf - within, len - p);
      const chunk = this.chunks[ci];
      const srcL = chunk.L;
      const srcR = chunk.R;
      const dst = outOffset + done;
      for (let i = 0; i < run; i++) {
        outL[dst + i] = srcL[within + i];
        outR[dst + i] = srcR[within + i];
      }
      done += run;
      p += run;
    }
    if (done < n) {
      outL.fill(0, outOffset + done, outOffset + n);
      outR.fill(0, outOffset + done, outOffset + n);
    }
  }

  /**
   * Mix `n` frames of `L`/`R` (read from index 0) into the take at `pos`: 'add' adds `gain * input`, 'replace'
   * overwrites with `gain * input`. A chunk shared with a snapshot is copied before it is touched.
   *
   * `pos` is a whole frame number. Writes never extend the take: frames outside `[0, length)` are dropped, with the
   * input kept aligned to the frames that land (the core never writes there, so this is only a safety clamp).
   *
   * Returns false on MEMORY FULL, when a shared chunk needs copying and the pool has none to give. All copies are made
   * before any frame is written, so a false return changes no audio, and nothing is half written.
   */
  write(pos: number, L: Float32Array, R: Float32Array, n: number, mode: 'add' | 'replace', gain = 1): boolean {
    const start = Math.max(pos, 0);
    const end = Math.min(pos + n, this.len);
    if (end <= start) return true;
    const cf = this.pool.chunkFrames;
    const first = Math.floor(start / cf);
    const last = Math.floor((end - 1) / cf);
    for (let ci = first; ci <= last; ci++) {
      if (this.exclusive(ci) === null) return false;
    }
    const replace = mode === 'replace';
    let p = start;
    while (p < end) {
      const ci = Math.floor(p / cf);
      const within = p - ci * cf;
      const run = Math.min(end - p, cf - within);
      const chunk = this.chunks[ci];
      const dstL = chunk.L;
      const dstR = chunk.R;
      const src = p - pos;
      if (replace) {
        for (let i = 0; i < run; i++) {
          dstL[within + i] = gain * L[src + i];
          dstR[within + i] = gain * R[src + i];
        }
      } else {
        for (let i = 0; i < run; i++) {
          dstL[within + i] += gain * L[src + i];
          dstR[within + i] += gain * R[src + i];
        }
      }
      p += run;
    }
    return true;
  }

  /** A new take sharing every chunk with this one. Nothing is copied until either side writes. */
  snapshot(): AudioTake {
    const snap = new AudioTake(this.pool);
    snap.chunks = this.chunks.slice();
    for (const chunk of snap.chunks) this.pool.retain(chunk);
    snap.len = this.len;
    return snap;
  }

  /** Give every chunk back to the pool. Safe to call more than once; the take is empty afterwards and takes no appends. */
  release(): void {
    if (this.released) return;
    this.released = true;
    for (const chunk of this.chunks) this.pool.release(chunk);
    this.chunks = [];
    this.len = 0;
  }

  /** Shorten the take to `len` frames (clamped to `[0, length]`), releasing the chunks wholly beyond it. */
  truncate(len: number): void {
    const keep = Math.min(Math.max(len, 0), this.len);
    if (keep >= this.len) return;
    const keepChunks = Math.ceil(keep / this.pool.chunkFrames);
    for (let i = keepChunks; i < this.chunks.length; i++) this.pool.release(this.chunks[i]);
    this.chunks.length = keepChunks;
    this.len = keep;
  }

  /** The whole take as two fresh arrays of `length` frames. */
  toArrays(): { L: Float32Array; R: Float32Array } {
    const L = new Float32Array(this.len);
    const R = new Float32Array(this.len);
    this.read(0, L, R, 0, this.len);
    return { L, R };
  }

  /** A take holding a copy of `L`/`R`, or null if it would not fit the budget (anything partly allocated is released). */
  static fromArrays(pool: ChunkPool, L: Float32Array, R: Float32Array): AudioTake | null {
    if (L.length !== R.length) {
      throw new RangeError(`fromArrays needs equal channel lengths, got ${L.length} and ${R.length}`);
    }
    const take = new AudioTake(pool);
    if (!take.append(L, R, L.length)) {
      take.release();
      return null;
    }
    return take;
  }

  /**
   * Chunk `ci` made safe to write: itself when this take is its only holder, otherwise a fresh copy that replaces it
   * here (the old one loses a ref). Null when the pool has no chunk for the copy.
   */
  private exclusive(ci: number): Chunk | null {
    const chunk = this.chunks[ci];
    if (chunk.refs <= 1) return chunk;
    const copy = this.pool.alloc();
    if (copy === null) return null;
    copy.L.set(chunk.L);
    copy.R.set(chunk.R);
    this.chunks[ci] = copy;
    this.pool.release(chunk);
    return copy;
  }
}
