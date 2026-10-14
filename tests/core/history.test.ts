/** The undo history's slots and in-flight lists (src/core/history.ts), on their own. */
import { describe, expect, it } from 'vitest';
import { AudioTake, ChunkPool } from '../../src/core/chunks';
import { History, Sinks } from '../../src/core/history';
import type { Snap } from '../../src/core/history';

const SR = 1000;
const CHUNK_BYTES = SR * 2 * 4;

function setup(): { pool: ChunkPool; take: AudioTake; snap: () => Snap } {
  const pool = new ChunkPool(SR, 16 * CHUNK_BYTES);
  const take = AudioTake.fromArrays(pool, new Float32Array(2000), new Float32Array(2000))!;
  const snap = (): Snap => ({ take: take.snapshot(), recordedTempo: 120, measures: null, loopSeq: 1 });
  return { pool, take, snap };
}

describe('History', () => {
  it('a snapshot is released once no slot holds it, and onRelease hears of it first', () => {
    const { pool, take, snap } = setup();
    const released: AudioTake[] = [];
    const h = new History((t) => released.push(t));
    const s = snap();
    h.set('undo', s);
    h.set('recBack', s); // two slots, one Snap
    h.set('undo', null);
    expect(released).toEqual([]);
    expect(h.recBack).toBe(s);
    h.set('recBack', null);
    expect(released).toEqual([s.take]);
    expect(s.take!.length).toBe(0);
    take.write(0, new Float32Array(1).fill(1), new Float32Array(1).fill(1), 1, 'replace'); // no copy: unshared again
    expect(pool.usedBytes()).toBe(2 * CHUNK_BYTES);
  });

  it('detach empties a slot without releasing; drop releases unless a slot still holds it', () => {
    const { snap } = setup();
    const h = new History(() => undefined);
    const s = snap();
    h.set('undo', s);
    expect(h.detach('undo')).toBe(s);
    expect(h.undo).toBeNull();
    expect(s.take!.length).toBe(2000);
    h.drop(s);
    expect(s.take!.length).toBe(0);
  });

  it('reclaim lets go of a slot (with onlyIfFreeing, only one that alone holds a chunk); clear empties all four', () => {
    const { take, snap } = setup();
    const h = new History(() => undefined);
    h.set('mark', snap()); // shares every chunk with `take`
    expect(h.reclaim('mark', true)).toBe(false);
    expect(h.reclaim('mark', false)).toBe(true);
    expect(h.mark).toBeNull();
    expect(h.reclaim('redo', false)).toBe(false);
    h.set('undo', { take: null, recordedTempo: 120, measures: null, loopSeq: 0 });
    expect(h.reclaim('undo', false)).toBe(false); // an empty-track snapshot holds nothing
    for (const w of ['undo', 'redo', 'mark', 'recBack'] as const) h.set(w, snap());
    h.clear();
    expect([h.undo, h.redo, h.mark, h.recBack]).toEqual([null, null, null, null]);
    expect(take.length).toBe(2000);
  });
});

describe('Sinks', () => {
  it('holds each take once, forgets on remove, and refuses a seventh live take', () => {
    const { take } = setup();
    const k = new Sinks();
    k.reset(take);
    k.add(take);
    expect(k.takes.filter((t) => t !== null)).toHaveLength(1);
    const extra = [1, 2, 3, 4, 5].map(() => take.snapshot());
    for (const t of extra) k.add(t);
    expect(() => k.add(take.snapshot())).toThrow(/live takes/);
    k.remove(extra[0]);
    expect(k.has(extra[0])).toBe(false);
    k.add(take.snapshot()); // room again
    k.reset(null);
    expect(k.takes.every((t) => t === null)).toBe(true);
  });
});
