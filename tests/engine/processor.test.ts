import { afterEach, describe, expect, it, vi } from 'vitest';
import { SageProcessor } from '../../src/engine/processor';
import { DESKTOP_MEMORY_BUDGET, PROCESSOR_NAME, RECORDER_BLOCK } from '../../src/engine/config';
import { MasterFx } from '../../src/dsp/master';
import { Mixer } from '../../src/dsp/mixer';
import { defaultMemory } from '../../src/schema/memory';
import type { TrackAudio } from '../../src/shared/protocol';
import { AudioTake } from '../../src/core/chunks';
import { LooperCore } from '../../src/core/looper';
import { BLOCK, SR, assembled, awaitTracks, exportTracks, freeSettings, makeProcessor, maxAbs, minOf, run, send } from './helpers';

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

  it('answers exportTracks with the five tracks, streamed in transferred parts', () => {
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
    const parts = port.posted.filter((m) => (m.data as { t: string }).t === 'tracksPart');
    expect(parts.length).toBeGreaterThan(0);
    for (const m of parts) expect(m.transfer).toHaveLength(2);
    expect(port.events('tracks')).toHaveLength(0); // the processor never posts the assembled event: the host builds it
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

describe('SageProcessor exportTracks (streamed, ruling R47)', () => {
  /** Loads 2.5 s of distinct audio on tracks 1, 3 and 5. */
  function loaded(): { p: SageProcessor; port: ReturnType<typeof makeProcessor>['port']; srcs: [number, TrackAudio][] } {
    const { p, port } = makeProcessor();
    send(port, freeSettings());
    const srcs: [number, TrackAudio][] = [[0, noiseAudio(SR, 1)], [2, noiseAudio(SR, 2)], [4, noiseAudio(SR / 2, 3)]];
    for (const [track, audio] of srcs) send(port, { t: 'loadTrack', track: track as 0 | 2 | 4, audio });
    run(p, BLOCK);
    return { p, port, srcs };
  }

  it('streams at most one second of audio per block as parts, and the parts reassemble sample-exact', () => {
    const { p, port, srcs } = loaded();
    send(port, { t: 'exportTracks', reqId: 3 });
    // The header goes at once; 2.5 s of audio at 1 s per block ends after the third block.
    const perBlock: number[] = [];
    for (let i = 0; i < 3; i++) {
      const before = port.events('tracksPart').length;
      run(p, BLOCK);
      perBlock.push(port.events('tracksPart').slice(before).reduce((n, e) => n + e.L.length, 0));
      expect(port.events('tracksEnd')).toHaveLength(i < 2 ? 0 : 1);
    }
    expect(perBlock).toEqual([SR, SR, SR / 2]);
    const head = port.events('tracksStart')[0]!;
    expect(head.reqId).toBe(3);
    expect(head.tracks.map((m) => m?.frames ?? null)).toEqual([SR, null, SR, null, SR / 2]);
    const tracks = assembled(port, 3)!;
    expect(tracks[1]).toBeNull();
    expect(tracks[3]).toBeNull();
    for (const [i, src] of srcs) {
      expect(tracks[i]!.L).toEqual(src.L);
      expect(tracks[i]!.R).toEqual(src.R);
      expect(tracks[i]!.sampleRate).toBe(SR);
      expect(tracks[i]!.recordedTempo).toBe(src.recordedTempo);
      expect(tracks[i]!.measures).toBe(src.measures);
    }
  });

  it('allocates nothing on the audio thread in proportion to the whole export: at most the per-block budget', () => {
    const { p, port } = loaded();
    const sizes: number[] = [];
    const Real = Float32Array;
    vi.stubGlobal('Float32Array', new Proxy(Real, {
      construct(target, args: unknown[]) {
        sizes.push(typeof args[0] === 'number' ? args[0] : -1);
        return Reflect.construct(target, args) as object;
      },
    }));
    try {
      const perBlock: number[] = [];
      send(port, { t: 'exportTracks', reqId: 1 });
      for (let i = 0; i < 4; i++) {
        sizes.length = 0;
        run(p, BLOCK);
        perBlock.push(sizes.filter((n) => n > BLOCK).reduce((a, b) => a + b, 0));
      }
      // Two channels of at most one second each per block; never the 2.5 s total at once.
      for (const n of perBlock) expect(n).toBeLessThanOrEqual(2 * SR);
      expect(Math.max(...perBlock)).toBeGreaterThan(0);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(assembled(port, 1)).not.toBeNull();
  });

  it('exports the audio as it was when asked, even if the track changes while it streams', () => {
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

  it('streams requests in order, sharing the per-block budget', () => {
    const { p, port } = makeProcessor();
    send(port, freeSettings());
    send(port, { t: 'loadTrack', track: 0, audio: noiseAudio(SR, 5) });
    send(port, { t: 'exportTracks', reqId: 1 });
    send(port, { t: 'exportTracks', reqId: 2 });
    run(p, BLOCK);
    expect(port.events('tracksEnd').map((e) => e.reqId)).toEqual([1]);
    run(p, BLOCK);
    expect(port.events('tracksEnd').map((e) => e.reqId)).toEqual([1, 2]);
    // Every part of request 1 comes before any part of request 2.
    const order = port.events('tracksPart').map((e) => e.reqId);
    expect(order).toEqual([...order].sort((x, y) => x - y));
  });

  it('a failure while streaming abandons the export and tells the host (tracksAbort)', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const real = AudioTake.prototype.read;
    let reads = 0;
    const spy = vi.spyOn(AudioTake.prototype, 'read').mockImplementation(function (this: AudioTake, ...args: Parameters<AudioTake['read']>) {
      if (++reads === 2) throw new Error('read failed');
      real.apply(this, args);
    });
    try {
      const { p, port } = loaded();
      send(port, { t: 'exportTracks', reqId: 6 });
      run(p, BLOCK);
      run(p, BLOCK);
      expect(port.events('tracksAbort').map((e) => e.reqId)).toEqual([6]);
      expect(port.events('tracksEnd')).toHaveLength(0);
      expect(port.events('message').map((e) => e.text)).toEqual(['ENGINE ERROR']);
      spy.mockRestore();
      for (const track of [0, 2, 4] as const) send(port, { t: 'clear', track });
      run(p, 1600);
      expect(port.events('status').at(-1)!.status.memoryBytes).toBe(0); // its snapshots were released
    } finally {
      spy.mockRestore();
      errors.mockRestore();
    }
  });

  it('a snapshot failing part-way releases the snapshots already taken (all or nothing)', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const real = AudioTake.prototype.snapshot;
    let calls = 0;
    const spy = vi.spyOn(AudioTake.prototype, 'snapshot').mockImplementation(function (this: AudioTake) {
      if (++calls === 2) throw new Error('snapshot failed');
      return real.call(this);
    });
    try {
      const { p, port } = loaded();
      send(port, { t: 'exportTracks', reqId: 1 });
      run(p, BLOCK);
      expect(port.events('message').map((e) => e.text)).toEqual(['ENGINE ERROR']);
      expect(port.events('tracksStart')).toHaveLength(0);
      for (const track of [0, 2, 4] as const) send(port, { t: 'clear', track });
      run(p, 1600);
      expect(port.events('status').at(-1)!.status.memoryBytes).toBe(0); // no chunk kept alive by a lost snapshot
    } finally {
      spy.mockRestore();
      errors.mockRestore();
    }
  });
});

describe('SageProcessor robustness and CPU', () => {
  it('drops a command that throws, reports ENGINE ERROR (and logs it), and keeps rendering', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { p, port } = makeProcessor();
    port.receive({ cmd: { t: 'settings', memory: defaultMemory() }, at: null }); // no system: configure throws
    send(port, freeSettings((_m, s) => {
      s.output.routing.inputThru = true;
    }));
    const out = run(p, 1600, 0.5);
    expect(port.events('message').map((e) => e.text)).toEqual(['ENGINE ERROR']);
    expect(out.L[1599]).toBeCloseTo(0.5, 4); // the command after it applied, and the blocks kept coming
    expect(port.events('status')).toHaveLength(2);
    expect(errors).toHaveBeenCalledTimes(1);
    errors.mockRestore();
  });

  it('a settings command that fails part-way leaves every DSP block and the core on the last good settings', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { p, port } = makeProcessor();
      send(port, freeSettings((_m, s) => {
        s.output.routing.inputThru = true;
        s.mixer.loopOut = 50;
      }));
      send(port, { t: 'recPlay', track: 0 });
      run(p, 4800, 0.5);
      send(port, { t: 'recPlay', track: 0 });
      run(p, 1600, 0);
      const good = run(p, 800, 0).L[799]!;
      expect(good).toBeCloseTo(0.25, 4); // the loop at LOOP OUT 50
      // INPUT and MIXER would configure (LOOP OUT 200), then MASTER FX finds no `master` and throws.
      const bad = freeSettings((m, s) => {
        s.mixer.loopOut = 200;
        m.tempo = 200;
      });
      delete (bad.system as { master?: unknown }).master;
      send(port, bad);
      const after = run(p, 1600, 0).L[1599]!;
      expect(after).toBeCloseTo(good, 6);
      expect(port.events('message').map((e) => e.text)).toEqual(['ENGINE ERROR']);
      expect(port.events('status').at(-1)!.status.tempo).not.toBeCloseTo(200, 3);
      expect(errors).toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it('a bad memory leaves the core on the last good settings, so it keeps rendering', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { p, port } = makeProcessor();
      send(port, freeSettings());
      send(port, { t: 'recPlay', track: 0 });
      run(p, 4800, 0.5);
      send(port, { t: 'recPlay', track: 0 });
      port.receive({ cmd: { t: 'settings', memory: {}, system: freeSettings().system }, at: null });
      const out = run(p, 4800, 0);
      expect(out.L[4799]).toBeCloseTo(0.5, 4);
      expect(port.events('message').map((e) => e.text)).toEqual(['ENGINE ERROR']);
    } finally {
      errors.mockRestore();
    }
  });

  it('probe B: after a bad settings command the recorder still starts and records', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { p, port } = makeProcessor();
      port.receive({ cmd: { t: 'settings', memory: defaultMemory() }, at: null }); // no system
      send(port, { t: 'recorder', on: true });
      run(p, RECORDER_BLOCK, 0.25);
      const blocks = port.events('recorderBlock');
      expect(blocks).toHaveLength(1);
      expect(blocks[0]!.L[RECORDER_BLOCK - 1]).toBeCloseTo(0.25, 4);
      expect(port.events('message').map((e) => e.text)).toEqual(['ENGINE ERROR']);
    } finally {
      errors.mockRestore();
    }
  });

  it('probe C: a bad settings command dated in a later block is caught too, and the blocks keep coming', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { p, port } = makeProcessor();
      send(port, freeSettings((_m, s) => {
        s.output.routing.inputThru = true;
      }));
      // A valid system but a broken memory, dated: the core would queue it and apply it inside its render.
      port.receive({ cmd: { t: 'settings', memory: {}, system: freeSettings().system }, at: 1000 });
      const out = run(p, 3200, 0.5);
      expect(out.L[3199]).toBeCloseTo(0.5, 4);
      expect(port.events('message').map((e) => e.text)).toEqual(['ENGINE ERROR']);
      expect(port.events('status')).toHaveLength(4);
    } finally {
      errors.mockRestore();
    }
  });

  it('a bad command the core applies later, inside its render, is caught: ENGINE ERROR, and rendering goes on', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { p, port } = makeProcessor();
      send(port, freeSettings((_m, s) => {
        s.output.routing.inputThru = true;
      }));
      // Dated: the core queues it and applies it at frame 1000, inside its process().
      port.receive({ cmd: { t: 'loadTrack', track: 0, audio: { L: null, R: null, sampleRate: SR, recordedTempo: 120, measures: null } }, at: 1000 });
      const out = run(p, 3200, 0.5);
      expect(out.L[3199]).toBeCloseTo(0.5, 4);
      expect(port.events('message').map((e) => e.text)).toEqual(['ENGINE ERROR']);
      expect(errors).toHaveBeenCalled();
      // And the core still works.
      send(port, { t: 'recPlay', track: 1 });
      run(p, 2400, 0.5);
      send(port, { t: 'recPlay', track: 1 });
      run(p, BLOCK, 0.5);
      expect(exportTracks(p, port)[1]!.L.length).toBe(2400);
    } finally {
      errors.mockRestore();
    }
  });

  it('no failure puts a stale memory tempo back over a tempo the engine derived (R31)', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { p, port } = makeProcessor();
      send(port, freeSettings((m) => {
        for (const t of m.track) t.loopSyncSw = true; // the first loop defines the tempo
      }));
      send(port, { t: 'recPlay', track: 0 });
      run(p, 72000, 0.5);
      send(port, { t: 'recPlay', track: 0 });
      run(p, 1600, 0.5);
      const derived = port.events('status').at(-1)!.status.tempo;
      expect(Math.abs(derived - 120)).toBeGreaterThan(1);
      // The controller adopts the derived tempo without a push, so the processor's last settings still say 120.
      // (i) A dated command that throws inside the core's render: nothing is restored (no settings are re-applied).
      const setSettings = vi.spyOn(LooperCore.prototype, 'setSettings');
      port.receive({ cmd: { t: 'loadTrack', track: 1, audio: { L: null, R: null, sampleRate: SR, recordedTempo: 120, measures: null } }, at: 74000 });
      run(p, 3200, 0);
      expect(setSettings).not.toHaveBeenCalled();
      setSettings.mockRestore();
      expect(port.events('status').at(-1)!.status.tempo).toBeCloseTo(derived, 9);
      // (ii) A settings command the core refuses: the last good settings come back, at the live tempo.
      port.receive({ cmd: { t: 'settings', memory: {}, system: freeSettings().system }, at: null });
      run(p, 1600, 0);
      expect(port.events('status').at(-1)!.status.tempo).toBeCloseTo(derived, 9);
      expect(port.events('message').map((e) => e.text)).toEqual(['ENGINE ERROR', 'ENGINE ERROR']);
      expect(port.events('status').at(-1)!.status.tracks[0]!.state).toBe('playing');
    } finally {
      errors.mockRestore();
    }
  });

  it('a looper that fails every block is reported at most once a second and logged once per burst', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const broken = vi.spyOn(LooperCore.prototype, 'process');
    try {
      const { p, port } = makeProcessor();
      send(port, freeSettings((_m, s) => {
        s.output.routing.inputThru = true;
      }));
      run(p, BLOCK);
      broken.mockImplementation(() => {
        throw new Error('broken');
      });
      const out = run(p, 3 * SR, 0.5); // 3 s of failing blocks
      const reports = port.events('message').filter((e) => e.text === 'ENGINE ERROR').length;
      expect(reports).toBeGreaterThanOrEqual(2);
      expect(reports).toBeLessThanOrEqual(3);
      expect(errors).toHaveBeenCalledTimes(1);
      expect(out.L[3 * SR - 1]).toBeCloseTo(0.5, 4); // the block still renders (the monitored mic) and statuses go on
      expect(port.events('status').length).toBeGreaterThanOrEqual(180);
      // Healthy again, then a new burst: logged again.
      broken.mockRestore();
      run(p, SR, 0.5);
      vi.spyOn(LooperCore.prototype, 'process').mockImplementation(() => {
        throw new Error('broken again');
      });
      run(p, BLOCK, 0.5);
      expect(errors).toHaveBeenCalledTimes(2);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('R67: a throw outside the guarded steps (the mixer) gives silence and ONE fault event, and never escapes process()', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { p, port } = makeProcessor();
      send(port, freeSettings((_m, s) => {
        s.output.routing.inputThru = true; // the mic is heard: a healthy block is not silent
      }));
      expect(run(p, BLOCK, 0.5).L[BLOCK - 1]).toBeCloseTo(0.5, 4);
      vi.spyOn(Mixer.prototype, 'process').mockImplementation(() => {
        throw new Error('mixer broke');
      });
      const out = run(p, 3 * SR, 0.5); // run() asserts every process() returned true (a throw would fail it)
      expect(maxAbs(out.L)).toBe(0);
      expect(maxAbs(out.R)).toBe(0);
      const faults = port.events('fault');
      expect(faults).toHaveLength(1); // no storm: one event for the whole run of failures
      expect(faults[0]!.message).toContain('mixer broke');
      expect(errors).toHaveBeenCalledTimes(1);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('R67 / ledger 311: a core whose status() throws (postStatus) is caught: that block is silent, one fault event', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { p, port } = makeProcessor();
      send(port, freeSettings((_m, s) => {
        s.output.routing.inputThru = true;
      }));
      run(p, 800, 0.5); // one status posted: the next is due 800 frames on
      port.clear();
      vi.spyOn(LooperCore.prototype, 'status').mockImplementation(() => {
        throw new Error('status broke');
      });
      const out = run(p, 2 * SR, 0.5);
      expect(port.events('fault')).toHaveLength(1);
      expect(port.events('status')).toHaveLength(0);
      // The block that tried to post the status is silent; the ones between statuses still play the mic.
      expect(out.L[0]).toBeCloseTo(0.5, 4);
      let silent = 0;
      for (let b = 0; b < out.L.length; b += BLOCK) if (maxAbs(out.L, b, b + BLOCK) === 0) silent++;
      expect(silent).toBeGreaterThan(0);
      expect(silent).toBeLessThan(out.L.length / BLOCK / 2);
    } finally {
      vi.restoreAllMocks();
    }
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

describe('SageProcessor undo/redo, marks and ALL START/STOP (Task 8)', () => {
  const track0 = (port: ReturnType<typeof makeProcessor>['port']) => port.events('status').at(-1)!.status.tracks[0]!;

  it('the commands reach the core: undoRedo, markSet, markClear, markBack, recBack, allStartStop', () => {
    const { p, port } = makeProcessor();
    send(port, freeSettings());
    send(port, { t: 'recPlay', track: 0 });
    run(p, SR, 0.5);
    send(port, { t: 'recPlay', track: 0 });
    run(p, SR, 0.5);
    send(port, { t: 'recPlay', track: 0 }); // overdub
    run(p, SR, 0.25);
    send(port, { t: 'recPlay', track: 0 });
    run(p, 1600);
    expect(track0(port)).toMatchObject({ state: 'playing', canUndo: true, canRedo: false, hasMark: false });
    send(port, { t: 'undoRedo', track: 0 });
    run(p, 1600);
    expect(track0(port)).toMatchObject({ canUndo: false, canRedo: true });
    send(port, { t: 'markSet', track: 0 });
    run(p, 1600);
    expect(track0(port).hasMark).toBe(true);
    send(port, { t: 'markClear', track: 0 });
    send(port, { t: 'recBack', track: 0 });
    run(p, 1600);
    expect(track0(port)).toMatchObject({ hasMark: false, canUndo: true, canRedo: false });
    send(port, { t: 'markBack', track: 0 }); // no mark: back to the recording again
    send(port, { t: 'allStartStop' });
    run(p, 1600);
    expect(track0(port)).toMatchObject({ state: 'stopped', canUndo: true });
    send(port, { t: 'allStartStop' });
    run(p, 1600);
    expect(track0(port).state).toBe('playing');
  });

  /**
   * Binding notes 2 and 6: an export taken at the STOP that ends an overdub at 1.5x (XFADE) must hold the ~6000
   * gathered frames still to land, as Track.audio() does: the processor streams `Track.exportSnapshot()`.
   */
  it('an export taken at the STOP ending an XFADE overdub at 1.5x holds the whole pass', () => {
    const sine = (hz: number) => (f: number): number => 0.4 * Math.sin((2 * Math.PI * hz * f) / SR);
    function dubThenStop(): { p: SageProcessor; port: ReturnType<typeof makeProcessor>['port'] } {
      const { p, port } = makeProcessor();
      send(port, freeSettings((m) => {
        m.track[0]!.tempoSyncMode = 'XFADE';
      }));
      send(port, { t: 'recPlay', track: 0 });
      run(p, 96000, sine(440)); // a 2 s loop at tempo 120
      send(port, { t: 'recPlay', track: 0 });
      send(port, { t: 'tempo', bpm: 180 }); // plays at 1.5x from here
      run(p, 4000, sine(440));
      send(port, { t: 'recPlay', track: 0 }); // punch in at position 6000
      run(p, 48000, sine(660));
      send(port, { t: 'stop', track: 0 }); // position 78000: the pass ends and the track stops
      return { p, port };
    }
    const now = dubThenStop();
    const got = exportTracks(now.p, now.port)[0]!.L;
    const later = dubThenStop();
    run(later.p, 48000);
    const want = exportTracks(later.p, later.port)[0]!.L;
    let missing = 0;
    for (let j = 7000; j < 76500; j++) if (Math.abs(got[j]! - want[j]!) > 1e-6) missing++;
    expect(missing).toBe(0);
  });
});
