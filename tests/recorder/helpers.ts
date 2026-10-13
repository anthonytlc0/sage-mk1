import { FakeEngine, makeStatus } from '../../src/control/fakeEngine';
import type { EngineCommand } from '../../src/shared/protocol';
import { StreamingResampler } from '../../src/storage/resample';
import { EXPORT_RATE } from '../../src/shared/constants';

export const BLOCK = 4096;

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** `frames` frames of a sine at `freq` Hz and `sr`, starting at absolute frame `start`; the right channel is half as loud. */
export function sine(frames: number, freq: number, sr: number, start = 0, amp = 0.5): [Float32Array, Float32Array] {
  const L = new Float32Array(frames);
  const R = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const v = amp * Math.sin((2 * Math.PI * freq * (start + i)) / sr);
    L[i] = v;
    R[i] = v / 2;
  }
  return [L, R];
}

/** The engine the recorder talks to: it answers `recorder on` and `off` the way the worklet does. */
export class RecEngine extends FakeEngine {
  /** Frames of the partial block posted when the recorder goes off (0: none). */
  tail = 0;
  /** False: never answer `recorder off` (a suspended audio context). */
  answerOff = true;
  /** False: never answer `recorder on` either (the engine is not running at all). */
  answerOn = true;
  /** The engine's frame counter, as statuses report it. */
  frame = 0;
  private tailAt = 0;
  private readonly sr = 48000;

  emitBlock(L: Float32Array, R: Float32Array): void {
    this.tailAt += L.length;
    this.emit({ t: 'recorderBlock', L, R });
  }

  /** Posts a status; `recorderFrames` null means the recorder is off. */
  status(recorderFrames: number | null, frame = (this.frame += 800)): void {
    this.frame = Math.max(this.frame, frame);
    this.emit({ t: 'status', status: makeStatus({ frame, recorderFrames }) });
  }

  override send(cmd: EngineCommand, eventTime?: number): void {
    super.send(cmd, eventTime);
    if (cmd.t !== 'recorder') return;
    if (cmd.on && this.answerOn) {
      queueMicrotask(() => this.status(0)); // the first status after `on` shows the recorder running
    } else if (!cmd.on && this.answerOff) {
      queueMicrotask(() => {
        if (this.tail > 0) {
          const [L, R] = sine(this.tail, 440, this.sr, this.tailAt);
          this.emitBlock(L, R);
        }
        this.status(null);
      });
    }
  }
}

/**
 * An engine whose worklet is slow to hear its commands: `recorder on` and `off` wait in a queue until `handle()`, as
 * messages do between the main thread and the audio thread. Statuses are posted by hand (`post`), so a test decides
 * which are already in flight when a command is sent.
 */
export class LaggyEngine extends FakeEngine {
  private queued: Extract<EngineCommand, { t: 'recorder' }>[] = [];
  private recOn = false;
  private recFrames = 0;
  private at = 0;
  frame = 0;

  override send(cmd: EngineCommand, eventTime?: number): void {
    super.send(cmd, eventTime);
    if (cmd.t === 'recorder') this.queued.push(cmd);
  }

  /** How many recorder commands the worklet has not heard yet. */
  get waiting(): number {
    return this.queued.length;
  }

  /** The worklet handles the queued commands in order; `off` posts the last, partial block of `tail` frames. */
  handle(tail = 0): void {
    for (const cmd of this.queued.splice(0)) {
      if (cmd.on) {
        this.recOn = true;
        this.recFrames = 0;
      } else {
        if (this.recOn && tail > 0) {
          const [L, R] = sine(tail, 440, 48000, this.at);
          this.emit({ t: 'recorderBlock', L, R });
        }
        this.recOn = false;
      }
    }
  }

  /** The worklet posts a block of the performance. */
  block(frames = BLOCK): void {
    const [L, R] = sine(frames, 440, 48000, this.at);
    this.at += frames;
    this.recFrames += frames;
    this.emit({ t: 'recorderBlock', L, R });
  }

  /** The worklet posts a status with the recorder as it is now; `frame` defaults to a step on. */
  post(frame = (this.frame += 800)): void {
    this.frame = Math.max(this.frame, frame);
    this.emit({ t: 'status', status: makeStatus({ frame, recorderFrames: this.recOn ? this.recFrames : null }) });
  }

  /** A status as it was posted earlier, in flight: its own frame and recorder state, whatever the worklet is now. */
  postStale(recorderFrames: number | null, frame: number): void {
    this.emit({ t: 'status', status: makeStatus({ frame, recorderFrames }) });
  }
}

/** The whole signal through a fresh resampler in one go (the reference for what a streaming encode must equal). */
export function resampleAll(L: Float32Array, R: Float32Array, inRate: number): [Float32Array, Float32Array] {
  const rs = new StreamingResampler(inRate, EXPORT_RATE, 2);
  const [aL, aR] = rs.push(L, R);
  const [bL, bR] = rs.flush();
  const outL = new Float32Array(aL.length + bL.length);
  const outR = new Float32Array(aR.length + bR.length);
  outL.set(aL, 0);
  outL.set(bL, aL.length);
  outR.set(aR, 0);
  outR.set(bR, aR.length);
  return [outL, outR];
}

export async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
