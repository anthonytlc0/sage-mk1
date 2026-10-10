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
 * Nothing here allocates while rendering. Scratch buffers are per track; the only allocations are the take's own
 * 1-second chunks while recording (or copy-on-write), and a fresh take shell when one is cleared.
 */
import { AudioTake } from './chunks';
import type { ChunkPool } from './chunks';
import { deriveTempo, noteFrames, snapLength } from './transport';
import type { Transport } from './transport';
import { Ramp, fadeTimeFrames, punchInGain, punchOutGain } from './fade';
import { phraseOffset } from './sync';
import type { LoopSync, SyncTrack } from './sync';
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
}

/** Frames per inner render step, and the size of the scratch buffers. */
const STEP = 256;

type DubMode = TrackSettings['dubMode'];
/** What follows a recording. */
type EndAction = 'play' | 'dub' | 'stop';
/** The grid an armed action waits on: measure lines, or LOOP LENGTH lines. */
type ArmUnit = 'measure' | 'loop';

/**
 * Input still being written after a pass ended: `left` frames from take position `pos`, at a gain falling from 1 to
 * 1/xfade (`punchOutGain`). A `replace` tail crossfades the take's audio back in as the input fades out.
 */
interface Tail {
  pos: number;
  left: number;
  replace: boolean;
}

/**
 * The last 5 ms of playback after a cut: the `left` frames still to play of a copy (`relBufL`/`relBufR`) taken at the
 * cut, at `gain` (the track's fade gain at the cut) times a fall from 1 to 1/xfade.
 */
interface Release {
  left: number;
  gain: number;
}

/** The armed slot: one action waiting for the timeline frame `frame`, re-aimed on the `unit` grid when it moves. */
interface Arm {
  action: 'rec' | 'play' | null;
  frame: number;
  unit: ArmUnit;
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
  private readonly recTail: Tail = { pos: 0, left: 0, replace: true };
  /** The punch-out still to write after an overdub ended. */
  private readonly dubTail: Tail = { pos: 0, left: 0, replace: false };

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
  }

  get state(): TrackState {
    return this._state;
  }

  /** The current audio. Replaced (never reused) when the track is cleared or loaded. */
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

  /** The grid moved (a tempo or beat change): aim the armed action at the same line, now at a new frame. */
  retarget(frame: number): void {
    if (this.arm.action === null) return;
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
        this.beginPass(false);
        return;
    }
  }

  /**
   * STOP, per STOP MODE. A second STOP during a FADE or LOOP stop stops at once (with the 5 ms ramp-out). STOP cancels
   * an armed action instead, leaving the track as it was.
   */
  stop(): void {
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
    if (this._state === 'recording') this.forceFinish();
    else if (this._state === 'overdubbing') this.endPass(true);
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
    this._state = 'recording'; // the take is always fresh and empty here
    this.recStart = frame;
    this.recEnd = null;
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
    const M = this.host.sync.measure();
    const measures = this.fixedMeasures() ?? Math.round(snapLength(len, M) / M);
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
    const M = this.host.sync.measure();
    const whole = Math.floor(len / M + 1e-9);
    if (whole >= 1) {
      this.closeLoop(Math.min(len, Math.round(whole * M)), next, whole);
    } else if (len <= 2 * this.host.xfade) {
      this.reset();
    } else {
      this.closeLoop(len, next, len / M);
    }
  }

  /**
   * Make the first `T` frames of the recording the loop, `measures` long, and move on to `next`.
   *
   * Frames recorded past `T` (a late press, or a trim) are the input that followed the loop end. Their first 5 ms are
   * crossfaded into the loop start, exactly as the live input is after an on-time press, and the rest are dropped.
   * Playback then picks up where the loop has got to since `T`, so it is in step with the grid at once.
   */
  private closeLoop(T: number, next: EndAction, measures: number | null): void {
    const take = this._take;
    const xf = this.host.xfade;
    const over = take.length - T;
    const baked = Math.min(xf, over);
    if (baked > 0) this.bakeSeam(T, baked);
    if (over > 0) take.truncate(T);
    // The rest of the seam crossfade comes from the live input.
    this.recTail.pos = baked;
    this.recTail.left = xf - baked;
    this.recEnd = null;
    this._measures = measures;
    this._loopSeq = this.host.sync.nextSeq();
    // INFERRED: a free loop has no tempo of its own; it takes the memory tempo of the moment its recording ends.
    this._recordedTempo = this.host.transport.bpm;
    this.host.audioChanged();
    if (next === 'stop') {
      this.toStopped();
      return;
    }
    // INFERRED: playback straight after a recording starts at full level (after the 5 ms ramp-in from the silent
    // recording); START MODE applies to starts from stopped.
    this._state = 'playing';
    this.stopping = null;
    this.env.set(1);
    this.mute.set(1);
    this.rampIn();
    const into = over % T;
    this.playhead = this.cfg.reverse ? T - 1 - into : into;
    // REC->DUB on a REVERSE or 1SHOT track, which cannot overdub, ends in playback (INFERRED).
    if (next === 'dub' && !this.cfg.reverse && !this.cfg.oneShot) this.beginPass(true);
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

  /** `measures` in whole frames at the current tempo (never so short that the recording would be discarded). */
  private measuresToFrames(measures: number): number {
    return Math.max(2 * this.host.xfade + 1, Math.round(measures * this.host.sync.measure()));
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

  /** REC/DUB/PLAY on a stopped track, per LOOP SYNC MODE. */
  private startFromStopped(now: number): void {
    const cfg = this.cfg;
    const sync = this.host.sync;
    if (!cfg.loopSyncSw) {
      this.startPlayback(this.startPosition());
      return;
    }
    if (!sync.gridRunning(this)) {
      // INFERRED: nothing to keep time with, so start now; the grid restarts here.
      sync.anchor(now, this);
      this.startPlayback(this.startPosition());
      return;
    }
    if (cfg.loopSyncMode !== 'IMMEDIATE') {
      // MEASURE: the next measure line; LOOP LENGTH: the next line in LOOP LENGTH units (INFERRED from the guide's
      // "starts in time with the beginning of other tracks, in units set by LOOP LENGTH").
      const unit: ArmUnit = cfg.loopSyncMode === 'MEASURE' ? 'measure' : 'loop';
      const at = sync.boundary(now, this.unitFrames(unit));
      if (at > now) this.setArm('play', at, unit);
      else this.startPlayback(this.alignedPosition(now));
      return;
    }
    // IMMEDIATE starts now. SYNC ADJUST: within one measure (or beat) of a phrase line, either side, the start snaps
    // into step with it (INFERRED: at once, at the aligned position, rather than waiting for the line).
    const len = this._take.length;
    const off = phraseOffset(now, sync.origin, len);
    const window = this.host.memory.play.syncAdjust === 'BEAT' ? sync.beat() : sync.measure();
    const near = off <= window || len - off <= window;
    this.startPlayback(near ? this.alignedPosition(now) : this.startPosition());
  }

  /**
   * The phrase position in step with the grid at `frame`: `(frame - origin) mod length` (mirrored in REVERSE). A
   * 1SHOT plays once from its start, so it always starts there (INFERRED).
   */
  private alignedPosition(frame: number): number {
    if (this.cfg.oneShot) return this.startPosition();
    const len = this._take.length;
    const off = Math.round(phraseOffset(frame, this.host.sync.origin, len)) % len;
    return this.cfg.reverse ? len - 1 - off : off;
  }

  /** Frames between the lines an armed action waits on. */
  private unitFrames(unit: ArmUnit): number {
    const sync = this.host.sync;
    const M = sync.measure();
    if (unit === 'measure') return M;
    const loopLength = this.host.memory.play.loopLength;
    return (typeof loopLength === 'number' ? loopLength : (sync.firstMeasures(null) ?? 1)) * M;
  }

  private setArm(action: 'rec' | 'play', frame: number, unit: ArmUnit): void {
    this.arm.action = action;
    this.arm.frame = frame;
    this.arm.unit = unit;
  }

  /** The armed action's line has come: act at timeline frame `frame`. */
  private fireArm(frame: number): void {
    const action = this.arm.action;
    this.arm.action = null;
    if (action === 'rec') this.beginRecording(frame);
    else if (action === 'play') this.startPlayback(this.alignedPosition(frame));
  }

  /** Start playback at take position `pos`, per START MODE. */
  private startPlayback(pos: number): void {
    this._state = 'playing';
    this.stopping = null;
    this.mute.set(1);
    this.playhead = pos;
    if (this.cfg.startMode === 'FADE') {
      this.attack.set(1); // the fade itself starts from 0
      this.env.set(0);
      this.env.start(1, this.fadeTime(this.host.memory.play.fadeIn));
    } else {
      this.env.set(1);
      this.rampIn();
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Transitions
  // -------------------------------------------------------------------------------------------------------------------

  /** 1SHOT retrigger: the old position fades out (release) while the start fades in, both over 5 ms. */
  private retrigger(): void {
    this.startRelease(this.direction());
    this.playhead = this.startPosition();
    this.rampIn();
  }

  /**
   * Punch in at the playhead. The DUB MODE is fixed for the pass (INFERRED: a change applies from the next pass).
   * `fromRecording`: the pass follows a recording, during which the track output nothing, so REPLACE2 is muted at once
   * rather than ramped (it must never play the track). And where the recording's seam crossfade is still running under
   * the playhead (it starts there, at `recTail.pos`), the pass carries it on rather than ramping in afresh: a REPLACE
   * pass writes the input at full gain (a second ramp would dip the level by 1 - u + u^2), and an OVERDUB pass takes
   * its ramp up where the seam has got to, so the two input gains still sum to 1 after a late end press.
   */
  private beginPass(fromRecording: boolean): void {
    this._state = 'overdubbing';
    this.passMode = this.cfg.dubMode;
    const replace = this.passMode !== 'OVERDUB';
    const seam = fromRecording && this.recTail.left > 0;
    this.passFrames = !seam ? 0 : replace ? this.host.xfade : this.recTail.pos;
    if (this.passMode === 'REPLACE2') {
      if (fromRecording) this.mute.set(0);
      else this.mute.start(0, this.host.xfade);
    }
  }

  /** Punch out: back to playing. `tail` keeps writing the fading input for 5 ms (not after MEMORY FULL). */
  private endPass(tail: boolean): void {
    if (tail) {
      // A tail still running from a pass that ended under 5 ms ago is cut short (a negligible overlap).
      this.dubTail.pos = this.playhead;
      this.dubTail.left = this.host.xfade;
      this.dubTail.replace = this.passMode !== 'OVERDUB';
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
    let pos = this.playhead;
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

  private toStopped(): void {
    this._state = 'stopped';
    this.stopping = null;
    this.playhead = 0;
    this.env.set(1);
    this.mute.set(1);
    this.attack.set(1);
  }

  /**
   * Release the take for a fresh one and return to empty, cancelling everything in flight except the release voice,
   * which plays from its own copy.
   */
  private reset(): void {
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
      if (!sounding && this.rel.left === 0 && this.recTail.left === 0 && this.dubTail.left === 0) {
        outL.fill(0, a, to);
        outR.fill(0, a, to);
        return;
      }
      const dir = this.direction();
      const m = this.stepLength(to - a, sounding, dir);
      const relN = Math.min(m, this.rel.left);
      // Reads first (the output is the audio before this step's writes)...
      if (sounding) this.readPlayback(m, dir);
      // ...then the tails, then the pass. A recording's seam crossfade must land before a REC->DUB pass adds to the
      // same frames, or it would scale the overdub layer down.
      if (this.recTail.left > 0) this.writeTail(this.recTail, inL, inR, a, m);
      if (this.dubTail.left > 0) this.writeTail(this.dubTail, inL, inR, a, m);
      if (this._state === 'overdubbing') this.writePass(inL, inR, a, m);
      if (sounding || relN > 0) {
        this.emit(outL, outR, a, m, sounding, relN);
      } else {
        outL.fill(0, a, a + m);
        outR.fill(0, a, a + m);
      }
      if (sounding) this.advance(m, dir);
      a += m;
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
  private stepLength(max: number, sounding: boolean, dir: 1 | -1): number {
    let m = Math.min(max, STEP);
    if (sounding) {
      m = Math.min(m, dir > 0 ? this._take.length - this.playhead : this.playhead + 1);
      if (this.stopping === 'FADE') m = Math.min(m, Math.max(1, this.env.remaining));
    }
    return m;
  }

  /** The take's audio under the next `m` frames of the playhead into `rawL`/`rawR`, in play order. */
  private readPlayback(m: number, dir: 1 | -1): void {
    if (dir > 0) {
      this._take.read(this.playhead, this.rawL, this.rawR, 0, m);
    } else {
      this._take.read(this.playhead - m + 1, this.rawL, this.rawR, 0, m);
      reverseInPlace(this.rawL, 0, m);
      reverseInPlace(this.rawR, 0, m);
    }
  }

  /** Write `m` frames of input at the playhead per the pass's DUB MODE, with the punch-in ramp. */
  private writePass(inL: Float32Array, inR: Float32Array, a: number, m: number): void {
    const xf = this.host.xfade;
    const j0 = this.passFrames;
    const { srcL, srcR, tmpL, tmpR } = this;
    const replace = this.passMode !== 'OVERDUB';
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

  /** Write up to `m` frames of a punch-out tail, wrapping at the loop end. */
  private writeTail(tail: Tail, inL: Float32Array, inR: Float32Array, a: number, m: number): void {
    const xf = this.host.xfade;
    const len = this._take.length;
    const { srcL, srcR, tmpL, tmpR } = this;
    const n = Math.min(m, tail.left);
    let k = 0;
    while (k < n) {
      const piece = Math.min(n - k, len - tail.pos);
      if (tail.replace) this._take.read(tail.pos, tmpL, tmpR, 0, piece);
      for (let i = 0; i < piece; i++) {
        const g = punchOutGain(tail.left - i, xf);
        const x = a + k + i;
        if (tail.replace) {
          srcL[i] = tmpL[i] * (1 - g) + inL[x] * g;
          srcR[i] = tmpR[i] * (1 - g) + inR[x] * g;
        } else {
          srcL[i] = inL[x] * g;
          srcR[i] = inR[x] * g;
        }
      }
      if (!this._take.write(tail.pos, srcL, srcR, piece, tail.replace ? 'replace' : 'add')) {
        this.host.post('MEMORY FULL');
        tail.left = 0;
        return;
      }
      tail.left -= piece;
      tail.pos += piece;
      if (tail.pos >= len) tail.pos = 0;
      k += piece;
    }
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

  /** Move the playhead `m` frames on; handle the loop end (wrap, 1SHOT end, LOOP stop) and the end of a FADE stop. */
  private advance(m: number, dir: 1 | -1): void {
    const len = this._take.length;
    this.playhead += dir * m;
    if (this.playhead >= len || this.playhead < 0) {
      this.playhead = dir > 0 ? 0 : len - 1;
      if (this.cfg.oneShot || this.stopping === 'LOOP') {
        // The release runs on from the wrapped position: the seam crossfade made it the loop end's continuation.
        // (INFERRED: the 5 ms ramp follows the loop end rather than taking the loop's last 5 ms.)
        this.startRelease(dir);
        if (this._state === 'overdubbing') this.endPass(true);
        this.toStopped();
        return;
      }
    }
    if (this.stopping === 'FADE' && !this.env.active) this.toStopped();
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
      // An armed start or recording, or the action a recording will end in once it reaches its line.
      pending: this.arm.action ?? (this._state === 'recording' ? this.recEnd : null),
      stopping: this.stopping !== null,
      autoRecWaiting: false,
      // INFERRED: the playhead's place in the take, so it runs 1 -> 0 in REVERSE; 0 when not playing.
      position: sounding && len > 0 ? this.playhead / len : 0,
      lengthFrames: len, // grows while recording
      measures: this._measures, // null for free loops
      peak,
      canUndo: false,
      canRedo: false,
      hasMark: false,
      speed: 'NORMAL',
    };
  }

  /** A copy of the loop, or null while the track is empty or its first recording is still running. */
  audio(): TrackAudio | null {
    if (this._state === 'empty' || this._state === 'recording') return null;
    const { L, R } = this._take.toArrays();
    return { L, R, sampleRate: this.host.sr, recordedTempo: this._recordedTempo, measures: this._measures };
  }
}
