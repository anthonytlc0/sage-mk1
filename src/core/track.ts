/**
 * One looper track: the state machine of the spec's "Track states" and "Dub modes", its audio (an `AudioTake`), the
 * playhead, loop sync, and the fades and crossfades that keep it click-free.
 *
 * States: empty -> recording -> playing <-> overdubbing, and stopped. REC ACTION picks what ends a recording
 * (REC->PLAY: playback, REC->DUB: overdub). A loop's length is set when its recording ends.
 *
 * Loop sync (LOOP SYNC SW ON; the grid itself is `LoopSync`, see sync.ts):
 *  - With no tempo reference, a recording is "free": the second press sets its length, and its length sets the tempo
 *    (`deriveTempo`) and its start the grid origin.
 *  - With a reference, a recording waits for a measure line when QUANTIZE is MEASURE (or LOOP SYNC MODE is MEASURE
 *    or LOOP LENGTH), and its length snaps to whole measures, or to MEASURE / LOOP LENGTH when they fix it. An early
 *    end press keeps recording to the line; a late one trims the overshoot. A fixed length also ends the recording by
 *    itself when it is reached.
 *  - A start from stopped waits for the next measure (or LOOP LENGTH) line in LOOP SYNC MODE MEASURE (or LOOP LENGTH)
 *    and begins at the phrase position in step with the grid. In IMMEDIATE it starts at once, and SYNC ADJUST snaps it
 *    into step when it is within a measure (or a beat) of a phrase line.
 *  - Waiting actions live in the track's armed slot: one action and its frame. It shows as `pending`, STOP cancels it,
 *    a repeat press while armed does nothing, and a tempo change re-aims it at the same line.
 *
 * Audio order within each frame: the playhead reads the take first (that is the track's output), then the pass and
 * tail writes land. So an overdub is heard from the next time round, REPLACE1 still plays the old audio during the
 * pass, and REPLACE2 mutes the track while it overdubs.
 *
 * Crossfades (5 ms, `host.xfade` frames):
 *  - Loop seam: when a recording ends, the input keeps being written over the start of the loop for 5 ms, fading
 *    from the live input into the recorded audio. The end of the loop runs straight on into that input, so the seam is
 *    continuous on every later pass, forwards or reversed, and an overdub across the seam stays continuous too.
 *    (INFERRED: the crossfade is baked into the take once, rather than applied at every wrap, so overdubs at the
 *    loop start are never faded. Loaded audio gets no seam crossfade; it was baked when first recorded.) A late end
 *    press already holds that input past the loop end, so it is baked from there.
 *  - Overdub punch-in: the input fades in over 5 ms. Punch-out: it keeps being written for 5 ms after the press,
 *    fading out (a "tail"). REPLACE passes crossfade the old audio out and back in the same way.
 *  - REPLACE2 mutes and unmutes the track output over 5 ms.
 *  - Starts ramp in over 5 ms: START MODE IMMEDIATE, and the first playback after a recording.
 *  - Cuts ramp out over 5 ms (controller ruling R20): an IMMEDIATE stop, a second STOP during a FADE/LOOP stop, the end
 *    of a LOOP stop, the end of a 1SHOT, and a clear or load while playing. The state changes at once; a "release"
 *    voice carries on from where the playhead was, fading to silence over 5 ms. It plays a copy of those 5 ms taken
 *    at the cut, so it outlives the take. A 1SHOT retrigger is the same release crossfaded with a ramp-in from the
 *    start.
 *
 * Tempo sync and speed (Parameter Guide p. 3 TEMPO SYNC, p. 4 SPEED CHANGE):
 *  - rate = (TEMPO SYNC SW ? memory tempo / recorded tempo : 1) x {HALF 0.5, NORMAL 1, DOUBLE 2}, read live each step
 *    and clamped to 0.25..4 (TEMPO TOO SLOW / TEMPO TOO FAST). A held SPEED MOMENT overrides the speed. SPEED CHANGE
 *    IMMEDIATE switches at once; LOOP END at the seam.
 *  - A synced loop's recorded tempo is the exact tempo of its whole-frame length (`measures` measures). A tempo change
 *    keeps a playing loop in step (the grid keeps its phase).
 *  - At rate 1 ("exact": the rate is within half a frame per pass of 1, as it is for a synced loop at its own grid
 *    tempo with SPEED NORMAL) the loop plays and overdubs whole frames, sample for sample. A loop whose length is not a
 *    whole number of grid frames is kept on the grid by moving the seam a frame earlier or later now and then
 *    (controller ruling R45), at the crossfaded seam, so it never drifts by a frame.
 *  - At any other rate the playhead is fractional: PITCH reads between samples (resampleRead.ts), XFADE stretches
 *    (timestretch.ts), and an overdub is written at the playhead (PITCH) or time-compressed in splices (XFADE) and
 *    gathered until the read heads have passed (resampleWrite.ts). When the rate comes back to 1, the next seam
 *    returns to the exact path.
 *
 * Undo history (Task 8; Owner's Manual p. 5, Parameter Guide pp. 14-16):
 *  - Each track keeps copy-on-write snapshots of its loop (`Snap`): REC BACK (the loop as its recording left it), the
 *    MARK (`markSet`), and one level each of undo and redo. A recording or an overdub pass sets undo to the loop as it
 *    was before the pass (empty, for a recording) and drops redo. `undoRedo` swaps the loop with undo (which becomes
 *    redo), or back with redo. `markBack` makes the mark (or, with none, REC BACK) the loop and `recBack` REC BACK,
 *    both keeping the loop they replace as undo. Taking a snapshot copies the chunk list, never the audio.
 *  - Any of these during an overdub ends the pass first (with its punch-out fade); during a first recording they do
 *    nothing (INFERRED). A swap while playing crossfades over 5 ms (the release voice and a ramp-in); the playhead
 *    stays where it is. Undoing a first recording empties the track; redo brings the loop back, stopped (INFERRED).
 *  - Writes still in flight when a snapshot is taken or the loop is swapped out (the 5 ms seam crossfade after a
 *    recording, a 5 ms punch-out tail, and at a rate other than 1 the gathered writes that land up to ~129 ms after the
 *    pass) land in every take they belong to: each in-flight write keeps the list of its takes (`Sinks`), and a
 *    snapshot of a take on that list joins it. So REC BACK after REC->DUB holds the whole seam crossfade and none of
 *    the overdub (binding note 1), and a snapshot taken at a punch-out holds the whole pass (note 2). A new pass
 *    first lands what an earlier pass still has gathered (cutting a splatted punch-out tail still running), since the
 *    two would share the gathering ring.
 *  - When the memory budget runs out the history gives way first (the core's `reclaim`), so MEMORY FULL only comes
 *    once nothing is left to give back. Clearing or loading a track drops its history; a loaded loop has no REC BACK.
 *
 * Nothing here allocates while rendering. Scratch buffers are per track; the only allocations are the take's own
 * 1-second chunks while recording (or copy-on-write), a fresh take shell when one is cleared, and the snapshots a
 * recording makes when it ends (ruling R15: once per user action).
 */
import { AudioTake } from './chunks';
import type { ChunkPool } from './chunks';
import { deriveTempo, noteFrames } from './transport';
import type { Transport } from './transport';
import { Ramp, fadeTimeFrames, punchInGain, punchOutGain } from './fade';
import { phraseOffset } from './sync';
import type { LoopSync, SyncTrack } from './sync';
import { readInterpolated } from './resampleRead';
import { SPLAT_MAX_WIDTH, SpliceWriter, SplatWriter } from './resampleWrite';
import { XfadeStretcher } from './timestretch';
import { TEMPO_MAX, TEMPO_MIN } from '../shared/constants';
import type { FadeTime, MeasureSetting, MemorySettings, TrackSettings } from '../schema/types';
import type { TrackIndex } from '../shared/ids';
import type { EngineMessage, TrackAudio, TrackState, TrackStatus } from '../shared/protocol';

/** What a track needs from the core that owns it. */
export interface TrackHost {
  readonly sr: number;
  /** Loop-seam and punch crossfade length in frames (5 ms). */
  readonly xfade: number;
  readonly pool: ChunkPool;
  readonly transport: Transport;
  /** The shared measure grid and the tempo reference. */
  readonly sync: LoopSync;
  /** The current memory settings. Read live, so a change applies from the next frame rendered. */
  readonly memory: MemorySettings;
  post(msg: EngineMessage): void;
  /** The track's audio changed (a pass ended, or it was cleared): the memory's audio is no longer what was saved. */
  audioChanged(): void;
  /**
   * PLAY MODE SINGLE: the frame at which `self`, asked at `now` to start from stopped, takes over from the other
   * SINGLE tracks playing (S.TRK CHANGE LOOP END or MEASURE), or `now` when none plays or the change is IMMEDIATE.
   */
  singleChange(self: Track, now: number): number;
  /** PLAY MODE SINGLE: `self` has just started playing, so the other SINGLE tracks stop. */
  singleStarted(self: Track): void;
}

/** Frames per inner render step, and the size of the scratch buffers. */
const STEP = 256;

/** Playback rates outside this range raise TEMPO TOO SLOW / TEMPO TOO FAST and play at the limit (the brief). */
export const RATE_MIN = 0.25;
export const RATE_MAX = 4;
/** A rate this close to 1 is 1, so float noise between equal tempos keeps a loop on the exact, sample-for-sample path. */
const RATE_EPSILON = 1e-12;
/** TEMPO SYNC SPEED as a rate factor. */
export const SPEED_FACTOR = { HALF: 0.5, NORMAL: 1, DOUBLE: 2 } as const;
type DubMode = TrackSettings['dubMode'];
type Speed = TrackSettings['tempoSyncSpeed'];
/** What follows a recording. */
type EndAction = 'play' | 'dub' | 'stop';
/**
 * The grid an armed action waits on: measure lines, LOOP LENGTH lines, or a fixed frame (a SINGLE track waiting for
 * another's loop end), which a tempo change does not move.
 */
export type ArmUnit = 'measure' | 'loop' | 'fixed';
/** The four history snapshots a track keeps. */
export type SnapSlot = 'undo' | 'redo' | 'mark' | 'recBack';

/** Most takes an in-flight write can land in: the current take and the four history snapshots, with one to spare. */
const SINKS = 6;

/**
 * The takes an in-flight write (a seam or punch-out tail, or a pass's gathered writes) lands in: the take it started
 * in and the snapshots taken of it since. Fixed size; a free slot is null. Writes skip a take the pool has released.
 */
class Sinks {
  readonly takes: (AudioTake | null)[] = new Array<AudioTake | null>(SINKS).fill(null);

  has(t: AudioTake): boolean {
    for (let i = 0; i < SINKS; i++) if (this.takes[i] === t) return true;
    return false;
  }

  add(t: AudioTake): void {
    if (this.has(t)) return;
    for (let i = 0; i < SINKS; i++) {
      if (this.takes[i] === null) {
        this.takes[i] = t;
        return;
      }
    }
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
 * A saved state of the loop: its audio (null: the track was empty) and what goes with it. A slot's take is never the
 * current take, and two slots hold the same take only by holding the same `Snap`.
 */
interface Snap {
  take: AudioTake | null;
  recordedTempo: number;
  measures: number | null;
  loopSeq: number;
}

/**
 * Input still being written after a pass ended: `left` frames from take position `pos`, at a gain falling from 1 to
 * 1/xfade (`punchOutGain`). A `replace` tail crossfades the take's audio back in as the input fades out.
 */
interface Tail {
  pos: number;
  left: number;
  replace: boolean;
  /** The takes it writes to. */
  readonly sinks: Sinks;
}

/**
 * The last 5 ms of playback after a cut: the `left` frames still to play of a copy (`relBufL`/`relBufR`) taken at the
 * cut, at `gain` (the track's fade gain at the cut) times a fall from 1 to 1/xfade.
 */
interface Release {
  left: number;
  gain: number;
}

/**
 * The armed slot: one action waiting for the timeline frame `frame`, re-aimed on the `unit` grid when it moves. 'play'
 * starts in step with the grid; 'start' starts as a press at that frame would (LOOP SYNC rules), for SINGLE changes
 * and ALL START.
 */
interface Arm {
  action: 'rec' | 'play' | 'start' | null;
  frame: number;
  unit: ArmUnit;
}

/**
 * A loop's playback rate (the brief): `(tempoSyncSw ? tempo / recordedTempo : 1) * SPEED_FACTOR[speed]`, before
 * clamping to RATE_MIN..RATE_MAX. Within RATE_EPSILON of 1 it is exactly 1. A recorded tempo that is not a positive
 * number gives no tempo sync.
 */
export function playbackRate(tempoSyncSw: boolean, tempo: number, recordedTempo: number, speed: Speed): number {
  const synced = tempoSyncSw && recordedTempo > 0 && Number.isFinite(recordedTempo);
  const r = (synced ? tempo / recordedTempo : 1) * SPEED_FACTOR[speed];
  return Math.abs(r - 1) < RATE_EPSILON ? 1 : r;
}

/** Reverse samples `[from, from + n)` of `a` in place. */
function reverseInPlace(a: Float32Array, from: number, n: number): void {
  for (let i = from, j = from + n - 1; i < j; i++, j--) {
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
}

export class Track implements SyncTrack {
  readonly index: TrackIndex;
  private readonly host: TrackHost;

  private _take: AudioTake;
  private _state: TrackState = 'empty';
  /** The tempo when the loop was recorded (or the loaded file's), for tempo sync. */
  private _recordedTempo: number;
  /** The loop's length in measures (synced loops), or null (free loops, no loop). */
  private _measures: number | null = null;
  /** When the loop was made (`LoopSync.nextSeq`), for "the first-recorded track". */
  private _loopSeq = 0;
  /** Next take frame to play, in [0, length) whenever the track is playing or overdubbing. */
  private playhead = 0;
  /** A FADE or LOOP stop in progress: the track still plays, and REC/DUB/PLAY is ignored. */
  private stopping: 'FADE' | 'LOOP' | null = null;

  /** An action waiting for a line. */
  private readonly arm: Arm = { action: null, frame: 0, unit: 'measure' };
  /** Timeline frame of the recording's first frame. */
  private recStart = 0;
  /** An end press that is waiting for the recording to reach its snapped length, `recEndMeasures` measures. */
  private recEnd: EndAction | null = null;
  private recEndMeasures = 0;

  /** START MODE fade-in and STOP MODE fade-out gain. */
  private readonly env = new Ramp(1);
  /** Output gain that REPLACE2 takes to 0 while overdubbing. */
  private readonly mute = new Ramp(1);
  /** 5 ms ramp-in of a start that would otherwise step from silence. */
  private readonly attack = new Ramp(1);
  /** The fading tail of playback after a cut or retrigger. */
  private readonly rel: Release = { left: 0, gain: 0 };

  /** DUB MODE of the pass in progress, fixed when it starts. */
  private passMode: DubMode = 'OVERDUB';
  /** Frames since the pass's punch-in, for the punch-in ramp. */
  private passFrames = 0;
  /** The seam crossfade still to write after a recording ended. */
  private readonly recTail: Tail = { pos: 0, left: 0, replace: true, sinks: new Sinks() };
  /** The punch-out still to write after an overdub ended. */
  private readonly dubTail: Tail = { pos: 0, left: 0, replace: false, sinks: new Sinks() };
  /**
   * A punch-in pressed while a splatted punch-out tail still runs (within 5 ms of a punch-out at a rate other than
   * 1): it starts the moment the tail ends (fix round 1). Shown as pending 'dub'; a second press cancels it.
   */
  private punchPending = false;

  // Undo history (see the file comment) ---------------------------------------------------------------------------
  private undoSnap: Snap | null = null;
  private redoSnap: Snap | null = null;
  private markSnap: Snap | null = null;
  private recBackSnap: Snap | null = null;
  /** Where the gathered (splatted) writes land: the take their stream started in, and snapshots taken of it since. */
  private readonly wSinks = new Sinks();
  /**
   * REC BACK's take while the seam crossfade writes into it and the current take alike: when the crossfade ends with
   * nothing else having written to the current take, REC BACK shares its chunks again (`AudioTake.shareFrom`).
   */
  private recShare: AudioTake | null = null;

  // Tempo sync and speed ------------------------------------------------------------------------------------------
  /** The speed playing now. SPEED CHANGE LOOP END holds a new one back until the seam. */
  private speed: Speed = 'NORMAL';
  /** A held SPEED MOMENT, which overrides TEMPO SYNC SPEED while held. */
  private moment: 'HALF' | 'DOUBLE' | null = null;
  /** Which limit the rate is past (+1 fast, -1 slow, 0 neither), so each excursion raises its message once. */
  private rateWarn: -1 | 0 | 1 = 0;
  /**
   * The playhead is a whole frame and the rate is 1 (within half a frame per pass): playback reads and overdubs write
   * whole frames, exactly as without tempo sync. Any other rate leaves this path (to interpolated reads and splatted
   * writes); the next seam at rate 1, or the next jump of the playhead, comes back to it.
   */
  private exact = true;
  /**
   * On the exact path: where the current pass ideally began (at the loop's true length on the timeline, `length /
   * rate`) relative to where it actually began, in frames. Each seam moves the next pass's start by a frame when that
   * keeps this nearest zero, so the loop stays within a frame of its ideal timing (ruling R45).
   */
  private seamPhase = 0;
  /** A seam correction skipped a frame while overdubbing: the pass's next input frame is written to it as well. */
  private seamSkip = false;
  /**
   * The next frame at the playhead (a whole frame inside the loop) is a replay: it plays `lastRaw` and a pass drops its
   * input frame there (set when a late REC->DUB loop starts a frame early, on a frame the overshoot dub wrote).
   */
  private replayNext = false;
  /** The last sample `readPlayback` produced, before that step's writes: a replayed frame plays it again. */
  private lastRawL = 0;
  private lastRawR = 0;
  /** Phase of an aligned start (`alignedPosition`), for `seamPhase`. */
  private alignPhase = 0;
  /** The playhead in stream frames (counting on past the loop end): where the read heads are for `writer`. */
  private readPos = 0;
  /** Stream frame of the next splatted input frame. */
  private wq = 0;
  /** Stream frame just past the last input frame splatted: the end of the punched span once the input stops. */
  private wqEnd = 0;
  /** The splatted stream is writing through splices (XFADE), else splatting at the playhead (PITCH). */
  private streamXfade = false;
  /** The rate the splatted stream last ran at (a punch-out tail keeps it after the track stops). */
  private wRate = 1;
  /** Frames left of a splatted punch-out tail, and whether it replaces. */
  private wTail = 0;
  private wTailReplace = false;
  /** The read heads of the step just rendered were the stretcher's. */
  private usedHeads = false;
  private readonly stretch: XfadeStretcher;
  /** The stretcher's source position is the playhead (cleared by every jump; it is re-seeded when next used). */
  private stretchSynced = false;
  private readonly writer: SplatWriter;
  /** Time-compresses an XFADE overdub into splices for `writer`. */
  private readonly splice: SpliceWriter;
  /**
   * How far from the playhead a gathered write can land: the larger of the stretcher heads' lag (1.5 grains, 4320
   * frames at 48 kHz) and a splice's reach at 4x (6167), plus the kernel: 6173 frames at 48 kHz.
   */
  private readonly writeBack: number;
  /**
   * How far behind the playhead gathered writes are written, past every read head and every later write: 6175 frames
   * (about 129 ms) at 48 kHz, for PITCH and XFADE alike. A loop shorter than that hears an overdub a pass late.
   */
  private readonly writeDelay: number;
  /** Keep-gain and input gain of each input frame of a splatted step (see resampleWrite.ts). */
  private readonly alphaBuf = new Float32Array(STEP);
  private readonly betaBuf = new Float32Array(STEP);

  // A grid recording across tempo changes (dispatch note c) ------------------------------------------------------
  /** Measures recorded up to the last tempo change, and the take length then. */
  private recMu = 0;
  private recFr = 0;
  /** The measure length (frames) since the last tempo change. */
  private recM = 0;
  /** A grid recording's start was rounded to a whole frame: the measure line it stood for, minus the frame. */
  private recResidual = 0;

  /** Largest absolute output sample since the last `status()`. */
  private peakAbs = 0;

  /** Raw take audio under the playhead for the current step (before level, pan and fades). */
  private readonly rawL = new Float32Array(STEP);
  private readonly rawR = new Float32Array(STEP);
  /** What a pass or tail writes. */
  private readonly srcL = new Float32Array(STEP);
  private readonly srcR = new Float32Array(STEP);
  /** The take's audio under a replace write. */
  private readonly tmpL = new Float32Array(STEP);
  private readonly tmpR = new Float32Array(STEP);
  /** The release voice: the 5 ms that would have played after the cut, in play order. */
  private readonly relBufL: Float32Array;
  private readonly relBufR: Float32Array;

  constructor(index: TrackIndex, host: TrackHost) {
    this.index = index;
    this.host = host;
    this._take = new AudioTake(host.pool);
    this._recordedTempo = host.transport.bpm;
    this.relBufL = new Float32Array(host.xfade);
    this.relBufR = new Float32Array(host.xfade);
    this.stretch = new XfadeStretcher(host.sr);
    const grain = this.stretch.grainFrames;
    this.splice = new SpliceWriter(grain);
    this.writeBack = Math.max(Math.ceil(1.5 * grain), this.splice.reach) + SPLAT_MAX_WIDTH + 2;
    this.writeDelay = this.writeBack + 2;
    // Gathered frames span the write delay plus the reach of a step's writes ahead of where the flush stopped (a
    // splice's reach, or a step at 4x, twice over for margin).
    this.writer = new SplatWriter(this.writeDelay + this.writeBack + 2 * RATE_MAX * STEP + 64);
  }

  get state(): TrackState {
    return this._state;
  }

  /** The current audio. Replaced (never reused) when the track is cleared or loaded, or a history snapshot swapped in. */
  get take(): AudioTake {
    return this._take;
  }

  get recordedTempo(): number {
    return this._recordedTempo;
  }

  private get cfg(): TrackSettings {
    return this.host.memory.track[this.index];
  }

  private get sounding(): boolean {
    return this._state === 'playing' || this._state === 'overdubbing';
  }

  // -------------------------------------------------------------------------------------------------------------------
  // SyncTrack: what loop sync reads
  // -------------------------------------------------------------------------------------------------------------------

  get synced(): boolean {
    return this.cfg.loopSyncSw;
  }

  get hasLoop(): boolean {
    return this._state === 'stopped' || this.sounding;
  }

  get onGrid(): boolean {
    if (!this.cfg.loopSyncSw) return false;
    if (this.arm.action !== null || this.sounding) return true;
    return this._state === 'recording' && this.host.sync.hasReference(this);
  }

  get measures(): number | null {
    return this._measures;
  }

  get loopSeq(): number {
    return this._loopSeq;
  }

  get measureAuto(): boolean {
    return this.cfg.measure === 'AUTO';
  }

  /**
   * The grid moved (a tempo or beat change): aim the armed action at the same line, now at a new frame. A grid
   * recording banks the measures it has recorded at the old measure length, so its end (a waiting press, or a fixed
   * length) stays on the same musical line (dispatch note c) rather than being recomputed from its start at the new
   * length, which could land before what is already recorded and trim it.
   */
  retarget(frame: number): void {
    if (this._state === 'recording') {
      const M = this.host.sync.measure();
      if (this.syncMode() === 'grid' && this.recM > 0) {
        const len = this._take.length;
        this.recMu += (len - this.recFr) / this.recM;
        this.recFr = len;
      }
      this.recM = M;
    }
    if (this.arm.action === null || this.arm.unit === 'fixed') return;
    this.arm.frame = this.host.sync.boundary(frame, this.unitFrames(this.arm.unit));
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Commands (`now` is the timeline frame the command applies at)
  // -------------------------------------------------------------------------------------------------------------------

  /** REC/DUB/PLAY. */
  recPlay(now: number): void {
    if (this.arm.action !== null) return; // one arm at a time: a repeat press waits with it
    switch (this._state) {
      case 'empty':
        this.startRecording(now);
        return;
      case 'recording':
        this.endRecording(this.host.memory.rec.recAction === 'REC->DUB' ? 'dub' : 'play');
        return;
      case 'overdubbing':
        this.endPass(true);
        return;
      case 'stopped':
        this.startFromStopped(now);
        return;
      case 'playing':
        if (this.stopping !== null) return; // FADE/LOOP stop under way: no overdub until playback stops
        if (this.cfg.oneShot) {
          this.retrigger(); // 1SHOT: retrigger from the start, never overdub
          return;
        }
        if (this.cfg.reverse) return; // REVERSE: no overdub
        if (this.punchPending) {
          this.punchPending = false; // a second press before the waiting punch-in started: cancelled
          return;
        }
        if (this.wTail > 0 && !this.exact) {
          // INFERRED (fix round 1): the earlier pass's splatted punch-out tail finishes first (at most 5 ms), so that
          // pass is whole, in the take and in the new pass's undo. Cutting it left a step in the layer, and the two
          // passes cannot share the gathering ring without the undo picking up the new one.
          this.punchPending = true;
          return;
        }
        this.beginPass(false);
        return;
    }
  }

  /**
   * STOP, per STOP MODE. A second STOP during a FADE or LOOP stop stops at once (with the 5 ms ramp-out). STOP cancels
   * an armed action instead, leaving the track as it was.
   */
  stop(): void {
    this.punchPending = false;
    if (this.arm.action !== null) {
      this.arm.action = null;
      return;
    }
    const dir = this.direction();
    switch (this._state) {
      case 'empty':
      case 'stopped':
        return;
      case 'recording':
        // INFERRED: STOP while recording keeps the recording and leaves the track stopped (nothing plays yet, so
        // STOP MODE has nothing to fade). A synced recording still ends on its line.
        this.endRecording('stop');
        return;
      case 'overdubbing':
        // INFERRED: STOP while overdubbing ends the pass, then stops the playback per STOP MODE.
        this.endPass(true);
        break;
      case 'playing':
        break;
    }
    if (this.stopping !== null) {
      this.cutToStopped(dir);
      return;
    }
    switch (this.cfg.stopMode) {
      case 'IMMEDIATE':
        this.cutToStopped(dir);
        return;
      case 'FADE':
        this.stopping = 'FADE';
        this.env.start(0, this.fadeTime(this.host.memory.play.fadeOut));
        return;
      case 'LOOP':
        this.stopping = 'LOOP';
        return;
    }
  }

  /**
   * SPEED MOMENT: `speed` overrides TEMPO SYNC SPEED while held; null lets go. It switches at the SPEED CHANGE timing
   * like any speed change (INFERRED: the guide gives one timing for "the playback speed").
   */
  speedMoment(speed: 'HALF' | 'DOUBLE' | null): void {
    this.moment = speed;
  }

  /** Empty the track: its take is released and replaced by a fresh one. A playing loop ramps out over 5 ms. */
  clear(): void {
    // A first recording still running had no loop yet: clearing it leaves the track as it was before.
    const hadLoop = this._state !== 'empty' && this._state !== 'recording';
    if (this.sounding) this.startRelease(this.direction());
    this.reset();
    if (hadLoop) this.host.audioChanged();
  }

  /**
   * The host lost audio (app switch, lock screen, call): a recording or overdub ends its pass as if REC/DUB/PLAY had
   * moved it to playback, keeping the audio. A synced recording cannot wait for its line, so it ends at once. Other
   * states are left alone.
   */
  interrupt(): void {
    this.arm.action = null; // an armed action would fire on a stale line when audio resumes
    this.punchPending = false;
    if (this._state === 'recording') this.forceFinish();
    else if (this._state === 'overdubbing') this.endPass(true);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Undo history commands (see the file comment)
  // -------------------------------------------------------------------------------------------------------------------

  /** UNDO/REDO: swap the loop with undo (it becomes redo), or with redo when there is no undo (it becomes undo). */
  undoRedo(): void {
    if (this._state === 'recording') return;
    const back = this.undoSnap;
    const fwd = this.redoSnap;
    if (back === null && fwd === null) return;
    if (this._state === 'overdubbing') this.endPass(true);
    if (back !== null) {
      this.undoSnap = null;
      this.swapIn(back, 'redo');
      this.drop(back); // (still REC BACK after REC->DUB: kept)
    } else if (fwd !== null) {
      this.redoSnap = null;
      this.swapIn(fwd, 'undo');
      this.drop(fwd);
    }
  }

  /** MARK SET: remember the loop as it is (a running pass ends first). Nothing while there is no loop yet. */
  markSet(): void {
    if (!this.hasLoop) return;
    if (this._state === 'overdubbing') this.endPass(true);
    this.setSlot('mark', this.snapCurrent());
  }

  /** MARK CLEAR. */
  markClear(): void {
    this.setSlot('mark', null);
  }

  /** MARK BACK: the marked loop, or with no mark the loop as its recording left it (REC BACK). */
  markBack(): void {
    const target = this.markSnap ?? this.recBackSnap;
    if (target !== null) this.goBack(target);
  }

  /** REC BACK: the loop as its recording left it. */
  recBack(): void {
    if (this.recBackSnap !== null) this.goBack(this.recBackSnap);
  }

  /** MARK BACK / REC BACK to `target`: the loop it replaces becomes undo, and redo goes. */
  private goBack(target: Snap): void {
    if (this._state === 'recording') return;
    if (this._state === 'overdubbing') this.endPass(true);
    if (this.swapIn(target, 'undo')) this.setSlot('redo', null);
  }

  /**
   * The memory budget has run out (the core's `reclaim`): let go of the `which` snapshot, if there is one holding
   * audio, and with `onlyIfFreeing` only when it is the sole holder of at least one chunk. Returns whether it did.
   */
  dropHistory(which: SnapSlot, onlyIfFreeing: boolean): boolean {
    const s = this.slot(which);
    if (s === null || s.take === null) return false;
    if (onlyIfFreeing && !s.take.ownsChunks()) return false;
    this.setSlot(which, null);
    return true;
  }

  /**
   * Make `s` the loop. The loop it replaces is kept in the `keep` slot (moved there: its take, not a copy, so writes
   * still in flight to it keep landing in it, which is why nothing needs flushing first); `s` stays in whatever slots
   * hold it, since the loop becomes a snapshot of it. A playing track crossfades from the old loop to the new one over
   * 5 ms where its playhead is.
   *
   * The new loop's snapshot is taken before anything here can allocate (fix round 1): a copy-on-write copy can make
   * the pool reclaim history, `s` is history, and once released it has no audio left to take. Nothing then allocates
   * until `s` is safe (the swap itself needs no memory). A source already released is refused (MEMORY FULL), so a
   * 0-length loop is never installed. Returns whether the swap happened.
   */
  private swapIn(s: Snap, keep: 'undo' | 'redo'): boolean {
    if (s.take !== null && s.take.length === 0) {
      this.host.post('MEMORY FULL');
      return false;
    }
    const incoming = s.take === null ? null : this.shareTake(s.take);
    const sounding = this.sounding;
    const dir = this.direction();
    const wasEmpty = this._state === 'empty';
    const out: Snap = {
      take: wasEmpty ? null : this._take,
      recordedTempo: this._recordedTempo,
      measures: this._measures,
      loopSeq: this._loopSeq,
    };
    this.recShare = null;
    this.punchPending = false;
    if (sounding) this.startRelease(dir); // the old loop's next 5 ms, fading out
    if (incoming === null) {
      if (!wasEmpty) {
        this._take = new AudioTake(this.host.pool);
        this.becomeEmpty();
      }
    } else {
      if (wasEmpty) this._take.release(); // an empty take holds nothing
      this._take = incoming;
      this._recordedTempo = s.recordedTempo;
      this._measures = s.measures;
      this._loopSeq = s.loopSeq;
      if (wasEmpty) {
        this._state = 'stopped';
      } else if (sounding) {
        const len = incoming.length;
        if (this.playhead >= len || this.playhead < -1) this.playhead = ((this.playhead % len) + len) % len;
        this.replayNext = false;
        this.seamSkip = false;
        this.stretchSynced = false;
        this.rampIn();
      }
    }
    this.setSlot(keep, out);
    this.host.audioChanged();
    return true;
  }

  /**
   * The track holds no loop any more (an undone first recording), but writes still in flight to the loop it held go
   * on landing there. Everything else is as `reset` leaves it.
   */
  private becomeEmpty(): void {
    this.settleWriter();
    this._state = 'empty';
    this.stopping = null;
    this.playhead = 0;
    this.readPos = 0;
    this.exact = true;
    this.stretchSynced = false;
    this.seamSkip = false;
    this.replayNext = false;
    this.rateWarn = 0;
    this.arm.action = null;
    this.recEnd = null;
    this._measures = null;
    this.env.set(1);
    this.mute.set(1);
    this.attack.set(1);
  }

  /**
   * A snapshot of the loop as it is: what the gathered writes can land now is in it, and it joins every write still in
   * flight to the current take, so it ends up holding all of it.
   */
  private snapCurrent(): Snap {
    this.flushPendingWrites();
    return {
      take: this.shareTake(this._take),
      recordedTempo: this._recordedTempo,
      measures: this._measures,
      loopSeq: this._loopSeq,
    };
  }

  /** A copy-on-write snapshot of `src` that joins every in-flight write `src` receives. */
  private shareTake(src: AudioTake): AudioTake {
    const t = src.snapshot();
    if (this.recTail.left > 0 && this.recTail.sinks.has(src)) this.recTail.sinks.add(t);
    if (this.dubTail.left > 0 && this.dubTail.sinks.has(src)) this.dubTail.sinks.add(t);
    // (Never a running pass's own writes: no snapshot is taken while one runs.)
    if ((this.wTail > 0 || this.writer.pending) && this._state !== 'overdubbing' && this.wSinks.has(src)) {
      this.wSinks.add(t);
    }
    return t;
  }

  private slot(which: SnapSlot): Snap | null {
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
  private setSlot(which: SnapSlot, s: Snap | null): void {
    const old = this.slot(which);
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
    if (old !== null && old !== s) this.drop(old);
  }

  /** Release `s`'s take, unless a slot still holds `s`. */
  private drop(s: Snap): void {
    const t = s.take;
    if (t === null || s === this.undoSnap || s === this.redoSnap || s === this.markSnap || s === this.recBackSnap) return;
    this.recTail.sinks.remove(t);
    this.dubTail.sinks.remove(t);
    this.wSinks.remove(t);
    if (this.recShare === t) this.recShare = null;
    t.release();
  }

  /** Let go of all four snapshots (the loop they belong to is gone). */
  private clearHistory(): void {
    this.setSlot('undo', null);
    this.setSlot('redo', null);
    this.setSlot('mark', null);
    this.setSlot('recBack', null);
  }

  /**
   * Replace the track's audio with `audio` (null empties it), leaving it stopped. `audio` must be at the core's sample
   * rate (the caller resamples). On MEMORY FULL the track is left empty. A playing loop ramps out over 5 ms.
   */
  load(audio: TrackAudio | null): void {
    if (this.sounding) this.startRelease(this.direction());
    this.reset();
    if (audio === null || audio.L.length === 0 || audio.L.length !== audio.R.length) return;
    const take = AudioTake.fromArrays(this.host.pool, audio.L, audio.R);
    if (take === null) {
      this.host.post('MEMORY FULL');
      return;
    }
    this._take.release();
    this._take = take;
    this._state = 'stopped';
    this._recordedTempo = audio.recordedTempo;
    const m = audio.measures;
    this._measures = typeof m === 'number' && Number.isFinite(m) && m > 0 ? m : null;
    this._loopSeq = this.host.sync.nextSeq();
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Recording
  // -------------------------------------------------------------------------------------------------------------------

  /**
   * Start recording at `now`, or arm it for the next measure line. A synced track with a tempo reference waits when
   * QUANTIZE is MEASURE, or (INFERRED, from the guide's "Recording or playback starts at the beginning of a measure")
   * when LOOP SYNC MODE is MEASURE or LOOP LENGTH.
   */
  private startRecording(now: number): void {
    const cfg = this.cfg;
    const sync = this.host.sync;
    if (cfg.loopSyncSw && sync.hasReference(this)) {
      sync.anchor(now, this);
      if (this.host.memory.rec.quantize === 'MEASURE' || cfg.loopSyncMode !== 'IMMEDIATE') {
        const at = sync.boundary(now, sync.measure());
        if (at > now) {
          this.setArm('rec', at, 'measure');
          return;
        }
      }
    }
    this.beginRecording(now);
  }

  private beginRecording(frame: number): void {
    this.clearHistory(); // what an undone loop left (redo, REC BACK, the mark) goes with it
    this._state = 'recording'; // the take is always fresh and empty here
    this.recStart = frame;
    this.recEnd = null;
    this.recMu = 0;
    this.recFr = 0;
    this.recM = this.host.sync.measure();
    this.recResidual = 0;
    if (this.syncMode() === 'grid') {
      // The measure line nearest the start (a line rounded to a whole frame, when the recording waited for one).
      const sync = this.host.sync;
      const M = this.recM;
      const r = sync.origin + Math.round((frame - sync.origin) / M) * M - frame;
      if (Math.abs(r) < 1) this.recResidual = r;
    }
  }

  /**
   * How the recording relates to the grid, decided live: 'free' (LOOP SYNC off), 'define' (synced with no reference:
   * it will set the tempo), or 'grid' (synced against a reference: its length snaps).
   */
  private syncMode(): 'free' | 'define' | 'grid' {
    if (!this.cfg.loopSyncSw) return 'free';
    return this.host.sync.hasReference(this) ? 'grid' : 'define';
  }

  /** The end press (REC/DUB/PLAY or STOP) of a recording. */
  private endRecording(next: EndAction): void {
    if (this.recEnd !== null) {
      // Already waiting for its line: a repeat press does nothing, but STOP turns the wait into a stop (INFERRED).
      if (next === 'stop') this.recEnd = 'stop';
      return;
    }
    if (this.syncMode() !== 'grid') {
      this.finishRecording(next);
      return;
    }
    const len = this._take.length;
    const measures = this.fixedMeasures() ?? Math.max(1, Math.round(this.recordedMeasures()));
    const target = this.measuresToFrames(measures);
    if (target > len) {
      // INFERRED (spec: Behaviors to verify): an early press keeps recording to the line.
      this.recEnd = next;
      this.recEndMeasures = measures;
      return;
    }
    // INFERRED (spec: Behaviors to verify): a late press trims the overshoot, with the 5 ms seam crossfade.
    this.closeLoop(target, next, measures);
  }

  /**
   * End a free or defining recording at its recorded length. A recording of 2 x XFADE frames or fewer is discarded
   * and the track is empty again. A defining one sets the tempo and the grid origin.
   */
  private finishRecording(next: EndAction): void {
    const len = this._take.length;
    if (len <= 2 * this.host.xfade) {
      this.reset();
      return;
    }
    let measures: number | null = null;
    if (this.syncMode() === 'define') {
      const t = this.host.transport;
      const d = deriveTempo(len, t.sr, t.beat, this.defineSetting());
      this.host.sync.define(d.bpm, this.recStart, this.recStart + len);
      measures = d.measures;
    }
    this.closeLoop(len, next, measures);
  }

  /**
   * End the recording now, without waiting for a line: MEMORY FULL, or the host lost audio. A grid recording keeps its
   * last whole measure, or all of itself when it has less than one (INFERRED). It plays unless STOP was waiting.
   */
  private forceFinish(): void {
    const next: EndAction = this.recEnd === 'stop' ? 'stop' : 'play';
    if (this.syncMode() !== 'grid') {
      this.recEnd = null;
      this.finishRecording(next);
      return;
    }
    const len = this._take.length;
    const recorded = this.recordedMeasures();
    const whole = Math.floor(recorded + 1e-9);
    if (whole >= 1) {
      this.closeLoop(Math.min(len, this.framesFor(whole)), next, whole);
    } else if (len <= 2 * this.host.xfade) {
      this.reset();
    } else {
      this.closeLoop(len, next, recorded);
    }
  }

  /**
   * Make the first `T` frames of the recording the loop, `measures` long, and move on to `next`.
   *
   * Frames recorded past `T` (a late press, or a trim) are the input that followed the loop end, so they get exactly
   * what an on-time press would have done with that input: their first 5 ms are crossfaded into the loop start (the
   * seam), and with REC->DUB the pass dubs all of them onto the loop start by its DUB MODE rules. Then they are
   * dropped, and playback (and the pass) pick up where the loop has got to since `T`, in step with the grid at once:
   * `rate * over` frames on, at the rate the loop now plays at.
   */
  private closeLoop(T: number, next: EndAction, measures: number | null): void {
    const take = this._take;
    const xf = this.host.xfade;
    const over = take.length - T;
    const baked = Math.min(xf, over);
    if (baked > 0) this.bakeSeam(T, baked);
    // The rest of the seam crossfade comes from the live input.
    this.recTail.pos = baked;
    this.recTail.left = xf - baked;
    this.recTail.sinks.reset(take);
    this.recEnd = null;
    this._measures = measures;
    this._loopSeq = this.host.sync.nextSeq();
    // A synced loop's tempo is the exact tempo at which its T frames are `measures` measures (dispatch note b): T is a
    // whole number of frames and a measure rarely is, so the memory tempo would leave tempo sync playing it a fraction
    // of a frame per measure off the grid, drifting without end. At this tempo `memory tempo / recorded tempo` makes
    // one pass exactly `measures` measures of the grid. (It is also exact after a tempo change mid-recording, note c.)
    // INFERRED: a free loop has no tempo of its own; it takes the memory tempo of the moment its recording ends.
    this._recordedTempo = measures !== null ? this.loopTempo(T, measures) : this.host.transport.bpm;
    // REC->DUB on a REVERSE or 1SHOT track, which cannot overdub, ends in playback (INFERRED).
    const dub = next === 'dub' && this.canDub();
    // Undo history: the recording was the first pass, and before it the track was empty. REC BACK is the loop as it
    // is now; the live part of the seam crossfade lands in it too (binding note 1), and an overshoot dub does not.
    const postTake = take.snapshot();
    if (over > 0) postTake.truncate(T);
    if (this.recTail.left > 0) this.recTail.sinks.add(postTake);
    const post: Snap = { take: postTake, recordedTempo: this._recordedTempo, measures, loopSeq: this._loopSeq };
    this.setSlot('recBack', post);
    this.setSlot('undo', { take: null, recordedTempo: this._recordedTempo, measures: null, loopSeq: 0 });
    this.setSlot('redo', null);
    this.setSlot('mark', null);
    // Without a pass, the two hold the same audio once the crossfade is done: REC BACK then shares the take's chunks.
    this.recShare = !dub && this.recTail.left > 0 ? postTake : null;
    this.host.audioChanged();
    if (next === 'stop') {
      if (over > 0) take.truncate(T);
      this.toStopped();
      return;
    }
    // INFERRED: playback straight after a recording starts at full level (after the 5 ms ramp-in from the silent
    // recording); START MODE applies to starts from stopped. It starts at the speed set now (it was not playing).
    this.speed = this.targetSpeed();
    this.rateWarn = 0;
    this.stretchSynced = false;
    this._state = 'playing';
    this.stopping = null;
    this.env.set(1);
    this.mute.set(1);
    this.rampIn();
    const rate = this.rateAt(this.speed);
    this.exact = this.isUnity(rate);
    this.seamPhase = 0;
    if (this.exact) {
      this.readPos = 0;
      const into = over % T;
      let p = this.cfg.reverse ? T - 1 - into : into;
      let shift = 0;
      if (rate !== 1) {
        // A loop a fraction of a frame off its grid length (ruling R45): this pass ideally began where the recording's
        // (rounded) start line plus its passes since put it. Start it a frame early or late when that keeps it nearest
        // the grid over the pass, as `correctSeam` does at each seam, so it is within 0.75 of a frame from the start.
        const drift = T / rate - T;
        let phase = this.recResidual + (1 + Math.floor(over / T)) * drift;
        shift = -Math.round(phase + drift / 2);
        shift = shift < -1 ? -1 : shift > 1 ? 1 : shift;
        phase += shift;
        this.seamPhase = phase;
        p = this.cfg.reverse ? p - shift : p + shift;
        if (p >= T) p -= T;
        else if (p < -1) p += T;
      }
      // Starting a frame early replays the frame just before: the loop's last (frame -1 or T), or, after a late
      // REC->DUB press, the last frame the overshoot dub is about to write. Either way it plays as it was before any
      // pass wrote it, and the live pass drops its first input frame there rather than writing that frame twice.
      const replay = shift < 0 && (p === -1 || p === T || (dub && over > 0));
      if (replay) {
        this._take.read(p < 0 ? T - 1 : p >= T ? 0 : p, this.tmpL, this.tmpR, 0, 1); // before the overshoot dub
        this.lastRawL = this.tmpL[0];
        this.lastRawR = this.tmpR[0];
      }
      if (dub) {
        // The pass as it would have run from the line: from position 0, under the seam crossfade. An OVERDUB pass
        // ramps in with the seam (the two input gains sum to 1); a REPLACE pass writes the input at full gain, since
        // the seam already fades it in over the old audio (a second ramp would dip the level by 1 - u + u^2).
        this.beginPass(true, this.cfg.dubMode === 'OVERDUB' ? 0 : xf, post);
        if (over > 0) this.dubOvershoot(T, over);
      }
      if (over > 0) take.truncate(T);
      if (shift > 0 && dub) this.seamSkip = true;
      this.replayNext = replay && p >= 0 && p < T; // (frames -1 and T replay by position)
      this.playhead = p;
      this.readPos = p;
      return;
    }
    // Any other rate: the overshoot is splatted (a REC->DUB pass) and playback resumes between samples.
    const skip = over > 0 ? over - Math.min(over, Math.ceil(T / rate)) : 0; // the cap of note d, see dubOvershoot
    this.readPos = rate * skip;
    if (dub) {
      this.beginPass(true, this.cfg.dubMode === 'OVERDUB' ? 0 : xf, post);
      if (over > 0) this.dubOvershootSplat(T, over, skip, rate);
    }
    if (over > 0) take.truncate(T);
    const into = (rate * over) % T;
    let p = this.cfg.reverse ? T - 1 - into : into;
    if (p < 0) p += T;
    this.playhead = p;
    this.readPos = dub ? this.wq : p;
  }

  /**
   * The tempo at which `frames` frames are `measures` measures of the current beat (as `deriveTempo` computes it),
   * clamped to TEMPO_MIN..TEMPO_MAX: the memory file refuses a recorded tempo outside the range. (At the very ends of
   * the range a measure is a whole number of frames at the usual sample rates, so the clamp costs no drift there; it
   * does mean a loop whose derived tempo was clamped plays at rate 1, off the grid, as before tempo sync.)
   */
  private loopTempo(frames: number, measures: number): number {
    const t = this.host.transport;
    const perMeasure = (t.beat.num * 4) / t.beat.den;
    const bpm = (measures * perMeasure * 60 * t.sr) / frames;
    return bpm < TEMPO_MIN ? TEMPO_MIN : bpm > TEMPO_MAX ? TEMPO_MAX : bpm;
  }

  /**
   * A late REC->DUB end press: run the pass over the loop positions `[0, over)` with the recorded overshoot
   * (`take[T, T + over)`) as its input, as it would have run live from the line, wrapping at `T`. `passFrames` carries
   * on from there, so the live pass continues the same ramp.
   *
   * INFERRED (dispatch note d): an overshoot longer than the loop, which only happens when the length shrinks under a
   * running recording (a MEASURE or LOOP LENGTH change), dubs only its last loop length. Each loop position is then
   * written once, by the last pass over it, so one callback never does more than a loop length of work. REPLACE
   * passes come out exactly as before (the last pass overwrote the earlier ones anyway); an OVERDUB pass keeps only
   * that last layer of the overshoot.
   */
  private dubOvershoot(T: number, over: number): void {
    const { rawL, rawR } = this;
    let k = over > T ? over - T : 0;
    this.passFrames += k; // the skipped frames' ramp has run its course
    while (k < over && this._state === 'overdubbing') {
      const pos = k % T;
      const m = Math.min(STEP, over - k, T - pos);
      this._take.read(T + k, rawL, rawR, 0, m);
      this.playhead = pos;
      this.writePass(rawL, rawR, 0, m);
      k += m;
    }
  }

  /**
   * `dubOvershoot` at a rate other than 1: the overshoot frames from `skip` on are splatted at stream frame
   * `rate * k`, as the live pass would have written them, wrapping at `T` (flushed as it goes, so the gathering ring
   * stays small). The cap is the same: at most one loop length (`T / rate` input frames). XFADE splices it, as live.
   */
  private dubOvershootSplat(T: number, over: number, skip: number, rate: number): void {
    const { rawL, rawR } = this;
    this.passFrames += skip;
    let k = skip;
    while (k < over && this._state === 'overdubbing') {
      const m = Math.min(STEP, over - k);
      this._take.read(T + k, rawL, rawR, 0, m);
      this.splatStep(rawL, rawR, 0, m, rate);
      this.readPos = this.wq;
      if (!this.writer.flush(this.wSinks.takes, this.wq - this.writeDelay, T)) this.writeFailed();
      k += m;
    }
  }

  /** Whether the track can overdub at all: REVERSE and 1SHOT tracks cannot. */
  private canDub(): boolean {
    return !this.cfg.reverse && !this.cfg.oneShot;
  }

  /** Crossfade `take[T, T + n)`, the audio just after the loop end, into the loop's first `n` frames (n <= xfade). */
  private bakeSeam(T: number, n: number): void {
    const xf = this.host.xfade;
    const { srcL, srcR, tmpL, tmpR } = this;
    for (let j0 = 0; j0 < n; j0 += STEP) {
      const m = Math.min(STEP, n - j0);
      this._take.read(T + j0, srcL, srcR, 0, m);
      this._take.read(j0, tmpL, tmpR, 0, m);
      for (let k = 0; k < m; k++) {
        const g = punchOutGain(xf - j0 - k, xf); // the same gains as the live seam tail
        srcL[k] = tmpL[k] * (1 - g) + srcL[k] * g;
        srcR[k] = tmpR[k] * (1 - g) + srcR[k] * g;
      }
      if (!this._take.write(j0, srcL, srcR, m, 'replace')) {
        this.host.post('MEMORY FULL');
        return;
      }
    }
  }

  /**
   * Measures that fix the recording's length, or null when it snaps to whole measures. LOOP SYNC MODE LOOP LENGTH
   * uses LOOP LENGTH (AUTO: the first-recorded phrase, if there is one); otherwise MEASURE: a count, a note, or AUTO's
   * shared count (once another AUTO track has set it). FREE never fixes it.
   */
  private fixedMeasures(): number | null {
    const cfg = this.cfg;
    const sync = this.host.sync;
    if (cfg.loopSyncMode === 'LOOP LENGTH') {
      const loopLength = this.host.memory.play.loopLength;
      if (typeof loopLength === 'number') return loopLength;
      const first = sync.firstMeasures(this);
      if (first !== null) return first;
    }
    const m = cfg.measure;
    if (m === 'FREE') return null;
    if (m === 'AUTO') return sync.autoMeasures(this);
    if ('note' in m) {
      const t = this.host.transport;
      return noteFrames(t.sr, t.bpm, m.note) / sync.measure();
    }
    return m.measures;
  }

  /** MEASURE for `deriveTempo` when this recording sets the tempo: LOOP LENGTH's count when it gives one. */
  private defineSetting(): MeasureSetting {
    const loopLength = this.host.memory.play.loopLength;
    if (this.cfg.loopSyncMode === 'LOOP LENGTH' && typeof loopLength === 'number') return { measures: loopLength };
    return this.cfg.measure;
  }

  /** The recording's length in measures: those banked at tempo changes, then the rest at the current measure. */
  private recordedMeasures(): number {
    return this.recMu + (this._take.length - this.recFr) / this.host.sync.measure();
  }

  /**
   * Frames from the recording's start to the end of its measure `measures`, across tempo changes: the frames banked
   * at the last change, then the rest at the current measure length. (A length within the banked part is taken pro
   * rata.) With no tempo change it is `round(measures * measure)`.
   */
  private framesFor(measures: number): number {
    if (measures >= this.recMu) {
      return this.recFr + Math.round((measures - this.recMu) * this.host.sync.measure());
    }
    return Math.round((measures * this.recFr) / this.recMu);
  }

  /** `framesFor(measures)`, never so short that the recording would be discarded. */
  private measuresToFrames(measures: number): number {
    return Math.max(2 * this.host.xfade + 1, this.framesFor(measures));
  }

  /** The length, in measures, at which the recording ends by itself: a waiting end press, or a fixed length. */
  private targetMeasures(): number | null {
    if (this.recEnd !== null) return this.recEndMeasures;
    if (this.syncMode() !== 'grid') return null;
    return this.fixedMeasures();
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Playback starts
  // -------------------------------------------------------------------------------------------------------------------

  /**
   * REC/DUB/PLAY on a stopped track, per LOOP SYNC MODE. A SINGLE track with another SINGLE track playing first waits
   * for the S.TRK CHANGE point (LOOP END: that track's loop end; MEASURE: the next measure line), and starts there as a
   * press there would (`playFrom`).
   */
  private startFromStopped(now: number): void {
    if (this.cfg.playMode === 'SINGLE') {
      const at = this.host.singleChange(this, now);
      if (at > now) {
        this.setArm('start', at, this.host.memory.play.sTrkChange === 'MEASURE' ? 'measure' : 'fixed');
        return;
      }
    }
    const at = this.startLine(now);
    if (at > now) this.setArm('play', at, this.lineUnit);
    else this.playFrom(now);
  }

  /**
   * The line a start from stopped at `now` waits for, or `now`. With the grid running, LOOP SYNC MODE MEASURE waits for
   * the next measure line, LOOP LENGTH for the next line in LOOP LENGTH units (INFERRED from the guide's "starts in
   * time with the beginning of other tracks, in units set by LOOP LENGTH").
   */
  startLine(now: number): number {
    const cfg = this.cfg;
    const sync = this.host.sync;
    if (!cfg.loopSyncSw || cfg.loopSyncMode === 'IMMEDIATE' || !sync.gridRunning(this)) return now;
    return sync.boundary(now, this.unitFrames(this.lineUnit));
  }

  /** The grid `startLine` waits on. */
  get lineUnit(): ArmUnit {
    return this.cfg.loopSyncMode === 'LOOP LENGTH' ? 'loop' : 'measure';
  }

  /** Start playback at `frame` from stopped, at the position LOOP SYNC gives (the waiting is done). */
  private playFrom(frame: number): void {
    const cfg = this.cfg;
    const sync = this.host.sync;
    if (!cfg.loopSyncSw) {
      this.startPlayback(this.startPosition());
      return;
    }
    if (!sync.gridRunning(this)) {
      // INFERRED: nothing to keep time with, so start now; the grid restarts here.
      sync.anchor(frame, this);
      this.startPlayback(this.startPosition());
      return;
    }
    if (cfg.loopSyncMode !== 'IMMEDIATE') {
      this.startPlayback(this.alignedPosition(frame), this.alignPhase);
      return;
    }
    // IMMEDIATE starts now. SYNC ADJUST, which the guide gives only "When SPEED CHANGE is set to IMMEDIATE": within
    // one measure (or beat) of a phrase line, either side, the start snaps into step with it (INFERRED: at once, at the
    // aligned position, rather than waiting for the line).
    const play = this.host.memory.play;
    const phrase = this._take.length / this.rateAt(this.targetSpeed()); // the loop's length on the timeline
    const off = phraseOffset(frame, sync.origin, phrase);
    const window = play.syncAdjust === 'BEAT' ? sync.beat() : sync.measure();
    const near = play.speedChange === 'IMMEDIATE' && (off <= window || phrase - off <= window);
    if (near) this.startPlayback(this.alignedPosition(frame), this.alignPhase);
    else this.startPlayback(this.startPosition());
  }

  // ALL START/STOP and PLAY MODE SINGLE (driven by the core) --------------------------------------------------------

  /** Recording, playing or overdubbing. */
  get running(): boolean {
    return this._state === 'recording' || this.sounding;
  }

  /** An action is armed (a start or recording waiting for its line or a SINGLE change). */
  get armed(): boolean {
    return this.arm.action !== null;
  }

  /** ALL START: start at `at`, now or armed until then (an armed start is replaced). Only a stopped track starts. */
  allStart(now: number, at: number, unit: ArmUnit): void {
    if (this._state !== 'stopped') return;
    this.arm.action = null;
    if (at > now) this.setArm('start', at, unit);
    else this.playFrom(now);
  }

  /** ALL STOP: STOP for a track that is recording, playing or armed (a recording or a pass ends first). */
  allStop(): void {
    if (this.running || this.arm.action !== null) this.stop();
  }

  /** PLAY MODE SINGLE: another SINGLE track has started, so this one stops at once (5 ms ramp-out), ending a pass. */
  yieldToSingle(): void {
    if (!this.sounding) return;
    const dir = this.direction();
    if (this._state === 'overdubbing') this.endPass(true);
    this.cutToStopped(dir);
  }

  /** Frames until the playhead next crosses the loop end at the rate it plays now; Infinity when not playing. */
  get framesToLoopEnd(): number {
    if (!this.sounding) return Infinity;
    const len = this._take.length;
    const dir = this.direction();
    const p = this.playhead;
    if (this.exact) return dir > 0 ? len - p : p + 1;
    return this.framesToSeam(len, p, dir, this.rateAt(this.speed));
  }

  /** The frame of an armed start that will make other SINGLE tracks stop; Infinity when there is none. */
  get singleArmFrame(): number {
    const a = this.arm.action;
    return a !== null && a !== 'rec' && this.cfg.playMode === 'SINGLE' ? this.arm.frame : Infinity;
  }

  /**
   * Fire a SINGLE track's armed start due at or before `frame`. The core does this before any track renders `frame`,
   * so the tracks it stops stop on that very frame whatever their order.
   */
  fireSingleStart(frame: number): void {
    if (this.singleArmFrame <= frame) this.fireArm(frame);
  }

  /**
   * The phrase position in step with the grid at `frame` (mirrored in REVERSE). The loop spans `length / rate`
   * timeline frames, so the position is `rate * ((frame - origin) mod (length / rate))`: at rate 1, the whole frame
   * `(frame - origin) mod length`. A 1SHOT plays once from its start, so it always starts there (INFERRED).
   */
  private alignedPosition(frame: number): number {
    this.alignPhase = 0;
    if (this.cfg.oneShot) return this.startPosition();
    const len = this._take.length;
    const rate = this.rateAt(this.targetSpeed());
    if (this.isUnity(rate)) {
      // A whole frame, for the exact path. At rate 1 exactly the phrase is the take. Otherwise (a loop a fraction of a
      // frame off its grid length) the frame is chosen to keep the coming pass centred on the grid, and its offset from
      // the ideal start becomes the seam phase (ruling R45).
      const phrase = len / rate;
      const raw = phraseOffset(frame, this.host.sync.origin, phrase);
      if (rate === 1) {
        const off = Math.round(raw) % len;
        return this.cfg.reverse ? len - 1 - off : off;
      }
      const off = (((Math.round(raw - (phrase - len) / 2) % len) + len) % len);
      // `raw` counts timeline frames into the phrase (which is `phrase` long), so a frame that wrapped to the loop
      // start belongs to the next phrase: wrap the phase by the phrase, not the loop length.
      let phase = off - raw;
      if (phase < -phrase / 2) phase += phrase;
      else if (phase > phrase / 2) phase -= phrase;
      this.alignPhase = phase;
      return this.cfg.reverse ? len - 1 - off : off;
    }
    let off = phraseOffset(frame, this.host.sync.origin, len / rate) * rate;
    if (off >= len) off -= len;
    if (!this.cfg.reverse) return off;
    const p = len - 1 - off;
    return p < 0 ? p + len : p;
  }

  /** Frames between the lines an armed action waits on (a fixed frame is not on a grid; it counts as measures). */
  private unitFrames(unit: ArmUnit): number {
    const sync = this.host.sync;
    const M = sync.measure();
    if (unit !== 'loop') return M;
    const loopLength = this.host.memory.play.loopLength;
    return (typeof loopLength === 'number' ? loopLength : (sync.firstMeasures(null) ?? 1)) * M;
  }

  private setArm(action: 'rec' | 'play' | 'start', frame: number, unit: ArmUnit): void {
    this.arm.action = action;
    this.arm.frame = frame;
    this.arm.unit = unit;
  }

  /** The armed action's line has come: act at timeline frame `frame`. */
  private fireArm(frame: number): void {
    const action = this.arm.action;
    this.arm.action = null;
    if (action === 'rec') this.beginRecording(frame);
    else if (action === 'play') this.startPlayback(this.alignedPosition(frame), this.alignPhase);
    else if (action === 'start') this.playFrom(frame);
  }

  /**
   * Start playback at take position `pos`, per START MODE, at the speed set now (the track was not playing). `phase`:
   * the seam phase of an aligned start.
   */
  private startPlayback(pos: number, phase = 0): void {
    this.speed = this.targetSpeed();
    this.rateWarn = 0;
    this._state = 'playing';
    this.stopping = null;
    this.mute.set(1);
    this.seek(pos, phase);
    if (this.cfg.startMode === 'FADE') {
      this.attack.set(1); // the fade itself starts from 0
      this.env.set(0);
      this.env.start(1, this.fadeTime(this.host.memory.play.fadeIn));
    } else {
      this.env.set(1);
      this.rampIn();
    }
    if (this.cfg.playMode === 'SINGLE') this.host.singleStarted(this);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Transitions
  // -------------------------------------------------------------------------------------------------------------------

  /** 1SHOT retrigger: the old position fades out (release) while the start fades in, both over 5 ms. */
  private retrigger(): void {
    this.startRelease(this.direction());
    this.seek(this.startPosition());
    this.rampIn();
  }

  /**
   * Jump the playhead to `pos`. Gathered overdub writes land now, since the stream they belong to has ended; a splatted
   * punch-out tail still running is cut (only a start within 5 ms of a stop does that). The exact path resumes when
   * `pos` is a whole frame (and the rate is 1), and the stretcher is re-seeded when next used.
   */
  private seek(pos: number, phase = 0): void {
    this.flushWrites();
    this.playhead = pos;
    this.readPos = pos;
    this.exact = Number.isInteger(pos);
    this.seamPhase = phase;
    this.seamSkip = false;
    this.replayNext = false;
    this.stretchSynced = false;
  }

  /**
   * Punch in at the playhead. The DUB MODE is fixed for the pass (INFERRED: a change applies from the next pass).
   * `passFrames` is where the punch-in ramp starts (0: from silence; xfade or more: full gain at once).
   * `fromRecording`: the pass follows a recording, during which the track output nothing, so REPLACE2 is muted at once
   * rather than ramped (it must never play the track).
   */
  private beginPass(fromRecording: boolean, passFrames = 0, before: Snap | null = null): void {
    // Undo history: the pass can be undone to the loop as it is now (`before`, when the caller has it). An earlier
    // pass's gathered writes land first, so that loop holds all of it; seam and punch-out tails carry on into it.
    if (before === null) {
      this.settleWriter();
      before = this.snapCurrent();
    }
    this.setSlot('undo', before);
    this.setSlot('redo', null);
    this.recShare = null;
    this._state = 'overdubbing';
    this.passMode = this.cfg.dubMode;
    this.passFrames = passFrames;
    if (!this.exact) this.startStream();
    if (this.passMode === 'REPLACE2') {
      if (fromRecording) this.mute.set(0);
      else this.mute.start(0, this.host.xfade);
    }
  }

  /** Punch out: back to playing. `tail` keeps writing the fading input for 5 ms (not after MEMORY FULL). */
  private endPass(tail: boolean): void {
    this.seamSkip = false;
    this.replayNext = false;
    if (tail && this.exact) {
      // A tail still running from a pass that ended under 5 ms ago is cut short (a negligible overlap).
      this.dubTail.pos = this.wrapped(this.playhead);
      this.dubTail.left = this.host.xfade;
      this.dubTail.replace = this.passMode !== 'OVERDUB';
      this.dubTail.sinks.reset(this._take);
    } else if (tail) {
      // The splatted stream carries on for 5 ms more, fading out (see writeSplatted).
      this.wTail = this.host.xfade;
      this.wTailReplace = this.passMode !== 'OVERDUB';
      this.splice.punchOut(this.wq, this.wRate);
    }
    this._state = 'playing';
    if (this.passMode === 'REPLACE2') this.mute.start(1, this.host.xfade);
    this.host.audioChanged();
  }

  /** Stop at once without a click: the release voice fades out what was playing over 5 ms. */
  private cutToStopped(dir: 1 | -1): void {
    this.startRelease(dir);
    this.toStopped();
  }

  /**
   * Start the release voice at the playhead (the next frame that would have played), at the track's current fade
   * gain: copy the next 5 ms in play order, wrapping at the loop ends. A release still running from a cut under 5 ms
   * ago is replaced (a negligible overlap).
   */
  private startRelease(dir: 1 | -1): void {
    const rel = this.rel;
    const take = this._take;
    const len = take.length;
    const xf = this.host.xfade;
    rel.gain = this.env.value * this.mute.value * this.attack.value;
    if (len === 0) {
      rel.left = 0;
      return;
    }
    const { relBufL, relBufR } = this;
    if (!this.exact) {
      // The next 5 ms at the current rate, as the stretcher or the interpolated read would have played them.
      const v = dir * this.rateAt(this.speed);
      const bounded = this.cfg.oneShot;
      if (this.cfg.tempoSyncMode === 'XFADE') {
        if (!this.stretchSynced) {
          this.stretch.reset(this.playhead);
          this.stretchSynced = true;
        }
        this.stretch.bounded = bounded;
        this.stretch.peek(take, v, xf, relBufL, relBufR, 0);
      } else {
        for (let k = 0; k < xf; k++) readInterpolated(take, this.playhead + v * k, relBufL, relBufR, k, bounded);
      }
      rel.left = xf;
      return;
    }
    let pos = this.wrapped(this.playhead); // a seam-corrected frame (-1 or length) is the loop's last or first
    let k = 0;
    while (k < xf) {
      if (dir > 0) {
        const piece = Math.min(xf - k, len - pos);
        take.read(pos, relBufL, relBufR, k, piece);
        pos += piece;
        if (pos >= len) pos = 0;
        k += piece;
      } else {
        const piece = Math.min(xf - k, pos + 1);
        take.read(pos - piece + 1, relBufL, relBufR, k, piece);
        reverseInPlace(relBufL, k, piece);
        reverseInPlace(relBufR, k, piece);
        pos -= piece;
        if (pos < 0) pos = len - 1;
        k += piece;
      }
    }
    rel.left = xf;
  }

  /** Ramp the output in from silence over 5 ms. */
  private rampIn(): void {
    this.attack.set(0);
    this.attack.start(1, this.host.xfade);
  }

  /** Stop. A splatted punch-out tail carries on writing (and its gathered writes land) without the playhead. */
  private toStopped(): void {
    this.punchPending = false;
    this._state = 'stopped';
    this.stopping = null;
    this.playhead = 0;
    this.stretchSynced = false;
    this.seamSkip = false;
    this.replayNext = false;
    this.rateWarn = 0;
    this.env.set(1);
    this.mute.set(1);
    this.attack.set(1);
  }

  /**
   * Release the take for a fresh one and return to empty, cancelling everything in flight except the release voice,
   * which plays from its own copy.
   */
  private reset(): void {
    this.clearHistory();
    this.recTail.sinks.reset(null);
    this.dubTail.sinks.reset(null);
    this.wSinks.reset(null);
    this.recShare = null;
    this.punchPending = false;
    // A released take refuses appends, so it must be replaced, never kept.
    this._take.release();
    this._take = new AudioTake(this.host.pool);
    this._state = 'empty';
    this.stopping = null;
    this.playhead = 0;
    this.env.set(1);
    this.mute.set(1);
    this.attack.set(1);
    this.recTail.left = 0;
    this.dubTail.left = 0;
    this.writer.discard();
    this.splice.reset(0);
    this.wTail = 0;
    this.exact = true;
    this.readPos = 0;
    this.stretchSynced = false;
    this.rateWarn = 0;
    this.arm.action = null;
    this.recEnd = null;
    this._measures = null;
  }

  /** Where playback (re)starts: the first frame, or the last in REVERSE. */
  private startPosition(): number {
    return this.cfg.reverse ? this._take.length - 1 : 0;
  }

  /** Play direction. An overdub pass always runs forwards (INFERRED: REVERSE switched on mid-pass waits for it). */
  private direction(): 1 | -1 {
    return this._state !== 'overdubbing' && this.cfg.reverse ? -1 : 1;
  }

  /** FADE TIME in frames at the tempo of the moment (INFERRED: a tempo change mid-fade does not re-time it). */
  private fadeTime(f: FadeTime): number {
    const t = this.host.transport;
    return fadeTimeFrames(this.host.sr, t.bpm, t.beat, f);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Tempo sync and speed
  // -------------------------------------------------------------------------------------------------------------------

  /** The speed the track is set to: a held SPEED MOMENT, else TEMPO SYNC SPEED. */
  private targetSpeed(): Speed {
    return this.moment ?? this.cfg.tempoSyncSpeed;
  }

  /**
   * The speed playing now. A new speed applies at once with SPEED CHANGE IMMEDIATE, or on a track that is not playing
   * (INFERRED: there is no seam to wait for, so it starts at the new speed); LOOP END waits for the seam (`advance`).
   */
  private currentSpeed(): Speed {
    const target = this.targetSpeed();
    if (target !== this.speed && (!this.sounding || this.host.memory.play.speedChange === 'IMMEDIATE')) {
      this.speed = target;
    }
    return this.speed;
  }

  /**
   * The rate counts as 1: the loop's length on the timeline is within half a frame of its length in frames. A synced
   * loop at its own grid tempo with SPEED NORMAL always is (its length was rounded to whole frames); a real tempo or
   * speed change never is. Such a loop plays on the exact path, its drift corrected at the seam.
   */
  private isUnity(rate: number): boolean {
    return Math.abs(rate - 1) * this._take.length <= 0.5 + 1e-9;
  }

  /** A position folded into `[0, length)`: the exact path's seam-corrected frames -1 and `length` are the loop's ends. */
  private wrapped(pos: number): number {
    const len = this._take.length;
    return pos < 0 ? pos + len : pos >= len ? pos - len : pos;
  }

  /** The playback rate at `speed`, clamped to RATE_MIN..RATE_MAX. */
  private rateAt(speed: Speed): number {
    const r = playbackRate(this.cfg.tempoSyncSw, this.host.transport.bpm, this._recordedTempo, speed);
    return r > RATE_MAX ? RATE_MAX : r < RATE_MIN ? RATE_MIN : r;
  }

  /**
   * The rate for the next step, read live (a tempo, speed or TEMPO SYNC change applies from the frame it lands on).
   * Outside RATE_MIN..RATE_MAX it raises TEMPO TOO SLOW or TEMPO TOO FAST, once each time it goes out (INFERRED: the
   * LCD message, not one per block), and plays at the limit.
   */
  private stepRate(): number {
    const r = playbackRate(this.cfg.tempoSyncSw, this.host.transport.bpm, this._recordedTempo, this.currentSpeed());
    const warn = r > RATE_MAX ? 1 : r < RATE_MIN ? -1 : 0;
    if (warn !== this.rateWarn) {
      this.rateWarn = warn;
      if (warn > 0) this.host.post('TEMPO TOO FAST');
      else if (warn < 0) this.host.post('TEMPO TOO SLOW');
    }
    return r > RATE_MAX ? RATE_MAX : r < RATE_MIN ? RATE_MIN : r;
  }

  /** The rate is no longer 1: from here the playhead is fractional and overdubs are splatted. */
  private leaveExact(): void {
    this.exact = false;
    this.seamSkip = false;
    this.replayNext = false;
    this.readPos = this.playhead;
    this.stretchSynced = false;
    if (this._state === 'overdubbing') this.startStream();
  }

  /** Start (or carry on) the splatted write stream at the playhead. */
  private startStream(): void {
    // A fresh stream writes to the current take only (a pass's own writes never reach a snapshot).
    if (this.writer.pending) this.wSinks.add(this._take);
    else this.wSinks.reset(this._take);
    this.writer.begin(this.readPos, this.writeBack);
    this.wq = this.readPos;
    this.wqEnd = this.readPos;
    if (this.wTail === 0) {
      // The input is not continuous with any earlier splices. (A pass from a recording that starts at full gain has
      // passFrames >= the ramp already.)
      const replace = this.passMode !== 'OVERDUB';
      this.splice.reset(this.readPos, replace, this.passFrames, this.host.xfade, this.rateAt(this.speed));
      this.streamXfade = this.cfg.tempoSyncMode === 'XFADE';
    }
  }

  /** The splatted input has ended (the tail is done, or the playhead jumps): close an XFADE overdub's splices. */
  private finishStream(): void {
    this.splice.finish(this.writer, this.wqEnd);
  }

  /** A step's splatted writes: the pass and any punch-out tail, then whatever gathered frames are now complete. */
  private writeSplatted(
    inL: Float32Array,
    inR: Float32Array,
    a: number,
    m: number,
    rate: number,
    sounding: boolean,
    dir: 1 | -1,
  ): void {
    if (this._state === 'overdubbing' || this.wTail > 0) {
      this.splatStep(inL, inR, a, m, sounding ? rate : this.wRate);
      if (this._state !== 'overdubbing' && this.wTail === 0) this.finishStream(); // the punch-out tail just ended
    }
    const active = this._state === 'overdubbing' || this.wTail > 0;
    let limit: number;
    if (sounding && dir > 0) {
      // Behind every read head (the stretcher's lag up to 1.5 grains) and every write still to come (a splice reaches
      // up to 6167 frames at 48 kHz, 4x), from where the
      // playhead will be after this step: this step's reads are done, so only the next step's reads count.
      const next = this.readPos + rate * m;
      limit = (active ? Math.min(this.wq, next) : next) - this.writeDelay;
    } else {
      // Nothing reads ahead of a stopped or reversed playhead in the stream's direction.
      limit = active ? this.wq - SPLAT_MAX_WIDTH - 1 : Infinity;
    }
    if (!this.writer.flush(this.wSinks.takes, limit)) this.writeFailed();
  }

  /**
   * Gather `m` input frames from `in[a, a + m)` into the writer, at `rate` take frames per input frame from stream
   * frame `wq`, with the pass's punch-in gain and the tail's punch-out gain composed per DUB MODE (the tail's write,
   * then the pass's, as on the exact path).
   *
   * INFERRED (overdub at a rate other than 1): PITCH splats each input frame at the fractional playhead, so the next
   * pass at the same rate plays it back as played (tape-style, like the playback). XFADE time-compresses the input by
   * the rate in splices that keep its pitch (`SpliceWriter`), placed at the playhead, so the stretcher plays it back at
   * the pitch it was played. (Splatting at the playhead would store it time-compressed, and the stretcher would then
   * play it back pitch-shifted by 1 / rate.)
   */
  private splatStep(inL: Float32Array, inR: Float32Array, a: number, m: number, rate: number): void {
    const xfade = this.cfg.tempoSyncMode === 'XFADE';
    if (xfade !== this.streamXfade) this.switchWritePath(xfade, rate);
    const xf = this.host.xfade;
    const passing = this._state === 'overdubbing';
    const tail = this.wTail;
    const tailReplace = this.wTailReplace;
    const passReplace = this.passMode !== 'OVERDUB';
    const j0 = this.passFrames;
    const { alphaBuf, betaBuf, writer } = this;
    for (let k = 0; k < m; k++) {
      let al = 1;
      let be = 0;
      if (k < tail) {
        const g = punchOutGain(tail - k, xf);
        if (tailReplace) {
          al *= 1 - g;
          be = be * (1 - g) + g;
        } else {
          be += g;
        }
      }
      if (passing) {
        const g = punchInGain(j0 + k, xf);
        if (passReplace) {
          al *= 1 - g;
          be = be * (1 - g) + g;
        } else {
          be += g;
        }
      }
      alphaBuf[k] = al;
      betaBuf[k] = be;
    }
    const width = rate > 1 ? rate : 1;
    const scale = rate / width;
    const q0 = this.wq;
    // Only the frames that carry input: after a punch-out tail ends, the rest of the step writes nothing.
    const live = passing ? m : Math.min(m, tail);
    if (xfade) {
      const splice = this.splice;
      // (The splices apply the punch gains by take position: see SpliceWriter.)
      for (let k = 0; k < live; k++) splice.push(writer, q0 + rate * k, rate, inL[a + k], inR[a + k]);
    } else {
      for (let k = 0; k < live; k++) {
        writer.deposit(q0 + rate * k, width, scale, inL[a + k], inR[a + k], alphaBuf[k], betaBuf[k]);
      }
    }
    this.wRate = rate;
    this.wqEnd = q0 + rate * live;
    this.wq = q0 + rate * m;
    if (passing) this.passFrames = j0 + m;
    this.wTail = tail > m ? tail - m : 0;
  }

  /**
   * TEMPO SYNC MODE changed in the middle of a splatted pass (or its tail). The old write path is closed at the
   * playhead, keeping everything it wrote, and the new one carries on from there: PITCH splats from the playhead on
   * (the splices are finished there: their gaps filled, nothing kept past it); XFADE opens fresh splices anchored at
   * the playhead, past the PITCH writes, with the pass's punch-in ramp as far as it has got (and a running punch-out
   * fade carried on).
   */
  private switchWritePath(toXfade: boolean, rate: number): void {
    if (toXfade) {
      const xf = this.host.xfade;
      this.splice.reset(this.wq, this.passMode !== 'OVERDUB', this.passFrames, xf, rate);
      if (this.wTail > 0) this.splice.punchOut(this.wq - rate * (xf - this.wTail), rate);
    } else {
      this.splice.finish(this.writer, this.wqEnd);
    }
    this.streamXfade = toXfade;
  }

  /** Write every gathered frame now (the stream ended with a jump of the playhead), cutting a splatted tail. */
  private flushWrites(): void {
    this.finishStream();
    this.wTail = 0;
    if (this.writer.pending && !this.writer.flush(this.wSinks.takes, Infinity)) {
      this.host.post('MEMORY FULL');
    }
  }

  /**
   * Before a new pass (or emptying the track): the gathered writes of passes that have ended land now, in every take
   * they belong to, cutting a splatted punch-out tail still running (only a punch-in within 5 ms of a punch-out at a
   * rate other than 1 does that). The new pass's own writes then never mix with them in the gathering ring.
   */
  private settleWriter(): void {
    if (this.wTail > 0 || this.writer.pending) this.flushWrites();
  }

  /** A gathered write could not get a chunk (MEMORY FULL): the stream ends where it is, like a failed `writePass`. */
  private writeFailed(): void {
    this.host.post('MEMORY FULL');
    this.wTail = 0;
    this.writer.discard();
    this.splice.reset(0);
    if (this._state === 'overdubbing') this.endPass(false);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------------------------------------------------

  /**
   * Render frames `[from, to)` of the block whose first frame is timeline frame `frame0`: record or play, write
   * overdubs and tails, and put the track's output (after PLAY LEVEL, PAN and the fades) in `outL`/`outR`. No command
   * lands inside the range; an armed action fires at its exact frame within it.
   */
  render(
    inL: Float32Array,
    inR: Float32Array,
    outL: Float32Array,
    outR: Float32Array,
    from: number,
    to: number,
    frame0: number,
  ): void {
    let a = from;
    while (a < to) {
      let end = to;
      if (this.arm.action !== null) {
        const due = this.arm.frame - frame0;
        if (due <= a) {
          this.fireArm(frame0 + a);
          continue;
        }
        if (due < end) end = due;
      }
      this.renderSpan(inL, inR, outL, outR, a, end);
      a = end;
    }
  }

  /** Render `[from, to)` with no armed action due inside it. */
  private renderSpan(
    inL: Float32Array,
    inR: Float32Array,
    outL: Float32Array,
    outR: Float32Array,
    from: number,
    to: number,
  ): void {
    let a = from;
    while (a < to) {
      if (this._state === 'recording') {
        a += this.renderRecording(inL, inR, outL, outR, a, to);
        continue;
      }
      const sounding = this.sounding;
      const splatting = this.wTail > 0 || this.writer.pending;
      if (!sounding && this.rel.left === 0 && this.recTail.left === 0 && this.dubTail.left === 0 && !splatting) {
        outL.fill(0, a, to);
        outR.fill(0, a, to);
        return;
      }
      const dir = this.direction();
      const rate = sounding ? this.stepRate() : this.wRate;
      if (sounding && this.exact && !this.isUnity(rate)) this.leaveExact();
      const m = this.stepLength(to - a, sounding, dir, rate);
      const relN = Math.min(m, this.rel.left);
      // Reads first (the output is the audio before this step's writes)...
      if (sounding) this.readPlayback(m, dir, rate);
      // ...then the tails, then the pass. A recording's seam crossfade must land before a REC->DUB pass adds to the
      // same frames, or it would scale the overdub layer down. (Splatted writes are gathered and land later still.)
      if (this.recTail.left > 0) this.writeTail(this.recTail, inL, inR, a, m);
      if (this.dubTail.left > 0) this.writeTail(this.dubTail, inL, inR, a, m);
      if (this.exact) {
        if (this._state === 'overdubbing') this.writePass(inL, inR, a, m);
      } else if (this._state === 'overdubbing' || splatting) {
        this.writeSplatted(inL, inR, a, m, rate, sounding, dir);
      }
      if (sounding || relN > 0) {
        this.emit(outL, outR, a, m, sounding, relN);
      } else {
        outL.fill(0, a, a + m);
        outR.fill(0, a, a + m);
      }
      this.replayNext = false; // a replayed frame lasts one step of one frame
      if (sounding) this.advance(m, dir, rate);
      a += m;
      if (this.punchPending && this.wTail === 0) {
        // The punch-out tail has just ended: the waiting punch-in starts here, as a press on this frame would.
        this.punchPending = false;
        if (this._state === 'playing' && this.stopping === null) this.beginPass(false);
      }
    }
  }

  /**
   * Append input from `a` up to `to`, or up to the length at which the recording ends by itself, and end it there.
   * Returns the frames recorded (0 only when the recording has just ended). On MEMORY FULL the recording ends at
   * once (`forceFinish`) and the track plays (INFERRED: even with REC->DUB, since an overdub could not be stored
   * either).
   */
  private renderRecording(
    inL: Float32Array,
    inR: Float32Array,
    outL: Float32Array,
    outR: Float32Array,
    a: number,
    to: number,
  ): number {
    const take = this._take;
    const tm = this.targetMeasures();
    const target = tm === null ? 0 : this.measuresToFrames(tm);
    if (tm !== null && take.length >= target) {
      this.reachTarget(target, tm);
      return 0;
    }
    const want = tm === null ? to - a : Math.min(to - a, target - take.length);
    const before = take.length;
    const ok = take.append(inL, inR, want, a);
    const got = take.length - before;
    // The input is monitored by the mixer, not the track; a loop cleared just before may still be ramping out.
    if (this.rel.left > 0) {
      this.emit(outL, outR, a, got, false, Math.min(got, this.rel.left));
    } else {
      outL.fill(0, a, a + got);
      outR.fill(0, a, a + got);
    }
    if (!ok) {
      this.host.post('MEMORY FULL');
      this.forceFinish();
    } else if (tm !== null && take.length >= target) {
      this.reachTarget(target, tm);
    }
    return got;
  }

  /** The recording reached its length: it ends per the waiting press, or per REC ACTION when it ended by itself. */
  private reachTarget(T: number, measures: number): void {
    const next = this.recEnd ?? (this.host.memory.rec.recAction === 'REC->DUB' ? 'dub' : 'play');
    this.closeLoop(T, next, measures);
  }

  /** Frames to render in one step: up to the loop end (in the play direction) and the end of a FADE stop. */
  private stepLength(max: number, sounding: boolean, dir: 1 | -1, rate: number): number {
    let m = Math.min(max, STEP);
    if (sounding) {
      const len = this._take.length;
      const p = this.playhead;
      let left: number;
      if (!this.exact) left = this.framesToSeam(len, p, dir, rate);
      else if (p < 0 || p >= len || this.replayNext) left = 1; // a replayed frame (seam correction)
      else left = dir > 0 ? len - p : p + 1;
      m = Math.min(m, left);
      if (this.stopping === 'FADE') m = Math.min(m, Math.max(1, this.env.remaining));
    }
    if (this.punchPending && this.wTail > 0) m = Math.min(m, this.wTail); // a waiting punch-in starts on its frame
    return m;
  }

  /**
   * Frames until the playhead `p`, moving `rate` per frame in direction `dir`, crosses the loop end: the first frame
   * count `k` at which `p + rate * k >= len` (forwards) or `p - rate * k < 0` (backwards), so the last frame read is
   * still inside the loop and the next lands past the seam.
   */
  private framesToSeam(len: number, p: number, dir: 1 | -1, rate: number): number {
    let k: number;
    if (dir > 0) {
      k = Math.max(1, Math.ceil((len - p) / rate));
      while (k > 1 && p + rate * (k - 1) >= len) k--;
      while (p + rate * k < len) k++;
    } else {
      k = Math.max(1, Math.floor(p / rate) + 1);
      while (k > 1 && p - rate * (k - 1) < 0) k--;
      while (p - rate * k >= 0) k++;
    }
    return k;
  }

  /**
   * The take's audio under the next `m` frames of the playhead into `rawL`/`rawR`, in play order: whole frames on the
   * exact path; otherwise TEMPO SYNC MODE PITCH reads between samples at the rate (tape-style), and XFADE runs the
   * stretcher, whose source position is the playhead.
   */
  private readPlayback(m: number, dir: 1 | -1, rate: number): void {
    const { rawL, rawR } = this;
    const len = this._take.length;
    this.usedHeads = false;
    if (this.exact) {
      if (this.playhead < 0 || this.playhead >= len || this.replayNext) {
        // A replayed frame (seam correction, m is 1): the frame as it sounded a moment ago. An overdub pass has written
        // it since, and that layer must not be heard until the next pass.
        rawL[0] = this.lastRawL;
        rawR[0] = this.lastRawR;
      } else if (dir > 0) {
        this._take.read(this.playhead, rawL, rawR, 0, m);
      } else {
        this._take.read(this.playhead - m + 1, rawL, rawR, 0, m);
        reverseInPlace(rawL, 0, m);
        reverseInPlace(rawR, 0, m);
      }
      this.lastRawL = rawL[m - 1];
      this.lastRawR = rawR[m - 1];
      return;
    }
    const v = dir * rate;
    if (this.cfg.tempoSyncMode === 'XFADE') {
      if (!this.stretchSynced) {
        this.stretch.reset(this.playhead);
        this.stretchSynced = true;
      }
      // A 1SHOT plays once: its heads read silence past the take's ends rather than wrapping to its other end.
      this.stretch.bounded = this.cfg.oneShot;
      this.stretch.render(this._take, v, m, rawL, rawR, 0);
      this.usedHeads = true;
      return;
    }
    // INFERRED: a switch from XFADE to PITCH mid-loop drops the stretcher at once (a small step in the output).
    this.stretchSynced = false;
    const p = this.playhead;
    const bounded = this.cfg.oneShot;
    for (let k = 0; k < m; k++) readInterpolated(this._take, p + v * k, rawL, rawR, k, bounded);
  }

  /**
   * Write `m` frames of input at the playhead per the pass's DUB MODE, with the punch-in ramp. After a seam correction
   * skipped a frame, the first input frame is written to the skipped frame too, so no frame misses a pass (a hole
   * there would step by the whole layer and grow with every pass). A replayed frame's input frame is dropped: the
   * playhead sits outside the take, and `AudioTake.write` writes nothing there.
   */
  private writePass(inL: Float32Array, inR: Float32Array, a: number, m: number): void {
    const xf = this.host.xfade;
    const j0 = this.passFrames;
    const { srcL, srcR, tmpL, tmpR } = this;
    const replace = this.passMode !== 'OVERDUB';
    if (this.replayNext) {
      this.passFrames = j0 + m; // a replayed frame (m is 1): its input frame is dropped, as at frame -1
      return;
    }
    if (this.seamSkip) {
      this.seamSkip = false;
      const g = punchInGain(j0, xf);
      const at = this.playhead - 1;
      if (replace) {
        this._take.read(at, tmpL, tmpR, 0, 1);
        srcL[0] = tmpL[0] * (1 - g) + inL[a] * g;
        srcR[0] = tmpR[0] * (1 - g) + inR[a] * g;
      } else {
        srcL[0] = inL[a] * g;
        srcR[0] = inR[a] * g;
      }
      if (!this._take.write(at, srcL, srcR, 1, replace ? 'replace' : 'add')) {
        this.host.post('MEMORY FULL');
        this.endPass(false);
        return;
      }
    }
    if (replace) {
      // The audio being replaced as it is now, after any tail written this step.
      this._take.read(this.playhead, tmpL, tmpR, 0, m);
      for (let k = 0; k < m; k++) {
        const g = punchInGain(j0 + k, xf);
        srcL[k] = tmpL[k] * (1 - g) + inL[a + k] * g;
        srcR[k] = tmpR[k] * (1 - g) + inR[a + k] * g;
      }
    } else {
      for (let k = 0; k < m; k++) {
        const g = punchInGain(j0 + k, xf);
        srcL[k] = inL[a + k] * g;
        srcR[k] = inR[a + k] * g;
      }
    }
    this.passFrames = j0 + m;
    if (!this._take.write(this.playhead, srcL, srcR, m, replace ? 'replace' : 'add')) {
      // A copy-on-write chunk could not be had: nothing was written. End the pass where it is.
      this.host.post('MEMORY FULL');
      this.endPass(false);
    }
  }

  /**
   * Write up to `m` frames of a seam or punch-out tail, wrapping at the loop end, into each take it lands in (the
   * take it started in and the snapshots taken since; see `Sinks`). When the seam crossfade ends, REC BACK shares the
   * current take's chunks again if it can (`recShare`).
   */
  private writeTail(tail: Tail, inL: Float32Array, inR: Float32Array, a: number, m: number): void {
    const n = Math.min(m, tail.left);
    const takes = tail.sinks.takes;
    let len = 0;
    for (let t = 0; t < takes.length; t++) {
      const take = takes[t];
      if (take === null || take.length === 0 || (len > 0 && take.length !== len)) continue;
      len = take.length;
      if (!this.writeTailInto(take, tail, inL, inR, a, n) && take.length > 0) {
        this.host.post('MEMORY FULL');
        tail.left = 0;
        tail.sinks.reset(null);
        return;
      }
    }
    tail.left -= n;
    if (len > 0) {
      tail.pos += n;
      if (tail.pos >= len) tail.pos -= len;
    }
    if (tail.left > 0) return;
    if (tail === this.recTail && this.recShare !== null && tail.sinks.has(this._take)) {
      this.recShare.shareFrom(this._take);
    }
    if (tail === this.recTail) this.recShare = null;
    tail.sinks.reset(null);
  }

  /** `n` frames of `tail` into `take` from where the tail has got to. False on MEMORY FULL (nothing more written). */
  private writeTailInto(take: AudioTake, tail: Tail, inL: Float32Array, inR: Float32Array, a: number, n: number): boolean {
    const xf = this.host.xfade;
    const len = take.length;
    const { srcL, srcR, tmpL, tmpR } = this;
    let pos = tail.pos;
    let left = tail.left;
    let k = 0;
    while (k < n) {
      const piece = Math.min(n - k, len - pos);
      if (tail.replace) take.read(pos, tmpL, tmpR, 0, piece);
      for (let i = 0; i < piece; i++) {
        const g = punchOutGain(left - i, xf);
        const x = a + k + i;
        if (tail.replace) {
          srcL[i] = tmpL[i] * (1 - g) + inL[x] * g;
          srcR[i] = tmpR[i] * (1 - g) + inR[x] * g;
        } else {
          srcL[i] = inL[x] * g;
          srcR[i] = inR[x] * g;
        }
      }
      if (!take.write(pos, srcL, srcR, piece, tail.replace ? 'replace' : 'add')) return false;
      left -= piece;
      pos += piece;
      if (pos >= len) pos = 0;
      k += piece;
    }
    return true;
  }

  /**
   * The step's output: (playback x start/stop fade x REPLACE2 mute x ramp-in, plus the release voice for its first
   * `relN` frames) x PLAY LEVEL x PAN.
   */
  private emit(outL: Float32Array, outR: Float32Array, a: number, m: number, sounding: boolean, relN: number): void {
    const cfg = this.cfg;
    const level = cfg.playLevel / 100; // INFERRED: linear, 100 = unity, 200 = x2
    // INFERRED: a balance law, unity at CENTER (a mono input recorded in the center plays back at the level it went
    // in); the far side falls linearly to silence at L50/R50.
    const pan = cfg.pan;
    const gl = level * (pan > 0 ? 1 - pan / 50 : 1);
    const gr = level * (pan < 0 ? 1 + pan / 50 : 1);
    const { rawL, rawR, relBufL, relBufR, env, mute, attack, rel } = this;
    const xf = this.host.xfade;
    const relGain = rel.gain;
    const relLeft = rel.left;
    const relOff = xf - relLeft;
    let peak = this.peakAbs;
    for (let k = 0; k < m; k++) {
      let l = 0;
      let r = 0;
      if (sounding) {
        const g = env.next() * mute.next() * attack.next();
        l = rawL[k] * g;
        r = rawR[k] * g;
      }
      if (k < relN) {
        const g = relGain * punchOutGain(relLeft - k, xf);
        l += relBufL[relOff + k] * g;
        r += relBufR[relOff + k] * g;
      }
      l *= gl;
      r *= gr;
      outL[a + k] = l;
      outR[a + k] = r;
      const al = l < 0 ? -l : l;
      const ar = r < 0 ? -r : r;
      if (al > peak) peak = al;
      if (ar > peak) peak = ar;
    }
    this.peakAbs = peak;
    rel.left = relLeft - relN;
  }

  /**
   * Move the playhead on by `m` frames at `rate`; handle the loop end (wrap, a SPEED CHANGE LOOP END, 1SHOT end, LOOP
   * stop, the exact path's seam correction, a return to the exact path) and the end of a FADE stop. A fractional
   * playhead keeps its fraction across the seam.
   */
  private advance(m: number, dir: 1 | -1, rate: number): void {
    const len = this._take.length;
    const step = this.exact ? dir * m : dir * rate * m;
    this.playhead = this.usedHeads ? this.stretch.position : this.playhead + step;
    this.readPos += step;
    // Only `length` (forwards) or below 0 (backwards) is past the seam. A seam-corrected frame (-1 forwards, `length`
    // backwards) is already past it and steps back into the loop, also when the step that leaves it is fractional (a
    // tempo change on that very frame must not cross the seam a second time).
    const past = dir > 0 ? this.playhead >= len : this.playhead < 0;
    if (!past && !this.exact && (this.playhead < -1 || this.playhead > len)) {
      // Only after the play direction flipped: fold back into the loop without a seam.
      const folded = ((this.playhead % len) + len) % len;
      if (this.stretchSynced) this.stretch.shift(folded - this.playhead);
      this.playhead = folded;
    }
    if (past) {
      const shift = this.playhead >= len ? -len : len;
      this.playhead += shift; // exact: len -> 0 forwards, -1 -> len - 1 backwards
      if (this.stretchSynced) this.stretch.shift(shift);
      if (this.playhead >= len || this.playhead < 0) {
        // Only a loop shorter than one step at 4x gets here.
        this.playhead = ((this.playhead % len) + len) % len;
        this.stretchSynced = false;
      }
      this.speed = this.targetSpeed(); // the seam: where SPEED CHANGE LOOP END switches
      if (this.cfg.oneShot || this.stopping === 'LOOP') {
        // The release runs on from the wrapped position: the seam crossfade made it the loop end's continuation.
        // (INFERRED: the 5 ms ramp follows the loop end rather than taking the loop's last 5 ms.)
        this.startRelease(dir);
        if (this._state === 'overdubbing') this.endPass(true);
        this.toStopped();
        return;
      }
      if (this.exact) this.correctSeam(dir, rate);
      else if (this.isUnity(this.rateAt(this.speed))) this.enterExactAtSeam(dir);
    }
    if (this.stopping === 'FADE' && !this.env.active) this.toStopped();
  }

  /**
   * The exact path at the seam (ruling R45). The loop's true length on the timeline is `length / rate`, a fraction of
   * a frame off its length in frames; `seamPhase` holds how far the pass just ended ran from that ideal. The next pass
   * starts a frame early (replaying the frame just played, as frame -1 or `length`), on time, or a frame late (skipping
   * the loop's first frame), whichever keeps the error centred on zero over the coming pass, so it stays within 0.75
   * of a frame. Both land in the seam crossfade. During an overdub a replayed frame plays as it was before the pass
   * wrote it and its input frame is dropped, and a skipped frame is written with the next input frame too (INFERRED:
   * a one-sample stall or skip in that layer, at the crossfaded seam).
   */
  private correctSeam(dir: 1 | -1, rate: number): void {
    const len = this._take.length;
    const drift = len / rate - len; // ideal pass length minus actual, in frames (at most 0.5)
    if (drift === 0 && this.seamPhase === 0) return;
    let shift = -Math.round(this.seamPhase + 1.5 * drift);
    if (shift < -1) shift = -1;
    else if (shift > 1) shift = 1;
    this.seamPhase += drift + shift;
    this.playhead = dir > 0 ? shift : len - 1 - shift;
    if (shift > 0 && this._state === 'overdubbing') this.seamSkip = true;
  }

  /**
   * The rate is back to 1 (a tempo nudged back, a speed or SPEED MOMENT back to NORMAL, TEMPO SYNC SW off): at this
   * seam the fractional playhead rounds to a whole frame and the exact path resumes, keeping the fraction as its seam
   * phase, crossfaded over 5 ms. Gathered writes land now (they are behind the playhead) and a running pass carries on
   * writing whole frames.
   */
  private enterExactAtSeam(dir: 1 | -1): void {
    // The stretched (or interpolated) playback fades out over 5 ms from where it is, through the release voice, while
    // the exact read ramps in, as `retrigger` does: a cut here would click.
    this.startRelease(dir);
    const len = this._take.length;
    const frac = this.playhead;
    let p = Math.round(frac);
    if (p >= len) p = len - 1;
    this.seamPhase = dir > 0 ? p - frac : frac - p;
    this.flushWrites();
    this.playhead = p;
    this.readPos = p;
    this.exact = true;
    this.stretchSynced = false;
    this.rampIn();
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Reporting
  // -------------------------------------------------------------------------------------------------------------------

  /** This track's status. Resets the peak, which covers the time since the previous call. */
  status(): TrackStatus {
    const len = this._take.length;
    const sounding = this.sounding;
    const peak = this.peakAbs;
    this.peakAbs = 0;
    return {
      state: this._state,
      // An armed start or recording, or the action a recording will end in once it reaches its line (a REC->DUB end
      // on a track that cannot overdub ends in playback, so it shows 'play').
      pending:
        (this.arm.action === 'start' ? 'play' : this.arm.action) ??
        (this.punchPending ? 'dub' : null) ??
        (this._state !== 'recording' ? null : this.recEnd === 'dub' && !this.canDub() ? 'play' : this.recEnd),
      stopping: this.stopping !== null,
      autoRecWaiting: false,
      // INFERRED: the playhead's place in the take, so it runs 1 -> 0 in REVERSE; 0 when not playing.
      position: sounding && len > 0 ? this.wrapped(this.playhead) / len : 0,
      lengthFrames: len, // grows while recording
      measures: this._measures, // null for free loops
      peak,
      canUndo: this.undoSnap !== null,
      canRedo: this.redoSnap !== null,
      hasMark: this.markSnap !== null,
      speed: this.currentSpeed(),
    };
  }

  /**
   * Write every gathered overdub frame into the takes it belongs to now. Returns true when the current take is then
   * complete: no pass, and no seam or punch-out tail or gathered write (on either path) is still bound for it.
   *
   * At a rate other than 1 an overdub's writes are gathered and land `writeDelay` behind the playhead (6175 frames,
   * about 129 ms at 48 kHz, PITCH and XFADE alike) after the pass; the punch-out tail writes for 5 ms after the press
   * on every path. While a pass or tail is still running, only the frames it can no longer reach are written (writing
   * the rest early would lose their later contributions) and it returns false. The history snapshots call it and then
   * join the writes still in flight (`shareTake`); a save or export bakes the rest into its copy (`exportSnapshot`).
   */
  flushPendingWrites(): boolean {
    const active = this._state === 'overdubbing' || this.wTail > 0;
    if (this.writer.pending) {
      const limit = active ? Math.min(this.wq, this.readPos) - this.writeDelay : Infinity;
      if (!this.writer.flush(this.wSinks.takes, limit)) this.writeFailed();
    }
    const cur = this._take;
    return (
      this._state !== 'overdubbing' &&
      !((this.wTail > 0 || this.writer.pending) && this.wSinks.has(cur)) &&
      !(this.dubTail.left > 0 && this.dubTail.sinks.has(cur)) &&
      !(this.recTail.left > 0 && this.recTail.sinks.has(cur))
    );
  }

  /**
   * A copy-on-write snapshot of the loop to save or export, or null while the track is empty or its first recording
   * is still running. The gathered writes that can land now land in the take (`flushPendingWrites`); those that cannot
   * yet (a pass that ended under ~129 ms ago at a rate other than 1, binding note 2) are baked into the snapshot only,
   * as they stand, and still land in the take in their own time. What a tail has not yet received (its last few ms of
   * input) is not in it. The caller releases it.
   *
   * Side effects (fix round 1, item 5):
   *  - During a pass at a rate other than 1 the bake writes frames whose gathering is not finished (the pass is still
   *    adding to them): the copy holds the pass as far as it has got, partial averages at its leading edge included.
   *    The live take is not touched by the bake.
   *  - The bake writes into the snapshot, so its chunks are copied (copy-on-write; at most the 1-2 chunks the gathered
   *    span covers). At the memory budget that can make the pool reclaim undo history: a save or export made when
   *    memory is full can drop undo, redo, the mark or REC BACK (never the loop itself). If even that leaves no room,
   *    the copy just lacks those frames.
   */
  exportSnapshot(): AudioTake | null {
    if (this._state === 'empty' || this._state === 'recording') return null;
    this.flushPendingWrites();
    const snap = this._take.snapshot();
    // (On MEMORY FULL the copy simply lacks those frames, as it did before the bake.)
    if (this.writer.pending && this.wSinks.has(this._take)) this.writer.bake(snap);
    return snap;
  }

  /** A copy of the loop (`exportSnapshot` as arrays), or null while the track is empty or still recording. */
  audio(): TrackAudio | null {
    const snap = this.exportSnapshot();
    if (snap === null) return null;
    const { L, R } = snap.toArrays();
    snap.release();
    return { L, R, sampleRate: this.host.sr, recordedTempo: this._recordedTempo, measures: this._measures };
  }
}
