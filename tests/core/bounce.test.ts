import { afterEach, describe, expect, it, vi } from 'vitest';
import { LooperCore } from '../../src/core/looper';
import type { DeepPartial } from './harness';
import { at, dc, makeCore, makeOutput, recPlay, run, trk } from './harness';
import { defaultMemory } from '../../src/schema/memory';
import { defaultSystem } from '../../src/schema/system';
import type { MemorySettings, SystemSettings } from '../../src/schema/types';

const PLAY = { rec: { recAction: 'REC->PLAY' as const } };

/** Track 1 (index 0) records a 1000-frame loop of `level` from frame 0 and plays it from frame 1000. */
function withLoop(over: DeepPartial<MemorySettings>, level = 0.5): LooperCore {
  const core = makeCore({ ...PLAY, ...over });
  at(core, 0, recPlay(0), dc(level));
  at(core, 1000, recPlay(0), dc(level));
  return core;
}

/** Records track `i` from `from` for 1000 frames with the mic at `mic`, then returns its loop. */
function recordOver(core: LooperCore, i: 0 | 1 | 2 | 3 | 4, from: number, mic: number): Float32Array {
  at(core, from, recPlay(i), dc(mic));
  at(core, from + 1000, recPlay(i), dc(mic));
  return core.getTrackAudio(i)!.L;
}

describe('BOUNCE', () => {
  it('track 1 holds 0.5 and track 2 records with BOUNCE IN -> track 2 holds 0.5 plus the input', () => {
    const core = withLoop({ track: [{}, { bounceIn: true }] });
    const loop = recordOver(core, 1, 2000, 0.1);
    expect(loop[500]).toBeCloseTo(0.6, 6);
    expect(loop[999]).toBeCloseTo(0.6, 6);
  });

  it('without BOUNCE IN or BOUNCE SW a track records the input alone', () => {
    const core = withLoop({});
    expect(recordOver(core, 1, 2000, 0.1)[500]).toBeCloseTo(0.1, 6);
  });

  it('BOUNCE SW bounces the tracks selected in BOUNCE TRACK into whichever track records', () => {
    const on = withLoop({ rec: { bounceSw: true, bounceTrack: [true, true, true, true, true] } });
    expect(recordOver(on, 2, 2000, 0.1)[500]).toBeCloseTo(0.6, 6);

    const deselected = withLoop({ rec: { bounceSw: true, bounceTrack: [false, true, true, true, true] } });
    expect(recordOver(deselected, 2, 2000, 0.1)[500]).toBeCloseTo(0.1, 6);

    // BOUNCE IN picks its sources from BOUNCE TRACK as well.
    const picky = withLoop({ track: [{}, { bounceIn: true }], rec: { bounceTrack: [false, true, true, true, true] } });
    expect(recordOver(picky, 1, 2000, 0.1)[500]).toBeCloseTo(0.1, 6);
  });

  it('bounces into an overdub too, and never a track into itself', () => {
    const core = withLoop({ track: [{}, { bounceIn: true }] });
    recordOver(core, 1, 2000, 0.1); // track 2: 0.6
    // Track 2 plays from 3000. Overdub it for one pass with the mic silent: + track 1 (0.5), not its own 0.6.
    at(core, 4000, recPlay(1));
    at(core, 5000, recPlay(1));
    run(core, 100);
    expect(core.getTrackAudio(1)!.L[500]).toBeCloseTo(1.1, 5);
  });

  it('bounces what the source plays: after its PLAY LEVEL and PAN', () => {
    const core = withLoop({ track: [{ playLevel: 50, pan: 50 }, { bounceIn: true }] });
    recordOver(core, 1, 2000, 0);
    const a = core.getTrackAudio(1)!;
    expect(a.L[500]).toBeCloseTo(0, 6); // hard right: nothing on the left
    expect(a.R[500]).toBeCloseTo(0.25, 6);
  });

  it('works whatever the track order: track 1 can record track 2', () => {
    const core = makeCore({ ...PLAY, track: [{ bounceIn: true }] });
    at(core, 0, recPlay(1), dc(0.5));
    at(core, 1000, recPlay(1), dc(0.5));
    expect(recordOver(core, 0, 2000, 0.1)[500]).toBeCloseTo(0.6, 6);
  });

  it('with latency, the bounced playback lines up with the timeline it was heard on', () => {
    const core = makeCore({ ...PLAY, track: [{}, { bounceIn: true }] });
    core.setLatency(30, 10);
    // Track 1: a loop holding its own positions (take frame k = k), 1000 frames, from heard frame 0.
    const rampIn = (f: number): number => (f - 30) / 1000;
    at(core, 0, recPlay(0), rampIn);
    at(core, 1000, recPlay(0), rampIn);
    // Track 1 now plays position (f - 1000) mod 1000 at frame f. Track 2 records frames 2000..2999 as heard, silent mic.
    const heard = new Float32Array(4200);
    const out = run(core, 2000 - core.frame).tracks[0];
    heard.set(out, 1000);
    at(core, 2000, recPlay(1));
    heard.set(run(core, 1000).tracks[0], 2000);
    at(core, 3000, recPlay(1));
    heard.set(run(core, 200).tracks[0], 3000);
    const loop = core.getTrackAudio(1)!.L;
    expect(loop.length).toBe(1000);
    // Frame k of track 2's loop is what track 1 played at heard frame 2000 + k (away from the seam crossfade).
    for (let k = 10; k < 1000; k += 37) expect(loop[k]).toBeCloseTo(heard[2000 + k], 6);
  });
});

describe('TRACK INPUT routing', () => {
  it('a track with MIC1 off records silence from the mic', () => {
    const core = makeCore({ ...PLAY, track: [{ input: { MIC1: false } }] });
    at(core, 0, recPlay(0), dc(0.5));
    at(core, 1000, recPlay(0), dc(0.5));
    run(core, 10);
    expect(trk(core).lengthFrames).toBe(1000);
    expect(core.getTrackAudio(0)!.L.every((v) => v === 0)).toBe(true);
  });

  /** A core at sr 1000 with the rhythm on, `rhythmOut` as given and track 1's RHYTHM input as given. */
  function rhythmCore(rhythmOut: 'LOOP' | 'OUTPUT', rhythmIn: boolean): LooperCore {
    const memory: MemorySettings = defaultMemory();
    for (const t of memory.track) t.loopSyncSw = false;
    memory.rec.recAction = 'REC->PLAY';
    memory.track[0].input.RHYTHM = rhythmIn;
    memory.track[0].input.MIC1 = false;
    const system: SystemSettings = defaultSystem();
    system.output.routing.rhythmOut = rhythmOut;
    const core = new LooperCore({ sampleRate: 1000, memoryBudgetBytes: 64 * 1024 * 1024 });
    core.setSettings(memory, system);
    core.command({ t: 'rhythmStartStop' });
    return core;
  }

  it('RHYTHM records the GUIDE click when RHYTHM OUT is LOOP (Parameter Guide: LOOP lets you record the rhythm)', () => {
    const core = rhythmCore('LOOP', true);
    const clicks = new Float32Array(1000);
    const out = makeOutput(100);
    const z = new Float32Array(100);
    core.command(recPlay(0));
    for (let f = 0; f < 1000; f += 100) {
      core.process(z, z, z, z, out, 100);
      clicks.set(out.click[0], f);
    }
    core.command(recPlay(0));
    const loop = core.getTrackAudio(0)!.L;
    expect(loop.length).toBe(1000);
    let max = 0;
    for (let k = 0; k < 1000; k++) {
      expect(loop[k]).toBeCloseTo(clicks[k], 6);
      max = Math.max(max, Math.abs(loop[k]));
    }
    expect(max).toBeGreaterThan(0.1);
  });

  it('RHYTHM OUT OUTPUT or the track RHYTHM input off records no click', () => {
    for (const core of [rhythmCore('OUTPUT', true), rhythmCore('LOOP', false)]) {
      core.command(recPlay(0));
      run(core, 1000);
      core.command(recPlay(0));
      expect(core.getTrackAudio(0)!.L.every((v) => v === 0)).toBe(true);
    }
  });

  it('the external rhythm inputs reach RHYTHM-routed tracks too', () => {
    const core = rhythmCore('LOOP', true);
    core.command({ t: 'rhythmStartStop' }); // the click off: only the external rhythm
    const out = makeOutput(100);
    const z = new Float32Array(100);
    const ext = new Float32Array(100).fill(0.25);
    core.command(recPlay(0));
    for (let f = 0; f < 1000; f += 100) core.process(z, z, ext, ext, out, 100);
    core.command(recPlay(0));
    expect(core.getTrackAudio(0)!.L[500]).toBeCloseTo(0.25, 6);
  });
});

describe('routing and bounce allocate nothing per block', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('a bouncing overdub recording the click, with latency, makes no Float32Array', () => {
    const memory = defaultMemory();
    for (const t of memory.track) t.loopSyncSw = false;
    memory.rec.recAction = 'REC->DUB';
    memory.track[1].bounceIn = true;
    memory.track[1].input.RHYTHM = true;
    const system = defaultSystem();
    system.output.routing.rhythmOut = 'LOOP';
    const core = new LooperCore({ sampleRate: 1000, memoryBudgetBytes: 64 * 1024 * 1024 });
    core.setSettings(memory, system);
    core.setLatency(30, 10);
    at(core, 0, recPlay(0), dc(0.3));
    at(core, 1000, recPlay(0), dc(0.3)); // a 1000-frame loop, overdubbing from 1030 (REC->DUB)
    at(core, 1100, recPlay(0), dc(0.3)); // playing
    core.command({ t: 'rhythmStartStop' });
    at(core, 2000, recPlay(1), dc(0.1));
    at(core, 3000, recPlay(1), dc(0.1)); // track 2 overdubs from 3030
    run(core, 1500, dc(0.1)); // a whole pass: its copy-on-write chunk copy is done
    expect(trk(core, 1).state).toBe('overdubbing');

    const inL = new Float32Array(128).fill(0.1);
    const out = makeOutput(128);
    const made: unknown[] = [];
    const Real = Float32Array;
    vi.stubGlobal('Float32Array', new Proxy(Real, {
      construct(target, args: unknown[]) {
        made.push(args);
        return Reflect.construct(target, args) as object;
      },
    }));
    for (let i = 0; i < 40; i++) core.process(inL, inL, inL, inL, out, 128);
    vi.unstubAllGlobals();
    expect(trk(core, 1).state).toBe('overdubbing');
    expect(made).toHaveLength(0);
  });
});
