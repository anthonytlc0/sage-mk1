/**
 * The looper core: five tracks, the transport, the settings, and a queue of timed commands applied at exact frames
 * inside each render block. Pure TypeScript with no browser APIs; the engine runs it inside an AudioWorklet and the
 * tests run it sample by sample in Node.
 *
 * `process` allocates nothing apart from the tracks' 1-second recording chunks. Command and settings handling may
 * allocate a little (a fresh take shell when a track is cleared), but only once per user action.
 */
import { ChunkPool } from './chunks';
import { Transport } from './transport';
import { xfadeFrames } from './fade';
import { Track } from './track';
import type { TrackHost } from './track';
import { defaultMemory } from '../schema/memory';
import { defaultSystem } from '../schema/system';
import type { MemorySettings, SystemSettings } from '../schema/types';
import { TRACKS } from '../shared/ids';
import type { TrackIndex } from '../shared/ids';
import type { EngineCommand, EngineMessage, EngineStatus, TrackAudio } from '../shared/protocol';

export interface CoreConfig {
  sampleRate: number;
  memoryBudgetBytes: number;
}

/** Per-track stereo output (after PLAY LEVEL, PAN and the start/stop fades) and the guide click. */
export interface CoreOutput {
  tracks: [Float32Array, Float32Array][];
  click: [Float32Array, Float32Array];
}

export type CoreStatus = Pick<
  EngineStatus,
  'tempo' | 'beat' | 'beatPhase' | 'measurePhase' | 'rhythm' | 'tracks' | 'memoryBytes' | 'memoryBudget' | 'audioDirty'
>;

/** Pending timed commands. Presses arrive at human speed, so 64 is far more than a block ever holds. */
const QUEUE_CAPACITY = 64;
/** Room for every distinct EngineMessage; repeats of a pending message are dropped. */
const MESSAGE_CAPACITY = 8;

export class LooperCore {
  /** The five tracks, in order. Exposed for the engine's later tasks and for tests. */
  readonly tracks: readonly Track[];

  private readonly budget: number;
  private readonly pool: ChunkPool;
  private readonly transport: Transport;
  private memory: MemorySettings;
  /** Kept for the input routing and the click (Task 9). */
  private system: SystemSettings;
  private _frame = 0;
  /** Round-trip and output latency in frames. Stored now; the latency pipeline (Task 9) uses them. */
  private roundTripFrames = 0;
  private outputLatencyFrames = 0;

  /** Commands sorted by frame; equal frames keep arrival order. */
  private readonly queueAt = new Float64Array(QUEUE_CAPACITY);
  private readonly queueCmd: (EngineCommand | null)[] = new Array<EngineCommand | null>(QUEUE_CAPACITY).fill(null);
  private queueLength = 0;

  private readonly messages: EngineMessage[] = new Array<EngineMessage>(MESSAGE_CAPACITY).fill('MEMORY FULL');
  private messageCount = 0;
  private audioDirty = false;

  constructor(cfg: CoreConfig) {
    this.budget = cfg.memoryBudgetBytes;
    this.pool = new ChunkPool(cfg.sampleRate, cfg.memoryBudgetBytes);
    this.transport = new Transport(cfg.sampleRate);
    // Guide defaults until the engine hands over the real settings.
    this.memory = defaultMemory();
    this.system = defaultSystem();
    this.applyTransportSettings();

    const core = this; // the host's getter reads the live settings
    const host: TrackHost = {
      sr: cfg.sampleRate,
      xfade: xfadeFrames(cfg.sampleRate),
      pool: this.pool,
      transport: this.transport,
      get memory(): MemorySettings {
        return core.memory;
      },
      post: (msg) => this.post(msg),
      audioChanged: () => {
        this.audioDirty = true;
      },
    };
    this.tracks = TRACKS.map((i) => new Track(i, host));
  }

  /** The timeline frame at the start of the next block. */
  get frame(): number {
    return this._frame;
  }

  /** Take new settings. Tracks read them live; the tempo and beat go to the transport. */
  setSettings(memory: MemorySettings, system: SystemSettings): void {
    this.memory = memory;
    this.system = system;
    this.applyTransportSettings();
  }

  setLatency(roundTripFrames: number, outputLatencyFrames: number): void {
    this.roundTripFrames = roundTripFrames;
    this.outputLatencyFrames = outputLatencyFrames;
  }

  /**
   * Apply `cmd` at timeline frame `at` (rounded to a whole frame). Null or undefined means the current frame.
   *
   * A frame inside a later block is queued and applied at exactly that sample. A frame that is now or already past
   * applies at once, which is the same timeline point as the start of the next block, so `status()` reflects every
   * command received so far. Between calls, everything still queued lies in the future.
   *
   * If the queue is full, its earliest command is applied now to make room, so nothing is lost and order is kept
   * (INFERRED: 64 pending commands never happen at human speed).
   */
  command(cmd: EngineCommand, at?: number | null): void {
    const f = at === null || at === undefined || !Number.isFinite(at) ? this._frame : Math.round(at);
    if (this.queueLength === QUEUE_CAPACITY) this.apply(this.dequeue());
    let i = this.queueLength;
    while (i > 0 && this.queueAt[i - 1] > f) {
      this.queueAt[i] = this.queueAt[i - 1];
      this.queueCmd[i] = this.queueCmd[i - 1];
      i--;
    }
    this.queueAt[i] = f;
    this.queueCmd[i] = cmd;
    this.queueLength++;
    this.applyDue(this._frame);
  }

  /**
   * Render `n` frames. Commands due inside the block are applied at their exact frame, splitting the block there.
   * `rhythmL`/`rhythmR` (the click, for the RHYTHM input) are unused until input routing arrives (Task 9).
   */
  process(
    inL: Float32Array,
    inR: Float32Array,
    rhythmL: Float32Array,
    rhythmR: Float32Array,
    out: CoreOutput,
    n: number,
  ): void {
    void rhythmL;
    void rhythmR;
    out.click[0].fill(0, 0, n);
    out.click[1].fill(0, 0, n);
    const tracks = this.tracks;
    let pos = 0;
    while (pos < n) {
      this.applyDue(this._frame + pos);
      let end = n;
      if (this.queueLength > 0) end = Math.min(n, this.queueAt[0] - this._frame);
      for (let i = 0; i < tracks.length; i++) {
        const o = out.tracks[i];
        tracks[i].render(inL, inR, o[0], o[1], pos, end);
      }
      pos = end;
    }
    this._frame += n;
    this.applyDue(this._frame); // commands landing exactly on the next block's first frame
  }

  /**
   * The core's part of the engine status. Each track's `peak` covers the time since the previous call, and
   * `audioDirty` reports whether any track's audio changed (a pass ended, a track was cleared) since then.
   * (INFERRED: both reset on read, so a 60 Hz status poll sees each change once.)
   */
  status(): CoreStatus {
    const t = this.transport;
    const dirty = this.audioDirty;
    this.audioDirty = false;
    return {
      tempo: t.bpm,
      beat: { num: t.beat.num, den: t.beat.den },
      beatPhase: t.beatPhaseAt(this._frame),
      measurePhase: t.measureAt(this._frame).phase,
      rhythm: 'off', // the rhythm flag arrives with loop sync (Task 6)
      tracks: this.tracks.map((tr) => tr.status()),
      memoryBytes: this.pool.usedBytes(),
      memoryBudget: this.budget,
      audioDirty: dirty,
    };
  }

  /** Messages for the LCD raised since the last call, each at most once. */
  takeMessages(): EngineMessage[] {
    const out = this.messages.slice(0, this.messageCount);
    this.messageCount = 0;
    return out;
  }

  /** Track `i`'s loop, or null when it has none. Free loops report the current tempo as their recorded tempo. */
  getTrackAudio(i: TrackIndex): TrackAudio | null {
    return this.tracks[i]?.audio() ?? null;
  }

  /** Load (or with null, empty) track `i`. A loaded track is stopped. MEMORY FULL leaves it empty. */
  setTrackAudio(i: TrackIndex, a: TrackAudio | null): void {
    this.tracks[i]?.load(a);
  }

  private apply(cmd: EngineCommand): void {
    switch (cmd.t) {
      case 'recPlay':
        this.tracks[cmd.track]?.recPlay();
        return;
      case 'stop':
        this.tracks[cmd.track]?.stop();
        return;
      case 'clear':
        this.tracks[cmd.track]?.clear();
        return;
      case 'clearAll':
        for (const tr of this.tracks) tr.clear();
        return;
      case 'interrupt':
        for (const tr of this.tracks) tr.interrupt();
        return;
      case 'tempo':
        this.transport.setTempo(cmd.bpm);
        return;
      case 'settings':
        this.setSettings(cmd.memory, cmd.system);
        return;
      case 'loadTrack':
        this.setTrackAudio(cmd.track, cmd.audio);
        return;
      case 'latency':
        this.setLatency(cmd.roundTripFrames, cmd.outputLatencyFrames);
        return;
      // Not yet: undo/redo, marks and ALL START/STOP (Task 8), speedMoment (Task 7), rhythmStartStop (Task 6).
      // Engine-only, handled outside the core: fader (the mixer), exportTracks, recorder, calibrate.
      default:
        return;
    }
  }

  /** Apply, in order, every queued command dated at or before `frame`. */
  private applyDue(frame: number): void {
    while (this.queueLength > 0 && this.queueAt[0] <= frame) this.apply(this.dequeue());
  }

  private dequeue(): EngineCommand {
    const cmd = this.queueCmd[0]!;
    const len = this.queueLength - 1;
    for (let i = 0; i < len; i++) {
      this.queueAt[i] = this.queueAt[i + 1];
      this.queueCmd[i] = this.queueCmd[i + 1];
    }
    this.queueCmd[len] = null;
    this.queueLength = len;
    return cmd;
  }

  private post(msg: EngineMessage): void {
    for (let i = 0; i < this.messageCount; i++) if (this.messages[i] === msg) return;
    if (this.messageCount < MESSAGE_CAPACITY) this.messages[this.messageCount++] = msg;
  }

  private applyTransportSettings(): void {
    this.transport.setTempo(this.memory.tempo);
    const b = this.memory.rhythm.beat;
    this.transport.beat = { num: b.num, den: b.den };
  }
}
