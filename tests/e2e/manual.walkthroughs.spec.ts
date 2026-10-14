/**
 * The Owner's Manual walkthroughs, pp. 9-12, end to end in the real app: touch on the iPad (WebKit), mouse and keys on
 * the desktop (Chromium), the fake mic as the input, the real engine, menus and storage.
 *
 *   p. 9   Recording on a Single Track: record, play, overdub, stop; Undo/Redo and its LED colours
 *   p. 10  Recording on Multiple Tracks: tracks in ascending order, then stopping with ALL START/STOP
 *   p. 12  Saving a Memory (WRITE): write to memory 02, go to 03, back to 02
 *
 * Undo/redo and ALL START/STOP are no-ops in the core until Task 8 merges (ruling R62): the tests that need them are
 * written to the Task 8 brief and marked fixme.
 */
import { expect, test as base, type Page } from '@playwright/test';
import { FONT_LARGE, FONT_MEDIUM, FONT_SMALL } from '../../src/lcd/fonts';
import type { ButtonId } from '../../src/shared/ids';
import { lcdShows, menuDepth, openApp, topScreen } from './app';
import { fakeMic } from './fakeMic';
import {
  Panel, expectSteady, expectTrack, ledState, overdub, powerOn, recordLoop, session, stopTrack, trackLength, tracks, waitAudio,
} from './helpers';

const T8 = 'needs Task 8 (lane-a)';

/** A powered-on unit on the play screen, and the hand that works its panel. */
const test = base.extend<{ panel: Panel }>({
  panel: async ({ page, browserName }, use) => {
    await page.addInitScript(fakeMic);
    await openApp(page);
    const panel = new Panel(page, browserName);
    await powerOn(page, browserName, () => panel.press('exit'));
    await use(panel);
  },
});

test.describe.configure({ timeout: 90_000 });

const rec = (panel: Panel, k: number) => (): Promise<void> => panel.press(`trk${k + 1}.rec` as ButtonId);
const stop = (panel: Panel, k: number) => (): Promise<void> => panel.press(`trk${k + 1}.stop` as ButtonId);

/** Frames per measure of the tempo grid now (the first loop set the tempo). */
const measureFrames = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const st = window.__sage!.unit.controller!.status!;
    const quarters = (st.beat.num * 4) / st.beat.den;
    return (quarters * 60 * st.sampleRate) / st.tempo;
  });

const allStartTrk = (page: Page): Promise<boolean[]> =>
  page.evaluate(() => [...window.__sage!.unit.controller!.session.memory.play.allStartTrk]);

/** Tracks 1, 2 and 3 recorded one after another, as on p. 10. Returns their lengths. */
async function recordAscending(page: Page, panel: Panel): Promise<number[]> {
  const lengths: number[] = [];
  for (let k = 0; k < 3; k++) lengths.push(await recordLoop(page, k, 1, rec(panel, k)));
  return lengths;
}

// ------------------------------------------------------------------------------------------------ p. 9

test('p.9 single track: REC lights red, PLAY green, DUB yellow, PLAY again; STOP goes dark and keeps the phrase', async ({ page, panel }) => {
  expect(await ledState(page, 'trk1.track')).toEqual({ color: 'off', blink: 'none' }); // no phrase yet
  expect(await ledState(page, 'trk1.rec')).toEqual({ color: 'off', blink: 'none' });

  const length = await recordLoop(page, 0, 1, rec(panel, 0)); // Recording, then Playback: the phrase loops
  expect((await ledState(page, 'trk1.track')).color).not.toBe('off'); // lit: a phrase exists
  await expectSteady(page, 'allStartStop', 'green'); // something plays

  // Overdubbing, then Playback. "Repeat as many times as necessary."
  await overdub(page, 0, 0.6, rec(panel, 0));
  await overdub(page, 0, 0.6, rec(panel, 0));

  await stopTrack(page, 0, stop(panel, 0)); // Stopping: the REC/DUB/PLAY button goes dark
  await expectSteady(page, 'allStartStop', 'off');
  expect((await ledState(page, 'trk1.track')).color).not.toBe('off'); // the phrase is kept
  expect(await trackLength(page, 0)).toBe(length);

  await rec(panel, 0)(); // and plays again from REC/DUB/PLAY
  await expectTrack(page, 0, 'playing');
  await expectSteady(page, 'trk1.rec', 'green');
});

test('p.9 UNDO/REDO: green while undo is available, red once undone (redo available), unlit when neither', async ({ page, panel }) => {
  test.fixme(true, T8);
  const length = await recordLoop(page, 0, 1, rec(panel, 0));
  await overdub(page, 0, 0.6, rec(panel, 0));

  await panel.press('undoRedo'); // 1. UNDO/REDO lights
  await expectSteady(page, 'undoRedo', 'red');
  await expectSteady(page, 'trk1.rec', 'green'); // undo available (the overdub)
  await expectSteady(page, 'trk2.rec', 'off'); // nothing to undo or redo

  await rec(panel, 0)(); // 2. the track's REC/DUB/PLAY: the overdub is undone
  await expectSteady(page, 'trk1.rec', 'red'); // redo available
  expect((await tracks(page))[0]).toMatchObject({ state: 'playing', length, canUndo: false, canRedo: true });

  await rec(panel, 0)(); // redone
  await expectSteady(page, 'trk1.rec', 'green');
  expect((await tracks(page))[0]).toMatchObject({ state: 'playing', length, canUndo: true, canRedo: false });

  await panel.press('undoRedo'); // 3. back to the previous state: the play colours
  await expectSteady(page, 'undoRedo', 'off');
  await expectSteady(page, 'trk1.rec', 'green');
  expect(await tracks(page).then((t) => t[0]!.state)).toBe('playing');
});

test('p.9 UNDO of a first recording empties the track; REDO brings the phrase back', async ({ page, panel }) => {
  test.fixme(true, T8);
  const length = await recordLoop(page, 0, 1, rec(panel, 0));
  await panel.press('undoRedo');
  await expectSteady(page, 'trk1.rec', 'green'); // the recording itself can be undone

  await rec(panel, 0)();
  await expectTrack(page, 0, 'empty');
  await expectSteady(page, 'trk1.rec', 'red'); // redo available
  await expectSteady(page, 'trk1.track', 'off'); // no phrase

  await rec(panel, 0)();
  await expect.poll(() => tracks(page).then((t) => t[0]!.length)).toBe(length);
  expect(await tracks(page).then((t) => t[0]!.state)).not.toBe('empty');
  await expectSteady(page, 'trk1.rec', 'green');
  await panel.press('undoRedo');
  await expectSteady(page, 'undoRedo', 'off');
});

test('p.9 UNDO/REDO mode with nothing to undo: the button lights, an empty track stays dark and does not record', async ({ page, panel }) => {
  await recordLoop(page, 0, 1, rec(panel, 0));
  await panel.press('undoRedo');
  await expectSteady(page, 'undoRedo', 'red');
  await expectSteady(page, 'trk2.rec', 'off'); // track 2 has never recorded: no undo, no redo

  await rec(panel, 1)(); // in undo mode REC/DUB/PLAY is UNDO/REDO, never a recording
  await waitAudio(page, 0.3);
  expect((await tracks(page))[1]).toMatchObject({ state: 'empty', length: 0 });
  await expectSteady(page, 'trk2.rec', 'off');
  expect((await tracks(page))[0]!.state).toBe('playing'); // track 1 plays on

  await panel.press('undoRedo'); // out again: the play colours come back
  await expectSteady(page, 'undoRedo', 'off');
  await expectSteady(page, 'trk1.rec', 'green');
  await expectSteady(page, 'trk2.rec', 'off');
});

// ------------------------------------------------------------------------------------------------ p. 10

test('p.10 multiple tracks in ascending order: each records, plays and overdubs over the loop before it', async ({ page, panel }) => {
  // Track 1 sets the tempo; the others wait for its measure lines (QUANTIZE MEASURE) and are whole measures long.
  const len1 = await recordLoop(page, 0, 1, rec(panel, 0));
  await overdub(page, 0, 0.5, rec(panel, 0));
  const measure = await measureFrames(page);
  expect(len1 / measure).toBeCloseTo(Math.round(len1 / measure * 4) / 4, 2); // a musical share of a measure

  for (const k of [1, 2]) {
    const len = await recordLoop(page, k, 1, rec(panel, k));
    const measures = len / measure;
    expect(Math.round(measures)).toBeGreaterThanOrEqual(1);
    expect(Math.abs(len - Math.round(measures) * measure)).toBeLessThanOrEqual(2); // whole measures, to the frame
    await overdub(page, k, 0.5, rec(panel, k));
    // the tracks before it play on
    for (let j = 0; j < k; j++) {
      expect((await tracks(page))[j]!.state).toBe('playing');
      await expectSteady(page, `trk${j + 1}.rec` as ButtonId, 'green');
    }
  }
  await expectSteady(page, 'allStartStop', 'green');
  expect((await tracks(page)).map((t) => t.state)).toEqual(['playing', 'playing', 'playing', 'empty', 'empty']);
});

test('p.10 stopping: ALL START/STOP darkens every track; pressed again it starts the ALL START TRK set', async ({ page, panel }) => {
  test.fixme(true, T8);
  const lengths = await recordAscending(page, panel);

  // LOOP > PLAY, page 2: ALL START TRK, track 3 off (knob [1] turned to it, pushed)
  await panel.press('loop');
  await expect.poll(() => topScreen(page)).toBe('LOOP');
  await panel.press('knob3');
  await expect.poll(() => topScreen(page)).toBe('PLAY');
  await panel.press('right');
  await panel.turn('knob1', 2);
  await panel.press('knob1');
  await expect.poll(() => allStartTrk(page)).toEqual([true, true, false, true, true]);
  await panel.press('exit');
  await panel.press('exit');
  await expect.poll(() => menuDepth(page)).toBe(1);

  await panel.press('allStartStop'); // Stopping: ALL START/STOP and every track's REC/DUB/PLAY go dark
  await expect.poll(async () => (await tracks(page)).map((t) => t.state)).toEqual(['stopped', 'stopped', 'stopped', 'empty', 'empty']);
  for (const id of ['allStartStop', 'trk1.rec', 'trk2.rec', 'trk3.rec'] as const) await expectSteady(page, id, 'off');
  expect((await tracks(page)).slice(0, 3).map((t) => t.length)).toEqual(lengths);

  await panel.press('allStartStop'); // the set with audio starts together: tracks 1 and 2, not 3
  await expect.poll(async () => (await tracks(page)).map((t) => t.state)).toEqual(['playing', 'playing', 'stopped', 'empty', 'empty']);
  await expectSteady(page, 'trk1.rec', 'green');
  await expectSteady(page, 'trk2.rec', 'green');
  await expectSteady(page, 'trk3.rec', 'off');
  await expectSteady(page, 'allStartStop', 'green');

  await panel.press('allStartStop'); // and stops them again
  await expect.poll(async () => (await tracks(page)).map((t) => t.state)).toEqual(['stopped', 'stopped', 'stopped', 'empty', 'empty']);
  await expectSteady(page, 'allStartStop', 'off');
});

test('p.10 ALL START/STOP pressed while the starts wait for the measure line cancels them (R61)', async ({ page, panel }) => {
  test.fixme(true, T8);
  await recordLoop(page, 0, 1, rec(panel, 0));
  await recordLoop(page, 1, 1, rec(panel, 1));
  // TRACK 1 and 2, page 3: LOOP SYNC MODE (knob [4]) IMMEDIATE -> MEASURE, so a start waits for the next measure line
  for (const k of [0, 1]) {
    await panel.press(`trk${k + 1}.track` as ButtonId);
    await expect.poll(() => topScreen(page)).toBe(`TRACK${k + 1}`);
    await panel.press('right');
    await panel.press('right');
    await panel.turn('knob4', 1);
    await expect.poll(() => page.evaluate((k) => window.__sage!.unit.controller!.session.memory.track[k]!.loopSyncMode, k)).toBe('MEASURE');
    await panel.press('exit');
    await expect.poll(() => menuDepth(page)).toBe(1);
  }

  await panel.press('allStartStop'); // stop all
  await expect.poll(async () => (await tracks(page)).slice(0, 2).map((t) => t.state)).toEqual(['stopped', 'stopped']);

  // Early in a measure, so the line is most of a measure away: start (armed), then cancel before it comes.
  await expect
    .poll(() => page.evaluate(() => window.__sage!.unit.controller!.status!.measurePhase), { timeout: 10_000, intervals: [10] })
    .toBeLessThan(0.3);
  await panel.press('allStartStop');
  await expect.poll(async () => (await tracks(page)).slice(0, 2).map((t) => t.pending)).toEqual(['play', 'play']);
  expect((await ledState(page, 'trk1.rec'))).toEqual({ color: 'green', blink: 'fast' }); // armed: blinks
  await panel.press('allStartStop');
  await expect.poll(async () => (await tracks(page)).slice(0, 2).map((t) => [t.state, t.pending])).toEqual([['stopped', null], ['stopped', null]]);
  const sr = await page.evaluate(() => window.__sage!.unit.controller!.status!.sampleRate);
  await waitAudio(page, (await measureFrames(page)) / sr + 0.5); // past the line: nothing starts
  expect((await tracks(page)).slice(0, 2).map((t) => t.state)).toEqual(['stopped', 'stopped']);
  await expectSteady(page, 'trk1.rec', 'off');
  await expectSteady(page, 'allStartStop', 'off');
});

// ------------------------------------------------------------------------------------------------ p. 12

test('p.12 WRITE to memory 02, then memory 03, then back to 02: the tracks come back with their lengths', async ({ page, panel }) => {
  const len1 = await recordLoop(page, 0, 1, rec(panel, 0));
  const len2 = await recordLoop(page, 1, 1, rec(panel, 1));
  await stopTrack(page, 0, stop(panel, 0)); // WRITE waits for the looper to stop (STOP ALL)
  await stopTrack(page, 1, stop(panel, 1));

  await panel.exitEnter(); // 1. EXIT and ENTER together: the WRITE screen
  await expect.poll(() => topScreen(page)).toBe('WRITE');
  await panel.press('knob1'); // 2. [1] (WRITE)
  await expect.poll(() => lcdShows(page, 'WRITE: ENTER', FONT_SMALL)).toBe(true);
  await panel.turn('knob1', 1); // 3. the memory: 01 -> 02
  await expect.poll(() => lcdShows(page, '02', FONT_MEDIUM, true)).toBe(true);
  await panel.press('enter'); // 4. ENTER: saved (EXECUTING... while it runs), back to the play screen
  await expect.poll(() => menuDepth(page), { timeout: 20_000 }).toBe(1);
  expect(await session(page)).toMatchObject({ slot: 2, dirty: false });
  await expect.poll(() => lcdShows(page, '02', FONT_LARGE)).toBe(true);

  await panel.turn('knob1', 1); // the MEMORY knob: memory 03, empty
  await expect.poll(async () => (await session(page)).slot).toBe(3);
  await expect.poll(async () => (await tracks(page)).map((t) => t.state)).toEqual(['empty', 'empty', 'empty', 'empty', 'empty']);
  await expect.poll(() => lcdShows(page, '03', FONT_LARGE)).toBe(true);
  await expectSteady(page, 'trk1.track', 'off');

  await panel.turn('knob1', -1); // back to 02: the phrases are restored, stopped, at their lengths
  await expect.poll(async () => (await session(page)).slot).toBe(2);
  await expect
    .poll(async () => (await tracks(page)).map((t) => [t.state, t.length]))
    .toEqual([['stopped', len1], ['stopped', len2], ['empty', 0], ['empty', 0], ['empty', 0]]);
  await expect.poll(() => lcdShows(page, '02', FONT_LARGE)).toBe(true);
  expect((await ledState(page, 'trk1.track')).color).not.toBe('off');

  await rec(panel, 0)(); // and they play
  await expectTrack(page, 0, 'playing');
  await expectSteady(page, 'trk1.rec', 'green');
});
