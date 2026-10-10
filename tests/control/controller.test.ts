import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHECKPOINT_DEBOUNCE_MS, MESSAGE_MS, SYSTEM_SAVE_DEBOUNCE_MS } from '../../src/control/controller';
import { makeStatus } from '../../src/control/fakeEngine';
import { defaultMemory, defaultSystem } from '../../src/schema/params';
import type { EngineCommand } from '../../src/shared/protocol';
import { setup, take } from './helpers';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const loadTracks = (sent: { cmd: EngineCommand }[]) =>
  sent.map((s) => s.cmd).filter((c): c is Extract<EngineCommand, { t: 'loadTrack' }> => c.t === 'loadTrack');

describe('setParam and the session', () => {
  it('a memory param updates the session, marks it dirty and pushes settings', () => {
    const { c, engine } = setup();
    expect(c.session.dirty).toBe(false);
    c.setParam('track.*.pan', 25, 2);
    expect(c.session.memory.track[2]!.pan).toBe(25);
    expect(c.session.dirty).toBe(true);
    const s = engine.last('settings')!;
    expect(s.memory.track[2]!.pan).toBe(25);
    expect(s.system).toEqual(c.session.system);
  });

  it('values are validated, clamped and snapped by the schema', () => {
    const { c } = setup();
    c.setParam('track.*.playLevel', 999, 0);
    expect(c.session.memory.track[0]!.playLevel).toBe(200);
    c.setParam('tempo', 123.456);
    expect(c.session.memory.tempo).toBe(123.5);
    expect(() => c.setParam('track.*.dubMode', 'NOPE', 0)).toThrow(RangeError);
    expect(() => c.setParam('no.such.param', 1)).toThrow();
  });

  it('an unchanged value sends nothing and leaves the session clean', () => {
    const { c, engine } = setup();
    c.setParam('track.*.pan', 0, 1);
    c.setParam('setup.contrast', defaultSystem().setup.contrast);
    expect(engine.sent).toEqual([]);
    expect(c.session.dirty).toBe(false);
  });

  it('setting the tempo also sends the tempo command, so the transport and memory.tempo agree', () => {
    const { c, engine } = setup();
    c.setParam('tempo', 90);
    expect(engine.types()).toEqual(['settings', 'tempo']);
    expect(engine.last('tempo')).toEqual({ t: 'tempo', bpm: 90 });
  });

  it('a system param does not dirty the memory and is saved to the system store (debounced)', async () => {
    const { c, stores } = setup();
    c.setParam('setup.contrast', 9);
    c.setParam('setup.contrast', 10);
    expect(c.session.dirty).toBe(false);
    expect(stores.system.saves).toBe(0);
    await vi.advanceTimersByTimeAsync(SYSTEM_SAVE_DEBOUNCE_MS);
    expect(stores.system.saves).toBe(1);
    expect(stores.system.stored!.setup.contrast).toBe(10);
  });

  it('boot() loads the system settings and memory 1', async () => {
    const { c, stores, engine } = setup();
    const sys = defaultSystem();
    sys.setup.contrast = 2;
    stores.system.stored = sys;
    const mem = defaultMemory();
    mem.name = 'BEATBOX 1';
    stores.memories.slots.set(1, { settings: mem, tracks: [take(1), null, null, null, null] });
    await c.boot();
    expect(c.session.system.setup.contrast).toBe(2);
    expect(c.session.memory.name).toBe('BEATBOX 1');
    expect(c.session.slot).toBe(1);
    expect(engine.last('settings')!.system.setup.contrast).toBe(2);
    expect(loadTracks(engine.sent).map((l) => l.audio?.L[0] ?? null)).toEqual([1, null, null, null, null]);
    expect(stores.recovery.discards).toBe(0); // the app checks for a checkpoint to recover after boot
  });

  it('an engine status with audioDirty marks the session dirty', () => {
    const { c, engine } = setup();
    engine.emit({ t: 'status', status: makeStatus({ audioDirty: false }) });
    expect(c.session.dirty).toBe(false);
    engine.emit({ t: 'status', status: makeStatus({ audioDirty: true }) });
    engine.emit({ t: 'status', status: makeStatus({ audioDirty: false }) }); // the flag is a pulse; the session latches it
    expect(c.session.audioDirty).toBe(true);
    expect(c.session.dirty).toBe(true);
    expect(c.status!.audioDirty).toBe(false);
  });

  it('adopts a tempo the engine set by itself, so the next settings push does not revert it', () => {
    const { c, engine } = setup();
    engine.emit({ t: 'status', status: makeStatus({ tempo: 120 }) });
    engine.emit({ t: 'status', status: makeStatus({ tempo: 93.42 }) });
    expect(c.session.memory.tempo).toBe(93.4);
    expect(engine.sent).toEqual([]);
    // a stale status still carrying the old tempo after our own change is not adopted
    c.setParam('tempo', 100);
    engine.emit({ t: 'status', status: makeStatus({ tempo: 93.42 }) });
    expect(c.session.memory.tempo).toBe(100);
  });
});

describe('memories', () => {
  it('selectMemory discards unsaved changes, reloads the slot and sends settings + loadTrack x5', async () => {
    const { c, engine, stores } = setup();
    const saved = defaultMemory();
    saved.name = 'SAVED';
    saved.tempo = 88;
    stores.memories.slots.set(4, { settings: saved, tracks: [null, take(2), null, take(4), null] });
    await c.selectMemory(4);
    c.setParam('name', 'EDITED');
    engine.emit({ t: 'status', status: makeStatus({ audioDirty: true }) });
    expect(c.session.dirty).toBe(true);
    engine.reset();

    await c.selectMemory(4);
    expect(c.session.memory.name).toBe('SAVED');
    expect(c.session.dirty).toBe(false);
    expect(c.session.savedTempo).toBe(88);
    expect(engine.types()).toEqual(['settings', 'loadTrack', 'loadTrack', 'loadTrack', 'loadTrack', 'loadTrack']);
    expect(engine.last('settings')!.memory.name).toBe('SAVED');
    const loads = loadTracks(engine.sent);
    expect(loads.map((l) => l.track)).toEqual([0, 1, 2, 3, 4]);
    expect(loads.map((l) => l.audio?.L[0] ?? null)).toEqual([null, 2, null, 4, null]);
  });

  it('selecting an empty slot loads the default memory and empty tracks', async () => {
    const { c, engine } = setup();
    c.setParam('name', 'X');
    engine.reset();
    await c.selectMemory(7);
    expect(c.session.slot).toBe(7);
    expect(c.session.memory).toEqual(defaultMemory());
    expect(loadTracks(engine.sent).every((l) => l.audio === null)).toBe(true);
  });

  it('write(3) on an empty slot saves the settings and the tracks from the tracks event', async () => {
    const { c, engine, stores } = setup();
    c.setParam('name', 'MY LOOP');
    engine.exportReply = [take(1), null, take(3), null, null];
    const result = await c.write(3);
    expect(result).toBe('ok');
    const req = engine.commands('exportTracks');
    expect(req).toHaveLength(1);
    const rec = stores.memories.slots.get(3)!;
    expect(rec.settings.name).toBe('MY LOOP');
    expect(rec.tracks.map((t) => t?.L[0] ?? null)).toEqual([1, null, 3, null, null]);
    expect(c.session.slot).toBe(3);
    expect(c.session.dirty).toBe(false);
  });

  it('write waits for the tracks event with its own reqId', async () => {
    const { c, engine, stores } = setup();
    engine.exportReply = null; // reply by hand
    const p = c.write(5);
    await vi.advanceTimersByTimeAsync(0);
    const { reqId } = engine.last('exportTracks')!;
    engine.emit({ t: 'tracks', reqId: reqId + 1, tracks: [take(9), null, null, null, null] }); // someone else's
    await vi.advanceTimersByTimeAsync(0);
    expect(stores.memories.saves).toBe(0);
    engine.emit({ t: 'tracks', reqId, tracks: [take(6), null, null, null, null] });
    expect(await p).toBe('ok');
    expect(stores.memories.slots.get(5)!.tracks[0]!.L[0]).toBe(6);
  });

  it('a different slot that holds audio returns NOT EMPTY; the current slot can always be re-saved', async () => {
    const { c, stores } = setup();
    stores.memories.slots.set(2, { settings: defaultMemory(), tracks: [take(1), null, null, null, null] });
    stores.memories.slots.set(6, { settings: defaultMemory(), tracks: [null, null, null, null, null] });
    expect(await c.write(2)).toBe('NOT EMPTY');
    expect(stores.memories.saves).toBe(0);
    expect(await c.write(6)).toBe('ok'); // settings only, no phrase: may be overwritten
    await c.selectMemory(2);
    expect(await c.write(2)).toBe('ok');
  });

  it('write returns MEMORY FULL when storage refuses, and the session stays dirty', async () => {
    const { c, stores } = setup();
    c.setParam('name', 'BIG');
    stores.memories.full = true;
    expect(await c.write(1)).toBe('MEMORY FULL');
    expect(c.session.dirty).toBe(true);
  });

  it('clear(slot) erases the slot; clearing the current one also empties the session', async () => {
    const { c, engine, stores } = setup();
    stores.memories.slots.set(1, { settings: { ...defaultMemory(), name: 'ONE' }, tracks: [take(1), null, null, null, null] });
    stores.memories.slots.set(2, { settings: defaultMemory(), tracks: [take(2), null, null, null, null] });
    await c.selectMemory(1);
    await c.clear(2);
    expect(stores.memories.slots.has(2)).toBe(false);
    expect(c.session.memory.name).toBe('ONE');
    engine.reset();
    await c.clear(1);
    expect(stores.memories.slots.has(1)).toBe(false);
    expect(c.session.memory.name).toBe('');
    expect(loadTracks(engine.sent).every((l) => l.audio === null)).toBe(true);
  });
});

describe('recovery checkpoint', () => {
  it('checkpoints 2 s after the last rec/dub pass ends (audioDirty), debounced', async () => {
    const { c, engine, stores } = setup();
    engine.exportReply = [take(5), null, null, null, null];
    engine.emit({ t: 'status', status: makeStatus({ audioDirty: true }) });
    await vi.advanceTimersByTimeAsync(CHECKPOINT_DEBOUNCE_MS - 500);
    engine.emit({ t: 'status', status: makeStatus({ audioDirty: true }) });
    await vi.advanceTimersByTimeAsync(CHECKPOINT_DEBOUNCE_MS - 1);
    expect(stores.recovery.checkpoints).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(stores.recovery.checkpoints).toHaveLength(1);
    expect(stores.recovery.checkpoints[0]!.slot).toBe(c.session.slot);
    expect(stores.recovery.checkpoints[0]!.tracks[0]!.L[0]).toBe(5);
  });

  it('pagehide checkpoints unsaved work; a clean session is not checkpointed', async () => {
    const { c, events, stores } = setup();
    events.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(0);
    expect(stores.recovery.checkpoints).toHaveLength(0);
    c.setParam('name', 'UNSAVED');
    events.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(0);
    expect(stores.recovery.checkpoints).toHaveLength(1);
    expect(stores.recovery.checkpoints[0]!.settings.name).toBe('UNSAVED');
  });

  it('powerOff marks a clean shutdown; dispose stops listening', async () => {
    const { c, events, stores } = setup();
    c.setParam('setup.contrast', 3);
    await c.powerOff();
    expect(stores.recovery.cleanShutdowns).toBe(1);
    expect(stores.system.saves).toBe(1); // the pending system save is flushed
    c.dispose();
    c.setParam('name', 'AFTER');
    events.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(CHECKPOINT_DEBOUNCE_MS);
    expect(stores.recovery.checkpoints).toHaveLength(0);
  });

  it('a checkpoint still waiting for the engine is abandoned when the memory is reloaded meanwhile', async () => {
    const { c, engine, events, stores } = setup();
    engine.exportReply = null;
    c.setParam('name', 'OLD WORK');
    events.dispatchEvent(new Event('pagehide'));
    const { reqId } = engine.last('exportTracks')!;
    await c.selectMemory(2);
    engine.emit({ t: 'tracks', reqId, tracks: [take(1), null, null, null, null] });
    await vi.advanceTimersByTimeAsync(0);
    expect(stores.recovery.checkpoints).toHaveLength(0);
  });

  it('a saved or reloaded memory drops the stale checkpoint', async () => {
    const { c, stores } = setup();
    await c.write(1);
    expect(stores.recovery.discards).toBe(1);
    await c.selectMemory(2);
    expect(stores.recovery.discards).toBe(2);
  });
});

describe('messages', () => {
  it('showMessage sets the popup text for its time; engine messages are shown too', () => {
    const { c, engine } = setup();
    c.showMessage('EXECUTING...', 500);
    expect(c.message).toBe('EXECUTING...');
    vi.advanceTimersByTime(500);
    expect(c.message).toBeNull();
    engine.emit({ t: 'message', text: 'MEMORY FULL' });
    expect(c.message).toBe('MEMORY FULL');
    vi.advanceTimersByTime(MESSAGE_MS);
    expect(c.message).toBeNull();
  });

  it('a newer message replaces an older one and gets its full time', () => {
    const { c } = setup();
    c.showMessage('A', 1000);
    vi.advanceTimersByTime(800);
    c.showMessage('B', 1000);
    vi.advanceTimersByTime(800);
    expect(c.message).toBe('B');
    vi.advanceTimersByTime(200);
    expect(c.message).toBeNull();
  });
});
