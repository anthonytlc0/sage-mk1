import { describe, expect, it, vi } from 'vitest';
import { AudioTake } from '../../src/core/chunks';
import { EngineHost, eventFrame } from '../../src/engine/host';
import { DESKTOP_MEMORY_BUDGET, PROCESSOR_NAME, TOUCH_MEMORY_BUDGET, memoryBudgetBytes } from '../../src/engine/config';
import type { EngineLike } from '../../src/control/controller';
import { defaultSystem } from '../../src/schema/system';
import type { EngineEvent, TrackAudio } from '../../src/shared/protocol';
import { freeSettings, run } from './helpers';
import { FakeContext, FakeDoc, FakeNav, sentCommands, settle, startHost } from './hostFakes';
import type { Rig } from './hostFakes';

const MiB = 1024 * 1024;

function messages(rig: Rig): string[] {
  return rig.events.flatMap((e) => (e.t === 'message' ? [e.text] : []));
}

function latencyCommands(rig: Rig): { roundTripFrames: number; outputLatencyFrames: number }[] {
  return rig.hostPort.commands().flatMap((c) =>
    c.cmd.t === 'latency' ? [{ roundTripFrames: c.cmd.roundTripFrames, outputLatencyFrames: c.cmd.outputLatencyFrames }] : [],
  );
}

describe('memoryBudgetBytes (ruling R9)', () => {
  it('is 384 MiB on a touch device (an iPad reports maxTouchPoints 5) and 1 GiB otherwise', () => {
    expect(TOUCH_MEMORY_BUDGET).toBe(384 * MiB);
    expect(DESKTOP_MEMORY_BUDGET).toBe(1024 * MiB);
    expect(memoryBudgetBytes({ maxTouchPoints: 5 })).toBe(384 * MiB);
    expect(memoryBudgetBytes({ maxTouchPoints: 2 })).toBe(384 * MiB);
    expect(memoryBudgetBytes({ maxTouchPoints: 1 })).toBe(1024 * MiB);
    expect(memoryBudgetBytes({ maxTouchPoints: 0 })).toBe(1024 * MiB);
    expect(memoryBudgetBytes({})).toBe(1024 * MiB);
    expect(memoryBudgetBytes(undefined)).toBe(1024 * MiB);
  });

  it('reaches the processor through the node options', async () => {
    const nav = new FakeNav();
    nav.maxTouchPoints = 5;
    const ipad = await startHost({ nav });
    expect(ipad.node.options.processorOptions).toEqual({ memoryBudgetBytes: 384 * MiB });
    run(ipad.processor, 1600);
    const s = ipad.events.find((e): e is Extract<EngineEvent, { t: 'status' }> => e.t === 'status')!;
    expect(s.status.memoryBudget).toBe(384 * MiB);

    const desktop = await startHost();
    expect(desktop.node.options.processorOptions).toEqual({ memoryBudgetBytes: 1024 * MiB });
  });
});

describe('EngineHost.start', () => {
  it('sets the audio session to play-and-record before asking for the mic, with only echoCancellation from MIC PROCESS', async () => {
    const rig = await startHost();
    expect(rig.nav.sessionAtCall).toEqual(['play-and-record']);
    expect(rig.nav.lastAudio()).toEqual({ echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 });
    expect(rig.host.micAvailable).toBe(true);
    expect(rig.logs.some(([m, d]) => /mic/i.test(m) && d === rig.nav.streams[0]!.track.settings)).toBe(true);
  });

  it('MIC PROCESS ON at start asks for echoCancellation', async () => {
    const system = defaultSystem();
    system.setup.micProcess = true;
    const rig = await startHost({ system });
    expect(rig.nav.lastAudio().echoCancellation).toBe(true);
  });

  it('works without navigator.audioSession', async () => {
    const nav = new FakeNav();
    delete nav.audioSession;
    const rig = await startHost({ nav });
    expect(rig.host.micAvailable).toBe(true);
  });

  it('loads the worklet and wires mic -> worklet -> destination', async () => {
    const rig = await startHost();
    expect(rig.ctx.modules).toEqual(['sage-processor.js']);
    expect(rig.node.options).toMatchObject({ numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 1, channelCountMode: 'explicit' });
    expect(rig.ctx.sources).toHaveLength(1);
    expect(rig.ctx.sources[0]!.stream).toBe(rig.nav.streams[0]);
    expect(rig.ctx.sources[0]!.node.connections).toEqual([rig.node]);
    expect(rig.node.connections).toEqual([rig.ctx.destination]);
  });

  it('without a mic: micAvailable is false, the engine still runs, and a later subscriber gets NO INPUT once', async () => {
    const nav = new FakeNav();
    nav.fail = true;
    const rig = await startHost({ nav });
    expect(rig.host.micAvailable).toBe(false);
    expect(rig.node.connections).toEqual([rig.ctx.destination]);
    expect(rig.ctx.sources).toHaveLength(0);
    await settle();
    expect(messages(rig)).toEqual(['NO INPUT']);
    const late: EngineEvent[] = [];
    rig.host.on((e) => late.push(e));
    await settle();
    expect(late).toEqual([]);
    run(rig.processor, 1600);
    expect(rig.events.some((e) => e.t === 'status')).toBe(true);
  });

  it('without mediaDevices (an insecure page) is the same NO INPUT case', async () => {
    const nav = new FakeNav();
    (nav as { mediaDevices?: unknown }).mediaDevices = undefined;
    const rig = await startHost({ nav });
    await settle();
    expect(rig.host.micAvailable).toBe(false);
    expect(messages(rig)).toEqual(['NO INPUT']);
  });

  it('a worklet that fails to load rejects start and releases the mic and the context', async () => {
    const ctx = new FakeContext();
    ctx.audioWorklet.addModule = async () => {
      throw new Error('load failed');
    };
    const nav = new FakeNav();
    await expect(startHost({ ctx, nav })).rejects.toThrow('load failed');
    expect(nav.streams[0]!.track.stopped).toBe(true);
    expect(ctx.state).toBe('closed');
  });

  it('satisfies the controller-facing EngineLike', async () => {
    const rig = await startHost();
    const engine: EngineLike = rig.host;
    expect(typeof engine.send).toBe('function');
    expect(EngineHost.start).toBeTypeOf('function');
  });
});

describe('EngineHost.send', () => {
  it('posts a TimedCommand with the heard frame of the event time', async () => {
    const rig = await startHost();
    rig.ctx.timestamp = { contextTime: 2, performanceTime: 10000 };
    rig.host.send({ t: 'recPlay', track: 0 }, 10250);
    // (2 s + 250 ms) x 48000
    expect(sentCommands(rig).at(-1)).toEqual({ t: 'recPlay', at: 108000 });
  });

  it('sends at = null without an event time, before the context plays, or while it is not running', async () => {
    const rig = await startHost();
    rig.host.send({ t: 'stop', track: 1 });
    expect(sentCommands(rig).at(-1)!.at).toBeNull();
    rig.ctx.timestamp = { contextTime: 0, performanceTime: 0 };
    rig.host.send({ t: 'stop', track: 1 }, 5000);
    expect(sentCommands(rig).at(-1)!.at).toBeNull();
    rig.ctx.timestamp = { contextTime: 2, performanceTime: 10000 };
    rig.ctx.setState('suspended');
    rig.host.send({ t: 'stop', track: 1 }, 10250);
    expect(sentCommands(rig).at(-1)!.at).toBeNull();
  });

  it('eventFrame maps performance time onto the output timeline', () => {
    expect(eventFrame({ contextTime: 1, performanceTime: 500 }, 1500, 44100)).toBe(88200);
    expect(eventFrame({ contextTime: 1, performanceTime: 500 }, 400, 1000)).toBe(900);
    expect(eventFrame({}, 1500, 44100)).toBeNull();
    expect(eventFrame({ contextTime: 0, performanceTime: 0 }, 1500, 44100)).toBeNull();
    expect(eventFrame({ contextTime: 1, performanceTime: 500 }, undefined, 44100)).toBeNull();
    expect(eventFrame({ contextTime: 1, performanceTime: 500 }, Number.NaN, 44100)).toBeNull();
  });

  it('delivers the processor events to every handler until it unsubscribes', async () => {
    const rig = await startHost();
    const mine: EngineEvent[] = [];
    const off = rig.host.on((e) => mine.push(e));
    run(rig.processor, 1600);
    const n = mine.length;
    expect(n).toBeGreaterThan(0);
    off();
    run(rig.processor, 1600);
    expect(mine).toHaveLength(n);
    expect(rig.events.length).toBeGreaterThan(n);
  });

  it('settings with a new MIC PROCESS restart the mic with the new echoCancellation', async () => {
    const rig = await startHost();
    const first = rig.nav.streams[0]!;
    rig.host.send(freeSettings((_m, s) => {
      s.setup.micProcess = true;
    }));
    await settle();
    expect(first.track.stopped).toBe(true);
    expect(rig.nav.streams).toHaveLength(2);
    expect(rig.nav.lastAudio().echoCancellation).toBe(true);
    expect(rig.ctx.sources[1]!.node.connections).toEqual([rig.node]);
    // The same value again changes nothing.
    rig.host.send(freeSettings((_m, s) => {
      s.setup.micProcess = true;
    }));
    await settle();
    expect(rig.nav.streams).toHaveLength(2);
    expect(sentCommands(rig).filter((c) => c.t === 'settings')).toHaveLength(2);
  });
});

/** Distinct stereo audio. */
function audioOf(frames: number, seed: number): TrackAudio {
  const L = new Float32Array(frames);
  const R = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    L[i] = Math.sin(i * 0.001 * seed);
    R[i] = Math.cos(i * 0.002 * seed);
  }
  return { L, R, sampleRate: 48000, recordedTempo: 90 + seed, measures: null };
}

function trackReplies(rig: Rig): Extract<EngineEvent, { t: 'tracks' }>[] {
  return rig.events.filter((e): e is Extract<EngineEvent, { t: 'tracks' }> => e.t === 'tracks');
}

describe('EngineHost export reassembly (ruling R47)', () => {
  it('reassembles a streamed export into one tracks event, sample-exact; handlers never see the parts', async () => {
    const rig = await startHost();
    const a = audioOf(120000, 1);
    const b = audioOf(30000, 2);
    rig.host.send({ t: 'loadTrack', track: 1, audio: a });
    rig.host.send({ t: 'loadTrack', track: 3, audio: b });
    rig.host.send({ t: 'exportTracks', reqId: 4 });
    for (let i = 0; i < 5 && trackReplies(rig).length === 0; i++) run(rig.processor, 128);
    const replies = trackReplies(rig);
    expect(replies).toHaveLength(1);
    const { reqId, tracks } = replies[0]!;
    expect(reqId).toBe(4);
    expect(tracks.map((t) => (t === null ? null : t.L.length))).toEqual([null, 120000, null, 30000, null]);
    expect(tracks[1]!.L).toEqual(a.L);
    expect(tracks[1]!.R).toEqual(a.R);
    expect(tracks[3]!.L).toEqual(b.L);
    expect(tracks[1]!.recordedTempo).toBe(91);
    expect(rig.events.some((e) => e.t === 'tracksStart' || e.t === 'tracksPart' || e.t === 'tracksEnd')).toBe(false);
  });

  it('keeps interleaved requests in order, each with its own audio', async () => {
    const rig = await startHost();
    const a = audioOf(60000, 3);
    rig.host.send({ t: 'loadTrack', track: 0, audio: a });
    rig.host.send({ t: 'exportTracks', reqId: 1 });
    run(rig.processor, 128); // request 1 is streaming
    rig.host.send({ t: 'clear', track: 0 });
    rig.host.send({ t: 'exportTracks', reqId: 2 });
    for (let i = 0; i < 6; i++) run(rig.processor, 128);
    const replies = trackReplies(rig);
    expect(replies.map((r) => r.reqId)).toEqual([1, 2]);
    expect(replies[0]!.tracks[0]!.L).toEqual(a.L);
    expect(replies[1]!.tracks[0]).toBeNull();
  });
});

describe('EngineHost export failures', () => {
  it('an export the processor abandons (tracksAbort) frees the host arrays and delivers nothing', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const real = AudioTake.prototype.read;
    let reads = 0;
    // Loaded tracks are stopped, so the export's are the only reads: the second one fails.
    const spy = vi.spyOn(AudioTake.prototype, 'read').mockImplementation(function (this: AudioTake, ...args: Parameters<AudioTake['read']>) {
      if (++reads === 2) throw new Error('read failed');
      real.apply(this, args);
    });
    try {
      const rig = await startHost();
      rig.host.send({ t: 'loadTrack', track: 0, audio: audioOf(120000, 1) });
      rig.host.send({ t: 'exportTracks', reqId: 1 });
      run(rig.processor, 128);
      expect(rig.host.exportsInFlight).toBe(1);
      run(rig.processor, 128); // the second part fails
      expect(rig.procPort.events('tracksAbort').map((e) => e.reqId)).toEqual([1]);
      expect(rig.host.exportsInFlight).toBe(0);
      for (let i = 0; i < 4; i++) run(rig.processor, 128);
      expect(trackReplies(rig)).toHaveLength(0);
      expect(rig.events.filter((e) => e.t === 'message').map((e) => (e as { text: string }).text)).toEqual(['ENGINE ERROR']);
    } finally {
      spy.mockRestore();
      errors.mockRestore();
    }
  });

  it('stop() in the middle of an export clears the reassembly state', async () => {
    const rig = await startHost();
    rig.host.send({ t: 'loadTrack', track: 2, audio: audioOf(150000, 2) });
    rig.host.send({ t: 'exportTracks', reqId: 1 });
    run(rig.processor, 128);
    expect(rig.host.exportsInFlight).toBe(1);
    await rig.host.stop();
    expect(rig.host.exportsInFlight).toBe(0);
    expect(trackReplies(rig)).toHaveLength(0);
  });
});

describe('EngineHost latency', () => {
  it('estimates outputLatency (or baseLatency) and outputLatency + baseLatency until calibrated, and sends it', async () => {
    const rig = await startHost();
    // outputLatency 0.02 s, baseLatency 0.005 s at 48 kHz
    expect(rig.host.latency()).toEqual({ roundTripFrames: 1200, outputLatencyFrames: 960 });
    expect(latencyCommands(rig)).toEqual([{ roundTripFrames: 1200, outputLatencyFrames: 960 }]);
  });

  it('falls back to baseLatency while outputLatency reads 0, and updates once the context runs', async () => {
    const ctx = new FakeContext();
    ctx.outputLatency = 0; // Safari: 0 until the context is playing
    ctx.state = 'suspended';
    ctx.resumeHangs = true; // start() asks to resume; without a gesture that waits
    const rig = await startHost({ ctx });
    expect(rig.host.latency()).toEqual({ roundTripFrames: 240, outputLatencyFrames: 240 });
    ctx.outputLatency = 0.01;
    ctx.setState('running');
    expect(rig.host.latency()).toEqual({ roundTripFrames: 720, outputLatencyFrames: 480 });
    expect(latencyCommands(rig).at(-1)).toEqual({ roundTripFrames: 720, outputLatencyFrames: 480 });
  });

  it('re-estimates when the host\'s own resume brings the context back', async () => {
    const ctx = new FakeContext();
    ctx.outputLatency = 0;
    const rig = await startHost({ ctx });
    ctx.setState('interrupted');
    ctx.outputLatency = 0.01;
    rig.doc.set('visible');
    await settle();
    expect(ctx.state).toBe('running');
    expect(latencyCommands(rig).at(-1)).toEqual({ roundTripFrames: 720, outputLatencyFrames: 480 });
  });

  it('uses the calibrated SETUP LATENCY when it is set', async () => {
    const rig = await startHost();
    rig.host.send(freeSettings((_m, s) => {
      s.setup.latency = 2345;
    }));
    expect(rig.host.latency()).toEqual({ roundTripFrames: 2345, outputLatencyFrames: 960 });
    expect(latencyCommands(rig).at(-1)).toEqual({ roundTripFrames: 2345, outputLatencyFrames: 960 });
    const before = latencyCommands(rig).length;
    rig.host.send(freeSettings((_m, s) => {
      s.setup.latency = 2345;
    }));
    expect(latencyCommands(rig)).toHaveLength(before);
  });

  it('a latency command sent through the host becomes its latency', async () => {
    const rig = await startHost();
    rig.host.send({ t: 'latency', roundTripFrames: 1500, outputLatencyFrames: 700 });
    expect(rig.host.latency()).toEqual({ roundTripFrames: 1500, outputLatencyFrames: 700 });
  });
});

describe('EngineHost.stop', () => {
  it('closes the context, stops the mic and stops listening', async () => {
    const doc = new FakeDoc();
    const rig = await startHost({ doc });
    expect(doc.listenerCount).toBe(1);
    await rig.host.stop();
    expect(rig.ctx.state).toBe('closed');
    expect(rig.nav.streams[0]!.track.stopped).toBe(true);
    expect(rig.node.disconnects).toBeGreaterThan(0);
    expect(doc.listenerCount).toBe(0);
    const before = sentCommands(rig).length;
    doc.set('hidden');
    expect(sentCommands(rig)).toHaveLength(before);
    await rig.host.stop(); // twice is harmless
  });
});
