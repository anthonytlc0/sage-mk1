import { afterEach, describe, expect, it, vi } from 'vitest';
import { RESUME_TIMEOUT_MS } from '../../src/engine/host';
import type { SageProcessor } from '../../src/engine/processor';
import type { FakePort } from '../../src/engine/fakePort';
import type { EngineEvent, TrackState } from '../../src/shared/protocol';
import { BLOCK, exportTracks, freeSettings, makeProcessor, maxAbs, run, send } from './helpers';
import { FakeNav, sentCommands, settle, startHost } from './hostFakes';
import type { Rig } from './hostFakes';

/** The 5 ms seam / punch crossfade at 48 kHz. */
const XF = 240;

function lastState(port: FakePort, track = 0): TrackState {
  return port.events('status').at(-1)!.status.tracks[track]!.state;
}

/** Track 1 holds a 4800-frame loop of 0.5 and is overdubbing 0.25 over its first half when this returns. */
function overdubbing(p: SageProcessor, port: FakePort): void {
  send(port, freeSettings());
  send(port, { t: 'recPlay', track: 0 });
  run(p, 4800, 0.5);
  send(port, { t: 'recPlay', track: 0 }); // REC->PLAY
  run(p, 4800, 0.5); // one pass; the input stays 0.5 under the seam crossfade
  send(port, { t: 'recPlay', track: 0 }); // overdub from the loop start
  run(p, 2400, 0.25);
  expect(lastState(port)).toBe('overdubbing');
}

describe('SageProcessor interrupt', () => {
  it('a track in overdub becomes playing and keeps the audio, overdub included', () => {
    const { p, port } = makeProcessor();
    overdubbing(p, port);
    send(port, { t: 'interrupt' });
    run(p, 1600, 0);
    expect(lastState(port)).toBe('playing');
    const t = exportTracks(p, port)[0]!;
    expect(t.L.length).toBe(4800);
    expect(t.L[1200]).toBeCloseTo(0.75, 5); // the overdub layer is kept
    expect(t.L[3600]).toBeCloseTo(0.5, 5);  // past the punch-out, the loop as it was
  });

  it('a first recording becomes a playing loop of everything recorded so far', () => {
    const { p, port } = makeProcessor();
    send(port, freeSettings());
    send(port, { t: 'recPlay', track: 0 });
    run(p, 3000, 0.5);
    send(port, { t: 'interrupt' });
    run(p, 1600, 0);
    expect(lastState(port)).toBe('playing');
    const t = exportTracks(p, port)[0]!;
    expect(t.L.length).toBe(3000);
    expect(t.L[1500]).toBeCloseTo(0.5, 6);
  });

  it('input after the interrupt (audio that resumed later) is not written into the seam crossfade', () => {
    const { p, port } = makeProcessor();
    send(port, freeSettings());
    send(port, { t: 'recPlay', track: 0 });
    run(p, 3000, 0.5);
    send(port, { t: 'interrupt' });
    run(p, 1600, 0.9); // the first audio after the context came back
    const t = exportTracks(p, port)[0]!;
    expect(maxAbs(t.L)).toBeLessThanOrEqual(0.5 + 1e-6);
    expect(maxAbs(t.R)).toBeLessThanOrEqual(0.5 + 1e-6);
    expect(t.L[0]).toBe(0); // the seam fades in from silence: there is no continuation of the recording
    expect(t.L[XF + 10]).toBeCloseTo(0.5, 6);
  });

  it('input after the interrupt is not written into the punch-out tail of an overdub', () => {
    const { p, port } = makeProcessor();
    overdubbing(p, port);
    send(port, { t: 'interrupt' });
    run(p, 1600, 0.9);
    const t = exportTracks(p, port)[0]!;
    expect(maxAbs(t.L)).toBeLessThanOrEqual(0.75 + 1e-6);
    expect(t.L[2400 + XF / 2]).toBeCloseTo(0.5, 6);
  });

  it('only the tail is gated: input is recorded again 5 ms after the interrupt', () => {
    const { p, port } = makeProcessor();
    send(port, freeSettings());
    send(port, { t: 'recPlay', track: 0 });
    run(p, 3000, 0.5);
    send(port, { t: 'interrupt' });
    run(p, 2 * BLOCK, 0.9);
    send(port, { t: 'recPlay', track: 1 });
    run(p, 2400, 0.9);
    send(port, { t: 'recPlay', track: 1 });
    run(p, BLOCK, 0.9);
    const t = exportTracks(p, port)[1]!;
    expect(t.L.length).toBe(2400);
    expect(t.L[0]).toBeCloseTo(0.9, 6);
    expect(t.L[1200]).toBeCloseTo(0.9, 6);
  });
});

// ---------------------------------------------------------------------------------------------------------------------

function statuses(rig: Rig): Extract<EngineEvent, { t: 'status' }>['status'][] {
  return rig.events.flatMap((e) => (e.t === 'status' ? [e.status] : []));
}

function interrupts(rig: Rig): number {
  return sentCommands(rig).filter((c) => c.t === 'interrupt').length;
}

function messages(rig: Rig): string[] {
  return rig.events.flatMap((e) => (e.t === 'message' ? [e.text] : []));
}

/** Starts a first recording on track 1 through the host and runs until a status shows it. */
function recordThroughHost(rig: Rig): void {
  rig.host.send(freeSettings());
  rig.host.send({ t: 'recPlay', track: 0 });
  run(rig.processor, 1600, 0.5);
  expect(statuses(rig).at(-1)!.tracks[0]!.state).toBe('recording');
}

/** An iPad's navigator: more than one touch point. */
function touchNav(): FakeNav {
  const nav = new FakeNav();
  nav.maxTouchPoints = 5;
  return nav;
}

describe('EngineHost interrupts (ruling R37)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('the context going to interrupted while a track overdubs sends interrupt; the pass ends and the audio stays', async () => {
    const rig = await startHost();
    const p = rig.processor;
    rig.host.send(freeSettings());
    rig.host.send({ t: 'recPlay', track: 0 });
    run(p, 4800, 0.5);
    rig.host.send({ t: 'recPlay', track: 0 });
    run(p, 4800, 0.5);
    rig.host.send({ t: 'recPlay', track: 0 });
    run(p, 2400, 0.25);
    expect(statuses(rig).at(-1)!.tracks[0]!.state).toBe('overdubbing');

    rig.ctx.setState('interrupted');
    expect(sentCommands(rig).at(-1)).toEqual({ t: 'interrupt', at: null });
    run(p, 1600, 0.25); // the context is back
    const s = statuses(rig).at(-1)!.tracks[0]!;
    expect(s.state).toBe('playing');
    expect(s.lengthFrames).toBe(4800);
  });

  it('suspended while a first recording runs also sends interrupt', async () => {
    const rig = await startHost();
    recordThroughHost(rig);
    rig.ctx.setState('suspended');
    expect(interrupts(rig)).toBe(1);
    run(rig.processor, 1600, 0.5);
    expect(statuses(rig).at(-1)!.tracks[0]!.state).toBe('playing');
  });

  it('every interrupted or suspended the host did not cause sends interrupt, recording or not (it is idempotent)', async () => {
    const rig = await startHost();
    run(rig.processor, 1600);
    rig.ctx.setState('interrupted');
    rig.ctx.setState('suspended');
    rig.ctx.setState('running');
    rig.ctx.setState('suspended');
    expect(interrupts(rig)).toBe(3);
  });

  it('touch device: going hidden sends interrupt', async () => {
    const rig = await startHost({ nav: touchNav() });
    rig.doc.set('hidden');
    expect(sentCommands(rig).at(-1)).toEqual({ t: 'interrupt', at: null });
  });

  it('desktop: going hidden sends nothing (background tabs keep their audio); a suspended context still interrupts', async () => {
    const rig = await startHost();
    recordThroughHost(rig);
    rig.doc.set('hidden');
    expect(interrupts(rig)).toBe(0);
    run(rig.processor, 1600, 0.5);
    expect(statuses(rig).at(-1)!.tracks[0]!.state).toBe('recording');
    rig.ctx.setState('suspended');
    expect(interrupts(rig)).toBe(1);
  });

  it.each([
    ['touch', touchNav],
    ['desktop', () => new FakeNav()],
  ] as const)('%s: visible with the context not running: suspend() then resume() (WebKit bug 276016), no second interrupt', async (_kind, nav) => {
    const rig = await startHost({ nav: nav() });
    recordThroughHost(rig);
    rig.doc.set('hidden');
    rig.ctx.setState('interrupted');
    const before = interrupts(rig);
    expect(before).toBeGreaterThanOrEqual(1);
    rig.ctx.calls.length = 0;
    rig.doc.set('visible');
    await settle();
    expect(rig.ctx.calls).toEqual(['suspend', 'resume']);
    expect(rig.ctx.state).toBe('running');
    expect(interrupts(rig)).toBe(before); // the host's own suspend is not an interruption
    expect(messages(rig)).toEqual([]);
  });

  it.each([
    ['touch', touchNav],
    ['desktop', () => new FakeNav()],
  ] as const)('%s: visible with the context still running leaves it alone', async (_kind, nav) => {
    const rig = await startHost({ nav: nav() });
    rig.doc.set('hidden');
    rig.ctx.calls.length = 0;
    rig.doc.set('visible');
    await settle();
    expect(rig.ctx.calls).toEqual([]);
    expect(rig.nav.streams).toHaveLength(1);
    expect(rig.nav.streams[0]!.track.stopped).toBe(false);
    expect(messages(rig)).toEqual([]);
  });

  it.each(['ended', 'muted'] as const)('visible with the mic track %s: getUserMedia again and reconnect', async (how) => {
    const rig = await startHost({ nav: touchNav() });
    const first = rig.nav.streams[0]!;
    if (how === 'ended') first.track.readyState = 'ended';
    else first.track.muted = true;
    rig.doc.set('hidden');
    rig.doc.set('visible');
    await settle();
    expect(rig.nav.streams).toHaveLength(2);
    expect(first.track.stopped).toBe(true);
    expect(rig.ctx.sources[0]!.node.disconnects).toBe(1);
    expect(rig.ctx.sources[1]!.stream).toBe(rig.nav.streams[1]);
    expect(rig.ctx.sources[1]!.node.connections).toEqual([rig.node]);
    expect(rig.host.micAvailable).toBe(true);
    expect(rig.nav.sessionAtCall.at(-1)).toBe('play-and-record');
    expect(messages(rig)).toEqual([]);
  });

  it('interrupted -> running while the page stays visible (Siri, a call): an ended mic is opened again', async () => {
    const rig = await startHost({ nav: touchNav() });
    rig.ctx.setState('interrupted');
    rig.nav.streams[0]!.track.readyState = 'ended';
    rig.ctx.setState('running');
    await settle();
    expect(rig.nav.streams).toHaveLength(2);
    expect(rig.ctx.sources[1]!.node.connections).toEqual([rig.node]);
    expect(rig.host.micAvailable).toBe(true);
    expect(messages(rig)).toEqual([]);
  });

  it('running again while the page is hidden leaves the mic to the visible resume', async () => {
    const rig = await startHost({ nav: touchNav() });
    rig.doc.set('hidden');
    rig.ctx.setState('interrupted');
    rig.nav.streams[0]!.track.readyState = 'ended';
    rig.ctx.setState('running'); // still hidden: no getUserMedia from the background
    await settle();
    expect(rig.nav.streams).toHaveLength(1);
    rig.doc.set('visible');
    await settle();
    expect(rig.nav.streams).toHaveLength(2);
    expect(rig.ctx.sources[1]!.node.connections).toEqual([rig.node]);
    expect(rig.host.micAvailable).toBe(true);
  });

  it('a mic that cannot be had again gives NO INPUT and needsResume', async () => {
    const rig = await startHost();
    rig.nav.streams[0]!.track.readyState = 'ended';
    rig.nav.fail = true;
    rig.doc.set('hidden');
    rig.doc.set('visible');
    await settle();
    expect(rig.host.micAvailable).toBe(false);
    expect(messages(rig)).toEqual(['NO INPUT']);
    expect(rig.host.needsResume).toBe(true);
  });

  it('a context that refuses to resume gives NO INPUT and needsResume; a later resume() clears it', async () => {
    const rig = await startHost();
    const seen: boolean[] = [];
    rig.host.onNeedsResume((v) => seen.push(v));
    rig.ctx.setState('interrupted');
    rig.ctx.resumeFails = true;
    rig.doc.set('visible');
    await settle();
    expect(messages(rig)).toEqual(['NO INPUT']);
    expect(rig.host.needsResume).toBe(true);
    rig.ctx.resumeFails = false;
    await expect(rig.host.resume()).resolves.toBe(true);
    expect(rig.host.needsResume).toBe(false);
    expect(seen).toEqual([true, false]);
  });

  it('a resume that has not settled after RESUME_TIMEOUT_MS gives NO INPUT; when it goes through later, needsResume clears', async () => {
    const rig = await startHost();
    const seen: boolean[] = [];
    rig.host.onNeedsResume((v) => seen.push(v));
    vi.useFakeTimers();
    rig.ctx.setState('interrupted');
    rig.ctx.resumeHangs = true;
    rig.doc.set('visible');
    await vi.advanceTimersByTimeAsync(RESUME_TIMEOUT_MS - 1);
    expect(messages(rig)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(messages(rig)).toEqual(['NO INPUT']);
    expect(rig.host.needsResume).toBe(true);
    rig.ctx.finishResume(); // the context runs after all
    await vi.advanceTimersByTimeAsync(0);
    expect(rig.host.needsResume).toBe(false);
    expect(seen).toEqual([true, false]);
    expect(messages(rig)).toEqual(['NO INPUT']);
  });

  it('a resume racing stop() reports nothing after the stop', async () => {
    const rig = await startHost();
    const seen: boolean[] = [];
    rig.host.onNeedsResume((v) => seen.push(v));
    vi.useFakeTimers();
    rig.ctx.setState('interrupted');
    rig.ctx.resumeHangs = true;
    const resumed = rig.host.resume();
    await vi.advanceTimersByTimeAsync(10);
    await rig.host.stop();
    await vi.advanceTimersByTimeAsync(RESUME_TIMEOUT_MS * 2);
    await expect(resumed).resolves.toBe(false);
    expect(messages(rig)).toEqual([]);
    expect(seen).toEqual([]);
  });

  it('a failure inside the automatic resume is caught and logged, never an unhandled rejection', async () => {
    const rig = await startHost();
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown): void => {
      unhandled.push(e);
    };
    // Node's process, without the Node typings this project does not install.
    const proc = (globalThis as unknown as { process: { on(e: string, f: (r: unknown) => void): void; off(e: string, f: (r: unknown) => void): void } }).process;
    proc.on('unhandledRejection', onUnhandled);
    try {
      // (Event handlers are isolated from each other since M8; a needsResume handler still runs inside the resume.)
      rig.host.onNeedsResume(() => {
        throw new Error('a handler failed');
      });
      rig.ctx.setState('interrupted');
      rig.ctx.resumeFails = true;
      rig.doc.set('visible');
      await settle();
      expect(unhandled).toEqual([]);
      expect(rig.logs.some(([m, d]) => m === 'engine: resume failed' && d instanceof Error && d.message === 'a handler failed')).toBe(true);
    } finally {
      proc.off('unhandledRejection', onUnhandled);
    }
  });

  it('resume({ retryMic: true }) (TAP POWER TO RESUME) asks for a mic that was never had', async () => {
    const nav = new FakeNav();
    nav.fail = true;
    const rig = await startHost({ nav });
    await settle();
    expect(messages(rig)).toEqual(['NO INPUT']);
    expect(rig.host.needsResume).toBe(false); // no mic at power-on is not a lost resume
    rig.doc.set('hidden');
    rig.doc.set('visible'); // an automatic resume does not ask again
    await settle();
    expect(nav.constraints).toHaveLength(1);
    nav.fail = false;
    await expect(rig.host.resume({ retryMic: true })).resolves.toBe(true);
    expect(nav.constraints).toHaveLength(2);
    expect(rig.host.micAvailable).toBe(true);
    expect(rig.ctx.sources.at(-1)!.node.connections).toEqual([rig.node]);
  });
});

describe('EngineHost and SageProcessor timelines', () => {
  it('a dated press lands on the core frame it was heard at, though the context ran before the processor existed', async () => {
    const rig = await startHost();
    const base = 96000; // context frame of the processor's first block: 2 s of permission prompt and worklet loading
    rig.host.send(freeSettings((_m, s) => {
      s.input.dynamics.mic1Ns = 0;
    }));
    rig.ctx.timestamp = { contextTime: 2.5, performanceTime: 10000 }; // heard frame 120000 at t = 10000 ms
    rig.host.send({ t: 'recPlay', track: 0 }, 10000); // heard frame 120000 = core frame 24000
    rig.host.send({ t: 'recPlay', track: 0 }, 10100); // 4800 frames later
    run(rig.processor, 48000, (f) => f / 100000, BLOCK, base); // the input is the core frame / 100000
    rig.host.send({ t: 'exportTracks', reqId: 1 });
    run(rig.processor, 4 * BLOCK, 0, BLOCK, base + 48000);
    const reply = rig.events.find((e): e is Extract<EngineEvent, { t: 'tracks' }> => e.t === 'tracks')!;
    const t = reply.tracks[0]!;
    expect(t.L.length).toBe(4800);
    // Core frame 25000 as heard (the first 5 ms hold the seam crossfade). Its input arrived a round trip later (the
    // latency pipeline, Task 9): the host's estimate, outputLatency + baseLatency = 1200 frames.
    const rt = rig.host.latency().roundTripFrames;
    expect(rt).toBe(1200);
    expect(t.L[1000]).toBeCloseTo((25000 + rt) / 100000, 5);
    // The last status followed core frame 48000 (60 x 800): on the context's timeline that is base + 48000.
    expect(statuses(rig).at(-1)!.frame).toBe(base + 48000);
  });
});
