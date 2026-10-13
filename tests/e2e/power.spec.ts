import { expect, test } from '@playwright/test';
import { FONT_MEDIUM, FONT_SMALL } from '../../src/lcd/fonts';
import { APP_VERSION } from '../../src/lcd/screens/boot';
import { expectLed, lcdShows, menuDepth, openApp, powerState, powerSwitch, pressControl, readLcd, tap, topScreen } from './app';
import { fakeMic } from './fakeMic';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(fakeMic);
  await openApp(page);
});

test('off until POWER: the panel is dark and its controls do nothing', async ({ page, browserName }) => {
  expect(await powerState(page)).toBe('off');
  expect((await readLcd(page)).every((p) => p === 0)).toBe(true);
  await pressControl(page, 'trk1.rec', browserName);
  await expectLed(page, 'trk1.rec', 'off', 300);
  expect(await powerState(page)).toBe('off');
});

test('first power-on: the boot screen, then CALIBRATE? over the play screen; EXIT shows the play screen at 120.0', async ({ page, browserName }) => {
  await tap(page, powerSwitch(page), browserName);
  await expect.poll(() => lcdShows(page, `VER ${APP_VERSION}`, FONT_SMALL), { intervals: [20] }).toBe(true);
  await expect.poll(() => powerState(page), { timeout: 3000, intervals: [50] }).toBe('on');
  await expect(powerSwitch(page)).toHaveAttribute('aria-checked', 'true');
  expect(await topScreen(page)).toBe('LATENCY'); // the first-run offer
  await expect.poll(() => lcdShows(page, 'CALIBRATE?', FONT_MEDIUM)).toBe(true); // drawn by the next frame
  await page.keyboard.press('Escape'); // EXIT
  await expect.poll(() => menuDepth(page)).toBe(1);
  await expect.poll(() => lcdShows(page, '120.0', FONT_SMALL)).toBe(true);
});

test('a returning user: POWER lands on the play screen within 3 s; POWER off goes dark', async ({ page, browserName }) => {
  // The first power-on makes the CALIBRATE? offer; a POWER off saves that it was made.
  await tap(page, powerSwitch(page), browserName);
  await expect.poll(() => powerState(page), { timeout: 3000 }).toBe('on');
  await page.keyboard.press('Escape');
  await tap(page, powerSwitch(page), browserName);
  await expect.poll(() => powerState(page)).toBe('off');
  await expect(powerSwitch(page)).toHaveAttribute('aria-checked', 'false');
  await expect.poll(async () => (await readLcd(page)).every((p) => p === 0)).toBe(true);

  await page.reload();
  await page.waitForFunction(() => window.__sage !== undefined);
  const t0 = Date.now();
  await tap(page, powerSwitch(page), browserName);
  await expect
    .poll(async () => (await powerState(page)) === 'on' && (await menuDepth(page)) === 1 && (await lcdShows(page, '120.0', FONT_SMALL)), {
      timeout: 3000,
      intervals: [50],
    })
    .toBe(true);
  expect(Date.now() - t0).toBeLessThan(3000);
});

test('trk1.rec with the fake mic: red while recording, green once the second press closes the loop', async ({ page, browserName }) => {
  await tap(page, powerSwitch(page), browserName);
  await expect.poll(() => powerState(page), { timeout: 3000 }).toBe('on');
  await page.keyboard.press('Escape'); // past the CALIBRATE? offer
  await expect.poll(() => lcdShows(page, '120.0', FONT_SMALL)).toBe(true);
  expect(await page.evaluate(() => window.__sage!.unit.engine!.micAvailable)).toBe(true);

  await pressControl(page, 'trk1.rec', browserName);
  await expectLed(page, 'trk1.rec', 'red');
  await page.waitForTimeout(1000);
  await pressControl(page, 'trk1.rec', browserName);
  await expectLed(page, 'trk1.rec', 'green');
});

test('portrait shows the rotate screen; landscape hides it', async ({ page }) => {
  const rotate = page.locator('.rotate-screen');
  await expect(rotate).toBeHidden();
  await page.setViewportSize({ width: 834, height: 1194 });
  await expect(rotate).toBeVisible();
  await expect(rotate).toContainText('ROTATE');
  await page.setViewportSize({ width: 1194, height: 834 });
  await expect(rotate).toBeHidden();
});

test('the panel, POWER and the recorder pod keep at least 24 px from every edge', async ({ page, browserName }) => {
  await tap(page, powerSwitch(page), browserName);
  await expect.poll(() => powerState(page), { timeout: 3000 }).toBe('on');
  const boxes = await page.evaluate(() => {
    const sr = window.__sage!.view.rootSvg.getBoundingClientRect();
    const vb = { w: 1680, h: 936 };
    const k = Math.min(sr.width / vb.w, sr.height / vb.h);
    const panel = { x: sr.left + (sr.width - vb.w * k) / 2, y: sr.top + (sr.height - vb.h * k) / 2, w: vb.w * k, h: vb.h * k };
    const box = (sel: string) => {
      const r = document.querySelector(sel)!.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    };
    return { panel, power: box('.power-switch'), pod: box('.recorder-pod'), vw: innerWidth, vh: innerHeight };
  });
  for (const b of [boxes.panel, boxes.power, boxes.pod]) {
    expect(b.x).toBeGreaterThanOrEqual(24 - 0.5);
    expect(b.y).toBeGreaterThanOrEqual(24 - 0.5);
    expect(boxes.vw - (b.x + b.w)).toBeGreaterThanOrEqual(24 - 0.5);
    expect(boxes.vh - (b.y + b.h)).toBeGreaterThanOrEqual(24 - 0.5);
  }
  // The shelf (POWER, pod) sits below the panel, never over it.
  expect(boxes.power.y).toBeGreaterThanOrEqual(boxes.panel.y + boxes.panel.h);
  expect(boxes.pod.y).toBeGreaterThanOrEqual(boxes.panel.y + boxes.panel.h);
});
