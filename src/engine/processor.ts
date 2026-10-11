/**
 * The audio engine. `SageProcessor` runs the looper core and the DSP chain on the audio thread. In the browser it lives
 * in an AudioWorklet, registered as 'sage-processor' by the block at the end of this file; in the tests it runs in Node
 * on a FakePort. It talks to the main thread only through its port: TimedCommands in, EngineEvents out.
 *
 * Each render block, in order:
 *  1. apply the TimedCommands received since the last block (the core dates its own; the engine's act at once);
 *  2. the mic input chain (MIC 1 IN gain and mute, EQ, comp, noise suppressor);
 *  3. the looper core (each track after PLAY LEVEL, PAN and fades; the guide click). Its RHYTHM inputs are silent
 *     until input routing lands (Task 9);
 *  4. the mixer: `out`, what is heard, and `perf`, the recorder bus with the mic always in. The core's click goes in
 *     as the rhythm. The core has already panned the tracks (ruling R19), so the mixer does not pan again;
 *  5. MASTER FX on each bus (one MasterFx per bus, each with its own state);
 *  6. `out` to the node's output;
 *  7. while the recorder is on, `perf` in 4096-frame `recorderBlock` events, their buffers transferred;
 *  8. every round(sr / 60) frames, a `status`, then any LCD messages the core raised.
 *
 * Nothing allocates in `process()` (no closures, no array destructuring) except the core's recording chunks, a fresh
 * recorder batch per 4096 frames and the status object 60 times a second (ruling R6), plus what the commands applied
 * in step 1 need, once per user action (the core's own rule; `exportTracks` copies the loops).
 *
 * Interrupts (the host lost audio): `interrupt` applies at once and the core ends every recording and overdub as if
 * STOP had been pressed, keeping the audio. Ending a pass leaves a 5 ms tail that keeps writing the input that follows
 * (a recording's seam crossfade, an overdub's punch-out). After a real interruption the input that follows is audio
 * from after the context came back, and writing it as if it continued the pass would splice unrelated sound into the
 * loop. So for the 5 ms after an interrupt the core records silence and the tails fade to it. Only the core's input is
 * gated: the monitor and recorder buses keep the live mic.
 */

import { xfadeFrames } from '../core/fade';
import { LooperCore } from '../core/looper';
import type { CoreOutput } from '../core/looper';
import { InputChain } from '../dsp/inputChain';
import { MasterFx } from '../dsp/master';
import { Mixer } from '../dsp/mixer';
import { defaultSystem } from '../schema/system';
import type { SystemSettings } from '../schema/types';
import { STATUS_HZ } from '../shared/constants';
import { TRACKS } from '../shared/ids';
import type { EngineEvent, EngineStatus, TimedCommand, TrackAudio } from '../shared/protocol';
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

export class SageProcessor {
  private readonly core: LooperCore;
  private readonly input: InputChain;
  private readonly mixer: Mixer;
  private readonly masterOut: MasterFx;
  private readonly masterPerf: MasterFx;
  private buf = makeBuffers(QUANTUM);

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
    this.configure(defaultSystem());
    this.statusEvery = Math.max(1, Math.round(sr / STATUS_HZ));
    this.xf = xfadeFrames(sr);
    port.onmessage = (ev) => this.receive(ev.data);
  }

  /** Renders one block. `inputs[0][0]` is the mono mic (absent with no mic); `outputs[0]` the stereo output. */
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const dest = outputs[0];
    const destL = dest?.[0];
    if (dest === undefined || destL === undefined || destL.length === 0) return true;
    const n = destL.length;
    if (n > this.buf.n) this.buf = makeBuffers(n);
    const b = this.buf;

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
    this.core.process(recL, recR, b.silence, b.silence, b.core, n);

    // 4.-5. Mix both buses and run MASTER FX on each.
    this.mixer.process(b.core.tracks, b.input, b.core.click, b.out, b.perf, n);
    const outL = b.out[0];
    const outR = b.out[1];
    this.masterOut.process(outL, outR, n);
    this.masterPerf.process(b.perf[0], b.perf[1], n);

    // 5b. A LATENCY calibration replaces what is heard with its clicks and records the raw mic.
    if (this.calib !== null && this.calib.process(mic !== undefined && mic.length >= n ? mic : undefined, outL, outR, n)) {
      this.post(this.calib.event(), [this.calib.capture.buffer]);
      this.calib = null;
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
    if (this.recOn) this.record(b.perf, n);

    // 8. Status.
    this.sinceStatus += n;
    if (this.sinceStatus >= this.statusEvery) {
      this.sinceStatus %= this.statusEvery;
      this.postStatus();
    }
    return true;
  }

  // -------------------------------------------------------------------------------------------------------------------

  private receive(data: unknown): void {
    if (isTimedCommand(data)) this.inbox.push(data);
  }

  private applyInbox(): void {
    const q = this.inbox;
    if (q.length === 0) return;
    // A reply posted here can make the host send more; those arrive in this same loop and apply too.
    for (let i = 0; i < q.length; i++) this.apply(q[i]!);
    q.length = 0;
  }

  private apply({ cmd, at }: TimedCommand): void {
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
        this.exportTracks(cmd.reqId);
        return;
      case 'settings':
        this.configure(cmd.system);
        this.core.command(cmd, at);
        return;
      case 'interrupt':
        // Now, whatever the date: the audio has already gone.
        this.core.command(cmd);
        this.gate = this.xf;
        return;
      case 'calibrate':
        this.calib = new Calibrator(cmd.reqId, this.sr); // a second one restarts the measurement
        return;
      default:
        this.core.command(cmd, at);
        return;
    }
  }

  private configure(system: SystemSettings): void {
    this.input.configure(system);
    this.mixer.configure(system);
    this.masterOut.configure(system);
    this.masterPerf.configure(system);
  }

  private setRecorder(on: boolean): void {
    if (on === this.recOn) return;
    if (on) {
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

  private exportTracks(reqId: number): void {
    const tracks: (TrackAudio | null)[] = [];
    const transfer: Transferable[] = [];
    for (const i of TRACKS) {
      const a = this.core.getTrackAudio(i); // fresh copies, so their buffers can go
      tracks.push(a);
      if (a === null) continue;
      if (a.L.buffer instanceof ArrayBuffer) transfer.push(a.L.buffer);
      if (a.R.buffer instanceof ArrayBuffer && a.R.buffer !== a.L.buffer) transfer.push(a.R.buffer);
    }
    this.post({ t: 'tracks', reqId, tracks }, transfer);
  }

  private postStatus(): void {
    const status: EngineStatus = {
      ...this.core.status(),
      frame: this.core.frame,
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
      return this.engine.process(inputs, outputs);
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
