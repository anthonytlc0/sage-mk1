/**
 * The performance recorder: everything the engine's recorder bus hears, as takes in the store.
 *
 * While a take runs, each `recorderBlock` from the engine (4096 frames at the context rate) is resampled to 44.1 kHz,
 * dithered to 24 bits and handed to `Takes.append` straight away, so a take is never held in memory, however long the
 * set. `Takes` copies the bytes when `append` is called. The take's own dither stream and resampler live in a
 * `Pcm24Stream`, one per take.
 *
 * Stopping: the engine posts the last, partial block while it handles `recorder off`, and every message after it
 * (the next status among them) arrives later. So `stop` waits for the first status that no longer reports a running
 * recorder, which is behind the last block, and gives up after `settleMs` if the engine is not answering at all (a
 * suspended audio context) and finishes with what it has.
 */

import type { EngineLike } from '../control/controller';
import type { EngineEvent } from '../shared/protocol';
import type { Takes } from '../storage/takes';
import { Pcm24Stream } from './encode';

/** How long `stop` waits for the engine's last block before finishing without it. */
export const STOP_SETTLE_MS = 1000;

export type RecorderEvent =
  | { kind: 'start' }
  /** The take is finished and stored under `takeId`. */
  | { kind: 'stop'; takeId: number }
  /** Storing failed (QuotaError: the disk is full). The recorder is already stopping; `stop` follows. */
  | { kind: 'error'; error: unknown };

export interface RecorderOptions {
  settleMs?: number;
}

export type RecorderState = 'idle' | 'starting' | 'recording' | 'stopping';

export class Recorder {
  private _state: RecorderState = 'idle';
  private takeId = 0;
  private stream: Pcm24Stream | null = null;
  private unsubscribe: (() => void) | null = null;
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<number> | null = null;
  /** Appends that have not settled yet (they never reject: a failure is recorded in `failedAt`). */
  private readonly inFlight = new Set<Promise<void>>();
  /** Frames stored before the first append that failed; null while all went well. Nothing is appended after a failure. */
  private failedAt: number | null = null;
  private readonly listeners = new Set<(e: RecorderEvent) => void>();
  private readonly settleMs: number;

  /** The id of the take most recently finished, or null before the first. */
  lastTakeId: number | null = null;
  /** The storage error that ended the latest take early, or null. Cleared when a take starts. */
  lastError: unknown = null;

  constructor(
    private readonly engine: EngineLike,
    readonly takes: Takes,
    /** The audio context's sample rate: the rate of the engine's `recorderBlock`s. */
    private readonly sr: number,
    opts: RecorderOptions = {},
  ) {
    this.settleMs = opts.settleMs ?? STOP_SETTLE_MS;
  }

  get state(): RecorderState {
    return this._state;
  }

  /** A take is running (not still starting, not already stopping). */
  get recording(): boolean {
    return this._state === 'recording';
  }

  /** Recorded so far in the running take, in 44.1 kHz frames; 0 when no take is running. */
  get recordingFrames(): number {
    return this.stream && (this._state === 'recording' || this._state === 'stopping') ? this.stream.frames : 0;
  }

  /** Tells `fn` when a take starts, stops, or fails. Returns the function that stops the telling. */
  onChange(fn: (e: RecorderEvent) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** Starts a take. Does nothing while one is running; waits for a take that is stopping. Rejects if the store refuses. */
  start(): Promise<void> {
    if (this._state === 'recording') return Promise.resolve();
    if (this._state === 'starting') return this.startPromise!;
    if (this._state === 'stopping') return this.stopPromise!.then(() => this.start());
    this._state = 'starting';
    const p = this.begin();
    this.startPromise = p;
    const clear = (): void => {
      if (this.startPromise === p) this.startPromise = null;
    };
    p.then(clear, clear);
    return p;
  }

  /** Ends the take and resolves with its id once it is complete in the store. Rejects when no take is running. */
  stop(): Promise<number> {
    if (this._state === 'stopping') return this.stopPromise!;
    if (this._state === 'starting') return this.startPromise!.then(() => this.stop());
    if (this._state !== 'recording') return Promise.reject(new Error('not recording'));
    this._state = 'stopping';
    const p = this.finish();
    this.stopPromise = p;
    const clear = (): void => {
      if (this.stopPromise === p) this.stopPromise = null;
    };
    p.then(clear, clear);
    return p;
  }

  // -------------------------------------------------------------------------------------------------------------------

  private async begin(): Promise<void> {
    let id: number;
    try {
      id = await this.takes.create();
    } catch (e) {
      this._state = 'idle';
      throw e;
    }
    this.takeId = id;
    this.stream = new Pcm24Stream(this.sr);
    this.failedAt = null;
    this.lastError = null;
    this.inFlight.clear();
    this.unsubscribe = this.engine.on((e) => this.onEngineEvent(e));
    this._state = 'recording';
    this.engine.send({ t: 'recorder', on: true });
    this.emit({ kind: 'start' });
  }

  private async finish(): Promise<number> {
    const id = this.takeId;
    const stream = this.stream!;
    try {
      const answered = this.engineAnswered();
      this.engine.send({ t: 'recorder', on: false });
      await answered; // the last block (still delivered to onEngineEvent) is in by now

      this.unsubscribe?.();
      this.unsubscribe = null;
      this.append(stream.flush());
      await Promise.all(this.inFlight);

      try {
        await this.takes.finish(id, this.failedAt ?? stream.frames);
      } catch (e) {
        this.noteFailure(e); // the audio is stored and playable; only its recorded length is missing
      }
    } finally {
      this.unsubscribe?.();
      this.unsubscribe = null;
      this.stream = null;
      this._state = 'idle';
    }
    this.lastTakeId = id;
    this.emit({ kind: 'stop', takeId: id });
    return id;
  }

  /** Resolves on the first status that shows the engine's recorder off (behind its last block), or after `settleMs`. */
  private engineAnswered(): Promise<void> {
    return new Promise((resolve) => {
      let off: (() => void) | null = null;
      const done = (): void => {
        clearTimeout(timer);
        off?.();
        resolve();
      };
      const timer = setTimeout(done, this.settleMs);
      off = this.engine.on((e) => {
        if (e.t === 'status' && e.status.recorderFrames === null) done();
      });
    });
  }

  private onEngineEvent(e: EngineEvent): void {
    if (e.t !== 'recorderBlock' || !this.stream) return;
    this.append(this.stream.push(e.L, e.R));
  }

  /** Stores `bytes` (the end of the stream so far) without waiting; a failure ends the take. */
  private append(bytes: Uint8Array): void {
    if (bytes.length === 0 || this.failedAt !== null || !this.stream) return;
    const before = this.stream.frames - bytes.length / 6;
    const p: Promise<void> = this.takes.append(this.takeId, bytes).then(
      () => {
        this.inFlight.delete(p);
      },
      (err: unknown) => {
        this.inFlight.delete(p);
        this.onAppendFailed(before, err);
      },
    );
    this.inFlight.add(p);
  }

  private onAppendFailed(framesBefore: number, err: unknown): void {
    this.failedAt = this.failedAt === null ? framesBefore : Math.min(this.failedAt, framesBefore);
    this.noteFailure(err);
    // Keep what is stored and stop adding to it: a take with a hole in the middle is worse than a short one.
    if (this._state === 'recording') this.stop().catch(() => {});
  }

  private noteFailure(err: unknown): void {
    if (this.lastError !== null) return;
    this.lastError = err;
    this.emit({ kind: 'error', error: err });
  }

  private emit(e: RecorderEvent): void {
    for (const fn of [...this.listeners]) {
      try {
        fn(e);
      } catch (err) {
        console.error('recorder listener failed', err);
      }
    }
  }
}
