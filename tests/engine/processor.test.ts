import { afterEach, describe, expect, it, vi } from 'vitest';
import { SageProcessor } from '../../src/engine/processor';
import { DESKTOP_MEMORY_BUDGET, PROCESSOR_NAME, RECORDER_BLOCK } from '../../src/engine/config';
import { BLOCK, SR, exportTracks, freeSettings, makeProcessor, maxAbs, minOf, run, send } from './helpers';

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
    const status = node.port.posted.map((m) => m as { t: string; status?: { sampleRate: number; memoryBudget: number } }).find((d) => d.t === 'status');
    expect(status?.status?.sampleRate).toBe(44100);
    expect(status?.status?.memoryBudget).toBe(5 * 1024 * 1024);
  });
});
