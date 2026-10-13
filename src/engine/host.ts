/// <reference types="vite/client" />
/**
 * The main-thread side of the engine: EngineHost creates the AudioContext, opens the mic, loads the 'sage-processor'
 * worklet and wires mic -> worklet -> speakers. It is the controller's `EngineLike`: `send` turns a command and the
 * time of the input event behind it into a TimedCommand for the worklet, and `on` delivers the worklet's events.
 *
 * iPad Safari (installed to the Home Screen) shapes most of it:
 *  - `navigator.audioSession.type = 'play-and-record'` is set before every getUserMedia, so playback carries on while
 *    the mic is open (Safari 16.4+; skipped where it does not exist).
 *  - Safari strips every audio constraint except `echoCancellation`, which follows SETUP MIC PROCESS (default OFF: on
 *    iOS 27 every page crackles while an echo-cancelled mic is open). What the browser actually gave is logged.
 *  - `latencyHint` is ignored and there is no input-latency API, so latency is estimated until it is calibrated
 *    (SETUP LATENCY), and `outputLatency` reads 0 until the context plays, so the estimate is redone once it runs.
 *  - Audio is lost in the background, on a call, to Siri (ruling R37). Every change of the context to `interrupted` or
 *    `suspended` that the host did not cause sends `interrupt` (the core ends rec/dub passes as if STOP were pressed,
 *    keeps the audio and cancels armed actions; sending it twice is harmless). On a touch device going hidden sends it
 *    too; a desktop tab keeps its audio in the background, so there the context's own state decides. Back to visible:
 *    `suspend()` then `resume()` (WebKit bug 276016) if the context is not running, and the mic is opened again if its
 *    track ended or was muted. A context that comes back to `running` by itself (after Siri or a call) gets an ended
 *    mic reopened too.
 *  - When audio cannot be brought back the LCD gets NO INPUT and `needsResume` turns true (`onNeedsResume` tells).
 *    For Task 23: show TAP POWER TO RESUME while `needsResume` is true, and from the tap call
 *    `resume({ retryMic: true })`. It turns false again by itself when the context does run after all (a resume that
 *    took longer than RESUME_TIMEOUT_MS) and the mic is back. No mic at power-on (a desktop without one) is NO INPUT
 *    only: the looper works without input, so it does not set `needsResume`.
 *
 * The browser pieces are injectable (`EngineHostOptions`) so the host runs in Node against fakes.
 */

import processorUrl from './processor.ts?worker&url';
import type { EngineLike } from '../control/controller';
import { defaultSystem } from '../schema/system';
import type { SystemSettings } from '../schema/types';
import type { EngineCommand, EngineEvent, TimedCommand } from '../shared/protocol';
import { ExportAssembler, isExportEvent } from './assemble';
import { PROCESSOR_NAME, isTouch, memoryBudgetBytes } from './config';
import type { MessagePortLike } from './processor';

/** How long `suspend()` / `resume()` may take before the resume counts as failed. */
// INFERRED: no figure is published; long enough for a slow wake, short enough that a hung resume (no user
// activation) reaches the TAP POWER TO RESUME prompt quickly.
export const RESUME_TIMEOUT_MS = 2000;

// ---------------------------------------------------------------------------------------------------------------------
// The browser pieces the host uses. The real AudioContext, AudioWorkletNode, MediaStream, navigator and document fit
// these shapes; the tests pass fakes.

export interface HostTrack {
  readonly readyState: string;
  readonly muted: boolean;
  getSettings(): object;
  stop(): void;
}

export interface HostStream {
  getAudioTracks(): HostTrack[];
}

export interface HostNode {
  connect(destination: HostNode): unknown;
  disconnect(): void;
}

export interface HostWorkletNode extends HostNode {
  readonly port: MessagePortLike;
  onprocessorerror: ((ev: ErrorEvent) => unknown) | null;
}

export interface HostContext {
  readonly sampleRate: number;
  readonly state: string;
  readonly baseLatency: number;
  readonly outputLatency?: number;
  readonly destination: HostNode;
  readonly audioWorklet: { addModule(url: string): Promise<void> };
  onstatechange: ((ev: Event) => unknown) | null;
  getOutputTimestamp?(): AudioTimestamp;
  createMediaStreamSource(stream: HostStream): HostNode;
  suspend(): Promise<void>;
  resume(): Promise<void>;
  close(): Promise<void>;
}

export interface HostNavigator {
  readonly maxTouchPoints?: number;
  readonly mediaDevices?: { getUserMedia(constraints: MediaStreamConstraints): Promise<HostStream> };
  /** Safari 16.4+ only, so not in the DOM typings. */
  audioSession?: { type: string };
}

export interface HostDocument {
  readonly visibilityState: string;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

export interface EngineHostOptions<C extends HostContext = AudioContext> {
  /** The system settings at power-on (SETUP MIC PROCESS, SETUP LATENCY). Defaults; later `settings` commands update them. */
  system?: SystemSettings;
  /** Default: `new AudioContext({ latencyHint: 'interactive' })`. Without it, `C` must be AudioContext. */
  createContext?: () => C;
  /** Default: `new AudioWorkletNode(ctx, 'sage-processor', options)`. */
  createNode?: (ctx: C, options: AudioWorkletNodeOptions) => HostWorkletNode;
  /** Default: `navigator`. */
  nav?: HostNavigator;
  /** Default: `document`; null listens for no visibility changes. */
  doc?: HostDocument | null;
  /** Default: the bundled worklet. */
  workletUrl?: string;
  /** Default: console.info. */
  log?: (message: string, detail?: unknown) => void;
}

export interface Latency {
  roundTripFrames: number;
  outputLatencyFrames: number;
}

const NO_INPUT: EngineEvent = { t: 'message', text: 'NO INPUT' };

// ---------------------------------------------------------------------------------------------------------------------

export class EngineHost<C extends HostContext = AudioContext> implements EngineLike {
  /** A mic is open and connected to the worklet. */
  micAvailable = false;

  private readonly handlers = new Set<(e: EngineEvent) => void>();
  /** Messages raised while nobody listened (NO INPUT during `start`), for the first subscriber. */
  private readonly undelivered: EngineEvent[] = [];
  private readonly resumeHandlers = new Set<(needsResume: boolean) => void>();
  /** Streamed exports being put back together (ruling R47). */
  private readonly assembler: ExportAssembler;
  private _needsResume = false;
  /** A mic has been open since power-on, so losing it is a loss to recover from. */
  private micExpected = false;
  /** Going hidden interrupts only on a touch device (R37). */
  private readonly touch: boolean;
  private system: SystemSettings;
  private lat: Latency = { roundTripFrames: 0, outputLatencyFrames: 0 };
  private stream: HostStream | null = null;
  private source: HostNode | null = null;
  /** The echoCancellation the open mic was asked for. */
  private micEcho: boolean;
  /** Inside our own suspend() / resume(): the state changes that causes are not interruptions. */
  private resuming = false;
  private stopped = false;
  /** Mic and context restarts run one at a time (a second getUserMedia mutes the first on iOS). */
  private chain: Promise<unknown> = Promise.resolve();
  /** A `restartMic` that is queued and has not started yet. */
  private micRestart: Promise<void> | null = null;

  private constructor(
    readonly ctx: C,
    private readonly node: HostWorkletNode,
    private readonly nav: HostNavigator,
    private readonly doc: HostDocument | null,
    system: SystemSettings,
    private readonly log: (message: string, detail?: unknown) => void,
  ) {
    this.system = system;
    this.micEcho = system.setup.micProcess;
    this.touch = isTouch(nav);
    this.assembler = new ExportAssembler(log);
  }

  /**
   * Powers the engine on. Call it straight from the POWER tap: the context is created before anything is awaited, so
   * it gets the tap's user activation. Without a mic the engine still runs: `micAvailable` is false and the first
   * subscriber gets NO INPUT. Rejects (releasing the mic and the context) only if the worklet cannot be loaded.
   */
  static async start<C extends HostContext = AudioContext>(opts: EngineHostOptions<C> = {}): Promise<EngineHost<C>> {
    // Without createContext, C is the default AudioContext.
    const ctx = opts.createContext ? opts.createContext() : (new AudioContext({ latencyHint: 'interactive' }) as unknown as C);
    const nav = opts.nav ?? globalThis.navigator;
    const doc = opts.doc === undefined ? (typeof document === 'undefined' ? null : document) : opts.doc;
    const log = opts.log ?? consoleLog;
    const system = opts.system ?? defaultSystem();

    const stream = await openMic(nav, system.setup.micProcess, log);
    let node: HostWorkletNode;
    try {
      await ctx.audioWorklet.addModule(opts.workletUrl ?? processorUrl);
      const createNode = opts.createNode ?? browserNode;
      node = createNode(ctx, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 1, // the mic, downmixed to mono
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
        processorOptions: { memoryBudgetBytes: memoryBudgetBytes(nav) },
      });
    } catch (e) {
      stopStream(stream);
      await ctx.close().catch(() => undefined);
      throw e;
    }

    const host = new EngineHost(ctx, node, nav, doc, system, log);
    node.port.onmessage = (ev) => host.receive(ev.data);
    node.onprocessorerror = (ev) => log('engine: the audio processor failed', ev);
    node.connect(ctx.destination);
    if (!host.attachMic(stream)) host.dispatch(NO_INPUT);
    ctx.onstatechange = () => host.onStateChange();
    doc?.addEventListener('visibilitychange', host.onVisibility);
    host.pushLatency();
    if (ctx.state !== 'running') ctx.resume().catch(() => undefined); // may wait for a gesture: not awaited
    return host;
  }

  /** Sends `cmd` to the engine, dated at the heard frame of `eventTime` (performance.now() ms) when it can be. */
  send(cmd: EngineCommand, eventTime?: number): void {
    if (this.stopped) return;
    this.post({ cmd, at: this.heardFrame(eventTime) });
    if (cmd.t === 'settings') this.applySettings(cmd.system);
    else if (cmd.t === 'latency') this.lat = { roundTripFrames: cmd.roundTripFrames, outputLatencyFrames: cmd.outputLatencyFrames };
  }

  /** Subscribes to the engine's events; returns the unsubscribe. */
  on(handler: (e: EngineEvent) => void): () => void {
    this.handlers.add(handler);
    if (this.undelivered.length > 0) queueMicrotask(() => this.flushUndelivered());
    return () => {
      this.handlers.delete(handler);
    };
  }

  /** The latency the engine was last given. */
  latency(): Latency {
    return { ...this.lat };
  }

  /** Streamed exports being reassembled (diagnostics; their full-length arrays are held until they end). */
  get exportsInFlight(): number {
    return this.assembler.inProgress;
  }

  /** Audio was lost and could not be brought back: the app shell shows TAP POWER TO RESUME while this is true. */
  get needsResume(): boolean {
    return this._needsResume;
  }

  /** Called with the new value whenever `needsResume` changes; returns the unsubscribe. */
  onNeedsResume(handler: (needsResume: boolean) => void): () => void {
    this.resumeHandlers.add(handler);
    return () => {
      this.resumeHandlers.delete(handler);
    };
  }

  /**
   * Brings audio back: `suspend()` then `resume()` (WebKit bug 276016) if the context is not running, then a new mic if
   * the old one's track ended or was muted (or an earlier reopen failed), or, with `retryMic` (from a tap: TAP POWER
   * TO RESUME), if there never was one. Resolves true and clears `needsResume` when audio is back; otherwise emits NO
   * INPUT, sets `needsResume` and resolves false. Runs on every return to visible. Reports nothing once stopped.
   */
  resume(opts: { retryMic?: boolean } = {}): Promise<boolean> {
    return this.serial(async () => {
      if (this.stopped) return false;
      let ok = this.ctx.state === 'running' || (await this.restartContext());
      if (this.stopped) return false;
      if (this.micLost(true) || (opts.retryMic === true && !this.micAvailable)) {
        if (!(await this.reopenMic())) ok = false;
      }
      if (this.stopped) return false;
      if (ok) this.setNeedsResume(false);
      else this.lostAudio();
      return ok;
    });
  }

  /**
   * Closes the mic and opens it again with the current SETUP MIC PROCESS (echoCancellation): the old tracks are
   * stopped first (a second getUserMedia mutes the first on iOS), then the new stream is connected to the worklet.
   * If no mic can be had it emits NO INPUT, and asks for TAP POWER TO RESUME only when a mic worked before (as a lost
   * mic does); a host that never had one stays NO INPUT only. Never rejects.
   * A `settings` command with a new MIC PROCESS calls it too, and the controller calls it through its `restartMic`
   * hook: a request made while one is queued and not yet started joins it, so the two give one reopen; a request made
   * while one runs queues another, so the last setting always wins.
   */
  restartMic(): Promise<void> {
    if (this.micRestart !== null) return this.micRestart;
    const run = this.serial(async () => {
      this.micRestart = null; // started: a later request queues a new restart
      if (this.stopped) return;
      if (await this.reopenMic()) return;
      if (this.stopped) return;
      // A mic that worked before is lost audio (TAP POWER TO RESUME); without ever having had one (a desktop with no
      // mic) it is NO INPUT only, as at power-on: the looper works without input and a resume could not help.
      if (this.micExpected) this.lostAudio();
      else this.dispatch(NO_INPUT);
    }).catch((e: unknown) => {
      this.log('engine: mic restart failed', e);
    });
    this.micRestart = run;
    return run;
  }

  /** Powers the engine off: stops listening, releases the mic and closes the context. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.doc?.removeEventListener('visibilitychange', this.onVisibility);
    this.ctx.onstatechange = null;
    this.node.port.onmessage = null;
    this.assembler.clear(); // drop any half-built export and its arrays
    this.detachMic();
    this.node.disconnect();
    try {
      await this.ctx.close();
    } catch (e) {
      this.log('engine: closing the audio context failed', e);
    }
  }

  // -------------------------------------------------------------------------------------------------------------------

  private readonly onVisibility = (): void => {
    if (this.stopped || this.doc === null) return;
    if (this.doc.visibilityState === 'hidden') {
      if (this.touch) this.interrupt();
      return;
    }
    this.resume().catch((e: unknown) => this.log('engine: resume failed', e));
  };

  private onStateChange(): void {
    if (this.stopped) return;
    const state = this.ctx.state;
    if (state === 'running') {
      this.pushLatency(); // outputLatency reads 0 until the context plays
      // Back by itself (after Siri or a call, or a resume that outlasted its timeout): check the mic, clear
      // needsResume. Our own resume() checks the mic itself.
      if (!this.resuming) this.serial(() => this.recheck()).catch((e: unknown) => this.log('engine: mic check failed', e));
      return;
    }
    // Our own suspend() is not an interruption.
    if ((state === 'interrupted' || state === 'suspended') && !this.resuming) this.interrupt();
  }

  /**
   * The mic is gone: its track ended (or, with `mutedToo`, is muted), or a reopen failed after one had been open. A
   * page that never had a mic has not lost it.
   */
  private micLost(mutedToo: boolean): boolean {
    if (this.stream === null) return this.micExpected;
    const track = this.stream.getAudioTracks()[0];
    return track === undefined || track.readyState === 'ended' || (mutedToo && track.muted);
  }

  /**
   * The context runs again by itself: reopen an ended mic, and clear `needsResume` once audio is back. Only while the
   * page is visible: from the background getUserMedia is refused or prompts unseen, and the visible resume does it.
   */
  private async recheck(): Promise<void> {
    if (this.stopped || this.ctx.state !== 'running' || (this.doc !== null && this.doc.visibilityState !== 'visible')) return;
    if (this.micLost(false) && !(await this.reopenMic())) {
      if (!this.stopped) this.lostAudio();
      return;
    }
    if (!this.stopped) this.setNeedsResume(false);
  }

  /** Audio could not be brought back: NO INPUT on the LCD, and TAP POWER TO RESUME in the shell. */
  private lostAudio(): void {
    this.setNeedsResume(true);
    this.dispatch(NO_INPUT);
  }

  private setNeedsResume(value: boolean): void {
    if (this.stopped || value === this._needsResume) return;
    this._needsResume = value;
    for (const h of [...this.resumeHandlers]) h(value);
  }

  private interrupt(): void {
    this.post({ cmd: { t: 'interrupt' }, at: null });
  }

  private async restartContext(): Promise<boolean> {
    this.resuming = true;
    try {
      await within(this.ctx.suspend(), RESUME_TIMEOUT_MS);
      await within(this.ctx.resume(), RESUME_TIMEOUT_MS);
      return this.ctx.state === 'running';
    } catch (e) {
      this.log('engine: the audio context did not resume', e);
      return false;
    } finally {
      this.resuming = false;
    }
  }

  private applySettings(system: SystemSettings): void {
    const before = this.system;
    this.system = system;
    if (system.setup.latency !== before.setup.latency) this.pushLatency();
    // MENU > SETUP > MIC PROCESS: the stream must be reopened for the new echoCancellation. One path with the
    // controller's restartMic hook, so the two together reopen the mic once.
    if (system.setup.micProcess !== this.micEcho && this.stream !== null) void this.restartMic();
  }

  /** Re-estimates the latency and sends it when it changed. */
  private pushLatency(): void {
    const next = estimateLatency(this.ctx, this.system.setup.latency);
    if (next.roundTripFrames === this.lat.roundTripFrames && next.outputLatencyFrames === this.lat.outputLatencyFrames) return;
    this.lat = next;
    this.post({ cmd: { t: 'latency', ...next }, at: null });
  }

  private heardFrame(eventTime: number | undefined): number | null {
    if (eventTime === undefined || this.ctx.state !== 'running' || typeof this.ctx.getOutputTimestamp !== 'function') return null;
    return eventFrame(this.ctx.getOutputTimestamp(), eventTime, this.ctx.sampleRate);
  }

  private async reopenMic(): Promise<boolean> {
    this.detachMic(); // the old stream first: a second getUserMedia mutes the first
    const echo = this.system.setup.micProcess;
    const stream = await openMic(this.nav, echo, this.log);
    if (this.stopped) {
      stopStream(stream);
      return false;
    }
    this.micEcho = echo;
    return this.attachMic(stream);
  }

  private attachMic(stream: HostStream | null): boolean {
    if (stream === null) {
      this.micAvailable = false;
      return false;
    }
    const source = this.ctx.createMediaStreamSource(stream);
    source.connect(this.node);
    this.stream = stream;
    this.source = source;
    this.micAvailable = true;
    this.micExpected = true;
    return true;
  }

  private detachMic(): void {
    this.source?.disconnect();
    this.source = null;
    stopStream(this.stream);
    this.stream = null;
    this.micAvailable = false;
  }

  private post(tc: TimedCommand): void {
    this.node.port.postMessage(tc, []);
  }

  private receive(data: unknown): void {
    if (typeof data !== 'object' || data === null || typeof (data as { t?: unknown }).t !== 'string') return;
    const e = data as EngineEvent;
    if (isExportEvent(e)) {
      // Internal parts of an export: handlers get only the finished `tracks` event.
      const done = this.assembler.take(e);
      if (done !== null) this.dispatch(done);
      return;
    }
    this.dispatch(e);
  }

  private dispatch(e: EngineEvent): void {
    if (this.stopped) return;
    if (this.handlers.size === 0) {
      if (e.t === 'message') this.undelivered.push(e);
      return;
    }
    for (const h of [...this.handlers]) h(e);
  }

  private flushUndelivered(): void {
    if (this.handlers.size === 0) return;
    for (const e of this.undelivered.splice(0)) this.dispatch(e);
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.catch(() => undefined);
    return run;
  }
}

// ---------------------------------------------------------------------------------------------------------------------

/**
 * The heard-timeline frame of an input event: where the output was at `eventTime` (performance.now() ms), from the
 * context's output timestamp. Null without an event time or a usable timestamp (performanceTime is 0 before the
 * context has played).
 */
export function eventFrame(ts: AudioTimestamp, eventTime: number | undefined, sr: number): number | null {
  if (eventTime === undefined || !Number.isFinite(eventTime)) return null;
  const { contextTime, performanceTime } = ts;
  if (contextTime === undefined || performanceTime === undefined || !(performanceTime > 0) || !Number.isFinite(contextTime)) return null;
  const frame = (contextTime + (eventTime - performanceTime) / 1000) * sr;
  return Number.isFinite(frame) ? frame : null;
}

/**
 * Latency in frames: output = `outputLatency` (or `baseLatency` while it reads 0); round trip = the calibrated SETUP
 * LATENCY when set (>= 0), else `outputLatency + baseLatency` as an estimate (there is no input-latency API).
 */
export function estimateLatency(ctx: Pick<HostContext, 'sampleRate' | 'baseLatency' | 'outputLatency'>, calibrated: number): Latency {
  const sr = ctx.sampleRate;
  const out = finiteOrZero(ctx.outputLatency);
  const base = finiteOrZero(ctx.baseLatency);
  return {
    roundTripFrames: calibrated >= 0 ? Math.round(calibrated) : Math.round((out + base) * sr),
    outputLatencyFrames: Math.round((out || base) * sr),
  };
}

function finiteOrZero(v: number | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/** Opens the mic (audio session first), or returns null (no getUserMedia, permission denied, no audio track). */
async function openMic(
  nav: HostNavigator,
  echoCancellation: boolean,
  log: (message: string, detail?: unknown) => void,
): Promise<HostStream | null> {
  const devices = nav.mediaDevices;
  if (devices === undefined || typeof devices.getUserMedia !== 'function') {
    log('engine: no getUserMedia (the page is not a secure context?)');
    return null;
  }
  if (nav.audioSession) nav.audioSession.type = 'play-and-record';
  try {
    // Safari keeps only echoCancellation; the rest is for the browsers that honour it.
    const stream = await devices.getUserMedia({
      audio: { echoCancellation, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
    const track = stream.getAudioTracks()[0];
    if (track === undefined) {
      log('engine: the mic stream has no audio track');
      return null;
    }
    log('engine: mic settings', track.getSettings());
    return stream;
  } catch (e) {
    log('engine: no mic', e);
    return null;
  }
}

function consoleLog(message: string, detail?: unknown): void {
  if (detail === undefined) console.info(message);
  else console.info(message, detail);
}

function stopStream(stream: HostStream | null): void {
  if (stream === null) return;
  for (const t of stream.getAudioTracks()) t.stop();
}

function browserNode(ctx: HostContext, options: AudioWorkletNodeOptions): HostWorkletNode {
  // `ctx` is the real AudioContext here (createNode is only left out together with createContext).
  return new AudioWorkletNode(ctx as unknown as BaseAudioContext, PROCESSOR_NAME, options);
}

/** `p`, or a rejection after `ms`. */
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
