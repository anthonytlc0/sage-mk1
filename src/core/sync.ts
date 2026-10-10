/**
 * Loop sync: the shared measure grid that synced tracks (LOOP SYNC SW ON) record and play against, per the spec's
 * "Transport" section and Parameter Guide pp. 3-4 (MEASURE, LOOP SYNC, QUANTIZE, LOOP LENGTH, SYNC ADJUST).
 *
 * The grid is the transport's tempo, beat and origin. Three questions decide what a synced track does:
 *  - Is there a tempo reference? The rhythm is on, or another synced track holds a loop (MIDI sync is phase 4). With
 *    none, a synced recording is "free": its length is set by the second press and it sets the tempo and the origin.
 *    With one, recordings snap to whole measures (or to MEASURE / LOOP LENGTH).
 *  - Is the grid running? The rhythm is on, or a synced track is playing, overdubbing, armed or recording to the grid.
 *    Only then does a press wait for a measure line. (INFERRED: with the rhythm off and every synced loop stopped,
 *    there is nothing to keep time with, so a press acts at once and the grid restarts from it.)
 *  - Where is the next line? `nextBoundary` from the origin, in whole frames.
 *
 * A tempo or beat change keeps the musical position: the measure and the phase within it are the same just before and
 * just after, so the origin moves. Armed actions are then re-aimed at the same line, now at a new frame.
 *
 * No allocation outside user actions: the queries loop over the five tracks by index.
 */
import { beatFrames, measureFrames, nextBoundary } from './transport';
import type { Transport } from './transport';
import type { Beat } from '../schema/types';

/** What loop sync reads from each track. `Track` implements it. */
export interface SyncTrack {
  /** LOOP SYNC SW is on. */
  readonly synced: boolean;
  /** The track holds a loop: stopped, playing or overdubbing. */
  readonly hasLoop: boolean;
  /** The track keeps time on the grid: synced and playing, overdubbing, armed, or recording against a reference. */
  readonly onGrid: boolean;
  /** The loop's length in measures; null for a free loop or no loop. */
  readonly measures: number | null;
  /** When the loop was made: lower is earlier. */
  readonly loopSeq: number;
  /** MEASURE is set to AUTO. */
  readonly measureAuto: boolean;
  /** The grid moved: aim any armed action at the same line, which may now be at a different frame. */
  retarget(frame: number): void;
}

/** `(frame - origin) mod len`, in `[0, len)`. */
export function phraseOffset(frame: number, origin: number, len: number): number {
  const r = (frame - origin) % len;
  return r < 0 ? r + len : r;
}

export class LoopSync {
  /** The rhythm flag (controller ruling R2: on/off only; the click is Task 9). */
  rhythm: 'off' | 'on' = 'off';

  private readonly transport: Transport;
  private tracks: readonly SyncTrack[] = [];
  private seq = 0;

  constructor(transport: Transport) {
    this.transport = transport;
  }

  /** The tracks to consult. The core calls this once, after building them. */
  attach(tracks: readonly SyncTrack[]): void {
    this.tracks = tracks;
  }

  /** A fresh, increasing number for a loop just made (recorded or loaded). */
  nextSeq(): number {
    return ++this.seq;
  }

  /** Frames in one measure at the current tempo and beat (fractional). */
  measure(): number {
    const t = this.transport;
    return measureFrames(t.sr, t.bpm, t.beat);
  }

  /** Frames in one beat at the current tempo and beat (fractional). */
  beat(): number {
    const t = this.transport;
    return beatFrames(t.sr, t.bpm, t.beat);
  }

  /** The grid origin: the frame where measure 0 begins. */
  get origin(): number {
    return this.transport.origin;
  }

  /** A tempo reference other than `self`: the rhythm is on, or another synced track holds a loop. */
  hasReference(self: SyncTrack | null): boolean {
    if (this.rhythm === 'on') return true;
    const tracks = this.tracks;
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      if (t !== self && t.synced && t.hasLoop) return true;
    }
    return false;
  }

  /** Something other than `self` keeps the grid running: the rhythm, or a synced track on the grid. */
  gridRunning(self: SyncTrack | null): boolean {
    if (this.rhythm === 'on') return true;
    const tracks = this.tracks;
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      if (t !== self && t.onGrid) return true;
    }
    return false;
  }

  /**
   * Make sure the grid is running at `frame` for `self`'s action: if nothing keeps it running, restart it there (the
   * origin moves to `frame`, so `frame` is a measure line). INFERRED, see the file comment.
   */
  anchor(frame: number, self: SyncTrack | null): void {
    if (!this.gridRunning(self)) this.transport.origin = frame;
  }

  /** The first line of a `unit`-frame grid from the origin at or after `frame`, as a whole frame (never before it). */
  boundary(frame: number, unit: number): number {
    return Math.max(frame, Math.round(nextBoundary(frame, this.transport.origin, unit)));
  }

  /**
   * The measure count shared by MEASURE AUTO tracks: that of the first-recorded synced AUTO track (other than `self`)
   * that holds a loop. Null when there is none, so `self` would set it.
   */
  autoMeasures(self: SyncTrack | null): number | null {
    let best: SyncTrack | null = null;
    const tracks = this.tracks;
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      if (t === self || !t.synced || !t.hasLoop || !t.measureAuto || t.measures === null) continue;
      if (best === null || t.loopSeq < best.loopSeq) best = t;
    }
    return best === null ? null : best.measures;
  }

  /**
   * LOOP LENGTH AUTO, "the length of the first-recorded phrase", in measures: the first-recorded synced track (other
   * than `self`) that holds a loop. Null when there is none.
   */
  firstMeasures(self: SyncTrack | null): number | null {
    let best: SyncTrack | null = null;
    const tracks = this.tracks;
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      if (t === self || !t.synced || !t.hasLoop || t.measures === null) continue;
      if (best === null || t.loopSeq < best.loopSeq) best = t;
    }
    return best === null ? null : best.measures;
  }

  /** The first synced loop with no reference sets the tempo, and its recording start becomes the origin. */
  define(bpm: number, origin: number, frame: number): void {
    this.transport.setTempo(bpm);
    this.transport.origin = origin;
    this.retargetAll(frame);
  }

  /**
   * Change the tempo and beat at `frame`, keeping the musical position (the measure and the phase within it), then
   * re-aim armed actions. A non-finite tempo is ignored, as `Transport.setTempo` does.
   */
  retime(bpm: number, beat: Beat, frame: number): void {
    const t = this.transport;
    const before = measureFrames(t.sr, t.bpm, t.beat);
    const cells = (frame - t.origin) / before;
    t.setTempo(bpm);
    if (t.beat.num !== beat.num || t.beat.den !== beat.den) t.beat = { num: beat.num, den: beat.den };
    const after = measureFrames(t.sr, t.bpm, t.beat);
    if (after === before) return;
    t.origin = frame - cells * after;
    this.retargetAll(frame);
  }

  /**
   * RHYTHM START/STOP at `frame` (ruling R2: a flag that makes the transport run and counts as a tempo reference).
   * Started with nothing on the grid, the grid starts at `frame`; otherwise the rhythm joins the running grid
   * (INFERRED).
   */
  toggleRhythm(frame: number): void {
    if (this.rhythm === 'on') {
      this.rhythm = 'off';
      this.transport.running = false;
      return;
    }
    this.anchor(frame, null);
    this.rhythm = 'on';
    this.transport.running = true;
  }

  private retargetAll(frame: number): void {
    const tracks = this.tracks;
    for (let i = 0; i < tracks.length; i++) tracks[i].retarget(frame);
  }
}
