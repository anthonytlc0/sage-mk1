/**
 * A memory out to a file and back in, through MENU > USB > STORAGE: two tracks recorded and track 1's PAN changed,
 * EXPORT MEMORY saves the file, the memory is cleared, IMPORT MEMORY puts the file into memory 04, and memory 04 then
 * has the same track lengths and the same PAN.
 *
 * The file is saved the way each device saves it: the download link on the desktop (Chromium, the download event),
 * the share sheet on the iPad (WebKit: `fakeShareSheet` makes the page a touch device with `navigator.share`, as an
 * iPad is, and keeps what is shared). It comes back through the file picker (`setFiles` on the file chooser).
 */
import { expect, test } from '@playwright/test';
import { FONT_LARGE, FONT_MEDIUM, FONT_SMALL } from '../../src/lcd/fonts';
import type { ButtonId } from '../../src/shared/ids';
import { lcdShows, menuDepth, openApp, topScreen } from './app';
import { fakeMic } from './fakeMic';
import { Panel, captureSave, expectSteady, fakeShareSheet, powerOn, recordLoop, session, stopTrack, topProp, tracks } from './helpers';

test.describe.configure({ timeout: 90_000 });

test('EXPORT MEMORY, CLEAR, IMPORT into memory 04: the track lengths and PAN come back', async ({ page, browserName }) => {
  await page.addInitScript(fakeMic);
  if (browserName === 'webkit') await page.addInitScript(fakeShareSheet);
  await openApp(page);
  const panel = new Panel(page, browserName);
  await powerOn(page, browserName, () => panel.press('exit'));
  const press = (id: ButtonId) => (): Promise<void> => panel.press(id);

  // Two tracks, stopped.
  const len1 = await recordLoop(page, 0, 1, press('trk1.rec'));
  const len2 = await recordLoop(page, 1, 1, press('trk2.rec'));
  await stopTrack(page, 0, press('trk1.stop'));
  await stopTrack(page, 1, press('trk2.stop'));

  // TRACK 1 (its TRACK button), page 1: PAN on knob [3], CENTER -> L5.
  await panel.press('trk1.track');
  await expect.poll(() => topScreen(page)).toBe('TRACK1');
  await panel.turn('knob3', -5);
  await expect.poll(async () => (await session(page)).pan[0]).toBe(-5);
  await expect.poll(() => lcdShows(page, 'L5', FONT_SMALL)).toBe(true);
  await panel.press('exit');
  await expect.poll(() => menuDepth(page)).toBe(1);

  // MENU > USB (page 2, knob [2]) > STORAGE (knob [1]).
  const openStorage = async (): Promise<void> => {
    await panel.press('menu');
    await expect.poll(() => topScreen(page)).toBe('MENU');
    await panel.press('right');
    await panel.press('knob2');
    await expect.poll(() => topScreen(page)).toBe('USB');
    await panel.press('knob1');
    await expect.poll(() => topScreen(page)).toBe('STORAGE');
  };
  const backToPlay = async (): Promise<void> => {
    for (let depth = await menuDepth(page); depth > 1; depth--) {
      await panel.press('exit');
      await expect.poll(() => menuDepth(page)).toBe(depth - 1);
    }
  };

  // EXPORT MEMORY: ENTER prepares the file, READY: ENTER=SAVE, ENTER saves it.
  await openStorage();
  expect(await topProp<number>(page, 'selected')).toBe(0); // EXPORT MEMORY
  await panel.press('enter');
  await expect.poll(() => topProp<string | null>(page, 'prompt'), { timeout: 20_000 }).toBe('READY: ENTER=SAVE');
  // the popup, as the LCD shows it: READY: ENTER=SAVE wrapped onto two lines
  await expect.poll(() => lcdShows(page, 'READY:', FONT_MEDIUM)).toBe(true);
  expect(await lcdShows(page, 'ENTER=SAVE', FONT_MEDIUM)).toBe(true);
  const file = await captureSave(page, browserName, () => panel.press('enter'));
  expect(file.name).toBe('sage-mk1-m01.sagemk1');
  if (browserName === 'webkit') expect(file.via).toBe('pointerup'); // shared inside ENTER's own tap (it acts on release)
  expect(file.bytes.length).toBeGreaterThan(1000);
  await expect.poll(() => topProp<string | null>(page, 'prompt')).toBe(null); // back to the list
  await backToPlay();

  // CLEAR the memory (EXIT + ENTER, knob [3]): the tracks empty, PAN back to CENTER.
  await panel.exitEnter();
  await expect.poll(() => topScreen(page)).toBe('WRITE');
  await panel.press('knob3');
  await expect.poll(() => lcdShows(page, 'CLEAR: ENTER', FONT_SMALL)).toBe(true);
  await panel.press('enter');
  await expect.poll(() => menuDepth(page), { timeout: 20_000 }).toBe(1);
  await expect.poll(async () => (await tracks(page)).map((t) => t.state)).toEqual(['empty', 'empty', 'empty', 'empty', 'empty']);
  expect((await session(page)).pan[0]).toBe(0);
  await expectSteady(page, 'trk1.track', 'off');

  // IMPORT MEMORY (knob [2], ENTER opens the picker), into memory 04.
  await openStorage();
  await panel.press('knob2');
  await expect.poll(() => topProp<number>(page, 'selected')).toBe(1);
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), panel.press('enter')]);
  await chooser.setFiles({ name: file.name, mimeType: 'application/octet-stream', buffer: file.bytes });
  await expect.poll(() => topProp<number | null>(page, 'importSlot'), { timeout: 20_000 }).toBe(1); // starts on the current memory
  await panel.turn('knob1', 3);
  await expect.poll(() => topProp<number | null>(page, 'importSlot')).toBe(4);
  await expect.poll(() => lcdShows(page, '04', FONT_LARGE)).toBe(true);
  await panel.press('enter');
  await expect.poll(() => topProp<number | null>(page, 'importSlot'), { timeout: 20_000 }).toBe(null); // done: the list again
  await backToPlay();

  // Memory 04 on the MEMORY knob: the two phrases at their lengths, and PAN L5.
  await panel.turn('knob1', 3);
  await expect.poll(async () => (await session(page)).slot).toBe(4);
  await expect
    .poll(async () => (await tracks(page)).map((t) => [t.state, t.length]))
    .toEqual([['stopped', len1], ['stopped', len2], ['empty', 0], ['empty', 0], ['empty', 0]]);
  expect(await session(page)).toMatchObject({ slot: 4, dirty: false, pan: [-5, 0, 0, 0, 0] });
  await expect.poll(() => lcdShows(page, '04', FONT_LARGE)).toBe(true);

  await panel.press('trk1.track'); // the TRACK screen shows it too
  await expect.poll(() => lcdShows(page, 'L5', FONT_SMALL)).toBe(true);
  await backToPlay();

  // Memory 01, loaded again from storage: still empty, so the import went to 04 only.
  await panel.turn('knob1', -3);
  await expect.poll(async () => (await session(page)).slot).toBe(1);
  await expect.poll(() => lcdShows(page, '01', FONT_LARGE)).toBe(true);
  await expect.poll(async () => (await tracks(page)).map((t) => [t.state, t.length])).toEqual([['empty', 0], ['empty', 0], ['empty', 0], ['empty', 0], ['empty', 0]]);
  expect(await session(page)).toMatchObject({ slot: 1, dirty: false, pan: [0, 0, 0, 0, 0] });
});
