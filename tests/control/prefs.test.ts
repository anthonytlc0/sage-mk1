import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CALIBRATE_TIMEOUT_MS, Controller, SYSTEM_SAVE_DEBOUNCE_MS } from '../../src/control/controller';
import { FakeEngine } from '../../src/control/fakeEngine';
import { PREF_GROUPS, effectiveSystem, prefGroupOf } from '../../src/control/prefs';
import { SYSTEM_PARAMS, concreteIds, defaultMemory, defaultSystem } from '../../src/schema/params';
import type { MemorySettings, SystemSettings } from '../../src/schema/types';
import { FakeLcd, click, memStores, setup, take } from './helpers';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** A controller whose stored system settings have been edited by `edit` and that has booted from them. */
async function booted(edit: (s: SystemSettings) => void, memories: Record<number, MemorySettings> = {}) {
  const r = setup();
  const sys = defaultSystem();
  edit(sys);
  r.stores.system.stored = sys;
  for (const [slot, m] of Object.entries(memories)) r.stores.memories.slots.set(Number(slot), { settings: m, tracks: [null, null, null, null, null] });
  await r.c.boot(1);
  r.engine.reset();
  return r;
}

describe('the PREFERENCE groups (ruling R26)', () => {
  it('every group switch is a SYSTEM/MEMORY param, and no param is in two groups', () => {
    for (const g of PREF_GROUPS) {
      const def = SYSTEM_PARAMS.find((d) => concreteIds(d).includes(g.pref))!;
      expect(def.values).toEqual(['SYSTEM', 'MEMORY']);
    }
    const all = SYSTEM_PARAMS.flatMap(concreteIds);
    for (const id of all) {
      const hits = PREF_GROUPS.filter((g) => g.paths.some((p) => id === p || id.startsWith(`${p}.`)));
      expect(hits.length, id).toBeLessThanOrEqual(1);
    }
    // the switches themselves are system settings, never per memory
    for (const g of PREF_GROUPS) expect(prefGroupOf(g.pref)).toBeUndefined();
  });

  it('cover INPUT EQ/DYNAMICS per input, OUTPUT EQ/ROUTING per jack, RHYTHM OUT, MASTER FX and the CTL FUNC tables', () => {
    expect(prefGroupOf('input.eq.MIC2.loGain')!.pref).toBe('input.preference.MIC');
    expect(prefGroupOf('input.dynamics.mic1Comp')!.pref).toBe('input.preference.MIC');
    expect(prefGroupOf('input.eq.INST1R.sw')!.pref).toBe('input.preference.INST1');
    expect(prefGroupOf('input.dynamics.inst2Ns')!.pref).toBe('input.preference.INST2');
    expect(prefGroupOf('output.eq.MAINR.level')!.pref).toBe('output.preference.MAIN');
    expect(prefGroupOf('output.routing.track.SUB1L.3')!.pref).toBe('output.preference.SUB1');
    expect(prefGroupOf('output.routing.inputRhythm.PHONES.RHYTHM')!.pref).toBe('output.preference.PHONES');
    expect(prefGroupOf('output.routing.rhythmOut')!.pref).toBe('output.preference.RHYTHM');
    expect(prefGroupOf('master.reverb')!.pref).toBe('output.preference.MFX');
    expect(prefGroupOf('ctl.panelPlay.fx.2')!.pref).toBe('ctl.preference.modePlay');
    expect(prefGroupOf('ctl.panelUndo.track.0')!.pref).toBe('ctl.preference.modeUndo');
    expect(prefGroupOf('ctl.footswitch.CTL3')!.pref).toBe('ctl.preference.footswitch');
    expect(prefGroupOf('ctl.exp.EXP2.max')!.pref).toBe('ctl.preference.exp');
    // the rest stay system settings
    for (const id of ['output.routing.inputThru', 'mixer.mic1In', 'input.phantom.MIC1', 'setup.contrast', 'ctl.preference.allClear']) {
      expect(prefGroupOf(id)).toBeUndefined();
    }
  });

  it('effectiveSystem is the system object itself while every switch is SYSTEM', () => {
    const s = defaultSystem();
    expect(effectiveSystem(s, { master: { comp: 5, reverb: 5, insert: 'OFF' } })).toBe(s);
  });

  it('effectiveSystem overlays only the MEMORY groups, and falls back to the system value where the memory has none', () => {
    const s = defaultSystem();
    s.output.preference.MFX = 'MEMORY';
    s.ctl.preference.modePlay = 'MEMORY';
    const prefs: MemorySettings['prefs'] = { master: { comp: 12, reverb: 30, insert: 'OFF' } };
    const eff = effectiveSystem(s, prefs);
    expect(eff.master).toEqual({ comp: 12, reverb: 30, insert: 'OFF' });
    expect(eff.ctl.panelPlay).toEqual(s.ctl.panelPlay); // MEMORY, but nothing stored: the system value
    expect(s.master.comp).toBe('OFF'); // the system object is untouched
  });
});

describe('PREFERENCE=MEMORY in the controller', () => {
  it('editing a MEMORY group writes memory.prefs, not the system; the engine hears it; the memory becomes unsaved', async () => {
    const { c, engine, stores } = await booted((s) => {
      s.input.preference.MIC = 'MEMORY';
    });
    const savesBefore = stores.system.saves;
    c.setParam('input.eq.*.loGain', 5, 'MIC1');
    expect(c.session.system.input.eq.MIC1.loGain).toBe(0);
    expect(c.session.memory.prefs.input!.eq.MIC1.loGain).toBe(5);
    expect(c.session.effectiveSystem.input.eq.MIC1.loGain).toBe(5);
    expect(c.session.get('input.eq.MIC1.loGain')).toBe(5);
    expect(engine.last('settings')!.system.input.eq.MIC1.loGain).toBe(5);
    expect(c.session.dirty).toBe(true);
    await vi.advanceTimersByTimeAsync(SYSTEM_SAVE_DEBOUNCE_MS * 2);
    expect(stores.system.saves).toBe(savesBefore); // nothing for the system store
  });

  it('a group left on SYSTEM still edits the system settings', async () => {
    const { c, stores } = await booted((s) => {
      s.input.preference.MIC = 'MEMORY';
    });
    c.setParam('input.eq.*.loGain', -4, 'INST1L');
    expect(c.session.system.input.eq.INST1L.loGain).toBe(-4);
    expect(c.session.memory.prefs.input?.eq.INST1L.loGain ?? 0).toBe(0);
    expect(c.session.dirty).toBe(false);
    await vi.advanceTimersByTimeAsync(SYSTEM_SAVE_DEBOUNCE_MS);
    expect(stores.system.stored!.input.eq.INST1L.loGain).toBe(-4);
  });

  it('loading a memory brings its prefs into effect for the MEMORY groups only', async () => {
    const m2 = defaultMemory();
    m2.prefs = { master: { comp: 20, reverb: 11, insert: 'OFF' } };
    const { c, engine } = await booted((s) => {
      s.output.preference.MFX = 'MEMORY';
      s.master.reverb = 3;
    }, { 2: m2 });
    expect(engine.sent).toHaveLength(0);
    await c.selectMemory(2);
    expect(engine.last('settings')!.system.master).toEqual({ comp: 20, reverb: 11, insert: 'OFF' });
    await c.selectMemory(1); // an empty slot: no prefs, so the system values
    expect(engine.last('settings')!.system.master.reverb).toBe(3);
    // MFX back to SYSTEM: memory 2's values are no longer used
    await c.selectMemory(2);
    c.setParam('output.preference.MFX', 'SYSTEM');
    expect(engine.last('settings')!.system.master.reverb).toBe(3);
    expect(c.session.system.output.preference.MFX).toBe('SYSTEM');
  });

  it('switching a group to MEMORY keeps the values heard until the memory stores its own', async () => {
    const { c, engine } = await booted((s) => {
      s.master.reverb = 9;
    });
    c.setParam('output.preference.MFX', 'MEMORY');
    expect(engine.last('settings')!.system.master.reverb).toBe(9);
    c.setParam('master.reverb', 15);
    expect(c.session.memory.prefs.master!.reverb).toBe(15);
    expect(c.session.system.master.reverb).toBe(9);
  });

  it('WRITE snapshots the MEMORY groups into memory.prefs and leaves the memory saved', async () => {
    const { c, stores } = await booted((s) => {
      s.ctl.preference.modePlay = 'MEMORY';
      s.ctl.panelPlay.track[2] = 'TRK3 REVERSE';
    });
    await c.write(1);
    const saved = stores.memories.slots.get(1)!.settings;
    expect(saved.prefs.ctl!.panelPlay.track[2]).toBe('TRK3 REVERSE');
    expect(saved.prefs.input).toBeUndefined(); // no INPUT group is MEMORY
    expect(c.session.dirty).toBe(false);
    // the stored copy survives a later system change for that memory
    c.setParam('ctl.preference.modePlay', 'SYSTEM');
    c.setParam('ctl.panelPlay.track.2', 'TRK3 CLEAR');
    c.setParam('ctl.preference.modePlay', 'MEMORY');
    await c.selectMemory(1);
    expect(c.session.get('ctl.panelPlay.track.2')).toBe('TRK3 REVERSE');
  });

  it('the [TRACK] buttons follow PANEL PLAY from the memory when MODE PLAY is MEMORY', async () => {
    const m2 = defaultMemory();
    const panelPlay = structuredClone(defaultSystem().ctl.panelPlay);
    panelPlay.track[0] = 'TRK1 REVERSE';
    m2.prefs = { ctl: { ...structuredClone(defaultSystem().ctl), panelPlay } };
    const { c, lcd } = await booted((s) => {
      s.ctl.preference.modePlay = 'MEMORY';
    }, { 2: m2 });
    await c.selectMemory(2);
    click(c, 'trk1.track');
    expect(c.session.memory.track[0]!.reverse).toBe(true);
    expect(lcd.shows).toEqual([]);
  });

  it('a recovery checkpoint carries the MEMORY groups too', async () => {
    const { c, engine, stores } = await booted((s) => {
      s.output.preference.MFX = 'MEMORY';
      s.master.comp = 7;
    });
    engine.emit({ t: 'status', status: (await import('../../src/control/fakeEngine')).makeStatus({ audioDirty: true }) });
    await c.checkpointNow();
    expect(stores.recovery.checkpoints.at(-1)!.settings.prefs.master!.comp).toBe(7);
  });
});

describe('MIC PROCESS restarts the mic', () => {
  it('calls the restartMic hook when SETUP MIC PROCESS changes, after the settings went out', () => {
    const engine = new FakeEngine();
    const order: string[] = [];
    const restartMic = vi.fn(async () => {
      order.push(`restart:${engine.last('settings')!.system.setup.micProcess}`);
    });
    const c = new Controller(engine, memStores(), new FakeLcd(), { events: new EventTarget(), restartMic });
    c.setParam('setup.contrast', 3);
    expect(restartMic).not.toHaveBeenCalled();
    c.setParam('setup.micProcess', true);
    expect(order).toEqual(['restart:true']);
    c.setParam('setup.micProcess', true); // unchanged
    expect(restartMic).toHaveBeenCalledTimes(1);
    c.setParam('setup.micProcess', false);
    expect(restartMic).toHaveBeenCalledTimes(2);
  });

  it('a failing restart is logged, not thrown', async () => {
    const restartMic = vi.fn(async () => {
      throw new Error('no mic');
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const c = new Controller(new FakeEngine(), memStores(), new FakeLcd(), { events: new EventTarget(), restartMic });
    c.setParam('setup.micProcess', true);
    await vi.advanceTimersByTimeAsync(0);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('replacing the system settings with a different MIC PROCESS restarts it too', async () => {
    const restartMic = vi.fn(async () => {});
    const c = new Controller(new FakeEngine(), memStores(), new FakeLcd(), { events: new EventTarget(), restartMic });
    const s = defaultSystem();
    s.setup.micProcess = true;
    await c.replaceSystem(s);
    expect(restartMic).toHaveBeenCalledTimes(1);
    await c.replaceSystem(structuredClone(s));
    expect(restartMic).toHaveBeenCalledTimes(1);
  });
});

describe('calibration, recovery, system replacement, factory reset and memory files', () => {
  it('requestCalibration sends calibrate and resolves with the matching calibration event', async () => {
    const { c, engine } = setup();
    const p = c.requestCalibration();
    const cmd = engine.last('calibrate')!;
    engine.emit({ t: 'calibration', reqId: cmd.reqId + 100, capture: new Float32Array(1), clickFrames: [] }); // not ours
    const capture = new Float32Array([0.5, 0.25]);
    engine.emit({ t: 'calibration', reqId: cmd.reqId, capture, clickFrames: [1, 2] });
    await expect(p).resolves.toEqual({ capture, clickFrames: [1, 2] });
  });

  it('requestCalibration rejects when the engine never answers', async () => {
    const { c } = setup();
    const p = c.requestCalibration();
    const failed = expect(p).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(CALIBRATE_TIMEOUT_MS + 1);
    await failed;
  });

  it('restoreRecovery makes the checkpoint the current memory, unsaved, and keeps the checkpoint', () => {
    const { c, engine, stores } = setup();
    const settings = defaultMemory();
    settings.name = 'LOST SONG';
    const tracks = [take(0.3), null, null, null, null];
    c.restoreRecovery({ slot: 7, settings, tracks });
    expect(c.session.slot).toBe(7);
    expect(c.session.memory.name).toBe('LOST SONG');
    expect(c.session.dirty).toBe(true);
    expect(engine.last('settings')!.memory.name).toBe('LOST SONG');
    expect(engine.commands('loadTrack').map((l) => l.audio)).toEqual(tracks);
    expect(stores.recovery.discards).toBe(0);
  });

  it('replaceSystem stores the new settings at once and pushes them', async () => {
    const { c, engine, stores } = setup();
    const s = defaultSystem();
    s.setup.contrast = 9;
    await c.replaceSystem(s);
    expect(c.session.system.setup.contrast).toBe(9);
    expect(stores.system.stored!.setup.contrast).toBe(9);
    expect(engine.last('settings')!.system.setup.contrast).toBe(9);
  });

  it('factoryReset SYSTEM restores defaultSystem(); MEMORY clears every memory and the current one', async () => {
    const { c, stores, engine } = setup();
    c.setParam('setup.contrast', 2);
    c.setParam('master.reverb', 22);
    stores.memories.slots.set(4, { settings: defaultMemory(), tracks: [take(1), null, null, null, null] });
    c.setParam('track.*.pan', 10, 0);
    await c.factoryReset('SYSTEM');
    expect(c.session.system).toEqual(defaultSystem());
    expect(stores.system.stored).toEqual(defaultSystem());
    expect(stores.memories.slots.size).toBe(1);
    expect(c.session.memory.track[0]!.pan).toBe(10);
    engine.reset();
    await c.factoryReset('MEMORY');
    expect(stores.memories.slots.size).toBe(0);
    expect(c.session.memory).toEqual(defaultMemory());
    expect(c.session.dirty).toBe(false);
    expect(engine.commands('loadTrack')).toHaveLength(5);
  });

  it('factoryReset MEMORY+SYSTEM does both', async () => {
    const { c, stores } = setup();
    c.setParam('setup.contrast', 2);
    stores.memories.slots.set(9, { settings: defaultMemory(), tracks: [null, null, null, null, null] });
    await c.factoryReset('MEMORY+SYSTEM');
    expect(stores.memories.slots.size).toBe(0);
    expect(c.session.system).toEqual(defaultSystem());
  });

  it('importMemory refuses a slot with a phrase (NOT EMPTY), and the current memory while it holds unsaved work', async () => {
    const { c, stores } = setup();
    stores.memories.slots.set(5, { settings: defaultMemory(), tracks: [take(1), null, null, null, null] });
    const contents = { settings: defaultMemory(), tracks: [take(2), null, null, null, null] };
    expect(await c.importMemory(5, contents)).toBe('NOT EMPTY');
    expect(stores.memories.slots.get(5)!.tracks[0]!.L[0]).toBe(1);
    c.setParam('track.*.pan', 5, 0); // the current memory (1) is now unsaved
    expect(await c.importMemory(1, contents)).toBe('NOT EMPTY');
    expect(await c.importMemory(6, contents)).toBe('ok');
    expect(stores.memories.slots.get(6)!.tracks[0]!.L[0]).toBe(2);
  });

  it('importMemory into the current (empty, saved) memory loads it', async () => {
    const { c, engine, stores } = setup();
    const settings = defaultMemory();
    settings.name = 'IMPORTED';
    expect(await c.importMemory(1, { settings, tracks: [take(3), null, null, null, null] })).toBe('ok');
    expect(stores.memories.slots.has(1)).toBe(true);
    expect(c.session.memory.name).toBe('IMPORTED');
    expect(engine.last('loadTrack')!.track).toBe(4);
  });

  it('importMemory reports MEMORY FULL when storage refuses', async () => {
    const { c, stores } = setup();
    stores.memories.full = true;
    expect(await c.importMemory(3, { settings: defaultMemory(), tracks: [null, null, null, null, null] })).toBe('MEMORY FULL');
  });

  it('exportCurrent is the current memory as it is (prefs snapshot included) with the engine tracks', async () => {
    const { c, engine } = setup();
    c.setParam('output.preference.MFX', 'MEMORY');
    c.setParam('master.reverb', 4);
    c.setParam('track.*.pan', -3, 1);
    engine.exportReply = [null, take(5), null, null, null];
    const out = await c.exportCurrent();
    expect(out.settings.track[1]!.pan).toBe(-3);
    expect(out.settings.prefs.master!.reverb).toBe(4);
    expect(out.tracks[1]!.L[0]).toBe(5);
  });

  it('backupAll gathers the 99 stored memories and the system settings; restoreAll puts them back', async () => {
    const { c, stores } = setup();
    const m = defaultMemory();
    m.name = 'KEEP';
    stores.memories.slots.set(2, { settings: m, tracks: [take(4), null, null, null, null] });
    c.setParam('setup.contrast', 8);
    const backup = await c.backupAll();
    expect(backup.memories).toHaveLength(99);
    expect(backup.memories[1]!.settings.name).toBe('KEEP');
    expect(backup.memories[0]).toBeNull();
    expect(backup.system.setup.contrast).toBe(8);

    stores.memories.slots.clear();
    stores.memories.slots.set(50, { settings: defaultMemory(), tracks: [null, null, null, null, null] });
    c.setParam('setup.contrast', 1);
    expect(await c.restoreAll(backup)).toBe('ok');
    expect([...stores.memories.slots.keys()]).toEqual([2]);
    expect(c.session.system.setup.contrast).toBe(8);
    expect(stores.system.stored!.setup.contrast).toBe(8);
  });
});
