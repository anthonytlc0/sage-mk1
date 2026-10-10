import type { EngineCommand, EngineEvent, EngineStatus, TrackAudio, TrackStatus } from '../shared/protocol';
import type { EngineLike } from './controller';

type CommandOf<T extends EngineCommand['t']> = Extract<EngineCommand, { t: T }>;

/**
 * A stand-in for the audio engine (Task 17) with the same `send`/`on` surface. It records every command and lets a test
 * push engine events with `emit`. `settings` commands are deep-copied when sent, the way the real engine's MessagePort
 * copies them, so a recorded command keeps the values it had at send time.
 *
 * `exportTracks` is answered with a `tracks` event carrying `exportReply` (on a microtask, as the real reply comes
 * later). Set `exportReply = null` to answer by hand with `emit`.
 */
export class FakeEngine implements EngineLike {
  readonly sent: { cmd: EngineCommand; eventTime?: number }[] = [];
  exportReply: (TrackAudio | null)[] | null = [null, null, null, null, null];
  private readonly handlers = new Set<(e: EngineEvent) => void>();

  send(cmd: EngineCommand, eventTime?: number): void {
    const copy = cmd.t === 'settings' ? structuredClone(cmd) : cmd;
    this.sent.push(eventTime === undefined ? { cmd: copy } : { cmd: copy, eventTime });
    const reply = this.exportReply;
    if (cmd.t === 'exportTracks' && reply) {
      const reqId = cmd.reqId;
      queueMicrotask(() => this.emit({ t: 'tracks', reqId, tracks: reply.slice() }));
    }
  }

  on(handler: (e: EngineEvent) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  emit(e: EngineEvent): void {
    for (const h of [...this.handlers]) h(e);
  }

  /** The types of the commands sent so far, in order. */
  types(): EngineCommand['t'][] {
    return this.sent.map((s) => s.cmd.t);
  }

  /** The commands of one type, in order. */
  commands<T extends EngineCommand['t']>(t: T): CommandOf<T>[] {
    return this.sent.map((s) => s.cmd).filter((c): c is CommandOf<T> => c.t === t);
  }

  /** The latest command of one type. */
  last<T extends EngineCommand['t']>(t: T): CommandOf<T> | undefined {
    return this.commands(t).at(-1);
  }

  /** Forgets the recorded commands. */
  reset(): void {
    this.sent.length = 0;
  }
}

/** A TrackStatus for an idle empty track, with `over` applied. */
export function makeTrackStatus(over: Partial<TrackStatus> = {}): TrackStatus {
  return {
    state: 'empty', pending: null, stopping: false, autoRecWaiting: false,
    position: 0, lengthFrames: 0, measures: null, peak: 0,
    canUndo: false, canRedo: false, hasMark: false, speed: 'NORMAL',
    ...over,
  };
}

/** An EngineStatus at 48 kHz, 120 BPM 4/4, five idle tracks; `tracks[i]` is applied to track i. */
export function makeStatus(over: Partial<Omit<EngineStatus, 'tracks'>> = {}, tracks: Partial<TrackStatus>[] = []): EngineStatus {
  return {
    frame: 0, sampleRate: 48000, tempo: 120, beat: { num: 4, den: 4 }, beatPhase: 0, measurePhase: 0,
    rhythm: 'off', inputPeak: 0, outputPeak: 0, memoryBytes: 0, memoryBudget: 384 * 1024 * 1024,
    recorderFrames: null, audioDirty: false,
    ...over,
    tracks: [0, 1, 2, 3, 4].map((i) => makeTrackStatus(tracks[i])),
  };
}
