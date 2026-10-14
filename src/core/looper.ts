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
 * Task 9 adds, each in its own module where it can be:
 *  - the GUIDE click (guide.ts) on `out.click` while the rhythm is on (RHYTHM START/STOP cycles off -> on -> off; the
 *    phase 3 rhythm adds standby);
 *  - each track's input (inputs.ts): its INPUT routing (MIC 1, RHYTHM when RHYTHM OUT is LOOP) and BOUNCE;
 *  - AUTO REC: the core listens to the mic for each waiting track and starts it on the frame the input reaches SENS;
 *  - the latency pipeline: a command is applied when it arrives (or at its frame, if that is later) but counts as heard
 *    at `at` (or, undated, at frame - outputLatencyFrames); the tracks write the input arriving at frame f where the
 *    timeline was at f - roundTripFrames (track.ts). The rhythm bus and BOUNCE's playback reach the inputs through
 *    delay rings of the same round trip.
 *
 * `process` allocates nothing apart from the tracks' 1-second recording chunks. Command and settings handling may
 * allocate a little (a fresh take shell when a track is cleared, the undo history's snapshots), but only once per user
 * action.
 */
import { ChunkPool } from './chunks';
import { GuideClick } from './guide';
import { InputRouter } from './inputs';
import { Transport } from './transport';
import { xfadeFrames } from './fade';
import { LoopSync } from './sync';
import { Track } from './track';
import type { ArmUnit, TrackHost } from './track';
import type { SnapSlot } from './history';
import { defaultMemory } from '../schema/memory';
import { defaultSystem } from '../schema/system';
import type { MemorySettings, SystemSettings } from '../schema/types';
import { TRACKS } from '../shared/ids';
import type { TrackIndex } from '../shared/ids';
import type { EngineCommand, EngineMessage, EngineStatus, TrackAudio } from '../shared/protocol';

export interface CoreConfig {
  sampleRate: number;
  memoryBudgetBytes: number;
  /**
   * Read loaded audio in place instead of copying it into the pool (`AudioTake.view`): for an offline render
   * (renderMix), whose arrays outlive the core and whose loops only play. Off for the engine.
   */
  inPlaceLoads?: boolean;
}

/** Per-track stereo output (after PLAY LEVEL, PAN and the start/stop fades) and the GUIDE click (the rhythm bus). */
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
/** INFERRED: the longest round trip taken, in seconds (a Bluetooth headset is a few hundred ms). */
const MAX_LATENCY_SECONDS = 1;
/** AUTO REC: SENS 1-100 maps to an input peak of SENS / 100 x this (INFERRED: SENS 50 is -12 dBFS, SENS 100 -6 dBFS). */
const AUTO_REC_FULL_SCALE = 0.5;

/** A latency in whole frames, 0..max: anything not a positive number is 0. */
function latencyFrames(v: number, max: number): number {
  return Number.isFinite(v) && v > 0 ? Math.min(max, Math.round(v)) : 0;
}

export class LooperCore {
  /** The five tracks, in order. Exposed for the engine's later tasks and for tests. */
  readonly tracks: readonly Track[];

  private readonly budget: number;
  private readonly pool: ChunkPool;
  private readonly transport: Transport;
  private readonly sync: LoopSync;
  private memory: MemorySettings;
  /** For the input routing (RHYTHM OUT). */
  private system: SystemSettings;
  private _frame = 0;
  /**
   * The latency pipeline: the round trip (input arriving at frame f was heard at f - roundTripFrames) and the output
   * latency (an undated command was heard at frame - outputLatencyFrames), in frames.
   */
  private roundTripFrames = 0;
  private outputLatencyFrames = 0;
  private readonly maxLatency: number;
  /** What the tracks read as `host.lead`: the round trip, or while a command applies, its own (see TrackHost). */
  private lead = 0;

  /** Commands sorted by frame; equal frames keep arrival order. Each keeps the frame it was heard at. */
  private readonly queueAt = new Float64Array(QUEUE_CAPACITY);
  private readonly queueHeard = new Float64Array(QUEUE_CAPACITY);
  private readonly queueCmd: (EngineCommand | null)[] = new Array<EngineCommand | null>(QUEUE_CAPACITY).fill(null);
  private queueLength = 0;
  /** The heard frame of the command `dequeue` just returned. */
  private dueHeard = 0;

  private readonly click: GuideClick;
  private readonly router: InputRouter;
  /** The input the next track renders with (`route`), and which tracks render after the others this span. */
  private inSelL: Float32Array;
  private inSelR: Float32Array;
  private readonly late: Uint8Array;

  private readonly messages: EngineMessage[] = new Array<EngineMessage>(MESSAGE_CAPACITY).fill('MEMORY FULL');
  private messageCount = 0;
  private audioDirty = false;

  constructor(cfg: CoreConfig) {
    this.budget = cfg.memoryBudgetBytes;
    this.pool = new ChunkPool(cfg.sampleRate, cfg.memoryBudgetBytes);
    this.transport = new Transport(cfg.sampleRate);
    this.sync = new LoopSync(this.transport);
    this.maxLatency = Math.round(MAX_LATENCY_SECONDS * cfg.sampleRate);
    this.click = new GuideClick(cfg.sampleRate);
    this.router = new InputRouter(TRACKS.length, this.maxLatency);
    this.inSelL = this.router.silence;
    this.inSelR = this.router.silence;
    this.late = new Uint8Array(TRACKS.length);
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
      get lag(): number {
        return core.roundTripFrames;
      },
      get lead(): number {
        return core.lead;
      },
      inPlaceLoads: cfg.inPlaceLoads === true,
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

  /**
   * The latency pipeline's figures, in frames (whole, 0 up to a second; anything else counts as 0): the round trip
   * (the engine's calibrated SETUP LATENCY, or its estimate) and the output latency. Recordings and overdubs then
   * write the input arriving at frame f where the timeline was at f - roundTripFrames (see track.ts), and an undated
   * command counts as heard at frame - outputLatencyFrames.
   */
  setLatency(roundTripFrames: number, outputLatencyFrames: number): void {
    this.roundTripFrames = latencyFrames(roundTripFrames, this.maxLatency);
    this.outputLatencyFrames = latencyFrames(outputLatencyFrames, this.maxLatency);
    this.lead = this.roundTripFrames;
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
    const dated = at !== null && at !== undefined && Number.isFinite(at);
    const f = dated ? Math.round(at) : this._frame;
    // The latency pipeline: when the press was heard, for what it records (`at`, or what was playing out just now).
    const heard = dated ? f : this._frame - this.outputLatencyFrames;
    if (this.queueLength === QUEUE_CAPACITY) this.apply(this.dequeue(), this._frame, this.dueHeard);
    let i = this.queueLength;
    while (i > 0 && this.queueAt[i - 1] > f) {
      this.queueAt[i] = this.queueAt[i - 1];
      this.queueHeard[i] = this.queueHeard[i - 1];
      this.queueCmd[i] = this.queueCmd[i - 1];
      i--;
    }
    this.queueAt[i] = f;
    this.queueHeard[i] = heard;
    this.queueCmd[i] = cmd;
    this.queueLength++;
    this.applyDue(this._frame);
  }

  /**
   * Render `n` frames. Commands due inside the block are applied at their exact frame, splitting the block there, and
   * so is an AUTO REC trigger. `inL`/`inR` is the mic (the MIC 1 route); `rhythmL`/`rhythmR` an external rhythm for the
   * RHYTHM route (silent in phase 1: the GUIDE click is the core's own, in `out.click`, and reaches that route too).
   */
  process(
    inL: Float32Array,
    inR: Float32Array,
    rhythmL: Float32Array,
    rhythmR: Float32Array,
    out: CoreOutput,
    n: number,
  ): void {
    const tracks = this.tracks;
    const router = this.router;
    router.ensure(n, this.roundTripFrames);
    let pos = 0;
    while (pos < n) {
      const f = this._frame + pos;
      this.applyDue(f);
      // A SINGLE start due here fires before any track renders this frame (it stops the other SINGLE tracks).
      for (let i = 0; i < tracks.length; i++) tracks[i].fireSingleStart(f);
      let end = n;
      if (this.queueLength > 0) end = Math.min(n, this.queueAt[0] - this._frame);
      for (let i = 0; i < tracks.length; i++) {
        const due = tracks[i].singleArmFrame - this._frame;
        if (due > pos && due < end) end = due;
      }
      end = this.autoRec(inL, inR, pos, end);
      // The GUIDE click, and the rhythm bus that RHYTHM-routed tracks record.
      this.click.render(this.transport, f, end - pos, out.click[0], out.click[1], pos);
      router.pushRhythm(f, out.click[0], out.click[1], rhythmL, rhythmR, pos, end);
      // Tracks that record others' playback (BOUNCE) render after the rest, so that playback is there to record.
      const late = this.late;
      for (let i = 0; i < tracks.length; i++) late[i] = tracks[i].wantsInput && this.bounces(i) ? 1 : 0;
      for (let pass = 0; pass < 2; pass++) {
        for (let i = 0; i < tracks.length; i++) {
          if (late[i] !== pass) continue;
          const o = out.tracks[i];
          this.route(i, inL, inR, pos, end, f);
          tracks[i].render(this.inSelL, this.inSelR, o[0], o[1], pos, end, this._frame);
          router.pushTrack(i, f, o[0], o[1], pos, end);
        }
      }
      pos = end;
    }
    this._frame += n;
    this.applyDue(this._frame); // commands landing exactly on the next block's first frame
  }

  /**
   * AUTO REC: a waiting track starts recording on the first frame of `[pos, end)` where the mic reaches its SENS
   * (either sign, either channel; the mic, not what BOUNCE would add: the guide's "input from the mic or guitar"). A
   * trigger at `pos` starts it now; a later one ends the span there. Returns the span's end.
   */
  private autoRec(inL: Float32Array, inR: Float32Array, pos: number, end: number): number {
    const tracks = this.tracks;
    // INFERRED: the guide gives SENS 1-100 and no level; SENS / 100 x 0.5 of full scale.
    const thr = (this.memory.rec.autoRecSens / 100) * AUTO_REC_FULL_SCALE;
    for (let i = 0; i < tracks.length; i++) {
      if (!tracks[i].autoRecWaiting) continue;
      let k = pos;
      while (k < end && !(inL[k] >= thr || inL[k] <= -thr || inR[k] >= thr || inR[k] <= -thr)) k++;
      if (k === end) continue;
      if (k > pos) {
        end = k;
        continue;
      }
      // The frame arriving now is the loop's first: no input of it was heard before the start.
      this.lead = 0;
      try {
        tracks[i].autoRecStart(this._frame + pos);
      } finally {
        this.lead = this.roundTripFrames;
      }
    }
    return end;
  }

  /** Track `i` records the playback of other tracks: its BOUNCE IN, or BOUNCE SW. */
  private bounces(i: number): boolean {
    return this.memory.track[i]?.bounceIn === true || this.memory.rec.bounceSw === true;
  }

  /**
   * Pick track `i`'s input for `[a, b)` (timeline frame `f` at `a`) into `inSelL`/`inSelR`: the mic as it is when the
   * track routes only MIC 1, silence when it routes nothing, else a mix the router builds (see inputs.ts). A track
   * that writes nothing in the span gets the mic, unused.
   */
  private route(i: number, inL: Float32Array, inR: Float32Array, a: number, b: number, f: number): void {
    this.inSelL = inL;
    this.inSelR = inR;
    const cfg = this.memory.track[i];
    if (cfg === undefined || !this.tracks[i].wantsInput) return;
    const mic = cfg.input.MIC1 !== false;
    const rhythm = cfg.input.RHYTHM === true && this.system.output.routing.rhythmOut === 'LOOP';
    let sources = 0;
    if (this.bounces(i)) {
      const sel = this.memory.rec.bounceTrack;
      for (let j = 0; j < this.tracks.length; j++) if (j !== i && sel[j] === true) sources |= 1 << j;
    }
    if (!rhythm && sources === 0) {
      if (!mic) {
        this.inSelL = this.router.silence;
        this.inSelR = this.router.silence;
      }
      return;
    }
    this.router.build(i, f, a, b, this.roundTripFrames, mic, inL, inR, rhythm, sources);
    this.inSelL = this.router.inputL(i);
    this.inSelR = this.router.inputR(i);
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

  /**
   * Load (or with null, empty) track `i`. A loaded track is stopped. MEMORY FULL leaves it empty. With no track
   * running, the transport may then take a loaded loop's exact tempo (`snapToLoops`, ruling R65).
   */
  setTrackAudio(i: TrackIndex, a: TrackAudio | null): void {
    this.loadTrack(i, a, this._frame);
  }

  /**
   * Offline renders only (LOOP MIX, ruling R64): start stopped track `i` playing at once from take position `pos` (see
   * `Track.startAt`). The engine never calls this; a live start is a `recPlay`.
   */
  startTrackAt(i: TrackIndex, pos: number): void {
    this.tracks[i]?.startAt(pos);
  }

  /**
   * Apply `cmd` at timeline frame `now`. It was heard at `heard` (<= now): the tracks' `lead` is how much of the input
   * from now on still belongs to before it (the latency pipeline), 0 when it was heard a round trip or more ago.
   */
  private apply(cmd: EngineCommand, now: number, heard: number): void {
    const rt = this.roundTripFrames;
    const lead = heard + rt - now;
    this.lead = lead < 0 ? 0 : lead > rt ? rt : lead;
    try {
      this.applyCommand(cmd, now);
    } finally {
      this.lead = this.roundTripFrames;
    }
  }

  private applyCommand(cmd: EngineCommand, now: number): void {
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
        this.loadTrack(cmd.track, cmd.audio, now);
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
    while (this.queueLength > 0 && this.queueAt[0] <= frame) {
      const cmd = this.dequeue();
      this.apply(cmd, frame, this.dueHeard);
    }
  }

  private dequeue(): EngineCommand {
    const cmd = this.queueCmd[0]!;
    this.dueHeard = this.queueHeard[0];
    const len = this.queueLength - 1;
    for (let i = 0; i < len; i++) {
      this.queueAt[i] = this.queueAt[i + 1];
      this.queueHeard[i] = this.queueHeard[i + 1];
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
    this.sync.retime(storedAs(tempo, bpm) ? bpm : tempo, this.memory.rhythm.beat, frame);
  }

  private loadTrack(i: TrackIndex, a: TrackAudio | null, now: number): void {
    this.tracks[i]?.load(a);
    this.snapToLoops(now);
  }

  /**
   * Ruling R65 (final review I4): a recalled memory brings its tempo at the 0.1 BPM step it is stored at, while each loop
   * keeps the exact tempo it was recorded at (128.4453 against 128.4). At the stored tempo a synced loop would miss the
   * exact path and play through the stretcher. So once the tracks have loaded and none is running, the transport takes
   * a loaded loop's exact tempo when the memory tempo is its 0.1 BPM copy (R31's own test, so a later settings push of
   * the memory tempo keeps it), and when that keeps more of the loaded loops on the exact path than the tempo it has.
   *
   * The tempo that keeps the most loops exact wins; a tie keeps the transport's tempo, then goes to the loops in track
   * order. So a memory whose first loop set the tempo gets that loop's tempo back (every loop recorded on its grid is
   * exact there), and a typed tempo stays (its grid loops are exact at it, and a loop's own tempo can push the longer
   * ones off). The memory, the LCD and storage keep the 0.1 BPM value. Runs after every load, so the last of a recall's
   * five loads decides; a command-time cost of five tracks by six tempos, no allocation.
   */
  private snapToLoops(frame: number): void {
    const tracks = this.tracks;
    for (let i = 0; i < tracks.length; i++) if (tracks[i].running) return;
    const tempo = this.memory.tempo;
    const current = this.transport.bpm;
    let best = current;
    let most = this.exactCount(current);
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      if (!t.hasLoop) continue;
      const bpm = t.recordedTempo;
      if (bpm === best || !storedAs(tempo, bpm)) continue;
      const n = this.exactCount(bpm);
      if (n > most) {
        best = bpm;
        most = n;
      }
    }
    if (best !== current) this.sync.retime(best, this.transport.beat, frame);
  }

  /** How many of the loaded loops would play on the exact path with the transport at `bpm`. */
  private exactCount(bpm: number): number {
    const tracks = this.tracks;
    let n = 0;
    for (let i = 0; i < tracks.length; i++) if (tracks[i].hasLoop && tracks[i].exactAt(bpm)) n++;
    return n;
  }
}

/** R31: `tempo` (the memory's, at its 0.1 BPM step) is how the memory stores `bpm`, so it is not a different tempo. */
function storedAs(tempo: number, bpm: number): boolean {
  return Math.abs(tempo - Math.round(bpm * 10) / 10) < 0.05;
}
