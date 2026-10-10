/**
 * One looper track: the state machine of the spec's "Track states" and "Dub modes", its audio (an `AudioTake`), the
 * playhead, and the fades and crossfades that keep it click-free.
 *
 * States: empty -> recording -> playing <-> overdubbing, and stopped. REC ACTION picks what ends a recording
 * (REC->PLAY: playback, REC->DUB: overdub). A loop's length is set when its recording ends.
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
 *    loop start are never faded. Loaded audio gets no seam crossfade; it was baked when first recorded.)
 *  - Overdub punch-in: the input fades in over 5 ms. Punch-out: it keeps being written for 5 ms after the press,
 *    fading out (a "tail"). REPLACE passes crossfade the old audio out and back in the same way.
 *  - REPLACE2 mutes and unmutes the track output over 5 ms.
 *  - Starts ramp in over 5 ms: START MODE IMMEDIATE, and the first playback after a recording.
 *  - Cuts ramp out over 5 ms (controller ruling R20): an IMMEDIATE stop, a second STOP during a FADE/LOOP stop, the end
 *    of a LOOP stop and the end of a 1SHOT. The state changes at once; a "release" voice carries on from where the
 *    playhead was, fading to silence over 5 ms. A 1SHOT retrigger is the same release crossfaded with a ramp-in from
 *    the start.
 *
 * Nothing here allocates while rendering. Scratch buffers are per track; the only allocations are the take's own
 * 1-second chunks while recording (or copy-on-write), and a fresh take shell when one is cleared.
 */
import { AudioTake } from './chunks';
import type { ChunkPool } from './chunks';
import type { Transport } from './transport';
import { Ramp, fadeTimeFrames, punchInGain, punchOutGain } from './fade';
import type { FadeTime, MemorySettings, TrackSettings } from '../schema/types';
import type { TrackIndex } from '../shared/ids';
import type { EngineMessage, TrackAudio, TrackState, TrackStatus } from '../shared/protocol';

/** What a track needs from the core that owns it. */
export interface TrackHost {
  readonly sr: number;
  /** Loop-seam and punch crossfade length in frames (5 ms). */
  readonly xfade: number;
  readonly pool: ChunkPool;
  readonly transport: Transport;
  /** The current memory settings. Read live, so a change applies from the next frame rendered. */
  readonly memory: MemorySettings;
  post(msg: EngineMessage): void;
  /** The track's audio changed (a pass ended, or it was cleared): the memory's audio is no longer what was saved. */
  audioChanged(): void;
}

/** Frames per inner render step, and the size of the scratch buffers. */
const STEP = 256;

type DubMode = TrackSettings['dubMode'];

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
 * The last 5 ms of playback after a cut: `left` frames read from take position `pos` in direction `dir`, at `gain`
 * (the track's fade gain at the cut) times a fall from 1 to 1/xfade.
 */
interface Release {
  pos: number;
  dir: 1 | -1;
  left: number;
  gain: number;
}

/** Reverse samples `[from, from + n)` of `a` in place. */
function reverseInPlace(a: Float32Array, from: number, n: number): void {
  for (let i = from, j = from + n - 1; i < j; i++, j--) {
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
}

export class Track {
  readonly index: TrackIndex;
  private readonly host: TrackHost;

  private _take: AudioTake;
  private _state: TrackState = 'empty';
  /** The tempo when the loop was recorded (or the loaded file's), for tempo sync. */
  private _recordedTempo: number;
  /** Next take frame to play, in [0, length) whenever the track is playing or overdubbing. */
  private playhead = 0;
  /** A FADE or LOOP stop in progress: the track still plays, and REC/DUB/PLAY is ignored. */
  private stopping: 'FADE' | 'LOOP' | null = null;

  /** START MODE fade-in and STOP MODE fade-out gain. */
  private readonly env = new Ramp(1);
  /** Output gain that REPLACE2 takes to 0 while overdubbing. */
  private readonly mute = new Ramp(1);
  /** 5 ms ramp-in of a start that would otherwise step from silence. */
  private readonly attack = new Ramp(1);
  /** The fading tail of playback after a cut or retrigger. */
  private readonly rel: Release = { pos: 0, dir: 1, left: 0, gain: 0 };

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
  /** The release voice's audio for the current step. */
  private readonly relL = new Float32Array(STEP);
  private readonly relR = new Float32Array(STEP);

  constructor(index: TrackIndex, host: TrackHost) {
    this.index = index;
    this.host = host;
    this._take = new AudioTake(host.pool);
    this._recordedTempo = host.transport.bpm;
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

  // -------------------------------------------------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------------------------------------------------

  /** REC/DUB/PLAY. */
  recPlay(): void {
    switch (this._state) {
      case 'empty':
        this._state = 'recording'; // the take is always fresh and empty here
        return;
      case 'recording':
        this.finishRecording(this.host.memory.rec.recAction === 'REC->DUB' ? 'dub' : 'play');
        return;
      case 'overdubbing':
        this.endPass(true);
        return;
      case 'stopped':
        this.startPlayback();
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

  /** STOP, per STOP MODE. A second STOP during a FADE or LOOP stop stops at once (with the 5 ms ramp-out). */
  stop(): void {
    const dir = this.direction();
    switch (this._state) {
      case 'empty':
      case 'stopped':
        return;
      case 'recording':
        // INFERRED: STOP while recording keeps the recording and leaves the track stopped (nothing plays yet, so
        // STOP MODE has nothing to fade).
        this.finishRecording('stop');
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

  /** Empty the track: its take is released and replaced by a fresh one. */
  clear(): void {
    // A first recording still running had no loop yet: clearing it leaves the track as it was before.
    const hadLoop = this._state !== 'empty' && this._state !== 'recording';
    this.reset();
    if (hadLoop) this.host.audioChanged();
  }

  /**
   * The host lost audio (app switch, lock screen, call): a recording or overdub ends its pass as if REC/DUB/PLAY had
   * moved it to playback, keeping the audio. Other states are left alone.
   */
  interrupt(): void {
    if (this._state === 'recording') this.finishRecording('play');
    else if (this._state === 'overdubbing') this.endPass(true);
  }

  /**
   * Replace the track's audio with `audio` (null empties it), leaving it stopped. `audio` must be at the core's sample
   * rate (the caller resamples). On MEMORY FULL the track is left empty.
   */
  load(audio: TrackAudio | null): void {
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
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Transitions
  // -------------------------------------------------------------------------------------------------------------------

  /**
   * End the recording: the loop length is what was recorded. A recording of 2 x XFADE frames or fewer is discarded
   * and the track is empty again. Otherwise the seam crossfade starts and the track moves on to `next`.
   */
  private finishRecording(next: 'play' | 'dub' | 'stop'): void {
    const len = this._take.length;
    const xf = this.host.xfade;
    if (len <= 2 * xf) {
      this.reset();
      return;
    }
    // INFERRED: a free loop has no tempo of its own; it takes the memory tempo of the moment its recording ends.
    this._recordedTempo = this.host.transport.bpm;
    this.recTail.pos = 0;
    this.recTail.left = xf;
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
    this.playhead = this.startPosition();
    // REC->DUB on a REVERSE or 1SHOT track, which cannot overdub, ends in playback (INFERRED).
    if (next === 'dub' && !this.cfg.reverse && !this.cfg.oneShot) this.beginPass(true);
  }

  /** Start playback from the beginning of the phrase (the end, in REVERSE), per START MODE. */
  private startPlayback(): void {
    this._state = 'playing';
    this.stopping = null;
    this.mute.set(1);
    this.playhead = this.startPosition();
    if (this.cfg.startMode === 'FADE') {
      this.attack.set(1); // the fade itself starts from 0
      this.env.set(0);
      this.env.start(1, this.fadeTime(this.host.memory.play.fadeIn));
    } else {
      this.env.set(1);
      this.rampIn();
    }
  }

  /** 1SHOT retrigger: the old position fades out (release) while the start fades in, both over 5 ms. */
  private retrigger(): void {
    this.startRelease(this.direction());
    this.playhead = this.startPosition();
    this.rampIn();
  }

  /**
   * Punch in at the playhead. The DUB MODE is fixed for the pass (INFERRED: a change applies from the next pass).
   * `fromSilence`: the pass follows a recording, during which the track output nothing, so REPLACE2 is muted at once
   * rather than ramped (it must never play the track).
   */
  private beginPass(fromSilence: boolean): void {
    this._state = 'overdubbing';
    this.passMode = this.cfg.dubMode;
    this.passFrames = 0;
    if (this.passMode === 'REPLACE2') {
      if (fromSilence) this.mute.set(0);
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
   * gain. A release still running from a cut under 5 ms ago is replaced (a negligible overlap).
   */
  private startRelease(dir: 1 | -1): void {
    const rel = this.rel;
    rel.pos = this.playhead;
    rel.dir = dir;
    rel.left = this.host.xfade;
    rel.gain = this.env.value * this.mute.value * this.attack.value;
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

  /** Release the take for a fresh one and return to empty, cancelling everything in flight. */
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
    this.rel.left = 0; // the take it read is gone (a clear cuts hard)
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
   * Render frames `[from, to)` of the block: record or play, write overdubs and tails, and put the track's output
   * (after PLAY LEVEL, PAN and the fades) in `outL`/`outR`. No command lands inside the range.
   */
  render(inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array, from: number, to: number): void {
    let a = from;
    while (a < to) {
      if (this._state === 'recording') {
        a += this.renderRecording(inL, inR, outL, outR, a, to);
        continue;
      }
      const sounding = this._state === 'playing' || this._state === 'overdubbing';
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
      if (relN > 0) this.readRelease(relN);
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
   * Append input from `a` up to `to`. Returns the frames recorded. On MEMORY FULL the recording ends at the last frame
   * that fit and the track plays (INFERRED: even with REC->DUB, since an overdub could not be stored either).
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
    const before = take.length;
    const ok = take.append(inL, inR, to - a, a);
    const got = take.length - before;
    outL.fill(0, a, a + got); // the input is monitored by the mixer, not the track
    outR.fill(0, a, a + got);
    if (!ok) {
      this.host.post('MEMORY FULL');
      this.finishRecording('play');
    }
    return got;
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

  /** The release voice's next `n` frames into `relL`/`relR`, in play order, wrapping at the loop ends. */
  private readRelease(n: number): void {
    const rel = this.rel;
    const len = this._take.length;
    let k = 0;
    while (k < n) {
      if (rel.dir > 0) {
        const piece = Math.min(n - k, len - rel.pos);
        this._take.read(rel.pos, this.relL, this.relR, k, piece);
        rel.pos += piece;
        if (rel.pos >= len) rel.pos = 0;
        k += piece;
      } else {
        const piece = Math.min(n - k, rel.pos + 1);
        this._take.read(rel.pos - piece + 1, this.relL, this.relR, k, piece);
        reverseInPlace(this.relL, k, piece);
        reverseInPlace(this.relR, k, piece);
        rel.pos -= piece;
        if (rel.pos < 0) rel.pos = len - 1;
        k += piece;
      }
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
    const { rawL, rawR, relL, relR, env, mute, attack, rel } = this;
    const xf = this.host.xfade;
    const relGain = rel.gain;
    const relLeft = rel.left;
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
        l += relL[k] * g;
        r += relR[k] * g;
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
    const sounding = this._state === 'playing' || this._state === 'overdubbing';
    const peak = this.peakAbs;
    this.peakAbs = 0;
    return {
      state: this._state,
      pending: null,
      stopping: this.stopping !== null,
      autoRecWaiting: false,
      // INFERRED: the playhead's place in the take, so it runs 1 -> 0 in REVERSE; 0 when not playing.
      position: sounding && len > 0 ? this.playhead / len : 0,
      lengthFrames: len, // grows while recording
      measures: null, // free loops
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
    return { L, R, sampleRate: this.host.sr, recordedTempo: this._recordedTempo, measures: null };
  }
}
