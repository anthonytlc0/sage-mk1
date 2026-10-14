/**
 * The computer keyboard drives the same flows as the panel (src/ui/input/keyboard.ts KEYMAP):
 *   A / S       REC/DUB/PLAY of tracks 1 / 2      Z / X   STOP of tracks 1 / 2
 *   Space       ALL START/STOP                    Tab     UNDO/REDO
 *   Esc + Enter EXIT + ENTER: the WRITE screen    Esc     EXIT, Enter ENTER
 * Only POWER (a shell control, not a panel one) and the encoder pushes, which have no keys, are tapped or clicked.
 */
import { expect, test as base, type Page } from '@playwright/test';
import { FONT_LARGE, FONT_SMALL } from '../../src/lcd/fonts';
import { lcdShows, menuDepth, openApp, powerState, topScreen } from './app';
import { fakeMic } from './fakeMic';
import { Panel, expectSteady, expectTrack, overdub, powerOn, recordLoop, session, stopTrack, tracks, waitAudio } from './helpers';

const T8 = 'needs Task 8 (lane-a)';

/** Every test starts powered on (the first-run CALIBRATE? offer dismissed with Esc); `panel` taps what has no key. */
const test = base.extend<{ panel: Panel }>({
  panel: [
    async ({ page, browserName }, use) => {
      await page.addInitScript(fakeMic);
      await openApp(page);
      await powerOn(page, browserName, () => page.keyboard.press('Escape'));
      await use(new Panel(page, browserName));
    },
    { auto: true },
  ],
});

test.describe.configure({ timeout: 90_000 });

const key = (page: Page, k: string) => (): Promise<void> => page.keyboard.press(k);
const states = async (page: Page): Promise<string[]> => (await tracks(page)).map((t) => t.state);

test('A and S record, play and overdub tracks 1 and 2; Z and X stop them', async ({ page }) => {
  const len1 = await recordLoop(page, 0, 1, key(page, 'KeyA'));
  await overdub(page, 0, 0.5, key(page, 'KeyA'));
  const len2 = await recordLoop(page, 1, 1, key(page, 'KeyS'));
  await overdub(page, 1, 0.5, key(page, 'KeyS'));
  expect(await states(page)).toEqual(['playing', 'playing', 'empty', 'empty', 'empty']);

  await stopTrack(page, 0, key(page, 'KeyZ'));
  await stopTrack(page, 1, key(page, 'KeyX'));
  expect((await tracks(page)).slice(0, 2).map((t) => t.length)).toEqual([len1, len2]);
  await expectSteady(page, 'allStartStop', 'off');

  await page.keyboard.press('KeyA'); // a stopped phrase plays again
  await expectTrack(page, 0, 'playing');
  await expectSteady(page, 'trk1.rec', 'green');
});

test('a held key is one press: A held down through its auto-repeat starts one recording, not a recording and its end', async ({ page }) => {
  await page.keyboard.down('KeyA');
  await expectTrack(page, 0, 'recording');
  for (let i = 0; i < 5; i++) await page.keyboard.down('KeyA'); // auto-repeat keydowns
  await waitAudio(page, 0.3);
  await page.keyboard.up('KeyA');
  await waitAudio(page, 0.3);
  expect((await tracks(page))[0]!.state).toBe('recording');
  await page.keyboard.press('KeyA');
  await expectTrack(page, 0, 'playing');
});

test('Space is ALL START/STOP: it stops both tracks, starts them together, and the unit stays on', async ({ page }) => {
  test.fixme(true, T8);
  await recordLoop(page, 0, 1, key(page, 'KeyA'));
  await recordLoop(page, 1, 1, key(page, 'KeyS'));

  await page.keyboard.press('Space');
  await expect.poll(() => states(page)).toEqual(['stopped', 'stopped', 'empty', 'empty', 'empty']);
  await expectSteady(page, 'allStartStop', 'off');
  await expectSteady(page, 'trk1.rec', 'off');
  await expectSteady(page, 'trk2.rec', 'off');
  expect(await powerState(page)).toBe('on'); // Space never reaches POWER (it is not focusable)

  await page.keyboard.press('Space');
  await expect.poll(() => states(page)).toEqual(['playing', 'playing', 'empty', 'empty', 'empty']);
  await expectSteady(page, 'allStartStop', 'green');
  await expectSteady(page, 'trk1.rec', 'green');
  await expectSteady(page, 'trk2.rec', 'green');

  await page.keyboard.press('Space');
  await expect.poll(() => states(page)).toEqual(['stopped', 'stopped', 'empty', 'empty', 'empty']);
});

test('Tab is UNDO/REDO: A undoes and redoes track 1 (red, then green), Tab again leaves undo mode', async ({ page }) => {
  test.fixme(true, T8);
  const length = await recordLoop(page, 0, 1, key(page, 'KeyA'));
  await overdub(page, 0, 0.5, key(page, 'KeyA'));

  await page.keyboard.press('Tab');
  await expectSteady(page, 'undoRedo', 'red');
  await expectSteady(page, 'trk1.rec', 'green'); // undo available
  await page.keyboard.press('KeyA'); // UNDO
  await expectSteady(page, 'trk1.rec', 'red'); // redo available
  expect((await tracks(page))[0]).toMatchObject({ state: 'playing', length, canRedo: true });
  await page.keyboard.press('KeyA'); // REDO
  await expectSteady(page, 'trk1.rec', 'green');
  await page.keyboard.press('Tab');
  await expectSteady(page, 'undoRedo', 'off');
  await expectSteady(page, 'trk1.rec', 'green');
});

test('Tab toggles UNDO/REDO mode; in it S does not record on an empty track 2', async ({ page }) => {
  await recordLoop(page, 0, 1, key(page, 'KeyA'));
  await page.keyboard.press('Tab');
  await expectSteady(page, 'undoRedo', 'red');
  await page.keyboard.press('KeyS');
  await waitAudio(page, 0.3);
  expect((await tracks(page))[1]).toMatchObject({ state: 'empty', length: 0 });
  await expectSteady(page, 'trk2.rec', 'off');
  await page.keyboard.press('Tab');
  await expectSteady(page, 'undoRedo', 'off');
  await expectSteady(page, 'trk1.rec', 'green');

  await recordLoop(page, 1, 1, key(page, 'KeyS')); // out of undo mode S records again
});

test('Esc + Enter opens WRITE: Esc cancels it; a knob push, then Enter, writes the memory', async ({ page, panel }) => {
  await recordLoop(page, 0, 1, key(page, 'KeyA'));
  await stopTrack(page, 0, key(page, 'KeyZ'));
  expect((await session(page)).dirty).toBe(true); // unsaved work

  const exitEnter = async (): Promise<void> => {
    await page.keyboard.down('Escape');
    await page.keyboard.down('Enter');
    await page.keyboard.up('Enter');
    await page.keyboard.up('Escape');
    await expect.poll(() => topScreen(page)).toBe('WRITE');
  };

  await exitEnter();
  await page.keyboard.press('Escape'); // EXIT: cancelled
  await expect.poll(() => menuDepth(page)).toBe(1);
  expect((await session(page)).dirty).toBe(true);

  await exitEnter();
  await panel.press('knob1'); // [1] (WRITE): the encoders have no keys
  await expect.poll(() => lcdShows(page, 'WRITE: ENTER', FONT_SMALL)).toBe(true);
  await page.keyboard.press('Enter'); // ENTER: memory 01 is saved
  await expect.poll(() => menuDepth(page), { timeout: 20_000 }).toBe(1);
  expect(await session(page)).toMatchObject({ slot: 1, dirty: false });
  await expect.poll(() => lcdShows(page, '01', FONT_LARGE)).toBe(true);
});
