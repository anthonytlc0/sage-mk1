import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { text } from '../../src/lcd/draw';
import { FONT_MEDIUM, FONT_SMALL } from '../../src/lcd/fonts';
import { registerEditScreens } from '../../src/lcd/screens/register';
import { writeScreen } from '../../src/lcd/screens/write';
import { defaultMemory } from '../../src/schema/params';
import { take } from '../control/helpers';
import { frame, push, rig, sameRegion, status, turn, turnEv } from './rig';
import type { Rig } from './rig';
import { blank } from './spec';

let unregister: () => void;
beforeEach(() => {
  vi.useFakeTimers();
  unregister = registerEditScreens();
});
afterEach(() => {
  unregister();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Lets the pending promise chains of a write (engine reply, store save) run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

/** The engine's answer to the controller's request for the tracks. (The request goes out only after the slot check, so let that run first.) */
async function answer(r: Rig): Promise<void> {
  await flush();
  r.engine.emit({ t: 'tracks', reqId: r.engine.last('exportTracks')!.reqId, tracks: [null, null, null, null, null] });
}

/** EXIT + ENTER as the controller delivers it: the chord asks the LCD host for the WRITE screen. */
function openWrite(r: Rig): void {
  r.c.handle({ kind: 'press', id: 'exit', t: 0 });
  r.c.handle({ kind: 'press', id: 'enter', t: 10 });
  r.c.handle({ kind: 'release', id: 'enter', t: 20 });
  r.c.handle({ kind: 'release', id: 'exit', t: 30 });
}

/** Opens WRITE and presses knob [1] (WRITE); turns to `slot` when given. */
function toWrite(r: Rig, slot?: number): void {
  openWrite(r);
  push(r, 'knob1');
  if (slot !== undefined) turn(r, 'knob1', slot - r.c.session.slot);
}
function toClear(r: Rig, slot?: number): void {
  openWrite(r);
  push(r, 'knob3');
  if (slot !== undefined) turn(r, 'knob1', slot - r.c.session.slot);
}

function seed(r: Rig, slot: number, name: string, withAudio = true): void {
  const mem = defaultMemory();
  mem.name = name;
  r.stores.memories.slots.set(slot, { settings: mem, tracks: [withAudio ? take(1) : null, null, null, null, null] });
}

describe('opening the WRITE screen', () => {
  it('EXIT + ENTER opens it (the chord) with the WRITE and CLEAR choice', () => {
    const r = rig();
    openWrite(r);
    expect(r.menu.depth).toBe(2);
    expect(r.menu.top.title).toBe('WRITE');
    const want = blank();
    text(want, 0, 57, 'WRITE', FONT_SMALL, { align: 'center', width: 64 });
    text(want, 64, 57, 'CLEAR', FONT_SMALL, { align: 'center', width: 64 });
    expect(sameRegion(frame(r.c), want, 0, 56, 128, 8)).toBe(true);
  });

  it('knobs [1] and [2] choose WRITE, [3] and [4] choose CLEAR (manual p. 12)', () => {
    for (const [knob, word] of [['knob1', 'WRITE: ENTER'], ['knob2', 'WRITE: ENTER'], ['knob3', 'CLEAR: ENTER'], ['knob4', 'CLEAR: ENTER']] as const) {
      const r = rig();
      openWrite(r);
      push(r, knob);
      const want = blank();
      text(want, 0, 11, word, FONT_SMALL, { align: 'right', width: 127 });
      expect(sameRegion(frame(r.c), want, 64, 11, 64, 7)).toBe(true);
    }
  });

  it('EXIT cancels from the choice and from either mode, and nothing is written', async () => {
    for (const to of [() => undefined, (r: Rig) => push(r, 'knob1'), (r: Rig) => push(r, 'knob3')]) {
      const r = rig();
      openWrite(r);
      to(r);
      push(r, 'exit');
      expect(r.menu.depth).toBe(1);
      await flush();
      expect(r.stores.memories.saves).toBe(0);
      expect(r.c.message).toBeNull();
    }
  });

  it('shows the target memory as a boxed number with its name: the current memory by its session name', async () => {
    const r = rig();
    r.c.setParam('name', 'Memory01');
    toWrite(r);
    const want = blank();
    text(want, 0, 11, 'WRITE: ENTER', FONT_SMALL, { align: 'right', width: 127 });
    text(want, 1, 44, '01', FONT_MEDIUM, { invert: true, width: 17, align: 'center' });
    text(want, 20, 44, 'Memory01', FONT_MEDIUM);
    expect(sameRegion(frame(r.c), want, 0, 44, 128, 11)).toBe(true);
  });
});

describe('the name of the memory being chosen', () => {
  /** The number box and name row of the memory select, as the screen draws it. */
  function row(num: string, name: string) {
    const fb = blank();
    text(fb, 1, 44, num, FONT_MEDIUM, { invert: true, width: 17, align: 'center' });
    if (name !== '') text(fb, 20, 44, name, FONT_MEDIUM);
    return fb;
  }
  const shows = (r: Rig, num: string, name: string): boolean => sameRegion(frame(r.c), row(num, name), 0, 44, 128, 11);

  it('shows the saved name of the slot you turn to, and none for an empty slot (WRITE and CLEAR alike)', async () => {
    for (const to of [toWrite, toClear]) {
      const r = rig();
      seed(r, 5, 'Hi-Hat 9');
      seed(r, 6, 'Zed', false);
      r.c.setParam('name', 'Memory01');
      to(r);
      await flush();
      expect(shows(r, '01', 'Memory01')).toBe(true);
      turn(r, 'knob3', 4);
      expect(shows(r, '05', 'Hi-Hat 9')).toBe(true);
      turn(r, 'knob2', 1);
      expect(shows(r, '06', 'Zed')).toBe(true);
      turn(r, 'knob4', 1);
      expect(shows(r, '07', '')).toBe(true);
      turn(r, 'knob1', -6); // back on the current slot: the name it has now
      expect(shows(r, '01', 'Memory01')).toBe(true);
    }
  });

  it('shows the session name for the current slot, not the one stored there (edits are what WRITE saves)', async () => {
    const r = rig();
    seed(r, 1, 'Old Name');
    r.c.setParam('name', 'New Name');
    toWrite(r);
    await flush();
    expect(shows(r, '01', 'New Name')).toBe(true);
  });

  it('asks for the names once, when the screen opens, and not again while you turn', async () => {
    const r = rig();
    const spy = vi.spyOn(r.c, 'memoryNames');
    toWrite(r);
    expect(spy).toHaveBeenCalledTimes(1);
    await flush();
    turn(r, 'knob1', 7);
    push(r, 'exit');
    toClear(r);
    expect(spy).toHaveBeenCalledTimes(2); // a new screen, a new ask
    await flush();
    expect(r.stores.memories.lists).toBe(2);
  });

  it('shows no names until they arrive, then picks them up', async () => {
    const r = rig();
    seed(r, 5, 'Hi-Hat 9');
    toWrite(r, 5);
    expect(shows(r, '05', '')).toBe(true);
    await flush();
    expect(shows(r, '05', 'Hi-Hat 9')).toBe(true);
  });

  it('a screen torn down before the names arrive is left alone, and the late names do no harm', async () => {
    const r = rig();
    seed(r, 5, 'Hi-Hat 9');
    const gate: { open: () => void } = { open: () => undefined };
    const held = new Promise<void>((res) => (gate.open = res));
    const real = r.stores.memories.list.bind(r.stores.memories);
    r.stores.memories.list = async () => {
      await held;
      return real();
    };
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    toWrite(r);
    r.menu.showStartScreen();
    gate.open();
    await flush();
    expect(r.menu.depth).toBe(1);
    expect(log).not.toHaveBeenCalled();
    expect(r.c.message).toBeNull();
  });

  it('if the names cannot be read the screen still works, without them (the failure is logged)', async () => {
    const r = rig();
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    r.stores.memories.list = async () => {
      throw new Error('db gone');
    };
    seed(r, 5, 'Hi-Hat 9');
    toWrite(r, 5);
    await flush();
    expect(log).toHaveBeenCalled();
    expect(shows(r, '05', '')).toBe(true);
    expect(r.c.message).toBeNull();
    push(r, 'enter');
    await flush();
    expect(r.c.message).toBe('NOT EMPTY'); // and writing goes on as usual
  });
});

describe('choosing the memory', () => {
  // SETUP MEMORY EXT MIN..MAX limits the memories the player can reach (ruling R39): the select wraps inside it, as the
  // memory knob on the play screen does.
  it.each([[3, 8], [8, 3]])('wraps inside MEMORY EXT %i..%i, like the memory knob', async (min, max) => {
    const cases: [number, number][] = [[-1, 8], [1, 4], [5, 8], [6, 3], [-3, 6], [12, 3], [-12, 3]];
    for (const [mode, spyOn] of [['write', 'write'], ['clear', 'clear']] as const) {
      for (const [steps, want] of cases) {
        const r = rig();
        r.c.setParam('setup.memoryExt.min', min);
        r.c.setParam('setup.memoryExt.max', max);
        await r.c.selectMemory(3);
        const spy = vi.spyOn(r.c, spyOn);
        (mode === 'write' ? toWrite : toClear)(r);
        turn(r, 'knob2', steps);
        push(r, 'enter');
        expect(spy, `${mode} after ${steps}`).toHaveBeenCalledWith(want);
        await flush();
      }
    }
  });

  it('turns a held knob by tens inside the range too', async () => {
    const r = rig();
    r.c.setParam('setup.memoryExt.max', 20);
    const spy = vi.spyOn(r.c, 'write');
    toWrite(r);
    r.c.handle({ kind: 'press', id: 'knob1', t: 0 });
    r.menu.onEvent(turnEv('knob1', 2), r.c); // 1 + 20 = 21, wraps to 1
    r.c.handle({ kind: 'release', id: 'knob1', t: 5 });
    push(r, 'enter');
    expect(spy).toHaveBeenLastCalledWith(1);
    await flush();
  });

  it('the current slot stays the starting point even outside the range', async () => {
    const r = rig();
    await r.c.selectMemory(50);
    r.c.setParam('setup.memoryExt.max', 10);
    const spy = vi.spyOn(r.c, 'write');
    toWrite(r);
    push(r, 'enter'); // no turn: over the current memory, which is always allowed
    expect(spy).toHaveBeenLastCalledWith(50);
    await flush();
  });

  it('any of the knobs [1]-[4] turns the target slot', () => {
    for (const knob of ['knob1', 'knob2', 'knob3', 'knob4'] as const) {
      const r = rig();
      const spy = vi.spyOn(r.c, 'write');
      toWrite(r);
      turn(r, knob, 2);
      push(r, 'enter');
      expect(spy).toHaveBeenLastCalledWith(3);
    }
  });

  it('turns by one, wraps from 99 to 1, and by ten while the knob is held', async () => {
    const r = rig();
    const spy = vi.spyOn(r.c, 'write');
    toWrite(r);
    turn(r, 'knob4', 3);
    r.c.handle({ kind: 'press', id: 'knob2', t: 0 }); // held: coarse
    r.menu.onEvent(turnEv('knob2', 2), r.c);
    r.c.handle({ kind: 'release', id: 'knob2', t: 5 });
    push(r, 'enter');
    expect(spy).toHaveBeenLastCalledWith(24); // 1 + 3 + 20
    await flush();

    const r2 = rig();
    const spy2 = vi.spyOn(r2.c, 'write');
    toWrite(r2);
    turn(r2, 'knob1', 98); // 99
    turn(r2, 'knob1', 1); // wraps to 1
    push(r2, 'enter');
    expect(spy2).toHaveBeenLastCalledWith(1);
    await flush();
  });
});

describe('WRITE', () => {
  it('to the empty slot 05 calls ctx.write(5) and shows EXECUTING...', async () => {
    const r = rig();
    const spy = vi.spyOn(r.c, 'write');
    toWrite(r, 5);
    push(r, 'enter');
    expect(spy).toHaveBeenCalledWith(5);
    expect(r.c.message).toBe('EXECUTING...');
    await flush();
    expect(r.stores.memories.slots.has(5)).toBe(true);
    expect(r.c.session.slot).toBe(5);
    expect(r.c.message).toBeNull(); // the popup comes down when the save is done
    expect(r.menu.depth).toBe(1); // and the screen is left
  });

  it('keeps EXECUTING... on until the save is done', async () => {
    const r = rig();
    r.engine.exportReply = null; // the engine answers by hand
    toWrite(r, 5);
    push(r, 'enter');
    await flush();
    vi.advanceTimersByTime(10_000); // the message has no timer of its own
    expect(r.c.message).toBe('EXECUTING...');
    await answer(r);
    await flush();
    expect(r.c.message).toBeNull();
    expect(r.stores.memories.slots.has(5)).toBe(true);
  });

  it('an engine that never answers ends in DATA WRITE ERR, not a stuck popup', async () => {
    const r = rig();
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    r.engine.exportReply = null;
    toWrite(r, 5);
    push(r, 'enter');
    await flush();
    vi.advanceTimersByTime(25_000); // the controller gives up after EXPORT_TIMEOUT_MS
    await flush();
    expect(r.c.message).toBe('DATA WRITE ERR');
    expect(log).toHaveBeenCalled();
    expect(r.menu.top.title).toBe('WRITE');
    expect(r.stores.memories.saves).toBe(0);
  });

  it('over the current slot is always allowed, even when it holds audio', async () => {
    const r = rig();
    seed(r, 1, 'LOOPS');
    await r.c.selectMemory(1);
    toWrite(r); // slot 1 is the target
    push(r, 'enter');
    await flush();
    expect(r.stores.memories.saves).toBe(1);
    expect(r.c.message).toBeNull();
  });

  it.each([['recording'], ['playing'], ['overdubbing']] as const)('while a track is %s shows STOP ALL and writes nothing', async (state) => {
    const r = rig();
    const spy = vi.spyOn(r.c, 'write');
    status(r, {}, [{}, {}, { state }]);
    toWrite(r, 5);
    push(r, 'enter');
    expect(r.c.message).toBe('STOP ALL');
    expect(spy).not.toHaveBeenCalled();
    await flush();
    expect(r.stores.memories.saves).toBe(0);
    expect(r.menu.top.title).toBe('WRITE'); // still on the screen
    status(r, {}, [{ state: 'stopped' }]);
    vi.advanceTimersByTime(5000);
    push(r, 'enter'); // stopped now: it goes ahead
    await flush();
    expect(r.stores.memories.saves).toBe(1);
  });

  // Parameter Guide p. 6 (RHYTHM memo): writing while the rhythm plays or waits saves a "rhythm: on" memory (ruling R40).
  it('goes ahead while only the rhythm plays or waits to start', async () => {
    for (const rhythm of ['on', 'standby'] as const) {
      const r = rig();
      status(r, { rhythm }, [{ state: 'stopped' }]);
      toWrite(r, 6);
      push(r, 'enter');
      expect(r.c.message).toBe('EXECUTING...');
      await flush();
      expect(r.stores.memories.slots.has(6)).toBe(true);
      expect(r.c.message).toBeNull();
    }
    const r = rig();
    status(r, { rhythm: 'on' }); // not even a stopped track
    toWrite(r, 6);
    push(r, 'enter');
    await flush();
    expect(r.stores.memories.slots.has(6)).toBe(true);
  });

  it('a stopped or empty looper does not block it', async () => {
    const r = rig();
    status(r, {}, [{ state: 'stopped' }]);
    toWrite(r, 6);
    push(r, 'enter');
    await flush();
    expect(r.stores.memories.slots.has(6)).toBe(true);
  });

  it('onto another slot that holds audio shows NOT EMPTY, writes nothing and stays for another try', async () => {
    const r = rig();
    seed(r, 7, 'TAKEN');
    toWrite(r, 7);
    push(r, 'enter');
    expect(r.c.message).toBe('EXECUTING...');
    await flush();
    expect(r.c.message).toBe('NOT EMPTY');
    expect(r.stores.memories.saves).toBe(0);
    expect(r.c.session.slot).toBe(1);
    expect(r.menu.top.title).toBe('WRITE');
    expect(r.menu.depth).toBe(2);
    turn(r, 'knob1', 1); // 8 is free
    push(r, 'enter');
    await flush();
    expect(r.stores.memories.slots.has(8)).toBe(true);
    expect(r.menu.depth).toBe(1);
  });

  it('a slot that holds settings but no audio can be written over', async () => {
    const r = rig();
    seed(r, 7, 'JUST SETTINGS', false);
    toWrite(r, 7);
    push(r, 'enter');
    await flush();
    expect(r.c.message).toBeNull();
    expect(r.c.session.slot).toBe(7);
  });

  it('shows MEMORY FULL when storage refuses, and stays', async () => {
    const r = rig();
    r.stores.memories.full = true;
    toWrite(r, 5);
    push(r, 'enter');
    await flush();
    expect(r.c.message).toBe('MEMORY FULL');
    expect(r.menu.depth).toBe(2);
  });

  it('a WRITE aborted because the memory changed mid-save shows a message instead of crashing', async () => {
    const r = rig();
    r.engine.exportReply = null;
    toWrite(r, 5);
    push(r, 'enter');
    await flush(); // the controller is now waiting for the engine's tracks
    const sel = r.c.selectMemory(2); // the memory changes under it (an unhandled rejection would fail the run)
    await answer(r);
    await sel;
    await flush();
    expect(r.c.message).toBe('WRITE ABORTED');
    expect(r.stores.memories.saves).toBe(0);
    expect(r.menu.top.title).toBe('WRITE'); // the screen is free again
    push(r, 'exit');
    expect(r.menu.depth).toBe(1);
  });

  it('any other failure shows DATA WRITE ERR (and is logged)', async () => {
    const r = rig();
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(r.c, 'write').mockRejectedValue(new Error('disk on fire'));
    toWrite(r, 5);
    push(r, 'enter');
    await flush();
    expect(r.c.message).toBe('DATA WRITE ERR');
    expect(log).toHaveBeenCalled();
    expect(r.menu.top.title).toBe('WRITE');
  });

  it('ignores a second ENTER and the knobs while the save runs', async () => {
    const r = rig();
    r.engine.exportReply = null;
    const spy = vi.spyOn(r.c, 'write');
    toWrite(r, 5);
    push(r, 'enter');
    push(r, 'enter');
    turn(r, 'knob1', 3);
    push(r, 'exit'); // EXIT does not abandon a save in progress
    expect(spy).toHaveBeenCalledTimes(1);
    expect(r.menu.top.title).toBe('WRITE');
    await answer(r);
    await flush();
    expect(r.stores.memories.slots.has(5)).toBe(true);
    expect(r.stores.memories.slots.has(8)).toBe(false);
  });

  it('is fine when the screen is gone before the save finishes: nothing is touched, the popup still comes down', async () => {
    const r = rig();
    r.engine.exportReply = null;
    toWrite(r, 5);
    push(r, 'enter');
    r.menu.showStartScreen(); // e.g. POWER / a new memory: every screen is torn down while the write waits
    expect(r.menu.depth).toBe(1);
    await answer(r);
    await flush();
    expect(r.stores.memories.slots.has(5)).toBe(true);
    expect(r.menu.depth).toBe(1);
    expect(r.c.message).toBeNull();
  });

  it('a late result does not close another screen opened since', async () => {
    const r = rig();
    r.engine.exportReply = null;
    toWrite(r, 5);
    push(r, 'enter');
    r.menu.showStartScreen();
    openWrite(r); // a second WRITE screen is now on top
    expect(r.menu.depth).toBe(2);
    await answer(r);
    await flush();
    expect(r.menu.depth).toBe(2);
    expect(r.menu.top.title).toBe('WRITE');
  });

  it('only asks a screen to leave while it is still on the stack', async () => {
    for (const tornDown of [true, false]) {
      const r = rig();
      r.engine.exportReply = null;
      const remove = vi.fn();
      const screen = writeScreen({ remove }, r.c);
      r.menu.push(screen);
      push(r, 'knob1');
      turn(r, 'knob1', 4);
      push(r, 'enter');
      if (tornDown) r.menu.pop();
      await answer(r);
      await flush();
      expect(r.stores.memories.slots.has(5)).toBe(true);
      if (tornDown) expect(remove).not.toHaveBeenCalled();
      else expect(remove).toHaveBeenCalledExactlyOnceWith(screen);
    }
  });

  it('a failure inside the screen\'s own follow-up is logged, not left as an unhandled rejection', async () => {
    const r = rig();
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const boom = new Error('remove failed');
    r.menu.push(writeScreen({ remove: () => { throw boom; } }, r.c)); // the write succeeds, closing the screen throws
    push(r, 'knob1');
    turn(r, 'knob1', 4);
    push(r, 'enter');
    await flush(); // an unhandled rejection would fail the run here
    expect(r.stores.memories.slots.has(5)).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.any(String), boom);
    expect(r.c.message).toBeNull();
  });

  it('runs one write at a time, even across screens (a new WRITE screen opened while the first one waits)', async () => {
    const r = rig();
    r.engine.exportReply = null;
    const spy = vi.spyOn(r.c, 'write');
    toWrite(r, 5);
    push(r, 'enter');
    r.menu.showStartScreen();
    toWrite(r, 6);
    push(r, 'enter');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(r.c.message).toBe('EXECUTING...');
    await answer(r);
    await flush();
    expect(r.stores.memories.slots.has(5)).toBe(true);
    expect(r.stores.memories.slots.has(6)).toBe(false);
    expect(r.c.message).toBeNull();
    push(r, 'enter'); // the second screen is free again
    await answer(r);
    await flush();
    expect(r.stores.memories.slots.has(6)).toBe(true);
  });

  it('a late NOT EMPTY after teardown still tells the player', async () => {
    const r = rig();
    seed(r, 7, 'TAKEN');
    const gate: { open: () => void } = { open: () => undefined };
    const held = new Promise<void>((res) => (gate.open = res));
    const real = r.stores.memories.hasAudio.bind(r.stores.memories);
    r.stores.memories.hasAudio = async (slot: number) => {
      await held;
      return real(slot);
    };
    toWrite(r, 7);
    push(r, 'enter');
    r.menu.showStartScreen();
    gate.open();
    await flush();
    expect(r.c.message).toBe('NOT EMPTY');
    expect(r.menu.depth).toBe(1);
  });
});

describe('CLEAR', () => {
  it('slot 05 calls ctx.clear(5), shows EXECUTING..., then empties it', async () => {
    const r = rig();
    seed(r, 5, 'OLD TAKE');
    const spy = vi.spyOn(r.c, 'clear');
    toClear(r, 5);
    push(r, 'enter');
    expect(spy).toHaveBeenCalledWith(5);
    expect(r.c.message).toBe('EXECUTING...');
    await flush();
    expect(r.stores.memories.slots.has(5)).toBe(false);
    expect(r.c.message).toBeNull();
    expect(r.menu.depth).toBe(1);
  });

  it('clearing the current memory empties the session as well', async () => {
    const r = rig();
    r.c.setParam('name', 'MINE');
    toClear(r);
    push(r, 'enter');
    await flush();
    expect(r.c.session.memory.name).toBe('');
  });

  // Controller.clear empties the engine's tracks when the current memory is cleared (ruling R41).
  it.each([['recording'], ['playing'], ['overdubbing']] as const)('of the current memory while a track is %s shows STOP ALL and clears nothing', async (state) => {
    const r = rig();
    r.c.setParam('name', 'MINE');
    seed(r, 1, 'MINE');
    const spy = vi.spyOn(r.c, 'clear');
    status(r, {}, [{}, { state }]);
    toClear(r); // the current slot
    push(r, 'enter');
    expect(r.c.message).toBe('STOP ALL');
    expect(spy).not.toHaveBeenCalled();
    await flush();
    expect(r.stores.memories.slots.has(1)).toBe(true);
    expect(r.c.session.memory.name).toBe('MINE');
    expect(r.menu.top.title).toBe('WRITE');
    status(r, {}, [{ state: 'stopped' }]);
    push(r, 'enter'); // stopped now: it goes ahead
    await flush();
    expect(r.stores.memories.slots.has(1)).toBe(false);
    expect(r.c.session.memory.name).toBe('');
  });

  it('of a different memory is allowed while tracks play (the engine is not touched)', async () => {
    const r = rig();
    seed(r, 5, 'OLD TAKE');
    status(r, {}, [{ state: 'playing' }]);
    r.engine.reset();
    toClear(r, 5);
    push(r, 'enter');
    await flush();
    expect(r.stores.memories.slots.has(5)).toBe(false);
    expect(r.engine.commands('loadTrack')).toEqual([]);
  });

  it('of the current memory is allowed while the rhythm plays (only tracks block it)', async () => {
    const r = rig();
    status(r, { rhythm: 'on' }, [{ state: 'stopped' }]);
    toClear(r);
    push(r, 'enter');
    await flush();
    expect(r.c.message).toBeNull();
    expect(r.menu.depth).toBe(1);
  });

  it('a failing clear shows DATA WRITE ERR and stays', async () => {
    const r = rig();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(r.c, 'clear').mockRejectedValue(new Error('nope'));
    toClear(r, 5);
    push(r, 'enter');
    await flush();
    expect(r.c.message).toBe('DATA WRITE ERR');
    expect(r.menu.top.title).toBe('WRITE');
  });

  it('ENTER on the choice screen does nothing', () => {
    const r = rig();
    const spyW = vi.spyOn(r.c, 'write');
    const spyC = vi.spyOn(r.c, 'clear');
    openWrite(r);
    push(r, 'enter');
    expect(spyW).not.toHaveBeenCalled();
    expect(spyC).not.toHaveBeenCalled();
    expect(r.menu.depth).toBe(2);
  });
});
