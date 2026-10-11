/**
 * Stand-ins for the browser pieces EngineHost uses (AudioContext, AudioWorkletNode, getUserMedia, document visibility),
 * and `startHost`, which starts a host on them with a real SageProcessor behind a paired FakePort. Not a test file.
 */
import { EngineHost } from '../../src/engine/host';
import type { EngineHostOptions, HostContext, HostDocument, HostNavigator, HostNode, HostStream, HostTrack, HostWorkletNode } from '../../src/engine/host';
import { SageProcessor } from '../../src/engine/processor';
import { FakePort } from '../../src/engine/fakePort';
import type { EngineEvent } from '../../src/shared/protocol';

export class FakeTrack implements HostTrack {
  readyState: MediaStreamTrackState = 'live';
  muted = false;
  stopped = false;
  constructor(readonly settings: MediaTrackSettings = { echoCancellation: false, sampleRate: 48000, channelCount: 1 }) {}
  getSettings(): MediaTrackSettings {
    return this.settings;
  }
  stop(): void {
    this.stopped = true;
    this.readyState = 'ended';
  }
}

export class FakeStream implements HostStream {
  constructor(readonly track = new FakeTrack()) {}
  getAudioTracks(): HostTrack[] {
    return [this.track];
  }
}

export class FakeNode implements HostNode {
  readonly connections: HostNode[] = [];
  disconnects = 0;
  constructor(readonly name = 'node') {}
  connect(destination: HostNode): unknown {
    this.connections.push(destination);
    return destination;
  }
  disconnect(): void {
    this.connections.length = 0;
    this.disconnects++;
  }
}

export class FakeWorkletNode extends FakeNode implements HostWorkletNode {
  onprocessorerror: ((ev: ErrorEvent) => unknown) | null = null;
  constructor(readonly port: FakePort, readonly options: AudioWorkletNodeOptions) {
    super('worklet');
  }
}

/** A context that records what is done to it. `setState` changes the state and fires `statechange`. */
export class FakeContext implements HostContext {
  sampleRate = 48000;
  state: AudioContextState = 'running';
  baseLatency = 0.005;
  outputLatency = 0.02;
  readonly destination = new FakeNode('destination');
  readonly modules: string[] = [];
  readonly audioWorklet = {
    addModule: async (url: string): Promise<void> => {
      this.calls.push('addModule');
      this.modules.push(url);
    },
  };
  onstatechange: ((ev: Event) => unknown) | null = null;
  timestamp: AudioTimestamp = { contextTime: 2, performanceTime: 10000 };
  /** Every suspend / resume / close / addModule, in order. */
  readonly calls: string[] = [];
  readonly sources: { stream: HostStream; node: FakeNode }[] = [];
  /** resume() rejects. */
  resumeFails = false;
  /** resume() never settles (no user activation). */
  resumeHangs = false;

  getOutputTimestamp(): AudioTimestamp {
    return this.timestamp;
  }
  createMediaStreamSource(stream: HostStream): HostNode {
    const node = new FakeNode('source');
    this.sources.push({ stream, node });
    return node;
  }
  async suspend(): Promise<void> {
    this.calls.push('suspend');
    this.setState('suspended');
  }
  resume(): Promise<void> {
    this.calls.push('resume');
    if (this.resumeHangs) return new Promise(() => {});
    if (this.resumeFails) return Promise.reject(new Error('resume refused'));
    this.setState('running');
    return Promise.resolve();
  }
  async close(): Promise<void> {
    this.calls.push('close');
    this.setState('closed');
  }
  setState(state: AudioContextState): void {
    if (this.state === state) return;
    this.state = state;
    this.onstatechange?.(new Event('statechange'));
  }
}

/** getUserMedia that hands out FakeStreams (or rejects with `fail`), logging the audio session type at each call. */
export class FakeNav implements HostNavigator {
  maxTouchPoints = 0;
  audioSession?: { type: string } = { type: 'auto' };
  readonly constraints: MediaStreamConstraints[] = [];
  readonly streams: FakeStream[] = [];
  /** The audio session type seen by each getUserMedia call. */
  readonly sessionAtCall: (string | undefined)[] = [];
  fail = false;
  readonly mediaDevices = {
    getUserMedia: async (constraints: MediaStreamConstraints): Promise<HostStream> => {
      this.sessionAtCall.push(this.audioSession?.type);
      this.constraints.push(constraints);
      if (this.fail) throw new DOMException('Permission denied', 'NotAllowedError');
      const s = new FakeStream();
      this.streams.push(s);
      return s;
    },
  };
  /** The audio constraints of the latest getUserMedia call. */
  lastAudio(): MediaTrackConstraints {
    return this.constraints.at(-1)!.audio as MediaTrackConstraints;
  }
}

export class FakeDoc implements HostDocument {
  visibilityState: DocumentVisibilityState = 'visible';
  private readonly listeners = new Set<() => void>();
  addEventListener(_type: 'visibilitychange', listener: () => void): void {
    this.listeners.add(listener);
  }
  removeEventListener(_type: 'visibilitychange', listener: () => void): void {
    this.listeners.delete(listener);
  }
  get listenerCount(): number {
    return this.listeners.size;
  }
  set(state: DocumentVisibilityState): void {
    this.visibilityState = state;
    for (const l of [...this.listeners]) l();
  }
}

export interface Rig {
  host: EngineHost<FakeContext>;
  ctx: FakeContext;
  nav: FakeNav;
  doc: FakeDoc;
  node: FakeWorkletNode;
  processor: SageProcessor;
  /** The host's end of the worklet port: `posted` holds every TimedCommand the host sent. */
  hostPort: FakePort;
  /** Everything the host passed to `log`. */
  logs: [string, unknown][];
  /** Every event the host delivered to its handlers (subscribed right after start). */
  events: EngineEvent[];
}

/** Starts an EngineHost on fakes, with a real SageProcessor at the context's rate behind the worklet node. */
export async function startHost(
  over: Omit<EngineHostOptions<FakeContext>, 'createContext' | 'createNode'> & { ctx?: FakeContext } = {},
): Promise<Rig> {
  const ctx = over.ctx ?? new FakeContext();
  const nav = (over.nav as FakeNav | undefined) ?? new FakeNav();
  const doc = (over.doc as FakeDoc | undefined) ?? new FakeDoc();
  const [hostPort, procPort] = FakePort.pair();
  let node: FakeWorkletNode | null = null;
  let processor: SageProcessor | null = null;
  const logs: [string, unknown][] = [];
  const host = await EngineHost.start<FakeContext>({
    workletUrl: 'sage-processor.js',
    log: (message, detail) => logs.push([message, detail]),
    ...over,
    nav,
    doc,
    createContext: () => ctx,
    createNode: (c, options) => {
      node = new FakeWorkletNode(hostPort, options);
      processor = new SageProcessor(c.sampleRate, procPort, options.processorOptions);
      return node;
    },
  });
  const events: EngineEvent[] = [];
  host.on((e) => events.push(e));
  return { host, ctx, nav, doc, node: node!, processor: processor!, hostPort, logs, events };
}

/** The commands the host has sent through the worklet port, in order. */
export function sentCommands(rig: Rig): { t: string; at: number | null }[] {
  return rig.hostPort.commands().map((c) => ({ t: c.cmd.t, at: c.at }));
}

/** Lets pending promise callbacks and zero-delay timers run. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}
