/**
 * The looper core: five tracks, the transport and loop sync, the settings, and a queue of timed commands applied at
 * exact frames inside each render block. Pure TypeScript with no browser APIs; the engine runs it inside an AudioWorklet
 * and the tests run it sample by sample in Node.
 *
 * Presses that wait for a measure line (QUANTIZE, LOOP SYNC MODE MEASURE) are not queued commands: each track holds
 * its own armed slot and fires it at the exact frame as it renders (see track.ts), so the queue only ever holds
 * presses dated by the caller. The one exception is a PLAY MODE SINGLE start, which stops the other SINGLE tracks:
 * the block is split at its frame and it fires before any track renders that frame, so they stop on it exactly.
 *
 * ALL START/STOP, the SINGLE change and MEMORY FULL's reclaiming of undo history span tracks, so they live here.
 *
 * `process` allocates nothing apart from the tracks' 1-second recording chunks. Command and settings handling may
 * allocate a little (a fresh take shell when a track is cleared, the undo history's snapshots), but only once per user
 * action.
 */
import { ChunkPool } from './chunks';
import { Transport } from './transport';
import { xfadeFrames } from './fade';
import { LoopSync } from './sync';
import { Track } from './track';
import type { ArmUnit, SnapSlot, TrackHost } from './track';
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
/** The order in which undo history gives way when the memory budget runs out: the least useful first. */
const RECLAIM_ORDER: readonly SnapSlot[] = ['redo', 'mark', 'recBack', 'undo'];

export class LooperCore {
  /** The five tracks, in order. Exposed for the engine's later tasks and for tests. */
  readonly tracks: readonly Track[];

  private readonly budget: number;
  private readonly pool: ChunkPool;
  private readonly transport: Transport;
  private readonly sync: LoopSync;
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
    this.sync = new LoopSync(this.transport);
    // Guide defaults until the engine hands over the real settings.
    this.memory = defaultMemory();
    this.system = defaultSystem();
    this.applyTransportSettings(0);

    const core = this; // the host's getter reads the live settings
    const host: TrackHost = {
      sr: cfg.sampleRate,
      xfade: xfadeFrames(cfg.sampleRate),
      pool: this.pool,
      transport: this.transport,
      sync: this.sync,
      get memory(): MemorySettings {
        return core.memory;
      },
      post: (msg) => this.post(msg),
      audioChanged: () => {
        this.audioDirty = true;
      },
      singleChange: (self, now) => this.singleChange(self, now),
      singleStarted: (self) => this.singleStarted(self),
    };
    this.tracks = TRACKS.map((i) => new Track(i, host));
    this.sync.attach(this.tracks);
    this.pool.reclaim = () => this.reclaim();
  }

  /** The timeline frame at the start of the next block. */
  get frame(): number {
    return this._frame;
  }

  /**
   * Take new settings. Tracks read them live; the tempo and beat go to the transport, keeping the musical position.
   *
   * The memory stores the tempo at 0.1 BPM, so a derived tempo (128.4453 from a first synced loop) comes back in later
   * pushes as 128.4. A memory tempo within 0.05 of the transport tempo rounded to 0.1 is that same tempo and is not
   * re-applied (controller ruling R31); any other value is a real change and is applied. The caller should still copy
   * `status().tempo` into the memory it sends, or a stale memory tempo puts the old tempo back.
   */
  setSettings(memory: MemorySettings, system: SystemSettings): void {
    this.applySettings(memory, system, this._frame);
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
    if (this.queueLength === QUEUE_CAPACITY) this.apply(this.dequeue(), this._frame);
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
      // A SINGLE start due here fires before any track renders this frame (it stops the other SINGLE tracks).
      for (let i = 0; i < tracks.length; i++) tracks[i].fireSingleStart(this._frame + pos);
      let end = n;
      if (this.queueLength > 0) end = Math.min(n, this.queueAt[0] - this._frame);
      for (let i = 0; i < tracks.length; i++) {
        const due = tracks[i].singleArmFrame - this._frame;
        if (due > pos && due < end) end = due;
      }
      for (let i = 0; i < tracks.length; i++) {
        const o = out.tracks[i];
        tracks[i].render(inL, inR, o[0], o[1], pos, end, this._frame);
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
      rhythm: this.sync.rhythm,
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

  /** Track `i`'s loop, or null when it has none. A free loop reports the memory tempo when its recording ended. */
  getTrackAudio(i: TrackIndex): TrackAudio | null {
    return this.tracks[i]?.audio() ?? null;
  }

  /** Load (or with null, empty) track `i`. A loaded track is stopped. MEMORY FULL leaves it empty. */
  setTrackAudio(i: TrackIndex, a: TrackAudio | null): void {
    this.tracks[i]?.load(a);
  }

  /** Apply `cmd` at timeline frame `now`. */
  private apply(cmd: EngineCommand, now: number): void {
    switch (cmd.t) {
      case 'recPlay':
        this.tracks[cmd.track]?.recPlay(now);
        return;
      case 'stop':
        this.tracks[cmd.track]?.stop();
        return;
      case 'clear':
        this.tracks[cmd.track]?.clear();
        return;
      case 'clearAll':
        for (let i = 0; i < this.tracks.length; i++) this.tracks[i].clear();
        return;
      case 'interrupt':
        for (let i = 0; i < this.tracks.length; i++) this.tracks[i].interrupt();
        return;
      case 'tempo':
        this.sync.retime(cmd.bpm, this.transport.beat, now);
        return;
      case 'rhythmStartStop':
        this.sync.toggleRhythm(now);
        return;
      case 'settings':
        this.applySettings(cmd.memory, cmd.system, now);
        return;
      case 'loadTrack':
        this.setTrackAudio(cmd.track, cmd.audio);
        return;
      case 'latency':
        this.setLatency(cmd.roundTripFrames, cmd.outputLatencyFrames);
        return;
      case 'speedMoment':
        this.tracks[cmd.track]?.speedMoment(cmd.speed);
        return;
      case 'undoRedo':
        this.tracks[cmd.track]?.undoRedo();
        return;
      case 'markSet':
        this.tracks[cmd.track]?.markSet();
        return;
      case 'markClear':
        this.tracks[cmd.track]?.markClear();
        return;
      case 'markBack':
        this.tracks[cmd.track]?.markBack();
        return;
      case 'recBack':
        this.tracks[cmd.track]?.recBack();
        return;
      case 'allStartStop':
        this.allStartStop(now);
        return;
      // Engine-only, handled outside the core: fader (the mixer), exportTracks, recorder, calibrate.
      default:
        return;
    }
  }

  /**
   * ALL START/STOP at `now` (Owner's Manual p. 4). If any track is recording, playing or overdubbing, or has a start
   * or recording armed (ruling R61), every track stops: a recording or pass ends first, then STOP MODE applies, and
   * armed actions are cancelled. Otherwise the tracks
   * set in ALL START TRK that hold a loop start together: at once, or, when one of them would wait for a line (LOOP
   * SYNC MODE MEASURE or LOOP LENGTH with the grid running), all of them at the latest such line.
   *
   * INFERRED: with PLAY MODE SINGLE only one SINGLE track can play, so only one of them starts: the current track when
   * it is one, otherwise the first. (ALL STOP TRK is for MIDI stop, phase 4; this button stops every track.)
   */
  private allStartStop(now: number): void {
    const tracks = this.tracks;
    for (let i = 0; i < tracks.length; i++) {
      if (!tracks[i].running && !tracks[i].armed) continue;
      for (let j = 0; j < tracks.length; j++) tracks[j].allStop();
      return;
    }
    const play = this.memory.play;
    let single = -1;
    for (let i = 0; i < tracks.length; i++) {
      if (play.allStartTrk[i] !== true || tracks[i].state !== 'stopped' || !this.isSingle(i)) continue;
      if (single < 0 || i === play.currentTrack) single = i;
    }
    let at = now;
    let unit: ArmUnit = 'measure';
    for (let i = 0; i < tracks.length; i++) {
      if (!this.allStarts(i, single)) continue;
      const line = tracks[i].startLine(now);
      if (line > at) {
        at = line;
        unit = tracks[i].lineUnit;
      }
    }
    for (let i = 0; i < tracks.length; i++) if (this.allStarts(i, single)) tracks[i].allStart(now, at, unit);
  }

  /** Whether ALL START starts track `i` (`single`: the one SINGLE track that may start, or -1). */
  private allStarts(i: number, single: number): boolean {
    return this.memory.play.allStartTrk[i] === true && this.tracks[i].state === 'stopped' && (!this.isSingle(i) || i === single);
  }

  private isSingle(i: number): boolean {
    return this.memory.track[i]?.playMode === 'SINGLE';
  }

  /**
   * S.TRK CHANGE (Parameter Guide p. 4): where `self` takes over from the other SINGLE tracks playing. IMMEDIATE: at
   * once (with LOOP SYNC MODE MEASURE the start itself waits for the measure line, and the change with it); LOOP END:
   * when the first of them reaches its loop end; MEASURE: at the next measure line. `now` when none is playing.
   */
  private singleChange(self: Track, now: number): number {
    const tracks = this.tracks;
    let end = Infinity;
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      if (t === self || !this.isSingle(i) || (t.state !== 'playing' && t.state !== 'overdubbing')) continue;
      end = Math.min(end, t.framesToLoopEnd);
    }
    if (end === Infinity) return now;
    switch (this.memory.play.sTrkChange) {
      case 'LOOP END':
        return now + end;
      case 'MEASURE':
        return this.sync.boundary(now, this.sync.measure());
      default:
        return now;
    }
  }

  /** PLAY MODE SINGLE: `self` started, so every other SINGLE track that is playing stops (Parameter Guide p. 2). */
  private singleStarted(self: Track): void {
    const tracks = this.tracks;
    for (let i = 0; i < tracks.length; i++) if (tracks[i] !== self && this.isSingle(i)) tracks[i].yieldToSingle();
  }

  /**
   * The pool's budget has run out: undo history gives way before anything is refused (INFERRED: the history is a
   * convenience, the performance is not). One snapshot per call, in RECLAIM_ORDER across the tracks: first those that
   * alone hold some chunk (letting go of them frees memory), then any (snapshots that share chunks only with each
   * other). False when no snapshot holding audio is left.
   */
  private reclaim(): boolean {
    const tracks = this.tracks;
    for (let pass = 0; pass < 2; pass++) {
      for (let k = 0; k < RECLAIM_ORDER.length; k++) {
        for (let i = 0; i < tracks.length; i++) if (tracks[i].dropHistory(RECLAIM_ORDER[k], pass === 0)) return true;
      }
    }
    return false;
  }

  /** Apply, in order, every queued command dated at or before `frame`. */
  private applyDue(frame: number): void {
    while (this.queueLength > 0 && this.queueAt[0] <= frame) this.apply(this.dequeue(), frame);
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

  private applySettings(memory: MemorySettings, system: SystemSettings, now: number): void {
    this.memory = memory;
    this.system = system;
    this.applyTransportSettings(now);
  }

  /** The memory tempo and beat, applied at `frame` without moving the musical position (armed actions follow). */
  private applyTransportSettings(frame: number): void {
    const bpm = this.transport.bpm;
    const tempo = this.memory.tempo;
    // R31: the transport's own tempo at the memory's 0.1 BPM step is not a change.
    const same = Math.abs(tempo - Math.round(bpm * 10) / 10) < 0.05;
    this.sync.retime(same ? bpm : tempo, this.memory.rhythm.beat, frame);
  }
}
