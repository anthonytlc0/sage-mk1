import { expect, test, type Page } from '@playwright/test';
import { FONT_MEDIUM, FONT_SMALL } from '../../src/lcd/fonts';
import { APP_VERSION } from '../../src/lcd/screens/boot';
import { expectLed, lcdShows, ledColor, menuDepth, openApp, powerState, powerSwitch, pressControl, readLcd, tap, topScreen } from './app';
import { fakeMic } from './fakeMic';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(fakeMic);
  await openApp(page);
});

test('off until POWER: the panel is dark and its controls do nothing', async ({ page, browserName }) => {
  expect(await powerState(page)).toBe('off');
  expect((await readLcd(page)).every((p) => p === 0)).toBe(true);
  await pressControl(page, 'trk1.rec', browserName);
  await page.waitForTimeout(300); // long enough for a recording to light it
  expect(await ledColor(page, 'trk1.rec')).toBe('off');
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
  // Timed in the page, from the tap's first input event to the first frame drawn with the unit on and the play screen
  // up, so Playwright's own waits and round trips are not counted. The Playwright timeout only bounds the wait.
  await page.evaluate(() => {
    const boot: BootTiming = { tapAt: null, onAt: null };
    (window as unknown as { __boot: BootTiming }).__boot = boot;
    const sw = document.querySelector('.power-switch')!;
    const first = (e: Event): void => {
      boot.tapAt ??= e.timeStamp;
    };
    for (const type of ['pointerdown', 'touchstart', 'mousedown']) sw.addEventListener(type, first, { capture: true });
    const frame = (t: number): void => {
      const unit = window.__sage!.unit;
      if (boot.tapAt !== null && unit.state === 'on' && unit.menu?.depth === 1) boot.onAt = t;
      else requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  await tap(page, powerSwitch(page), browserName);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __boot: BootTiming }).__boot.onAt !== null), { timeout: 10_000, intervals: [50] })
    .toBe(true);
  const { tapAt, onAt } = await page.evaluate(() => (window as unknown as { __boot: BootTiming }).__boot);
  test.info().annotations.push({ type: 'boot ms', description: (onAt! - tapAt!).toFixed(0) });
  expect(onAt! - tapAt!).toBeGreaterThan(0);
  expect(onAt! - tapAt!).toBeLessThan(3000);
  await expect.poll(() => lcdShows(page, '120.0', FONT_SMALL)).toBe(true); // the play screen
});

/** When the tap began (its first input event) and the first frame with the unit on, both on the page's clock (ms). */
interface BootTiming {
  tapAt: number | null;
  onAt: number | null;
}

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

// ------------------------------------------------------------------------------------------------ TAP POWER TO RESUME

interface ResumeProbe {
  calls: object[];
  ok: boolean;
}

/**
 * Puts the running engine into "audio lost" (as EngineHost does when a resume fails) and makes its `resume` answer
 * `ok`, recording each call. Uses the host's private setNeedsResume through the dev hook.
 */
async function loseAudio(page: Page, ok: boolean): Promise<void> {
  await page.evaluate((ok) => {
    const host = window.__sage!.unit.engine as unknown as {
      resume(opts?: object): Promise<boolean>;
      setNeedsResume(v: boolean): void;
    };
    const probe: ResumeProbe = { calls: [], ok };
    (window as unknown as { __resume: ResumeProbe }).__resume = probe;
    host.resume = (opts = {}) => {
      probe.calls.push(opts);
      if (probe.ok) host.setNeedsResume(false);
      return Promise.resolve(probe.ok);
    };
    host.setNeedsResume(true);
  }, ok);
}

const resumeCalls = (page: Page): Promise<object[]> =>
  page.evaluate(() => (window as unknown as { __resume: ResumeProbe }).__resume.calls);

/** The topmost element at the centre of `selector`'s box, as the nearest of the given shell classes it is inside. */
const topAt = (page: Page, selector: string): Promise<string> =>
  page.evaluate((selector) => {
    const r = (selector === 'panel' ? window.__sage!.view.rootSvg : document.querySelector(selector)!).getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    for (const cls of ['resume-overlay', 'power-switch', 'recorder-pod', 'panel-svg']) if (hit?.closest(`.${cls}`)) return cls;
    return hit?.tagName ?? 'nothing';
  }, selector);

test.describe('TAP POWER TO RESUME', () => {
  test.beforeEach(async ({ page, browserName }) => {
    await tap(page, powerSwitch(page), browserName);
    await expect.poll(() => powerState(page), { timeout: 3000 }).toBe('on');
    await page.keyboard.press('Escape');
  });

  test('audio lost: the prompt covers the panel but not POWER or the pod; a tap on it resumes', async ({ page, browserName }) => {
    const overlay = page.locator('.resume-overlay');
    await expect(overlay).toBeHidden();
    await loseAudio(page, true);
    await expect(overlay).toBeVisible();
    await expect(overlay.locator('.resume-text')).toHaveText('TAP POWER TO RESUME');
    expect(await topAt(page, 'panel')).toBe('resume-overlay'); // a touch on the panel lands on the prompt
    expect(await topAt(page, '.power-switch')).toBe('power-switch');
    expect(await topAt(page, '.rp-rec')).toBe('recorder-pod');
    await expect(page.locator('.rp-rec')).toHaveAttribute('aria-disabled', 'true'); // no takes of a dead engine

    await tap(page, overlay, browserName);
    await expect(overlay).toBeHidden();
    expect(await resumeCalls(page)).toEqual([{ retryMic: true }]);
    expect(await powerState(page)).toBe('on');
    await expect(page.locator('.rp-rec')).toHaveAttribute('aria-disabled', 'false');
  });

  test('POWER retries first; once that fails the prompt says POWER switches off, the prompt still retries, and POWER is OFF', async ({ page, browserName }) => {
    const overlay = page.locator('.resume-overlay');
    await loseAudio(page, false);
    await expect(overlay).toBeVisible();
    await tap(page, powerSwitch(page), browserName); // first POWER tap: a retry
    await expect.poll(() => resumeCalls(page)).toEqual([{ retryMic: true }]);
    expect(await powerState(page)).toBe('on');
    await expect(overlay.locator('.resume-text')).toHaveText('TAP POWER TO SWITCH OFF');
    await expect(powerSwitch(page)).toHaveAttribute('data-resume', 'off');

    await tap(page, overlay, browserName); // the prompt always retries
    await expect.poll(async () => (await resumeCalls(page)).length).toBe(2);
    expect(await powerState(page)).toBe('on');
    await expect(overlay.locator('.resume-text')).toHaveText('TAP POWER TO SWITCH OFF');

    await tap(page, powerSwitch(page), browserName); // now POWER switches off
    await expect.poll(() => powerState(page)).toBe('off');
    await expect(overlay).toBeHidden();
    expect((await resumeCalls(page)).length).toBe(2);
    await expect.poll(async () => (await readLcd(page)).every((p) => p === 0)).toBe(true);
  });
});
