/**
 * The audio engine. `SageProcessor` runs the looper core and the DSP chain on the audio thread. In the browser it lives
 * in an AudioWorklet, registered as 'sage-processor' by the block at the end of this file; in the tests it runs in Node
 * on a FakePort. It talks to the main thread only through its port: TimedCommands in, EngineEvents out.
 *
 * Timeline: the host dates commands in AudioContext frames (the heard frame of the press), but the core counts frames
 * from the processor's first block, and the context may have run for seconds before the node existed (permission
 * prompt, worklet load). The worklet passes `currentFrame` with every block; the difference is applied to each dated
 * command, and `status.frame` is reported in context frames.
 *
 * Each render block, in order:
 *  1. apply the TimedCommands received since the last block (the core dates its own; the engine's act at once, and so
 *     do settings: they apply as one unit to the DSP and the core, or not at all). A command that throws is dropped,
 *     logged and reported as an `ENGINE ERROR` message, with everything put back on the last good settings, so it
 *     cannot stop the processor (a browser never calls a processor again after it throws);
 *  2. the mic input chain (MIC 1 IN gain and mute, EQ, comp, noise suppressor);
 *  3. the looper core (each track after PLAY LEVEL, PAN and fades; the guide click). Its RHYTHM inputs are silent
 *     until input routing lands (Task 9). If its render throws (a dated command it applies there, which is then out of
 *     its queue), that block's tracks are silent and the rest of the block renders; the first failure of a run is
 *     logged and ENGINE ERROR is reported at most once a second, with nothing allocated per failed block. The core's
 *     frame counter is private and only a completed render advances it, so a failed block leaves it one block behind;
 *     the per-block offset (currentFrame - core.frame) keeps dated commands right, and the skew inside the core is at
 *     most the frames it rendered before the failure (a core `skip(n)` would remove it: a lane-a follow-up);
 *  4. the mixer: `out`, what is heard, and, only while the recorder is on, `perf`, the recorder bus with the mic always
 *     in. The core's click goes in as the rhythm. The core has already panned the tracks (ruling R19), so the mixer
 *     does not pan again;
 *  5. MASTER FX on each bus in use (one MasterFx per bus; the recorder's is made fresh at every recorder start, so a
 *     new take never opens on the last take's reverb tail);
 *  6. `out` to the node's output;
 *  7. while the recorder is on, `perf` in 4096-frame `recorderBlock` events, their buffers transferred;
 *  8. every round(sr / 60) frames, a `status`, then any LCD messages the core raised;
 *  9. pending `exportTracks` requests, streamed (ruling R47): `tracksStart` (lengths and metadata) when the request
 *     arrives, from copy-on-write snapshots of the takes; then up to one second of audio (all tracks together) per
 *     block as `tracksPart`s in fresh, transferred arrays; then `tracksEnd`. EngineHost reassembles them into `tracks`
 *     on the main thread, so the audio thread never allocates or copies a whole export at once.
 *
 * Nothing allocates in `process()` (no closures, no array destructuring) except the core's recording chunks, a fresh
 * recorder batch per 4096 frames and the status object 60 times a second (ruling R6), plus what the commands applied
 * in step 1 need, once per user action (the core's own rule), and an export's parts (at most the per-block budget).
 *
 * Interrupts (the host lost audio): `interrupt` applies at once and the core ends every recording and overdub as if
 * STOP had been pressed, keeping the audio. Ending a pass leaves a 5 ms tail that keeps writing the input that follows
 * (a recording's seam crossfade, an overdub's punch-out). After a real interruption the input that follows is audio
 * from after the context came back, and writing it as if it continued the pass would splice unrelated sound into the
 * loop. So for the 5 ms after an interrupt the core records silence and the tails fade to it. Only the core's input is
 * gated: the monitor and recorder buses keep the live mic.
 */

import type { AudioTake } from '../core/chunks';
import { xfadeFrames } from '../core/fade';
import { LooperCore } from '../core/looper';
import type { CoreOutput } from '../core/looper';
import { InputChain } from '../dsp/inputChain';
import { MasterFx } from '../dsp/master';
import { Mixer } from '../dsp/mixer';
import { defaultMemory } from '../schema/memory';
import { defaultSystem } from '../schema/system';
import type { MemorySettings, SystemSettings } from '../schema/types';
import { STATUS_HZ } from '../shared/constants';
import { TRACKS } from '../shared/ids';
import type { EngineCommand, EngineEvent, EngineStatus, TimedCommand, TrackExportMeta } from '../shared/protocol';
import { Calibrator } from './calibration';
import { DESKTOP_MEMORY_BUDGET, PROCESSOR_NAME, RECORDER_BLOCK } from './config';

/** The part of a MessagePort the engine uses (an AudioWorkletNode's port on either side, or a FakePort). */
export interface MessagePortLike {
  postMessage(message: unknown, transfer: Transferable[]): void;
  onmessage: ((ev: MessageEvent) => void) | null;
}

export interface SageProcessorOptions {
  /** The looper's memory budget (see `memoryBudgetBytes` in config.ts). Defaults to the desktop budget. */
  memoryBudgetBytes?: number;
}

type Stereo = [Float32Array, Float32Array];

/** Every buffer one block needs, sized for blocks of up to `n` frames. */
interface Buffers {
  readonly n: number;
  /** All zeros, never written: the mic when there is no input channel, and the core's RHYTHM inputs. */
  readonly silence: Float32Array;
  /** The input chain's output: the mic at the centre of both channels. Also the mixer's input bus. */
  readonly input: Stereo;
  /** The core's input while the post-interrupt gate is open. */
  readonly gated: Stereo;
  readonly core: CoreOutput;
  readonly out: Stereo;
  readonly perf: Stereo;
}

function stereo(n: number): Stereo {
  return [new Float32Array(n), new Float32Array(n)];
}

function makeBuffers(n: number): Buffers {
  return {
    n,
    silence: new Float32Array(n),
    input: stereo(n),
    gated: stereo(n),
    core: { tracks: TRACKS.map(() => stereo(n)), click: stereo(n) },
    out: stereo(n),
    perf: stereo(n),
  };
}

/** The render quantum every browser uses today. A larger block reallocates the buffers once. */
const QUANTUM = 128;
const NO_TRANSFER: Transferable[] = [];
/** Seconds of audio (all tracks together) an export copies per block. 5 x 30 s loops take 150 blocks (0.4 s). */
const EXPORT_SECONDS_PER_BLOCK = 1;

/** One `exportTracks` request being streamed out. */
interface ExportJob {
  readonly reqId: number;
  /** Per track: a copy-on-write snapshot of its take, or null (no loop). Each is released once streamed. */
  readonly takes: (AudioTake | null)[];
  /** The track being streamed and the next frame of it. */
  part: number;
  pos: number;
}

export class SageProcessor {
  private readonly core: LooperCore;
  private readonly input: InputChain;
  private readonly mixer: Mixer;
  private readonly masterOut: MasterFx;
  private masterPerf: MasterFx;
  private buf = makeBuffers(QUANTUM);
  /** The last settings the DSP and the core both took: put back when a settings command fails part-way. */
  private good: { memory: MemorySettings; system: SystemSettings };
  /** The core's render failed in the last block (a run of failures is logged once). */
  private failing = false;
  /** Frames until a render failure may be reported again (ENGINE ERROR at most once a second). */
  private errorCooldown = 0;
  /** The tempo in the last status: the fallback for the live tempo if the core cannot report it. */
  private lastTempo: number;
  /** Pulses a status() read outside postStatus took from the core, handed on with the next status. */
  private carriedDirty = false;
  private readonly carriedPeaks = new Float64Array(TRACKS.length);
  /** AudioContext frame minus core frame, from the worklet's `currentFrame` (0 until one is given). */
  private offset = 0;

  /** Commands received since the last block, in arrival order. */
  private readonly inbox: TimedCommand[] = [];
  /** Frames between statuses: round(sr / 60). */
  private readonly statusEvery: number;
  private sinceStatus = 0;
  /** Largest input (after MIC 1 IN) and output samples since the last status. */
  private inPeak = 0;
  private outPeak = 0;
  /** The seam / punch crossfade length; the post-interrupt gate lasts this long. */
  private readonly xf: number;
  /** Frames the core still records silence for after an interrupt. */
  private gate = 0;

  /** The LATENCY calibration in progress (engine/calibration.ts), or null. */
  private calib: Calibrator | null = null;

  private recOn = false;
  private recL = new Float32Array(RECORDER_BLOCK);
  private recR = new Float32Array(RECORDER_BLOCK);
  private recFill = 0;
  /** Frames the recorder has taken since it was switched on. */
  private recFrames = 0;

  /** Pending exports, oldest first, and the frames they may copy per block. */
  private readonly exports: ExportJob[] = [];
  private readonly exportBudget: number;

  constructor(
    private readonly sr: number,
    private readonly port: MessagePortLike,
    opts: SageProcessorOptions = {},
  ) {
    const budget = opts.memoryBudgetBytes;
    this.core = new LooperCore({
      sampleRate: sr,
      memoryBudgetBytes: typeof budget === 'number' && budget > 0 && Number.isFinite(budget) ? budget : DESKTOP_MEMORY_BUDGET,
    });
    this.input = new InputChain(sr);
    this.mixer = new Mixer(sr);
    this.masterOut = new MasterFx(sr);
    this.masterPerf = new MasterFx(sr);
    // The core starts on the guide defaults; the DSP matches it until the host sends the real settings.
    this.good = { memory: defaultMemory(), system: defaultSystem() };
    this.lastTempo = this.good.memory.tempo;
    this.configureDsp(this.good.system);
    this.exportBudget = Math.max(1, Math.round(sr * EXPORT_SECONDS_PER_BLOCK));
    this.statusEvery = Math.max(1, Math.round(sr / STATUS_HZ));
    this.xf = xfadeFrames(sr);
    port.onmessage = (ev) => this.receive(ev.data);
  }

  /**
   * Renders one block. `inputs[0][0]` is the mono mic (absent with no mic); `outputs[0]` the stereo output.
   * `contextFrame` is the AudioContext frame of the block's first sample (the worklet's `currentFrame`); without it the
   * last known offset stays (0 at first: the core's own frames).
   */
  process(inputs: Float32Array[][], outputs: Float32Array[][], contextFrame?: number): boolean {
    const dest = outputs[0];
    const destL = dest?.[0];
    if (dest === undefined || destL === undefined || destL.length === 0) return true;
    const n = destL.length;
    if (n > this.buf.n) this.buf = makeBuffers(n);
    const b = this.buf;
    if (contextFrame !== undefined && Number.isFinite(contextFrame)) this.offset = contextFrame - this.core.frame;

    // 1. Commands.
    this.applyInbox();

    // 2. The mic.
    const mic = inputs[0]?.[0];
    const inL = b.input[0];
    const inR = b.input[1];
    const peak = this.input.process(mic !== undefined && mic.length >= n ? mic : b.silence, inL, inR, n);
    if (peak > this.inPeak) this.inPeak = peak;

    // 3. The looper, recording silence while the post-interrupt gate is open.
    let recL = inL;
    let recR = inR;
    if (this.gate > 0) {
      const gL = b.gated[0];
      const gR = b.gated[1];
      const g = Math.min(this.gate, n);
      gL.fill(0, 0, g);
      gR.fill(0, 0, g);
      for (let k = g; k < n; k++) {
        gL[k] = inL[k]!;
        gR[k] = inR[k]!;
      }
      this.gate -= g;
      recL = gL;
      recR = gR;
    }
    try {
      this.core.process(recL, recR, b.silence, b.silence, b.core, n);
      this.failing = false;
    } catch (e) {
      this.renderFailed(e, b, n);
    }

    // 4.-5. Mix and run MASTER FX: `out` always, the recorder bus only while the recorder is on.
    const perf = this.recOn ? b.perf : null;
    this.mixer.process(b.core.tracks, b.input, b.core.click, b.out, perf, n);
    const outL = b.out[0];
    const outR = b.out[1];
    this.masterOut.process(outL, outR, n);
    if (perf !== null) this.masterPerf.process(perf[0], perf[1], n);

    // 5b. A LATENCY calibration replaces what is heard with its clicks (with 5 ms fades) and records the raw mic.
    if (this.calib !== null) {
      if (this.calib.process(mic !== undefined && mic.length >= n ? mic : undefined, outL, outR, n)) {
        this.post(this.calib.event(), [this.calib.capture.buffer]);
      }
      if (this.calib.finished) this.calib = null;
    }

    // 6. Out.
    const destR = dest[1];
    let op = this.outPeak;
    for (let k = 0; k < n; k++) {
      const l = outL[k]!;
      const r = outR[k]!;
      destL[k] = l;
      if (destR !== undefined) destR[k] = r;
      const al = l < 0 ? -l : l;
      const ar = r < 0 ? -r : r;
      if (al > op) op = al;
      if (ar > op) op = ar;
    }
    this.outPeak = op;

    // 7. The recorder.
    if (perf !== null) this.record(perf, n);

    // 8. Status.
    this.sinceStatus += n;
    if (this.sinceStatus >= this.statusEvery) {
      this.sinceStatus %= this.statusEvery;
      this.postStatus();
    }

    if (this.errorCooldown > 0) this.errorCooldown -= n;

    // 9. Exports.
    if (this.exports.length > 0) {
      try {
        this.stepExports();
      } catch (e) {
        console.error('engine: export failed', e);
        this.dropExports();
        this.post({ t: 'message', text: 'ENGINE ERROR' });
      }
    }
    return true;
  }

  // -------------------------------------------------------------------------------------------------------------------

  /**
   * The core's render threw. Drop this block's track output and keep rendering; nothing to restore (settings never sit
   * in the core's queue). Logged once per run of failures, reported at most once a second, nothing allocated otherwise.
   */
  private renderFailed(e: unknown, b: Buffers, n: number): void {
    if (!this.failing) {
      this.failing = true;
      console.error('engine: the looper failed (repeats in a row are not logged)', e);
    }
    const tracks = b.core.tracks;
    for (let i = 0; i < tracks.length; i++) {
      tracks[i]![0].fill(0, 0, n);
      tracks[i]![1].fill(0, 0, n);
    }
    b.core.click[0].fill(0, 0, n);
    b.core.click[1].fill(0, 0, n);
    if (this.errorCooldown <= 0) {
      this.errorCooldown = this.sr;
      this.post({ t: 'message', text: 'ENGINE ERROR' });
    }
  }

  private receive(data: unknown): void {
    if (isTimedCommand(data)) this.inbox.push(data);
  }

  private applyInbox(): void {
    const q = this.inbox;
    if (q.length === 0) return;
    // A reply posted here can make the host send more; those arrive in this same loop and apply too.
    for (let i = 0; i < q.length; i++) {
      try {
        this.apply(q[i]!);
      } catch (e) {
        // A browser stops calling a processor that throws: drop the command and let the LCD say so.
        console.error('engine: command failed and was dropped', q[i]!.cmd.t, e);
        this.post({ t: 'message', text: 'ENGINE ERROR' });
      }
    }
    q.length = 0;
  }

  private apply({ cmd, at }: TimedCommand): void {
    const coreAt = at === null ? null : at - this.offset; // context frames -> core frames
    switch (cmd.t) {
      case 'fader':
        this.mixer.setFader(cmd.track, cmd.gain);
        return;
      case 'micMute':
        this.input.setMute(cmd.on);
        return;
      case 'recorder':
        this.setRecorder(cmd.on);
        return;
      case 'exportTracks':
        this.startExport(cmd.reqId);
        return;
      case 'settings':
        this.applySettings(cmd);
        return;
      case 'interrupt':
        // Now, whatever the date: the audio has already gone.
        this.core.command(cmd);
        this.gate = this.xf;
        return;
      case 'calibrate':
        // a second one restarts the measurement, already muted
        this.calib = new Calibrator(cmd.reqId, this.sr, this.calib !== null);
        return;
      default:
        this.core.command(cmd, coreAt);
        return;
    }
  }

  /**
   * New settings, as one unit: the DSP and the core take them, now (settings are not timeline events; applying them at
   * once keeps a failure inside this command's try), or, if anything throws, everything goes back to the last good
   * settings and the error goes on to the caller.
   */
  private applySettings(cmd: Extract<EngineCommand, { t: 'settings' }>): void {
    let coreTouched = false;
    try {
      this.configureDsp(cmd.system);
      coreTouched = true;
      this.core.command(cmd);
    } catch (e) {
      this.configureDsp(this.good.system);
      if (coreTouched) this.restoreCore(); // the core may hold the bad settings now; otherwise it never saw them
      throw e;
    }
    this.good = { memory: cmd.memory, system: cmd.system };
  }

  /**
   * After a settings command failed inside the core: the last good settings again, at the core's live tempo. The last
   * good memory may carry a tempo the engine has since replaced (a first loop derives one, which the controller adopts
   * without a push), and putting that back would retime the loops (R31).
   */
  private restoreCore(): void {
    this.good = { memory: { ...this.good.memory, tempo: this.liveTempo() }, system: this.good.system };
    try {
      this.core.setSettings(this.good.memory, this.good.system);
    } catch (e) {
      console.error('engine: the looper refused the last good settings', e); // they applied before; never expected
    }
  }

  /** The transport's tempo now, from a core status (its pulses are kept for the next status) or the last status. */
  private liveTempo(): number {
    try {
      const cs = this.core.status();
      if (cs.audioDirty) this.carriedDirty = true;
      for (let i = 0; i < cs.tracks.length && i < this.carriedPeaks.length; i++) {
        this.carriedPeaks[i] = Math.max(this.carriedPeaks[i]!, cs.tracks[i]!.peak);
      }
      return cs.tempo;
    } catch {
      return this.lastTempo;
    }
  }

  private configureDsp(system: SystemSettings): void {
    this.input.configure(system);
    this.mixer.configure(system);
    this.masterOut.configure(system);
    this.masterPerf.configure(system);
  }

  private setRecorder(on: boolean): void {
    if (on === this.recOn) return;
    if (on) {
      // A fresh MasterFx: the recorder bus was not processed while off, so the old one holds a stale reverb tail.
      this.masterPerf = new MasterFx(this.sr);
      this.masterPerf.configure(this.good.system);
      this.recFill = 0;
      this.recFrames = 0;
      this.recOn = true;
      return;
    }
    // The last, partial batch goes out at its own length.
    if (this.recFill > 0) this.postRecorder(this.recL.slice(0, this.recFill), this.recR.slice(0, this.recFill));
    this.recFill = 0;
    this.recOn = false;
  }

  private record(perf: Stereo, n: number): void {
    const pL = perf[0];
    const pR = perf[1];
    let k = 0;
    while (k < n) {
      const m = Math.min(n - k, RECORDER_BLOCK - this.recFill);
      const L = this.recL;
      const R = this.recR;
      const f = this.recFill;
      for (let i = 0; i < m; i++) {
        L[f + i] = pL[k + i]!;
        R[f + i] = pR[k + i]!;
      }
      this.recFill = f + m;
      k += m;
      if (this.recFill === RECORDER_BLOCK) {
        this.postRecorder(L, R); // transferred: these buffers are gone, so the next batch gets new ones
        this.recL = new Float32Array(RECORDER_BLOCK);
        this.recR = new Float32Array(RECORDER_BLOCK);
        this.recFill = 0;
      }
    }
    this.recFrames += n;
  }

  private postRecorder(L: Float32Array<ArrayBuffer>, R: Float32Array<ArrayBuffer>): void {
    this.post({ t: 'recorderBlock', L, R }, [L.buffer, R.buffer]);
  }

  /**
   * Starts streaming every loop as it is now: copy-on-write snapshots (nothing is copied yet) and the header. All or
   * nothing: if anything fails, the snapshots already taken are released (they would hold chunks against the budget).
   */
  private startExport(reqId: number): void {
    const takes: (AudioTake | null)[] = [];
    let headerSent = false;
    try {
      const meta: (TrackExportMeta | null)[] = [];
      for (const tr of this.core.tracks) {
        // What Track.audio() copies: no loop while the track is empty or its first recording still runs, and the
        // gathered writes of a pass that has just ended are in it (binding note 2).
        const take = tr.exportSnapshot();
        if (take === null) {
          takes.push(null);
          meta.push(null);
          continue;
        }
        takes.push(take);
        meta.push({ frames: take.length, sampleRate: this.sr, recordedTempo: tr.recordedTempo, measures: tr.measures });
      }
      this.post({ t: 'tracksStart', reqId, tracks: meta });
      headerSent = true;
      this.exports.push({ reqId, takes, part: 0, pos: 0 });
    } catch (e) {
      for (const t of takes) t?.release();
      if (headerSent) this.post({ t: 'tracksAbort', reqId }); // the host has allocated for it: let it go
      throw e;
    }
  }

  /** Streams up to `exportBudget` frames of the pending exports as parts, and ends each one that is complete. */
  private stepExports(): void {
    let budget = this.exportBudget;
    while (this.exports.length > 0) {
      const job = this.exports[0]!;
      while (job.part < job.takes.length) {
        const take = job.takes[job.part] ?? null;
        if (take !== null && job.pos < take.length) {
          if (budget === 0) break;
          const m = Math.min(budget, take.length - job.pos);
          const L = new Float32Array(m);
          const R = new Float32Array(m);
          take.read(job.pos, L, R, 0, m);
          this.post({ t: 'tracksPart', reqId: job.reqId, track: TRACKS[job.part]!, offset: job.pos, L, R }, [L.buffer, R.buffer]);
          job.pos += m;
          budget -= m;
          if (job.pos < take.length) break;
        }
        take?.release();
        job.takes[job.part] = null;
        job.part++;
        job.pos = 0;
      }
      if (job.part < job.takes.length) return;
      this.exports.shift();
      this.post({ t: 'tracksEnd', reqId: job.reqId });
    }
  }

  /**
   * Abandons every pending export: its snapshots are released and the host is told (`tracksAbort`), so it frees the
   * arrays it allocated; the controller's request then times out.
   */
  private dropExports(): void {
    const jobs = this.exports.splice(0);
    for (const job of jobs) {
      for (const t of job.takes) t?.release();
      this.post({ t: 'tracksAbort', reqId: job.reqId });
    }
  }

  private postStatus(): void {
    const cs = this.core.status();
    if (this.carriedDirty) {
      cs.audioDirty = true;
      this.carriedDirty = false;
    }
    for (let i = 0; i < cs.tracks.length && i < this.carriedPeaks.length; i++) {
      const t = cs.tracks[i]!;
      if (this.carriedPeaks[i]! > t.peak) t.peak = this.carriedPeaks[i]!;
      this.carriedPeaks[i] = 0;
    }
    this.lastTempo = cs.tempo;
    const status: EngineStatus = {
      ...cs,
      frame: this.core.frame + this.offset,
      sampleRate: this.sr,
      inputPeak: this.inPeak,
      outputPeak: this.outPeak,
      recorderFrames: this.recOn ? this.recFrames : null,
    };
    this.inPeak = 0;
    this.outPeak = 0;
    this.post({ t: 'status', status });
    const messages = this.core.takeMessages();
    for (let i = 0; i < messages.length; i++) this.post({ t: 'message', text: messages[i]! });
  }

  private post(e: EngineEvent, transfer: Transferable[] = NO_TRANSFER): void {
    this.port.postMessage(e, transfer);
  }
}

/** A well-formed TimedCommand (the main thread is ours, but a bad message must not take the audio thread down). */
function isTimedCommand(v: unknown): v is TimedCommand {
  if (typeof v !== 'object' || v === null) return false;
  const { cmd, at } = v as { cmd?: unknown; at?: unknown };
  if (typeof cmd !== 'object' || cmd === null || typeof (cmd as { t?: unknown }).t !== 'string') return false;
  return at === null || typeof at === 'number';
}

// ---------------------------------------------------------------------------------------------------------------------
// AudioWorklet registration. These globals exist only in an AudioWorkletGlobalScope. Anywhere else (Node, the tests,
// the main thread) the module only exports SageProcessor and touches no global.

declare const registerProcessor: ((name: string, ctor: new (options?: AudioWorkletNodeOptions) => object) => void) | undefined;
declare const AudioWorkletProcessor: new () => { readonly port: MessagePortLike };
declare const sampleRate: number;
declare const currentFrame: number;

if (typeof registerProcessor !== 'undefined') {
  ensureStructuredClone();

  class SageWorkletProcessor extends AudioWorkletProcessor {
    private readonly engine: SageProcessor;

    constructor(options?: AudioWorkletNodeOptions) {
      super();
      const opts: SageProcessorOptions = options?.processorOptions ?? {};
      this.engine = new SageProcessor(sampleRate, this.port, opts);
    }

    process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
      return this.engine.process(inputs, outputs, currentFrame);
    }
  }

  registerProcessor(PROCESSOR_NAME, SageWorkletProcessor);
}

/**
 * The AudioWorkletGlobalScope has no `structuredClone` (it belongs to Window and Worker scopes), but the schema's default
 * builders clone with it, and the core calls `defaultMemory()` / `defaultSystem()` when it is constructed. Their values
 * are plain data (numbers, strings, booleans, plain objects and arrays), so a plain deep copy stands in.
 */
function ensureStructuredClone(): void {
  if (typeof globalThis.structuredClone === 'function') return;
  Object.defineProperty(globalThis, 'structuredClone', { value: clonePlain, configurable: true, writable: true });
}

function clonePlain<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value;
  if (Array.isArray(value)) return value.map((v: unknown) => clonePlain(v)) as T;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) out[key] = clonePlain((value as Record<string, unknown>)[key]);
  return out as T;
}
