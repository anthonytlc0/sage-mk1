import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { drawMessage } from '../../src/lcd/screens/message';
import { menuTree, registerMenuScreens } from '../../src/lcd/screens/menuTree';
import type { MenuNode } from '../../src/lcd/screens/menuTree';
import {
  MSG_PREPARING, MSG_READY, MSG_RESTORE_CONFIRM, storageScreen,
} from '../../src/lcd/screens/storage';
import type { StorageDeps } from '../../src/lcd/screens/storage';
import { CALIBRATE_PROMPT, MSG_CALIB_FAILED, MSG_MEASURING, MSG_REMOVE_HEADPHONES, latencyScreen, showCalibratePrompt } from '../../src/lcd/screens/latency';
import { RECOVER_PROMPT, recoverScreen, showBootPrompts } from '../../src/lcd/screens/recover';
import { FACTORY_RESET_TARGETS, SYSTEM_PARAMS, concreteIds, defaultMemory, defaultSystem } from '../../src/schema/params';
import { drawTitleBar } from '../../src/lcd/screens/common';
import { drawRows } from '../../src/lcd/screens/prompt';
import type { SaveResult } from '../../src/storage/share';
import { packBackup, packMemory } from '../../src/storage/memoryFile';
import type { MemoryContents } from '../../src/storage/memoryFile';
import { CALIBRATE_TIMEOUT_MS, SYSTEM_SAVE_DEBOUNCE_MS } from '../../src/control/controller';
import { Framebuffer } from '../../src/lcd/framebuffer';
import { frame, push, rig, sameRegion, status, turn } from './rig';
import type { Rig } from './rig';
import { take } from '../control/helpers';

let off: () => void = () => {};
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  off();
  off = () => {};
  vi.useRealTimers();
});

/** Lets the screens' promise chains (engine replies, stores, file reads) run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0);
}

/** Every concrete parameter id the tree lets you reach, in tree order (duplicates kept). */
function reached(node: MenuNode, out: string[] = []): string[] {
  switch (node.kind) {
    case 'items':
      for (const item of node.items) if (item) reached(item, out);
      break;
    case 'pages':
      for (const page of node.pages) for (const cell of page.cells) out.push(cell.id);
      break;
    case 'screen':
      out.push(...node.params);
      break;
  }
  return out;
}

/** Fake file functions that record their calls. */
function fakeFiles(over: Partial<StorageDeps> = {}) {
  const saves: { blob: Blob; name: string }[] = [];
  const picks: string[] = [];
  let saveResult: SaveResult = 'saved';
  let picked: File | null = null;
  const deps: StorageDeps = {
    saveFile: (blob, name) => {
      saves.push({ blob, name });
      return Promise.resolve(saveResult);
    },
    pickFile: (accept) => {
      picks.push(accept);
      return Promise.resolve(picked);
    },
    readFile: async (f) => new Uint8Array(await f.arrayBuffer()),
    maxDecodedBytes: () => 64 * 1024 * 1024,
    ...over,
  };
  return {
    deps,
    saves,
    picks,
    setSaveResult: (r: SaveResult) => {
      saveResult = r;
    },
    setPicked: (f: File | null) => {
      picked = f;
    },
  };
}

function menuRig(files = fakeFiles()) {
  const r = rig();
  off = registerMenuScreens({ storage: files.deps });
  return { ...r, files };
}

/** A picked file holding `bytes`. */
const fileOf = (bytes: Uint8Array, name: string): File => new File([bytes as Uint8Array<ArrayBuffer>], name);

/** The screen draws exactly the popup `text` (the same box as the message overlay). */
function showsPrompt(r: Rig, text: string): boolean {
  const want = new Framebuffer();
  drawMessage(want, text);
  return sameRegion(frame(r.c), want, 0, 12, 128, 52);
}

describe('menuTree', () => {
  it('reaches every SYSTEM_PARAMS id exactly once (hidden params skipped)', () => {
    const ids = reached(menuTree());
    const expected = SYSTEM_PARAMS.filter((d) => !d.hidden).flatMap(concreteIds);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(dupes).toEqual([]);
    expect([...ids].sort()).toEqual([...expected].sort());
    expect(ids).not.toContain('setup.calibPrompted');
  });

  it('has the guide items in the manual order, FACTORY RESET on knob [4] of the last page', () => {
    const root = menuTree();
    expect(root.kind).toBe('items');
    if (root.kind !== 'items') return;
    expect(root.items.map((n) => n?.title ?? null)).toEqual([
      'INPUT', 'OUTPUT', 'MIXER', 'CTL FUNC', 'ASSIGN', 'USB', 'MIDI', 'SETUP', null, null, null, 'FACTORY RESET',
    ]);
    const titles = (n: MenuNode | null | undefined): (string | null)[] => (n && n.kind === 'items' ? n.items.map((i) => i?.title ?? null) : []);
    expect(titles(root.items[0])).toEqual(['INPUT SETUP', 'INPUT EQ', 'DYNAMICS']);
    expect(titles(root.items[1])).toEqual(['OUTPUT SETUP', 'ROUTING', 'OUTPUT EQ', 'MASTER FX']);
    expect(titles(root.items[3])).toEqual(['PANEL PLAY', 'PANEL UNDO', 'CTL/EXP', 'PREFERENCE']);
    expect(titles(root.items[4])).toHaveLength(16);
  });

  it('pages group related parameters: KNOB FUNC 1-4 share a page, and no page holds a lone parameter', () => {
    const root = menuTree();
    if (root.kind !== 'items') throw new Error('root');
    const setup = root.items[7]!;
    if (setup.kind !== 'pages') throw new Error('setup');
    const knobPage = setup.pages.find((p) => p.cells.some((c) => c.id === 'setup.knobFunc.0'))!;
    expect(knobPage.cells.map((c) => c.id)).toEqual(['setup.knobFunc.0', 'setup.knobFunc.1', 'setup.knobFunc.2', 'setup.knobFunc.3']);
    const lone: string[] = [];
    const walk = (n: MenuNode): void => {
      if (n.kind === 'items') n.items.forEach((i) => i && walk(i));
      else if (n.kind === 'pages') {
        const total = n.pages.reduce((a, p) => a + p.cells.length, 0);
        for (const p of n.pages) if (total > 1 && p.cells.length < 2) lone.push(`${n.title}: ${p.cells[0]!.id}`);
      }
    };
    walk(root);
    expect(lone).toEqual([]);
    const usb = root.items[5]!;
    expect(usb.kind === 'pages' && usb.pages.map((p) => p.cells.length)).toEqual([3, 2]);
    const assign = root.items[4]!;
    const a1 = assign.kind === 'items' ? assign.items[0]! : null;
    expect(a1?.kind === 'pages' && a1.pages.map((p) => p.cells.length)).toEqual([4, 4]);
  });

  it('FACTORY RESET offers the one list of targets, MEMORY+SYSTEM as on Owner\'s Manual p. 24', async () => {
    expect(FACTORY_RESET_TARGETS).toEqual(['MEMORY', 'SYSTEM', 'MEMORY+SYSTEM']);
    const r = menuRig();
    push(r, 'menu');
    push(r, 'right');
    push(r, 'right');
    push(r, 'knob4');
    const want = new Framebuffer();
    drawTitleBar(want, 'FACTORY RESET');
    drawRows(want, FACTORY_RESET_TARGETS, 0);
    expect(sameRegion(frame(r.c), want, 0, 0, 128, 64)).toBe(true);
  });

  it('SETUP ends with LATENCY and MIC PROCESS; USB starts with STORAGE', () => {
    const root = menuTree();
    if (root.kind !== 'items') throw new Error('root');
    const setup = root.items[7]!;
    const usb = root.items[5]!;
    expect(setup.kind === 'pages' && setup.pages.at(-1)!.cells.map((c) => c.id)).toEqual(['setup.latency', 'setup.micProcess']);
    expect(usb.kind === 'pages' && usb.pages[0]!.cells[0]!.id).toBe('usb.storage');
  });
});

describe('the MENU screens', () => {
  it('MENU opens the item list; a knob push opens its item; parameters edit through the controller; EXIT goes back', () => {
    const r = menuRig();
    push(r, 'menu');
    expect(r.menu.top.title).toBe('MENU');
    push(r, 'knob1');
    expect(r.menu.top.title).toBe('INPUT');
    push(r, 'knob1');
    expect(r.menu.top.title).toBe('INPUT SETUP');
    turn(r, 'knob1', 1);
    expect(r.c.session.system.input.phantom.MIC1).toBe(true);
    expect(r.engine.last('settings')!.system.input.phantom.MIC1).toBe(true);
    push(r, 'exit');
    push(r, 'exit');
    expect(r.menu.top.title).toBe('MENU');
    push(r, 'exit');
    expect(r.menu.depth).toBe(1);
  });

  it('◀ ▶ page through the items and through parameter pages', () => {
    const r = menuRig();
    push(r, 'menu');
    push(r, 'right');
    push(r, 'knob4');
    expect(r.menu.top.title).toBe('SETUP');
    turn(r, 'knob1', 3); // CONTRAST 5 -> 8
    expect(r.c.session.system.setup.contrast).toBe(8);
    push(r, 'right');
    turn(r, 'knob1', -1); // AUTO OFF
    expect(r.c.session.system.setup.autoOff).toBe(false);
  });

  it('a knob with no item does nothing', () => {
    const r = menuRig();
    push(r, 'menu');
    push(r, 'right');
    push(r, 'right');
    push(r, 'knob1');
    expect(r.menu.top.title).toBe('MENU');
  });

  it('MIXER opens the mixer screen', () => {
    const r = menuRig();
    push(r, 'menu');
    push(r, 'knob3');
    expect(r.menu.top.title).toBe('MIXER');
  });

  it('editing a PREFERENCE=MEMORY parameter in the MENU writes the memory, and the page shows the memory value', () => {
    const r = menuRig();
    r.c.setParam('output.preference.MFX', 'MEMORY');
    push(r, 'menu');
    push(r, 'knob2'); // OUTPUT
    push(r, 'knob4'); // MASTER FX
    expect(r.menu.top.title).toBe('MASTER FX');
    turn(r, 'knob2', 6); // REVERB 0 -> 6
    expect(r.c.session.memory.prefs.master!.reverb).toBe(6);
    expect(r.c.session.system.master.reverb).toBe(0);
    turn(r, 'knob2', 1); // reads the memory value (6), not the system's (0)
    expect(r.c.session.memory.prefs.master!.reverb).toBe(7);
  });

  it('SETUP > MIC PROCESS is on the last SETUP page, beside LATENCY', () => {
    const r = menuRig();
    push(r, 'menu');
    push(r, 'right');
    push(r, 'knob4');
    for (let i = 0; i < 8; i++) push(r, 'right'); // to the last page
    push(r, 'knob2');
    expect(r.c.session.system.setup.micProcess).toBe(true);
  });

  it('USB > STORAGE turned opens the memory-file screen; the hardware value stays OFF', () => {
    const r = menuRig();
    push(r, 'menu');
    push(r, 'right');
    push(r, 'knob2');
    expect(r.menu.top.title).toBe('USB');
    turn(r, 'knob1', 1);
    expect(r.menu.top.title).toBe('STORAGE');
    expect(r.c.session.system.usb.storage).toBe('OFF');
    push(r, 'exit');
    expect(r.menu.top.title).toBe('USB');
    push(r, 'knob1'); // a push opens it too
    expect(r.menu.top.title).toBe('STORAGE');
  });

  it('SETUP > LATENCY: a push on its knob (or ENTER on its page) opens the calibration', () => {
    const r = menuRig();
    push(r, 'menu');
    push(r, 'right');
    push(r, 'knob4');
    for (let i = 0; i < 8; i++) push(r, 'right'); // to the last page
    push(r, 'knob1');
    expect(r.menu.top.title).toBe('LATENCY');
    push(r, 'exit');
    push(r, 'enter');
    expect(r.menu.top.title).toBe('LATENCY');
  });
});

describe('FACTORY RESET', () => {
  async function openReset(r: Rig) {
    push(r, 'menu');
    push(r, 'right');
    push(r, 'right');
    push(r, 'knob4');
    expect(r.menu.top.title).toBe('FACTORY RESET');
  }

  it('SYSTEM restores defaultSystem() (EXECUTING... while it runs), then the play screen', async () => {
    const r = menuRig();
    r.c.setParam('setup.contrast', 2);
    r.c.setParam('master.reverb', 30);
    r.c.setParam('setup.latency', 1500);
    await openReset(r);
    push(r, 'knob2'); // SYSTEM
    push(r, 'enter');
    expect(r.c.message).toBe('EXECUTING...');
    await flush();
    expect(r.c.session.system).toEqual(defaultSystem());
    expect(r.stores.system.stored).toEqual(defaultSystem());
    expect(r.engine.last('settings')!.system).toEqual(defaultSystem());
    expect(r.menu.depth).toBe(1);
    expect(r.c.message).toBeNull();
  });

  it('MEMORY clears all 99 memories; turning a knob chooses the target; EXIT cancels', async () => {
    const r = menuRig();
    r.stores.memories.slots.set(3, { settings: defaultMemory(), tracks: [take(1), null, null, null, null] });
    r.stores.memories.slots.set(99, { settings: defaultMemory(), tracks: [null, null, null, null, null] });
    await openReset(r);
    push(r, 'exit');
    expect(r.menu.top.title).toBe('MENU');
    expect(r.stores.memories.slots.size).toBe(2);
    push(r, 'knob4');
    turn(r, 'knob1', 2); // MEMORY+SYSTEM
    turn(r, 'knob3', -2); // back to MEMORY
    r.c.setParam('setup.contrast', 3);
    push(r, 'enter');
    await flush();
    expect(r.stores.memories.slots.size).toBe(0);
    expect(r.c.session.system.setup.contrast).toBe(3); // the system settings are kept
  });

  it('MEMORY+SYSTEM does both', async () => {
    const r = menuRig();
    r.stores.memories.slots.set(3, { settings: defaultMemory(), tracks: [null, null, null, null, null] });
    r.c.setParam('setup.contrast', 3);
    await openReset(r);
    push(r, 'knob3');
    push(r, 'enter');
    await flush();
    expect(r.stores.memories.slots.size).toBe(0);
    expect(r.c.session.system).toEqual(defaultSystem());
  });

  it('a reset that clears memories is refused with STOP ALL while the looper runs', async () => {
    const r = menuRig();
    r.stores.memories.slots.set(3, { settings: defaultMemory(), tracks: [null, null, null, null, null] });
    status(r, {}, [{ state: 'playing' }]);
    await openReset(r);
    push(r, 'enter');
    await flush();
    expect(r.c.message).toBe('STOP ALL');
    expect(r.stores.memories.slots.size).toBe(1);
  });
});

describe('STORAGE: memory files', () => {
  function openStorage(files = fakeFiles()) {
    const r = menuRig(files);
    r.menu.push(storageScreen(files.deps));
    return r;
  }

  it('lists EXPORT MEMORY, IMPORT MEMORY, BACKUP ALL, RESTORE ALL on knobs [1]-[4]', () => {
    const r = openStorage();
    const s = r.menu.top as ReturnType<typeof storageScreen>;
    expect(s.items).toEqual(['EXPORT MEMORY', 'IMPORT MEMORY', 'BACKUP ALL', 'RESTORE ALL']);
    expect(s.selected).toBe(0);
    push(r, 'knob3');
    expect(s.selected).toBe(2);
    turn(r, 'knob1', 1);
    expect(s.selected).toBe(3);
    turn(r, 'knob1', 5);
    expect(s.selected).toBe(3);
  });

  it('EXPORT is two-step: ENTER packs (PREPARING...), then READY: ENTER=SAVE, and that ENTER saves at once', async () => {
    const files = fakeFiles();
    const r = openStorage(files);
    r.c.setParam('track.*.pan', 7, 0);
    r.engine.exportReply = [take(0.5), null, null, null, null];
    push(r, 'enter');
    expect(showsPrompt(r, MSG_PREPARING)).toBe(true);
    await flush();
    expect(showsPrompt(r, MSG_READY)).toBe(true);
    expect(files.saves).toHaveLength(0);
    push(r, 'enter');
    expect(files.saves).toHaveLength(1); // synchronously, inside the tap: the share sheet needs it
    expect(files.saves[0]!.name).toMatch(/^sage-mk1-m01\.sagemk1$/);
    const bytes = new Uint8Array(await files.saves[0]!.blob.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(100);
    await flush();
    expect((r.menu.top as ReturnType<typeof storageScreen>).prompt).toBeNull();
    expect(r.c.message).toBeNull();
  });

  it('the file name carries the memory name', async () => {
    const files = fakeFiles();
    const r = openStorage(files);
    r.c.setParam('name', 'My Loop/1');
    push(r, 'enter');
    await flush();
    push(r, 'enter');
    expect(files.saves[0]!.name).toBe('sage-mk1-m01-My_Loop_1.sagemk1');
  });

  it("a cancelled share goes back to the list quietly; a failed one shows SAVE FAILED", async () => {
    const files = fakeFiles();
    const r = openStorage(files);
    files.setSaveResult('cancelled');
    push(r, 'enter');
    await flush();
    push(r, 'enter');
    await flush();
    expect((r.menu.top as ReturnType<typeof storageScreen>).prompt).toBeNull();
    expect(r.c.message).toBeNull();
    files.setSaveResult('failed');
    push(r, 'enter');
    await flush();
    push(r, 'enter');
    await flush();
    expect(r.c.message).toBe('SAVE FAILED');
  });

  it('EXIT on READY drops the prepared file', async () => {
    const files = fakeFiles();
    const r = openStorage(files);
    push(r, 'enter');
    await flush();
    push(r, 'exit');
    expect((r.menu.top as ReturnType<typeof storageScreen>).prompt).toBeNull();
    expect(r.menu.top.title).toBe('STORAGE');
    expect(files.saves).toHaveLength(0);
  });

  it('a memory too big for this device shows FILE TOO LARGE', async () => {
    const files = fakeFiles({ maxDecodedBytes: () => 16 });
    const r = openStorage(files);
    r.engine.exportReply = [take(1), null, null, null, null];
    push(r, 'enter');
    await flush();
    expect(r.c.message).toBe('FILE TOO LARGE');
    expect((r.menu.top as ReturnType<typeof storageScreen>).prompt).toBeNull();
  });

  it('IMPORT: ENTER opens the picker at once; then a slot is chosen; a slot with a phrase is NOT EMPTY', async () => {
    const files = fakeFiles();
    const r = openStorage(files);
    r.stores.memories.slots.set(2, { settings: defaultMemory(), tracks: [take(9), null, null, null, null] });
    const settings = defaultMemory();
    settings.name = 'FROM PC';
    files.setPicked(fileOf(packMemory(settings, [take(0.25), null, null, null, null]), 'song.sagemk1'));
    push(r, 'knob2');
    push(r, 'enter');
    expect(files.picks).toHaveLength(1); // synchronously, inside the tap
    await flush();
    const s = r.menu.top as ReturnType<typeof storageScreen>;
    expect(s.importSlot).toBe(1);
    turn(r, 'knob1', 1); // slot 2 holds a phrase
    expect(s.importSlot).toBe(2);
    push(r, 'enter');
    await flush();
    expect(r.c.message).toBe('NOT EMPTY');
    expect(r.stores.memories.slots.get(2)!.tracks[0]!.L[0]).toBe(9);
    turn(r, 'knob1', 3); // slot 5 is free
    push(r, 'enter');
    await flush();
    expect(r.stores.memories.slots.get(5)!.settings.name).toBe('FROM PC');
    expect(r.stores.memories.slots.get(5)!.tracks[0]!.L[0]).toBe(0.25);
    expect(s.prompt).toBeNull();
    expect(s.importSlot).toBeNull();
  });

  it('IMPORT of a file that is not a memory file shows UNSUPPORTED FILE; a cancelled picker does nothing', async () => {
    const files = fakeFiles();
    const r = openStorage(files);
    push(r, 'knob2');
    files.setPicked(null);
    push(r, 'enter');
    await flush();
    expect(r.c.message).toBeNull();
    expect((r.menu.top as ReturnType<typeof storageScreen>).prompt).toBeNull();
    files.setPicked(fileOf(new Uint8Array([1, 2, 3, 4]), 'photo.jpg'));
    push(r, 'enter');
    await flush();
    expect(r.c.message).toBe('UNSUPPORTED FILE');
  });

  it('IMPORT of a file over the size cap shows FILE TOO LARGE', async () => {
    const files = fakeFiles({ maxDecodedBytes: () => 16 });
    const r = openStorage(files);
    files.setPicked(fileOf(packMemory(defaultMemory(), [take(1), null, null, null, null], { maxDecodedBytes: 1e6 }), 'big.sagemk1'));
    push(r, 'knob2');
    push(r, 'enter');
    await flush();
    expect(r.c.message).toBe('FILE TOO LARGE');
  });

  it('BACKUP ALL is two-step too and saves every stored memory with the system settings', async () => {
    const files = fakeFiles();
    const r = openStorage(files);
    r.stores.memories.slots.set(4, { settings: defaultMemory(), tracks: [take(0.5), null, null, null, null] });
    push(r, 'knob3');
    push(r, 'enter');
    expect(showsPrompt(r, MSG_PREPARING)).toBe(true);
    await flush();
    expect(showsPrompt(r, MSG_READY)).toBe(true);
    push(r, 'enter');
    expect(files.saves).toHaveLength(1);
    expect(files.saves[0]!.name).toMatch(/^sage-mk1-backup-\d{4}-\d{2}-\d{2}\.sagemk1$/);
  });

  it('BACKUP ALL over the size cap shows FILE TOO LARGE before every memory is loaded', async () => {
    const files = fakeFiles({ maxDecodedBytes: () => 100 });
    const r = openStorage(files);
    r.stores.memories.slots.set(2, { settings: defaultMemory(), tracks: [take(0.5), take(0.5), null, null, null] });
    r.stores.memories.slots.set(60, { settings: defaultMemory(), tracks: [take(0.5), null, null, null, null] });
    push(r, 'knob3');
    push(r, 'enter');
    await flush();
    expect(r.c.message).toBe('FILE TOO LARGE');
    expect(r.stores.memories.loads).toBe(2);
    expect(files.saves).toHaveLength(0);
  });

  it('an oversized memory.json is UNSUPPORTED FILE, not FILE TOO LARGE (errors are told apart by class)', async () => {
    const files = fakeFiles();
    const r = openStorage(files);
    const huge = strToU8(JSON.stringify({ format: 'sage-mk1-memory', version: 1 }) + ' '.repeat(3_000_000));
    files.setPicked(fileOf(zipSync({ 'memory.json': [huge, { level: 6 }] }), 'odd.sagemk1'));
    push(r, 'knob2');
    push(r, 'enter');
    await flush();
    expect(r.c.message).toBe('UNSUPPORTED FILE');
  });

  it('RESTORE ALL: picker at once, a confirmation, then EXECUTING... and everything replaced', async () => {
    const files = fakeFiles();
    const r = openStorage(files);
    const kept = defaultMemory();
    kept.name = 'BACKED UP';
    const memories: (MemoryContents | null)[] = Array.from({ length: 99 }, () => null);
    memories[6] = { settings: kept, tracks: [take(0.5), null, null, null, null] };
    const sys = defaultSystem();
    sys.setup.contrast = 9;
    files.setPicked(fileOf(packBackup(memories, sys), 'backup.sagemk1'));
    r.stores.memories.slots.set(1, { settings: defaultMemory(), tracks: [null, null, null, null, null] });
    push(r, 'knob4');
    push(r, 'enter');
    expect(files.picks).toHaveLength(1);
    await flush();
    expect(showsPrompt(r, MSG_RESTORE_CONFIRM)).toBe(true);
    push(r, 'enter');
    expect(r.c.message).toBe('EXECUTING...');
    await flush();
    expect([...r.stores.memories.slots.keys()]).toEqual([7]);
    expect(r.stores.memories.slots.get(7)!.settings.name).toBe('BACKED UP');
    expect(r.c.session.system.setup.contrast).toBe(9);
    expect(r.c.message).toBeNull();
  });

  it('RESTORE ALL: EXIT at the confirmation changes nothing; a memory file is not a backup', async () => {
    const files = fakeFiles();
    const r = openStorage(files);
    files.setPicked(fileOf(packBackup([], defaultSystem()), 'backup.sagemk1'));
    r.stores.memories.slots.set(1, { settings: defaultMemory(), tracks: [null, null, null, null, null] });
    push(r, 'knob4');
    push(r, 'enter');
    await flush();
    push(r, 'exit');
    await flush();
    expect(r.stores.memories.slots.size).toBe(1);
    files.setPicked(fileOf(packMemory(defaultMemory(), []), 'one.sagemk1'));
    push(r, 'enter');
    await flush();
    expect(r.c.message).toBe('UNSUPPORTED FILE');
  });
});

describe('LATENCY calibration', () => {
  const SR = 48000;
  const clicks = Array.from({ length: 8 }, (_, i) => (i + 1) * 24000);
  function capture(delay: number | null): Float32Array {
    const buf = new Float32Array(Math.round(4.5 * SR));
    if (delay !== null) for (const c of clicks) for (let k = 0; k < 400; k++) buf[c + delay + k] = 0.3 * Math.exp(-k / 100);
    return buf;
  }

  it('REMOVE HEADPHONES, then ENTER runs the engine calibration and stores SETUP LATENCY', async () => {
    const r = menuRig();
    r.menu.push(latencyScreen());
    const screen = r.menu.top as ReturnType<typeof latencyScreen>;
    expect(screen.lines[0]).toBe(MSG_REMOVE_HEADPHONES);
    push(r, 'enter');
    const cmd = r.engine.last('calibrate')!;
    expect(cmd).toBeDefined();
    push(r, 'enter'); // ENTER while it runs starts nothing new
    expect(r.engine.commands('calibrate')).toHaveLength(1);
    r.engine.emit({ t: 'calibration', reqId: cmd.reqId, capture: capture(1234), clickFrames: clicks });
    await flush();
    expect(r.c.session.system.setup.latency).toBe(1234);
    expect(r.engine.last('settings')!.system.setup.latency).toBe(1234); // EngineHost turns it into a `latency` command
    expect(screen.lines.join(' ')).toContain('1234');
    await vi.advanceTimersByTimeAsync(SYSTEM_SAVE_DEBOUNCE_MS);
    expect(r.stores.system.stored!.setup.latency).toBe(1234);
  });

  it('CALIB FAILED when fewer than 5 clicks are heard; the setting is unchanged', async () => {
    const r = menuRig();
    r.menu.push(latencyScreen());
    push(r, 'enter');
    const cmd = r.engine.last('calibrate')!;
    r.engine.emit({ t: 'calibration', reqId: cmd.reqId, capture: capture(null), clickFrames: clicks });
    await flush();
    expect(r.c.message).toBe(MSG_CALIB_FAILED);
    expect(r.c.session.system.setup.latency).toBe(-1);
    expect((r.menu.top as ReturnType<typeof latencyScreen>).lines[0]).toBe(MSG_REMOVE_HEADPHONES);
  });

  it('EXIT is ignored while it measures (MEASURING...), so the output is never left muted behind the menu', async () => {
    const r = menuRig();
    r.menu.push(latencyScreen());
    const screen = r.menu.top as ReturnType<typeof latencyScreen>;
    push(r, 'enter');
    const cmd = r.engine.last('calibrate')!;
    expect(screen.lines).toEqual([MSG_MEASURING]);
    push(r, 'exit');
    expect(r.menu.top).toBe(screen);
    r.engine.emit({ t: 'calibration', reqId: cmd.reqId, capture: capture(1000), clickFrames: clicks });
    await flush();
    expect(r.c.session.system.setup.latency).toBe(1000);
    push(r, 'exit');
    expect(r.menu.depth).toBe(1);
  });

  it('a calibration that never answers gives CALIB FAILED and EXIT works again', async () => {
    const r = menuRig();
    r.menu.push(latencyScreen());
    push(r, 'enter');
    await vi.advanceTimersByTimeAsync(CALIBRATE_TIMEOUT_MS + 1);
    expect(r.c.message).toBe(MSG_CALIB_FAILED);
    push(r, 'exit');
    expect(r.menu.depth).toBe(1);
  });

  it('is refused with STOP ALL while a track records, plays or overdubs, or the rhythm plays', () => {
    for (const st of [{ tracks: [{ state: 'playing' as const }] }, { tracks: [{ state: 'recording' as const }] }, { tracks: [{ state: 'overdubbing' as const }] }, { rhythm: 'on' as const }]) {
      const r = menuRig();
      status(r, 'rhythm' in st ? { rhythm: st.rhythm } : {}, 'tracks' in st ? st.tracks : []);
      r.menu.push(latencyScreen());
      push(r, 'enter');
      expect(r.c.message).toBe('STOP ALL');
      expect(r.engine.commands('calibrate')).toHaveLength(0);
      expect((r.menu.top as ReturnType<typeof latencyScreen>).lines[0]).toBe(MSG_REMOVE_HEADPHONES);
      off();
    }
  });
});

describe('first-run CALIBRATE? prompt', () => {
  it('shows once at power-on while uncalibrated, and remembers that it was shown', async () => {
    const r = menuRig();
    expect(showCalibratePrompt(r.menu, r.c)).toBe(true);
    expect(showsPrompt(r, CALIBRATE_PROMPT)).toBe(true);
    expect(r.c.session.system.setup.calibPrompted).toBe(true);
    await vi.advanceTimersByTimeAsync(SYSTEM_SAVE_DEBOUNCE_MS);
    expect(r.stores.system.stored!.setup.calibPrompted).toBe(true);
    push(r, 'exit');
    expect(r.menu.depth).toBe(1);
    expect(showCalibratePrompt(r.menu, r.c)).toBe(false);
    expect(r.menu.depth).toBe(1);
  });

  it('ENTER opens the LATENCY calibration in its place', () => {
    const r = menuRig();
    showCalibratePrompt(r.menu, r.c);
    push(r, 'enter');
    expect(r.menu.top.title).toBe('LATENCY');
    expect(r.menu.depth).toBe(2);
  });

  it('is not shown once calibrated', () => {
    const r = menuRig();
    r.c.setParam('setup.latency', 900);
    expect(showCalibratePrompt(r.menu, r.c)).toBe(false);
    expect(r.c.session.system.setup.calibPrompted).toBe(false);
  });
});

describe('RECOVER?', () => {
  function fakeRecovery(needs = true) {
    const settings = defaultMemory();
    settings.name = 'UNSAVED';
    return {
      needsRecovery: vi.fn(async () => needs),
      take: vi.fn(async () => ({ slot: 4, settings, tracks: [take(0.75), null, null, null, null] })),
      discard: vi.fn(async () => {}),
    };
  }

  it('ENTER restores the checkpoint into the current memory as unsaved work', async () => {
    const r = menuRig();
    const rec = fakeRecovery();
    r.menu.push(recoverScreen(rec));
    expect(showsPrompt(r, RECOVER_PROMPT)).toBe(true);
    push(r, 'enter');
    expect(r.c.message).toBe('EXECUTING...');
    await flush();
    expect(rec.take).toHaveBeenCalledTimes(1);
    expect(r.c.session.slot).toBe(4);
    expect(r.c.session.memory.name).toBe('UNSAVED');
    expect(r.c.session.dirty).toBe(true);
    expect(r.engine.commands('loadTrack')[0]!.audio!.L[0]).toBe(0.75);
    expect(rec.discard).not.toHaveBeenCalled();
    expect(r.menu.depth).toBe(1);
    expect(r.c.message).toBeNull();
  });

  it('EXIT discards the checkpoint', async () => {
    const r = menuRig();
    const rec = fakeRecovery();
    r.menu.push(recoverScreen(rec));
    push(r, 'exit');
    await flush();
    expect(rec.discard).toHaveBeenCalledTimes(1);
    expect(rec.take).not.toHaveBeenCalled();
    expect(r.menu.depth).toBe(1);
  });

  it('showBootPrompts: RECOVER? first when needed, then CALIBRATE? while uncalibrated', async () => {
    const r = menuRig();
    const rec = fakeRecovery();
    await showBootPrompts(r.menu, r.c, rec);
    expect(showsPrompt(r, RECOVER_PROMPT)).toBe(true);
    push(r, 'exit');
    await flush();
    expect(showsPrompt(r, CALIBRATE_PROMPT)).toBe(true);
    push(r, 'exit');
    expect(r.menu.depth).toBe(1);
  });

  it('showBootPrompts shows nothing after a clean shutdown on a calibrated device', async () => {
    const r = menuRig();
    r.c.setParam('setup.latency', 1000);
    await showBootPrompts(r.menu, r.c, fakeRecovery(false));
    expect(r.menu.depth).toBe(1);
  });
});
