import { expect, test } from '@playwright/test';
import { FONT_MEDIUM, FONT_SMALL } from '../../src/lcd/fonts';
import { lcdShows, menuDepth, openApp, powerState, powerSwitch, pressControl, tap, topScreen } from './app';
import { noMic } from './fakeMic';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(noMic);
  await openApp(page);
});

test('getUserMedia refused: the unit powers on, the LCD shows NO INPUT for 2 s, and the menus still navigate', async ({ page, browserName }) => {
  await tap(page, powerSwitch(page), browserName);
  await expect.poll(() => powerState(page), { timeout: 3000, intervals: [20] }).toBe('on');
  // The LCD the hook reads is the last frame drawn, so NO INPUT shows up with the next animation frame.
  await expect.poll(() => lcdShows(page, 'NO INPUT', FONT_MEDIUM), { timeout: 500, intervals: [10] }).toBe(true);
  const shownAt = Date.now();
  expect(await page.evaluate(() => window.__sage!.unit.engine!.micAvailable)).toBe(false);
  expect(await page.evaluate(() => window.__sage!.unit.needsResume)).toBe(false); // no TAP POWER TO RESUME for this
  await expect(page.locator('.resume-overlay')).toBeHidden();

  await page.waitForTimeout(1500 - (Date.now() - shownAt));
  expect(await lcdShows(page, 'NO INPUT', FONT_MEDIUM)).toBe(true); // still up at 1.5 s
  await expect.poll(() => lcdShows(page, 'NO INPUT', FONT_MEDIUM), { timeout: 1500, intervals: [50] }).toBe(false);
  expect(Date.now() - shownAt).toBeGreaterThanOrEqual(1800); // 2 s, less the frame or two before it was first seen

  // The menus work without a mic: past the CALIBRATE? offer, MENU, into INPUT and back.
  await page.keyboard.press('Escape');
  await expect.poll(() => menuDepth(page)).toBe(1);
  await page.keyboard.press('KeyM');
  await expect.poll(() => topScreen(page)).toBe('MENU');
  await expect.poll(() => lcdShows(page, 'MENU', FONT_SMALL)).toBe(true);
  await pressControl(page, 'knob1', browserName);
  await expect.poll(() => topScreen(page)).toBe('INPUT');
  await page.keyboard.press('Escape');
  await expect.poll(() => topScreen(page)).toBe('MENU');
  await page.keyboard.press('Escape');
  await expect.poll(() => menuDepth(page)).toBe(1);
});
