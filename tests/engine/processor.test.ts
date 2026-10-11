import { afterEach, describe, expect, it, vi } from 'vitest';
import { SageProcessor } from '../../src/engine/processor';
import { DESKTOP_MEMORY_BUDGET, PROCESSOR_NAME, RECORDER_BLOCK } from '../../src/engine/config';
import { MasterFx } from '../../src/dsp/master';
import { defaultMemory } from '../../src/schema/memory';
import type { TrackAudio } from '../../src/shared/protocol';
import { BLOCK, SR, awaitTracks, exportTracks, freeSettings, makeProcessor, maxAbs, minOf, run, send } from './helpers';

/** Deterministic stereo audio whose every sample differs. */
function noiseAudio(frames: number, seed: number): TrackAudio {
  const L = new Float32Array(frames);
  const R = new Float32Array(frames);
  let x = seed * 7919;
  for (let i = 0; i < frames; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    L[i] = x / 2147483648 - 0.5;
    R[i] = 0.5 - x / 2147483648;
  }
  return { L, R, sampleRate: SR, recordedTempo: 100 + seed, measures: seed };
}

describe('SageProcessor', () => {
  it('records a 1 s loop of 0.5 DC and plays it back, posting a status about every 800 frames', () => {
    const { p, port } = makeProcessor();
    send(port, { t: 'recPlay', track: 0 });
    run(p, SR, 0.5);
    send(port, { t: 'recPlay', track: 0 });
    const out = run(p, SR, 0.5);

    const statuses = port.events('status').map((e) => e.status);
    // round(48000 / 60) = 800 frames: 96000 frames give 120 statuses, each within one block of its slot.
    expect(statuses).toHaveLength(120);
    for (let i = 1; i < statuses.length; i++) {
      const gap = statuses[i]!.frame - statuses[i - 1]!.frame;
      expect(gap).toBeGreaterThanOrEqual(800 - BLOCK);
      expect(gap).toBeLessThanOrEqual(800 + BLOCK);
    }
    const last = statuses.at(-1)!;
    expect(last.sampleRate).toBe(SR);
    expect(last.frame).toBeGreaterThan(2 * SR - 800 - BLOCK);
    expect(last.frame).toBeLessThanOrEqual(2 * SR);
    expect(last.tracks[0]!.state).toBe('playing');
    expect(Math.abs(last.tracks[0]!.lengthFrames - SR)).toBeLessThanOrEqual(BLOCK);
    expect(last.inputPeak).toBeCloseTo(0.5, 5);
    // Fader 1, PLAY LEVEL 100 at the centre (the core's balance law is unity there), every MIXER level 100, flat EQ,
    // no master FX, INPUT THRU off: the loop comes out at 0.5 on both sides.
    expect(out.L[SR - 1]).toBeCloseTo(0.5, 4);
    expect(out.R[SR - 1]).toBeCloseTo(0.5, 4);
    expect(last.outputPeak).toBeCloseTo(0.5, 4);
  });

  it('scales the track by its fader gain and the MIXER and master levels', () => {
    const { p, port } = makeProcessor();
    send(port, freeSettings());
    send(port, { t: 'recPlay', track: 0 });
    run(p, 4800, 0.5);
    send(port, { t: 'recPlay', track: 0 });
    send(port, { t: 'fader', track: 0, gain: 0.25 });
    let out = run(p, 4800, 0);
    expect(out.L[4799]).toBeCloseTo(0.125, 4);
    expect(out.R[4799]).toBeCloseTo(0.125, 4);

    // LOOP OUT 50 and MASTER OUT 50 halve it twice more; a pan to R25 halves the left side only (the core's balance law).
    send(port, freeSettings((m, s) => {
      s.mixer.loopOut = 50;
      s.mixer.masterOut = 50;
      m.track[0]!.pan = 25;
    }));
    out = run(p, 4800, 0);
    expect(out.L[4799]).toBeCloseTo(0.125 / 4 / 2, 4);
    expect(out.R[4799]).toBeCloseTo(0.125 / 4, 4);
  });

  it('applies settings to the core as well as the DSP', () => {
    const { p, port } = makeProcessor();
    send(port, freeSettings((m) => {
      m.tempo = 97.5;
    }));
    run(p, 1600);
    expect(port.events('status').at(-1)!.status.tempo).toBeCloseTo(97.5, 9);
  });

  it('monitors the mic only with INPUT THRU on', () => {
    const { p, port } = makeProcessor();
    send(port, freeSettings());
    expect(maxAbs(run(p, 1024, 0.5).L)).toBe(0);
    send(port, freeSettings((_m, s) => {
      s.output.routing.inputThru = true;
    }));
    const out = run(p, 1024, 0.5);
    expect(out.L[1023]).toBeCloseTo(0.5, 4);
    expect(out.R[1023]).toBeCloseTo(0.5, 4);
  });

  it('micMute silences the mic for the tracks, the meter and the recorder bus; unmuting restores it', () => {
    const { p, port } = makeProcessor();
    send(port, freeSettings());
    send(port, { t: 'micMute', on: true });
    send(port, { t: 'recorder', on: true });
    send(port, { t: 'recPlay', track: 0 });
    run(p, RECORDER_BLOCK, 0.5);
    send(port, { t: 'recPlay', track: 0 });
    run(p, 1600, 0.5);
    expect(port.events('status').at(-1)!.status.inputPeak).toBe(0);
    const blocks = port.events('recorderBlock');
    expect(blocks.length).toBeGreaterThan(0);
    expect(maxAbs(blocks[0]!.L)).toBe(0);
    const muted = exportTracks(p, port, 1)[0]!;
    expect(maxAbs(muted.L)).toBe(0);

    send(port, { t: 'micMute', on: false });
    run(p, 1600, 0.5);
    expect(port.events('status').at(-1)!.status.inputPeak).toBeCloseTo(0.5, 5);
  });

  it('batches the recorder bus into 4096-frame recorderBlock events that total the frames run', () => {
    const { p, port } = makeProcessor();
    send(port, freeSettings());
    send(port, { t: 'recorder', on: true });
    run(p, 10000, 0.25);
    expect(port.events('status').at(-1)!.status.recorderFrames).toBeGreaterThan(9000);
    send(port, { t: 'recorder', on: false });
    run(p, 1600, 0.25); // the stop applies at the next block and flushes the partial batch

    const posts = port.posted.filter((m) => (m.data as { t: string }).t === 'recorderBlock');
    const blocks = port.events('recorderBlock');
    expect(blocks.map((b) => b.L.length)).toEqual([RECORDER_BLOCK, RECORDER_BLOCK, 10000 - 2 * RECORDER_BLOCK]);
    for (const b of blocks) expect(b.R.length).toBe(b.L.length);
    // The recorder bus is the mix with the mic always in (at unity here, with no master FX).
    expect(minOf(blocks[1]!.L)).toBeCloseTo(0.25, 4);
    expect(maxAbs(blocks[1]!.R)).toBeCloseTo(0.25, 4);
    // Transferred, not copied: the processor's own buffers were detached by the post.
    for (const m of posts) {
      expect(m.transfer).toHaveLength(2);
      for (const b of m.transfer) expect((b as ArrayBuffer).byteLength).toBe(0);
    }
    expect(port.events('status').at(-1)!.status.recorderFrames).toBeNull();
  });

  it('a recorder started again begins a new count', () => {
    const { p, port } = makeProcessor();
    send(port, { t: 'recorder', on: true });
    run(p, 5000);
    send(port, { t: 'recorder', on: false });
    send(port, { t: 'recorder', on: true });
    run(p, 1664);
    const total = port.events('recorderBlock').reduce((n, b) => n + b.L.length, 0);
    expect(total).toBe(5000);
    const frames = port.events('status').at(-1)!.status.recorderFrames;
    expect(frames).toBeGreaterThan(0);
    expect(frames).toBeLessThanOrEqual(1664);
  });

  it('answers exportTracks with the five tracks, transferring the copies', () => {
    const { p, port } = makeProcessor();
    send(port, freeSettings());
    send(port, { t: 'recPlay', track: 1 });
    run(p, 4800, 0.5);
    send(port, { t: 'recPlay', track: 1 });
    run(p, BLOCK, 0.5);
    const tracks = exportTracks(p, port, 7);
    expect(tracks[0]).toBeNull();
    expect(tracks[2]).toBeNull();
    const t = tracks[1]!;
    expect(t.L.length).toBe(4800);
    expect(t.sampleRate).toBe(SR);
    expect(t.L[2400]).toBeCloseTo(0.5, 5);
    const post = port.posted.find((m) => (m.data as { t: string }).t === 'tracks')!;
    expect(post.transfer).toHaveLength(2);
  });

  it('loads a track sent with loadTrack', () => {
    const { p, port } = makeProcessor();
    send(port, freeSettings());
    const L = new Float32Array(2400).fill(0.3);
    const R = new Float32Array(2400).fill(-0.3);
    send(port, { t: 'loadTrack', track: 4, audio: { L, R, sampleRate: SR, recordedTempo: 120, measures: null } });
    run(p, 1600);
    expect(port.events('status').at(-1)!.status.tracks[4]!.state).toBe('stopped');
    expect(exportTracks(p, port)[4]!.R[100]).toBeCloseTo(-0.3, 6);
  });

  it('runs without a mic channel: silence in, nothing recorded, no crash', () => {
    const { p, port } = makeProcessor();
    send(port, freeSettings());
    send(port, { t: 'recPlay', track: 0 });
    const out = run(p, 4800, null);
    expect(maxAbs(out.L)).toBe(0);
    expect(port.events('status').at(-1)!.status.inputPeak).toBe(0);
  });

  it('passes MEMORY FULL from the core as a message event', () => {
    // A budget of one 1-second chunk (48000 frames x 2 channels x 4 bytes).
    const { p, port } = makeProcessor({ memoryBudgetBytes: SR * 8 });
    send(port, freeSettings());
    send(port, { t: 'recPlay', track: 0 });
    run(p, SR + 9600, 0.5);
    expect(port.events('message').map((e) => e.text)).toEqual(['MEMORY FULL']);
    expect(port.events('status').at(-1)!.status.tracks[0]!.state).toBe('playing');
  });

  it('reports the memory budget it was given, and the desktop budget by default', () => {
    const a = makeProcessor({ memoryBudgetBytes: 123 * 1024 * 1024 });
    run(a.p, 1600);
    expect(a.port.events('status').at(-1)!.status.memoryBudget).toBe(123 * 1024 * 1024);
    const b = makeProcessor();
    run(b.p, 1600);
    expect(b.port.events('status').at(-1)!.status.memoryBudget).toBe(DESKTOP_MEMORY_BUDGET);
  });

  it('posts status every round(sr / 60) frames at other rates too', () => {
    const { p, port } = makeProcessor({}, 44100);
    run(p, 44100);
    // round(44100 / 60) = 735: one second gives 60 statuses.
    expect(port.events('status')).toHaveLength(60);
    expect(port.events('status')[0]!.status.sampleRate).toBe(44100);
  });

  it('ignores malformed messages', () => {
    const { p, port } = makeProcessor();
    port.receive(null);
    port.receive({ t: 'recPlay', track: 0 });
    port.receive({ cmd: 'stop', at: null });
    run(p, 1600, 0.5);
    expect(port.events('status').at(-1)!.status.tracks[0]!.state).toBe('empty');
  });

  it('applies a command dated in a later block at its frame', () => {
    const { p, port } = makeProcessor();
    send(port, freeSettings());
    send(port, { t: 'recPlay', track: 0 }, 1000);
    run(p, 3000, 0.5);
    send(port, { t: 'recPlay', track: 0 }, 3000);
    run(p, BLOCK, 0.5);
    expect(exportTracks(p, port)[0]!.L.length).toBe(2000);
  });
});

describe('SageProcessor timeline', () => {
  it('dates commands on the AudioContext timeline (currentFrame), not from when the processor started', () => {
    const { p, port } = makeProcessor();
    send(port, freeSettings((_m, s) => {
      s.input.dynamics.mic1Ns = 0;
    }));
    const base = 96000; // the context had run 2 s (permission prompt, worklet load) before the node existed
    send(port, { t: 'recPlay', track: 0 }, base + 24000);
    send(port, { t: 'recPlay', track: 0 }, base + 28800);
    run(p, 48000, (f) => f / 100000, BLOCK, base); // the input is the core frame / 100000
    const t = exportTracks(p, port)[0]!;
    expect(t.L.length).toBe(4800);
    expect(t.L[1000]).toBeCloseTo(0.25, 5); // core frame 25000 (the first 5 ms hold the seam crossfade)
    expect(t.L[4799]).toBeCloseTo(0.28799, 5);
  });

  it('reports status.frame on the AudioContext timeline', () => {
    const { p, port } = makeProcessor();
    run(p, 1024, 0, BLOCK, 96000);
    // The first status follows the 7th block: 896 frames after the processor's first block.
    expect(port.events('status')[0]!.status.frame).toBe(96000 + 896);
  });
});

describe('SageProcessor exportTracks', () => {
  it('copies across blocks, at most one second of audio per block, and returns the audio exactly', () => {
    const { p, port } = makeProcessor();
    send(port, freeSettings());
    const a = noiseAudio(SR, 1);
    const b = noiseAudio(SR, 2);
    const c = noiseAudio(SR / 2, 3);
    send(port, { t: 'loadTrack', track: 0, audio: a });
    send(port, { t: 'loadTrack', track: 2, audio: b });
    send(port, { t: 'loadTrack', track: 4, audio: c });
    run(p, BLOCK);
    send(port, { t: 'exportTracks', reqId: 3 });
    // 2.5 s of audio at 1 s per block: no answer after one or two blocks, the answer after the third.
    run(p, BLOCK);
    expect(port.events('tracks')).toHaveLength(0);
    run(p, BLOCK);
    expect(port.events('tracks')).toHaveLength(0);
    run(p, BLOCK);
    const reply = port.events('tracks');
    expect(reply).toHaveLength(1);
    const tracks = reply[0]!.tracks;
    expect(reply[0]!.reqId).toBe(3);
    expect(tracks[1]).toBeNull();
    expect(tracks[3]).toBeNull();
    for (const [i, src] of [[0, a], [2, b], [4, c]] as const) {
      expect(tracks[i]!.L).toEqual(src.L);
      expect(tracks[i]!.R).toEqual(src.R);
      expect(tracks[i]!.sampleRate).toBe(SR);
      expect(tracks[i]!.recordedTempo).toBe(src.recordedTempo);
      expect(tracks[i]!.measures).toBe(src.measures);
    }
  });

  it('exports the audio as it was when asked, even if the track changes while it copies', () => {
    const { p, port } = makeProcessor();
    send(port, freeSettings());
    const a = noiseAudio(3 * SR, 4);
    send(port, { t: 'loadTrack', track: 1, audio: a });
    send(port, { t: 'exportTracks', reqId: 1 });
    run(p, BLOCK);
    send(port, { t: 'clear', track: 1 });
    const tracks = awaitTracks(p, port, 1);
    expect(tracks[1]!.L).toEqual(a.L);
    expect(exportTracks(p, port, 2)[1]).toBeNull();
  });

  it('answers requests in order, sharing the per-block budget', () => {
    const { p, port } = makeProcessor();
    send(port, freeSettings());
    send(port, { t: 'loadTrack', track: 0, audio: noiseAudio(SR, 5) });
    send(port, { t: 'exportTracks', reqId: 1 });
    send(port, { t: 'exportTracks', reqId: 2 });
    run(p, BLOCK);
    expect(port.events('tracks').map((e) => e.reqId)).toEqual([1]);
    run(p, BLOCK);
    expect(port.events('tracks').map((e) => e.reqId)).toEqual([1, 2]);
  });
});

describe('SageProcessor robustness and CPU', () => {
  it('drops a command that throws, reports ENGINE ERROR, and keeps rendering', () => {
    const { p, port } = makeProcessor();
    port.receive({ cmd: { t: 'settings', memory: defaultMemory() }, at: null }); // no system: configure throws
    send(port, freeSettings((_m, s) => {
      s.output.routing.inputThru = true;
    }));
    const out = run(p, 1600, 0.5);
    expect(port.events('message').map((e) => e.text)).toEqual(['ENGINE ERROR']);
    expect(out.L[1599]).toBeCloseTo(0.5, 4); // the command after it applied, and the blocks kept coming
    expect(port.events('status')).toHaveLength(2);
  });

  it('skips the recorder bus MASTER FX while the recorder is off', () => {
    const spy = vi.spyOn(MasterFx.prototype, 'process');
    try {
      const { p, port } = makeProcessor();
      run(p, 4 * BLOCK);
      expect(spy).toHaveBeenCalledTimes(4); // out only
      send(port, { t: 'recorder', on: true });
      run(p, 4 * BLOCK);
      expect(spy).toHaveBeenCalledTimes(12); // out and perf
    } finally {
      spy.mockRestore();
    }
  });

  it('a recorder started again gets fresh MASTER FX: no stale reverb tail from the last take', () => {
    const { p, port } = makeProcessor();
    send(port, freeSettings((_m, s) => {
      s.master.reverb = 40;
    }));
    send(port, { t: 'recorder', on: true });
    run(p, RECORDER_BLOCK, 0.5);
    send(port, { t: 'recorder', on: false });
    send(port, { t: 'recorder', on: true });
    run(p, RECORDER_BLOCK, 0);
    const blocks = port.events('recorderBlock');
    expect(blocks).toHaveLength(2);
    expect(maxAbs(blocks[0]!.L)).toBeGreaterThan(0.1);
    expect(maxAbs(blocks[1]!.L)).toBeLessThan(1e-9);
    expect(maxAbs(blocks[1]!.R)).toBeLessThan(1e-9);
  });
});

describe('the AudioWorklet registration', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('registers nothing when imported outside an AudioWorkletGlobalScope', () => {
    expect(typeof (globalThis as { registerProcessor?: unknown }).registerProcessor).toBe('undefined');
    expect(SageProcessor).toBeTypeOf('function');
  });

  it("registers 'sage-processor', which runs in a scope without structuredClone", async () => {
    let registered: { name: string; ctor: new (options?: unknown) => { process(i: Float32Array[][], o: Float32Array[][]): boolean } } | null = null;
    // A port that records posts without cloning them (FakePort clones with structuredClone, which is stubbed out here).
    class FakeWorkletProcessor {
      readonly port = {
        onmessage: null as ((ev: MessageEvent) => void) | null,
        posted: [] as unknown[],
        postMessage(message: unknown): void {
          this.posted.push(message);
        },
      };
    }
    vi.stubGlobal('registerProcessor', (name: string, ctor: never) => {
      registered = { name, ctor };
    });
    vi.stubGlobal('AudioWorkletProcessor', FakeWorkletProcessor);
    vi.stubGlobal('sampleRate', 44100);
    vi.stubGlobal('currentFrame', 441000); // the context has run 10 s
    vi.stubGlobal('structuredClone', undefined); // the AudioWorkletGlobalScope has none
    vi.resetModules();
    await import('../../src/engine/processor');

    expect(registered).not.toBeNull();
    const reg = registered!;
    expect(reg.name).toBe(PROCESSOR_NAME);
    expect(PROCESSOR_NAME).toBe('sage-processor');
    const node = new reg.ctor({ processorOptions: { memoryBudgetBytes: 5 * 1024 * 1024 } }) as unknown as {
      port: FakeWorkletProcessor['port'];
      process(i: Float32Array[][], o: Float32Array[][]): boolean;
    };
    for (let i = 0; i < 6; i++) expect(node.process([[new Float32Array(BLOCK)]], [[new Float32Array(BLOCK), new Float32Array(BLOCK)]])).toBe(true);
    const status = node.port.posted
      .map((m) => m as { t: string; status?: { sampleRate: number; memoryBudget: number; frame: number } })
      .find((d) => d.t === 'status');
    expect(status?.status?.sampleRate).toBe(44100);
    // currentFrame is read: the stub holds it at 441000, so the status shows the end of that block on the context's timeline.
    expect(status?.status?.frame).toBe(441000 + BLOCK);
    expect(status?.status?.memoryBudget).toBe(5 * 1024 * 1024);
  });
});
