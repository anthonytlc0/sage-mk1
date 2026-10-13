/**
 * The performance recorder: everything the engine's recorder bus hears, as takes in the store.
 *
 * While a take runs, each `recorderBlock` from the engine (4096 frames at the context rate) is resampled to 44.1 kHz,
 * dithered to 24 bits and appended to the take, so a take is never held in memory, however long the set. The appends
 * are chained: one is issued when the one before it has finished, so the chunks are stored in the order the blocks
 * came, and after the first failure nothing more is appended (a take with a hole in the middle is worse than a short
 * one: the stored bytes always match the frame count the take ends with). The take's own dither stream and resampler
 * live in a `Pcm24Stream`, one per take.
 *
 * Stopping (`stop`): the engine posts the last, partial block while it handles `recorder off`, and every message after
 * it (the next status among them) arrives later. Messages from the audio thread arrive in order, so the end is told
 * from the statuses:
 *  - the recorder must have been seen running (a status with `recorderFrames`) before `off` is sent. Until the worklet
 *    has heard `on`, the statuses in flight show it off, and would be taken for the answer to a command it has not
 *    heard yet. A stop right after a start therefore waits for that first running status;
 *  - then the answer is the first status that shows the recorder off with a frame no earlier than the last status seen
 *    when `off` was sent. A null status from before cannot end the wait early and cost the last block.
 *  If the engine is not answering at all (a suspended context) the whole wait gives up after `settleMs`, and the take is
 *  finished with what it has.
 *
 * Ending a take without the engine's help:
 *  - `halt()` ends the take at once (flush, finish) without waiting for any status. The app shell calls it when the
 *    audio thread has stopped or been interrupted (the host reports `needsResume`): a `stop()` then would only wait
 *    out `settleMs` for statuses that will not come, and REC would stay lit meanwhile. The take keeps everything
 *    received so far.
 *  - the stall watchdog calls it by itself when a take is running and no status has arrived for `stallMs` (1.5 s).
 *    A page that was itself blocked or throttled (a long render, a hidden tab) is not taken for a dead engine: a
 *    check that runs much later than due only restarts the count.
 *  - the shell should `await recorder.stop()` before it tears the engine down (POWER off), so the take is completed.
 */

import type { EngineLike } from '../control/controller';
import type { EngineEvent, EngineStatus } from '../shared/protocol';
import type { Takes } from '../storage/takes';
import { Pcm24Stream } from './encode';

/** How long `stop` waits for the engine's last block before finishing without it. */
export const STOP_SETTLE_MS = 1000;
/** A running take is halted when the engine has posted no status for this long. */
export const STALL_MS = 1500;

export type HaltReason = 'requested' | 'stalled';

export type RecorderEvent =
  | { kind: 'start' }
  /** The take is being ended without the engine's help (`halt`, or the stall watchdog); `stop` follows. */
  | { kind: 'halted'; reason: HaltReason }
  /** The take is finished and stored under `takeId`. */
  | { kind: 'stop'; takeId: number }
  /** Storing failed (QuotaError: the disk is full). The recorder is already stopping; `stop` follows. */
  | { kind: 'error'; error: unknown };

export interface RecorderOptions {
  settleMs?: number;
  stallMs?: number;
}

export type RecorderState = 'idle' | 'starting' | 'recording' | 'stopping';

export class Recorder {
  private _state: RecorderState = 'idle';
  private takeId = 0;
  private stream: Pcm24Stream | null = null;
  private unsubscribe: (() => void) | null = null;
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<number> | null = null;
  /** The appends so far, one after the other; it never rejects (a failure is recorded in `failedAt`). */
  private chain: Promise<void> = Promise.resolve();
  /** Frames stored before the append that failed; null while all went well. Nothing is appended after a failure. */
  private failedAt: number | null = null;
  private readonly listeners = new Set<(e: RecorderEvent) => void>();
  private readonly settleMs: number;
  private readonly stallMs: number;
  private readonly checkMs: number;

  // What the statuses of this take have shown.
  private sawRunning = false;
  private lastFrame: number | null = null;
  private lastStatusAt = 0;
  private lastCheck = 0;
  private watchdog: ReturnType<typeof setInterval> | undefined;
  /** `halt` was called: the waits for the engine are skipped. */
  private halted = false;
  private cancelWait: (() => void) | null = null;

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
    this.stallMs = opts.stallMs ?? STALL_MS;
    this.checkMs = Math.max(10, Math.round(this.stallMs / 3));
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

  /** Tells `fn` when a take starts, is halted, stops, or fails. Returns the function that stops the telling. */
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
    return this.beginStop(true);
  }

  /**
   * Ends the take now, without waiting for the engine (see the header): for an engine that has stopped or been
   * interrupted. Resolves with the take's id, or null when no take was running. A `stop` that is already waiting for
   * the engine is cut short.
   */
  halt(reason: HaltReason = 'requested'): Promise<number | null> {
    switch (this._state) {
      case 'idle':
        return Promise.resolve(null);
      case 'starting':
        return this.startPromise!.then(
          () => this.halt(reason),
          () => null,
        );
      case 'stopping':
        this.halted = true;
        this.cancelWait?.();
        return this.stopPromise!;
      case 'recording':
        this.halted = true;
        this.emit({ kind: 'halted', reason });
        return this.beginStop(false);
    }
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
    this.chain = Promise.resolve();
    this.sawRunning = false;
    this.lastFrame = null;
    this.halted = false;
    this.unsubscribe = this.engine.on((e) => this.onEngineEvent(e));
    this.lastStatusAt = this.lastCheck = performance.now();
    this.watchdog = setInterval(() => this.checkStall(), this.checkMs);
    this._state = 'recording';
    this.engine.send({ t: 'recorder', on: true });
    this.emit({ kind: 'start' });
  }

  private beginStop(settle: boolean): Promise<number> {
    this._state = 'stopping';
    const p = this.finish(settle);
    this.stopPromise = p;
    const clear = (): void => {
      if (this.stopPromise === p) this.stopPromise = null;
    };
    p.then(clear, clear);
    return p;
  }

  private async finish(settle: boolean): Promise<number> {
    const id = this.takeId;
    const stream = this.stream!;
    clearInterval(this.watchdog);
    this.watchdog = undefined;
    try {
      if (settle) await this.endWithEngine();
      else this.engine.send({ t: 'recorder', on: false });

      this.unsubscribe?.(); // the last block (still delivered to onEngineEvent) is in by now
      this.unsubscribe = null;
      this.append(stream.flush());
      await this.chain;

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

  /** Sends `off` at the right moment and waits for the last block, within `settleMs` in all (see the header). */
  private async endWithEngine(): Promise<void> {
    const deadline = performance.now() + this.settleMs;
    if (!this.sawRunning) await this.waitForStatus((s) => s.recorderFrames !== null, deadline); // `on` heard
    const offFrame = this.lastFrame;
    const answered = this.waitForStatus((s) => s.recorderFrames === null && (offFrame === null || s.frame >= offFrame), deadline);
    this.engine.send({ t: 'recorder', on: false });
    await answered;
  }

  /** Resolves true on the first status that `match`es, false at `deadline` (or at once after a halt). */
  private waitForStatus(match: (s: EngineStatus) => boolean, deadline: number): Promise<boolean> {
    return new Promise((resolve) => {
      const left = deadline - performance.now();
      if (this.halted || left <= 0) return resolve(false);
      let off: (() => void) | null = null;
      const done = (hit: boolean): void => {
        clearTimeout(timer);
        off?.();
        this.cancelWait = null;
        resolve(hit);
      };
      const timer = setTimeout(() => done(false), left);
      off = this.engine.on((e) => {
        if (e.t === 'status' && match(e.status)) done(true);
      });
      this.cancelWait = () => done(false);
    });
  }

  private onEngineEvent(e: EngineEvent): void {
    if (e.t === 'status') {
      this.lastStatusAt = performance.now();
      this.lastFrame = e.status.frame;
      if (e.status.recorderFrames !== null) this.sawRunning = true;
      return;
    }
    if (e.t !== 'recorderBlock' || !this.stream) return;
    this.append(this.stream.push(e.L, e.R));
  }

  /** The audio thread has gone quiet: halt. A check that itself ran late means the page was busy, so statuses may be queued. */
  private checkStall(): void {
    if (this._state !== 'recording') return;
    const now = performance.now();
    const late = now - this.lastCheck - this.checkMs;
    this.lastCheck = now;
    if (late > this.checkMs / 2) {
      this.lastStatusAt = now; // the page was blocked or throttled: give the queued statuses a chance to show up
      return;
    }
    if (now - this.lastStatusAt > this.stallMs) this.halt('stalled').catch(() => {});
  }

  /** Queues `bytes` (the end of the stream so far) behind the appends before it; a failure ends the take. */
  private append(bytes: Uint8Array): void {
    if (bytes.length === 0 || this.failedAt !== null || !this.stream) return;
    const id = this.takeId;
    const before = this.stream.frames - bytes.length / 6;
    this.chain = this.chain.then(async () => {
      if (this.failedAt !== null) return; // an earlier append failed: nothing after it is stored
      try {
        await this.takes.append(id, bytes);
      } catch (err) {
        this.onAppendFailed(before, err);
      }
    });
  }

  private onAppendFailed(framesBefore: number, err: unknown): void {
    this.failedAt = framesBefore;
    this.noteFailure(err);
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
