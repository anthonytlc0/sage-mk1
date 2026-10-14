/**
 * A track's undo history (Task 8): the four copy-on-write snapshots of its loop, and the lists of takes that in-flight
 * writes land in. Split out of track.ts (fix round 1); the rules that use them (when a pass sets undo, how a swap
 * works, which writes are in flight) live in track.ts, whose file comment describes them.
 *
 * Nothing here allocates except a `Sinks` list's fixed array at construction.
 */
import type { AudioTake } from './chunks';

/** The four history snapshots a track keeps. */
export type SnapSlot = 'undo' | 'redo' | 'mark' | 'recBack';

/**
 * A saved state of the loop: its audio (null: the track was empty) and what goes with it. A slot's take is never the
 * current take, and two slots hold the same take only by holding the same `Snap`.
 */
export interface Snap {
  take: AudioTake | null;
  recordedTempo: number;
  measures: number | null;
  loopSeq: number;
}

/**
 * Room in a `Sinks` list. A list only ever holds live takes of its own track: the current take, the takes of the four
 * slots, and, during a swap, the incoming take and the source being swapped in (detached from its slot, not yet let
 * go of). undo and redo are never both set (a pass, MARK BACK and REC BACK clear redo; UNDO/REDO moves the loop from
 * one to the other), so the slots hold at most 3 distinct takes, and at most 5 takes are alive at any moment. `drop`
 * removes a take from every list as it is released. One slot to spare.
 */
const SINKS = 6;

/**
 * The takes an in-flight write (a seam or punch-out tail, or a pass's gathered writes) lands in: the take it started
 * in and the snapshots taken of it since. Fixed size; a free slot is null. Writes skip a take the pool has released.
 */
export class Sinks {
  readonly takes: (AudioTake | null)[] = new Array<AudioTake | null>(SINKS).fill(null);

  has(t: AudioTake): boolean {
    for (let i = 0; i < SINKS; i++) if (this.takes[i] === t) return true;
    return false;
  }

  /**
   * Add `t` (once). It cannot overflow (see SINKS); if that bound were ever broken a snapshot would silently miss
   * the rest of an in-flight write, so it throws instead, at the command that broke it.
   */
  add(t: AudioTake): void {
    if (this.has(t)) return;
    for (let i = 0; i < SINKS; i++) {
      if (this.takes[i] === null) {
        this.takes[i] = t;
        return;
      }
    }
    throw new Error(`Sinks: more than ${SINKS} live takes for one in-flight write`);
  }

  remove(t: AudioTake): void {
    for (let i = 0; i < SINKS; i++) if (this.takes[i] === t) this.takes[i] = null;
  }

  /** Only `t` (or nothing). */
  reset(t: AudioTake | null): void {
    this.takes.fill(null);
    this.takes[0] = t;
  }
}

/**
 * The four slots. Putting a snapshot in a slot lets go of what was there; a take is released once no slot holds its
 * `Snap` (`onRelease` hears of it first, so the track can take it off its in-flight lists).
 */
export class History {
  private undoSnap: Snap | null = null;
  private redoSnap: Snap | null = null;
  private markSnap: Snap | null = null;
  private recBackSnap: Snap | null = null;
  private readonly onRelease: (take: AudioTake) => void;

  constructor(onRelease: (take: AudioTake) => void) {
    this.onRelease = onRelease;
  }

  get undo(): Snap | null {
    return this.undoSnap;
  }

  get redo(): Snap | null {
    return this.redoSnap;
  }

  get mark(): Snap | null {
    return this.markSnap;
  }

  get recBack(): Snap | null {
    return this.recBackSnap;
  }

  get(which: SnapSlot): Snap | null {
    switch (which) {
      case 'undo':
        return this.undoSnap;
      case 'redo':
        return this.redoSnap;
      case 'mark':
        return this.markSnap;
      case 'recBack':
        return this.recBackSnap;
    }
  }

  /** Put `s` in the `which` slot, letting go of what was there. */
  set(which: SnapSlot, s: Snap | null): void {
    const old = this.get(which);
    this.assign(which, s);
    if (old !== null && old !== s) this.drop(old);
  }

  /** Empty the `which` slot without letting go of its snapshot (the caller drops it when done with it). */
  detach(which: SnapSlot): Snap | null {
    const s = this.get(which);
    this.assign(which, null);
    return s;
  }

  /** Release `s`'s take, unless a slot still holds `s`. */
  drop(s: Snap): void {
    const t = s.take;
    if (t === null || this.holds(s)) return;
    this.onRelease(t);
    t.release();
  }

  /** Let go of all four snapshots (the loop they belong to is gone). */
  clear(): void {
    this.set('undo', null);
    this.set('redo', null);
    this.set('mark', null);
    this.set('recBack', null);
  }

  /**
   * The memory budget has run out (the core's `reclaim`): let go of the `which` snapshot, if there is one holding
   * audio, and with `onlyIfFreeing` only when it is the sole holder of at least one chunk. Returns whether it did.
   */
  reclaim(which: SnapSlot, onlyIfFreeing: boolean): boolean {
    const s = this.get(which);
    if (s === null || s.take === null) return false;
    if (onlyIfFreeing && !s.take.ownsChunks()) return false;
    this.set(which, null);
    return true;
  }

  private holds(s: Snap): boolean {
    return s === this.undoSnap || s === this.redoSnap || s === this.markSnap || s === this.recBackSnap;
  }

  private assign(which: SnapSlot, s: Snap | null): void {
    switch (which) {
      case 'undo':
        this.undoSnap = s;
        break;
      case 'redo':
        this.redoSnap = s;
        break;
      case 'mark':
        this.markSnap = s;
        break;
      case 'recBack':
        this.recBackSnap = s;
        break;
    }
  }
}
