import { expect, test, type Download, type Locator, type Page } from '@playwright/test';
import { FONT_SMALL } from '../../src/lcd/fonts';
import { expectLed, lcdShows, openApp, powerState, powerSwitch, pressControl, tap } from './app';
import { fakeMic } from './fakeMic';

const HARNESS = '/tests/e2e/pages/recorder.html';

const rec = (page: Page): Locator => page.locator('.rp-rec');
const clock = (page: Page): Locator => page.locator('.rp-clock');
const mix = (page: Page): Locator => page.locator('.rp-mix');
const takeRows = (page: Page): Locator => page.locator('.rp-take');

interface OpenOptions {
  /** Database name: the same name finds the same takes again after a reload. */
  db?: string;
  /** The pod's cacheBytes. */
  cache?: number;
  /** Replace saveFile with a stand-in the spec answers by hand (`__rec.saves`, `__rec.releaseSave`). */
  fakeSave?: boolean;
  /** No mixer behind LOOP MIX (`render: null`), as in the app until Task 9's renderMix exists (ruling R56). */
  noRender?: boolean;
}

async function open(page: Page, opts: OpenOptions | string = {}): Promise<void> {
  const o = typeof opts === 'string' ? { db: opts } : opts;
  const q = new URLSearchParams();
  if (o.db) q.set('db', o.db);
  if (o.cache !== undefined) q.set('cache', String(o.cache));
  if (o.fakeSave) q.set('save', 'fake');
  if (o.noRender) q.set('render', 'none');
  await page.goto(q.size ? `${HARNESS}?${q}` : HARNESS);
  await page.waitForFunction(() => document.documentElement.dataset.ready === '1');
}

/** REC, a little over `ms` of recording, REC again, and wait until the take is listed. */
async function recordTake(page: Page, ms = 1200): Promise<void> {
  const before = await takeRows(page).count();
  await rec(page).click();
  await expect(rec(page)).toHaveClass(/is-on/);
  await page.waitForTimeout(ms);
  await rec(page).click();
  await expect(takeRows(page)).toHaveCount(before + 1);
}

async function bytesOf(download: Download): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const c of await download.createReadStream()) chunks.push(c as Uint8Array);
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

function wavInfo(b: Uint8Array): { sr: number; bits: number; channels: number; seconds: number; dataBytes: number } {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const tag = (o: number) => String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);
  expect(tag(0)).toBe('RIFF');
  expect(tag(8)).toBe('WAVE');
  expect(tag(36)).toBe('data');
  const dataBytes = v.getUint32(40, true);
  expect(b.length).toBeGreaterThanOrEqual(44 + dataBytes);
  const sr = v.getUint32(24, true);
  return { sr, bits: v.getUint16(34, true), channels: v.getUint16(22, true), dataBytes, seconds: dataBytes / 6 / sr };
}

test.describe('recorder pod', () => {
  test.beforeEach(async ({ page }) => {
    await open(page);
  });

  test('REC lights red and the timer runs; a second click ends the take, listed as about 00:01', async ({ page }) => {
    await expect(clock(page)).toHaveText('00:00');
    await expect(rec(page)).not.toHaveClass(/is-on/);

    await rec(page).click();
    await expect(rec(page)).toHaveClass(/is-on/);
    await expect(rec(page)).toHaveAttribute('aria-pressed', 'true');
    // The LED is red while recording.
    const led = await rec(page).locator('.rp-led').evaluate((e) => getComputedStyle(e).backgroundColor);
    expect(led).toBe('rgb(226, 37, 45)');
    await expect(clock(page)).toHaveText('00:01'); // the timer follows the audio, not a stopwatch

    await rec(page).click();
    await expect(rec(page)).not.toHaveClass(/is-on/);
    await expect(clock(page)).toHaveText('00:00');
    await expect(takeRows(page)).toHaveCount(1);
    await expect(takeRows(page).first().locator('.rp-take-len')).toHaveText('00:01');
  });

  test('SAVE downloads the take as a 44.1 kHz 24-bit stereo WAV with the take file name', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'the download event is checked in Chromium; iPad Safari goes through the share sheet');
    await recordTake(page);
    const [download] = await Promise.all([page.waitForEvent('download'), takeRows(page).first().locator('.rp-save').click()]);
    expect(download.suggestedFilename()).toMatch(/^Sage MK1 take \d{4}-\d{2}-\d{2} \d{2}-\d{2}\.wav$/);
    const info = wavInfo(await bytesOf(download));
    expect(info).toMatchObject({ sr: 44100, bits: 24, channels: 2 });
    expect(info.seconds).toBeGreaterThan(1.1);
    expect(info.seconds).toBeLessThan(1.6);
    await expect(takeRows(page).first().locator('.rp-save')).toHaveText('SAVED');
  });

  test('Backquote, through the exported toggleRecord(), starts and ends a take', async ({ page }) => {
    await page.keyboard.press('Backquote');
    await expect(rec(page)).toHaveClass(/is-on/);
    await page.waitForTimeout(400);
    await page.keyboard.press('Backquote');
    await expect(rec(page)).not.toHaveClass(/is-on/);
    await expect(takeRows(page)).toHaveCount(1);
  });

  test('the buttons never take keyboard focus: Space, Enter and Tab do not press them', async ({ page }) => {
    await rec(page).click();
    await expect(rec(page)).toHaveClass(/is-on/);
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
    expect(await page.locator('.recorder-pod [tabindex], .recorder-pod button, .recorder-pod a').count()).toBe(0);
    await page.keyboard.press('Space');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    await page.waitForTimeout(150);
    await expect(rec(page)).toHaveClass(/is-on/); // still recording: no key pressed REC
    await rec(page).click();
    await expect(takeRows(page)).toHaveCount(1);
    // The keys did reach the page (where the panel's keyboard map lives).
    expect(await page.evaluate(() => window.__rec.keyPresses)).toEqual(['Space', 'Enter', 'Tab']);
  });

  test('play uses an object URL that is revoked when the take is stopped, replaced or deleted', async ({ page }) => {
    await recordTake(page, 600);
    await recordTake(page, 600);
    const rows = takeRows(page);
    const urls = () => page.evaluate(() => ({ ...window.__rec.urls }));

    await rows.nth(0).locator('.rp-play').click();
    await expect(rows.nth(0)).toHaveClass(/is-playing/);
    let u = await urls();
    expect(u.created).toHaveLength(1);
    expect(u.revoked).toEqual([]);

    await rows.nth(0).locator('.rp-play').click(); // ■ stops it
    await expect(rows.nth(0)).not.toHaveClass(/is-playing/);
    u = await urls();
    expect(u.revoked).toEqual(u.created);

    await rows.nth(0).locator('.rp-play').click();
    await rows.nth(1).locator('.rp-play').click(); // another take replaces it
    await expect(rows.nth(1)).toHaveClass(/is-playing/);
    u = await urls();
    expect(u.created).toHaveLength(3);
    expect(u.revoked).toHaveLength(2);

    await rows.nth(1).locator('.rp-del').click();
    await rows.nth(1).locator('.rp-del').click(); // deleting the take that is playing frees its URL too
    await expect(rows).toHaveCount(1);
    u = await urls();
    expect(u.revoked).toEqual(u.created);
  });

  test('DEL needs a second tap, and removes the take from the list and the store', async ({ page }) => {
    await recordTake(page, 500);
    const del = takeRows(page).first().locator('.rp-del');
    await expect(del).toHaveText('DEL');
    await del.click();
    await expect(del).toHaveText('SURE?');
    await expect(takeRows(page)).toHaveCount(1);
    await del.click();
    await expect(takeRows(page)).toHaveCount(0);
    await expect.poll(() => page.evaluate(async () => (await window.__rec.takes.list()).length)).toBe(0);
  });

  test('LOOP MIX shows PREPARING... while it renders, then SAVE MIX saves a 2 s mix at 44.1 kHz', async ({ page, browserName }) => {
    await page.evaluate(() => {
      window.__rec.engine.exportDelayMs = 500;
    });
    await expect(mix(page)).toHaveText('LOOP MIX');
    await mix(page).click();
    await expect(mix(page)).toHaveText('PREPARING…');
    await expect(mix(page)).toHaveText('SAVE MIX');
    await expect(page.locator('.rp-mix-discard')).toBeVisible();

    if (browserName === 'chromium') {
      const [download] = await Promise.all([page.waitForEvent('download'), mix(page).click()]);
      expect(download.suggestedFilename()).toMatch(/^Sage MK1 loop mix \d{4}-\d{2}-\d{2} \d{2}-\d{2}\.wav$/);
      const info = wavInfo(await bytesOf(download));
      expect(info).toMatchObject({ sr: 44100, bits: 24, channels: 2 });
      expect(info.seconds).toBeCloseTo(2, 3); // the 1 s and 2 s loops: one 2 s cycle
      await expect(mix(page)).toHaveText('LOOP MIX');
    }
  });

  test('LOOP MIX with nothing playing says so and stays LOOP MIX', async ({ page }) => {
    await page.evaluate(() => {
      window.__rec.engine.emit({
        t: 'status',
        status: { ...window.__rec.controller.status!, tracks: window.__rec.controller.status!.tracks.map((t) => ({ ...t, state: 'stopped' as const })) },
      });
    });
    await mix(page).click();
    await expect(page.locator('.rp-note')).toHaveText('NOTHING PLAYING');
    await expect(mix(page)).toHaveText('LOOP MIX');
  });

  test('takes survive a reload; an older take is prepared by one tap and saved by the next', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'checks the download event');
    const db = `recorder-e2e-reload-${Date.now()}`;
    await open(page, db);
    await recordTake(page, 600);
    await open(page, db);

    const row = takeRows(page).first();
    await expect(row).toHaveCount(1);
    await expect(row).toHaveClass(/is-cold/); // nothing cached yet after a reload
    await expect(row.locator('.rp-take-len')).toHaveText('00:00');
    await row.locator('.rp-save').click(); // first tap: prepare
    await expect(row).not.toHaveClass(/is-cold/);
    await expect(row.locator('.rp-save')).toHaveText('SAVE');
    const [download] = await Promise.all([page.waitForEvent('download'), row.locator('.rp-save').click()]); // second tap: save
    expect(wavInfo(await bytesOf(download)).sr).toBe(44100);
  });
});

// Each of these opens its own page: a small cache, or a save that does not answer until the spec says.
test.describe('recorder pod: memory and saving', () => {
  const save = (row: Locator): Locator => row.locator('.rp-save');
  const saves = (page: Page) => page.evaluate(() => window.__rec.saves.length);
  const release = (page: Page, result: 'saved' | 'cancelled' | 'failed') => page.evaluate((r) => window.__rec.releaseSave(r), result);

  test('with a small cache the oldest takes are evicted and prepared again by a tap', async ({ page }) => {
    // Each 0.8 s take is about 215 KB: two fit in 500 KB, three do not.
    await open(page, { cache: 500_000, fakeSave: true });
    await recordTake(page, 800);
    await recordTake(page, 800);
    const rows = takeRows(page);
    await expect(rows.nth(0)).not.toHaveClass(/is-cold/);
    await expect(rows.nth(1)).not.toHaveClass(/is-cold/);

    await recordTake(page, 800); // the third does not fit with the other two: the oldest goes
    await expect(rows.nth(0)).not.toHaveClass(/is-cold/);
    await expect(rows.nth(1)).not.toHaveClass(/is-cold/);
    await expect(rows.nth(2)).toHaveClass(/is-cold/);

    await save(rows.nth(2)).click(); // a tap on the cold one prepares it (and makes room by evicting the oldest other)
    await expect(rows.nth(2)).not.toHaveClass(/is-cold/);
    await expect(rows.nth(1)).toHaveClass(/is-cold/);
    await expect(rows.nth(0)).not.toHaveClass(/is-cold/);
    expect(await saves(page)).toBe(0); // preparing is not saving
  });

  test('a take over the cap is not prepared by itself; a tap prepares it, the save releases it again', async ({ page }) => {
    await open(page, { cache: 100_000, fakeSave: true }); // a 0.8 s take is about 215 KB
    await recordTake(page, 800);
    const row = takeRows(page).first();
    await page.waitForTimeout(400); // time enough for an automatic preparation, had there been one
    await expect(row).toHaveClass(/is-cold/);
    await expect(save(row)).toHaveText('SAVE');

    await save(row).click(); // first tap: prepare, held for this tap even though it is over the cap
    await expect(row).not.toHaveClass(/is-cold/);
    expect(await saves(page)).toBe(0);
    await save(row).click(); // second tap: save
    expect(await saves(page)).toBe(1);
    expect(await page.evaluate(() => window.__rec.saves[0]!.size)).toBeGreaterThan(100_000);
    await release(page, 'saved');
    await expect(save(row)).toHaveText('SAVED');
    await expect(row).toHaveClass(/is-cold/); // let go once saved
  });

  test('a take within the cap is prepared by itself, and let go after its save: saving it again takes two taps', async ({ page }) => {
    await open(page, { fakeSave: true });
    await recordTake(page, 500);
    const row = takeRows(page).first();
    await expect(row).not.toHaveClass(/is-cold/);

    await save(row).click();
    expect(await saves(page)).toBe(1);
    await release(page, 'saved');
    await expect(row).toHaveClass(/is-cold/);
    await expect(save(row)).toHaveText('SAVE'); // the SAVED note has gone

    await save(row).click(); // prepares again
    await expect(row).not.toHaveClass(/is-cold/);
    expect(await saves(page)).toBe(1);
    await save(row).click();
    expect(await saves(page)).toBe(2);
    await release(page, 'cancelled'); // dismissed: nothing was saved, the take stays ready
    await expect(row).not.toHaveClass(/is-cold/);
  });

  test('a double tap on SAVE starts one save, not two; once it has answered the button works again', async ({ page }) => {
    await open(page, { fakeSave: true });
    await recordTake(page, 500);
    const row = takeRows(page).first();
    await save(row).dblclick();
    expect(await saves(page)).toBe(1);
    await save(row).click(); // still in flight
    expect(await saves(page)).toBe(1);

    await release(page, 'cancelled');
    await expect(save(row)).not.toHaveClass(/is-saving/);
    await save(row).click();
    expect(await saves(page)).toBe(2);
    await release(page, 'cancelled');
  });

  test('a double tap on SAVE MIX starts one save, not two', async ({ page }) => {
    await open(page, { fakeSave: true });
    await mix(page).click();
    await expect(mix(page)).toHaveText('SAVE MIX');
    await mix(page).dblclick();
    expect(await saves(page)).toBe(1);
    await mix(page).click();
    expect(await saves(page)).toBe(1);

    await release(page, 'cancelled'); // dismissed: the mix is still there
    await expect(mix(page)).toHaveText('SAVE MIX');
    await expect(mix(page)).not.toHaveClass(/is-saving/);
    await mix(page).click();
    expect(await saves(page)).toBe(2);
    await release(page, 'saved');
    await expect(mix(page)).toHaveText('LOOP MIX');
  });

  test('an engine that stops mid-take ends it: REC goes dark, the clock is reset and the take is listed', async ({ page }) => {
    await open(page);
    await rec(page).click();
    await expect(rec(page)).toHaveClass(/is-on/);
    await page.waitForTimeout(600);
    await page.evaluate(() => window.__rec.recorder.halt()); // what the shell does when the host needs a resume
    await expect(rec(page)).not.toHaveClass(/is-on/);
    await expect(clock(page)).toHaveText('00:00');
    await expect(takeRows(page)).toHaveCount(1);
    await expect(page.locator('.rp-note')).toHaveText('AUDIO STOPPED: TAKE ENDED');
  });

  test('a worklet that goes silent is noticed by the watchdog without any tap', async ({ page }) => {
    await open(page);
    await rec(page).click();
    await expect(rec(page)).toHaveClass(/is-on/);
    await page.waitForTimeout(400);
    await page.evaluate(() => {
      window.__rec.engine.statuses = false; // statuses stop; (the sine blocks do too, once it is dead)
    });
    await expect(rec(page)).not.toHaveClass(/is-on/, { timeout: 5000 });
    await expect(takeRows(page)).toHaveCount(1);
    await expect(page.locator('.rp-note')).toHaveText('AUDIO STOPPED: TAKE ENDED');
  });
});

test.describe('recorder pod: LOOP MIX in the app (renderMix, Task 9)', () => {
  test('after recording a track, LOOP MIX prepares the mix and offers SAVE MIX', async ({ page, browserName }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    await page.addInitScript(fakeMic);
    await openApp(page);
    await tap(page, powerSwitch(page), browserName);
    await expect.poll(() => powerState(page), { timeout: 3000 }).toBe('on');
    await page.keyboard.press('Escape'); // past the CALIBRATE? offer
    await expect.poll(() => lcdShows(page, '120.0', FONT_SMALL)).toBe(true);

    await pressControl(page, 'trk1.rec', browserName);
    await expectLed(page, 'trk1.rec', 'red');
    await page.waitForTimeout(1000);
    await pressControl(page, 'trk1.rec', browserName);
    await expectLed(page, 'trk1.rec', 'green'); // playing

    // Every label LOOP MIX shows from here on.
    await page.evaluate(() => {
      const btn = document.querySelector('.rp-mix')!;
      const seen: string[] = [];
      (window as unknown as { __mixLabels: string[] }).__mixLabels = seen;
      new MutationObserver((records) => {
        for (const r of records) for (const n of r.addedNodes) seen.push(n.textContent ?? '');
      }).observe(btn, { childList: true });
    });
    await tap(page, mix(page), browserName);
    await expect(mix(page)).toHaveText('SAVE MIX', { timeout: 10000 });
    const labels = await page.evaluate(() => (window as unknown as { __mixLabels: string[] }).__mixLabels);
    expect(labels).toContain('PREPARING…');
    expect(labels.at(-1)).toBe('SAVE MIX');
    await expect(page.locator('.rp-note')).not.toHaveText('NOT READY');
    expect(errors).toEqual([]);
  });
});

test.describe('recorder pod: disabled while the unit is not on', () => {
  test('disabled: REC (click or Backquote) and LOOP MIX start nothing and show as disabled; enabled again, REC works', async ({ page }) => {
    await open(page);
    await page.evaluate(() => window.__rec.pod.setEnabled(false));
    await expect(page.locator('.recorder-pod')).toHaveClass(/is-disabled/);
    await expect(rec(page)).toHaveAttribute('aria-disabled', 'true');
    await expect(mix(page)).toHaveAttribute('aria-disabled', 'true');
    await rec(page).click({ force: true }); // a tap on the dimmed button
    await page.keyboard.press('Backquote');
    await mix(page).click({ force: true });
    await page.waitForTimeout(300);
    await expect(rec(page)).not.toHaveClass(/is-on/);
    await expect(mix(page)).toHaveText('LOOP MIX');
    expect(await page.evaluate(() => window.__rec.recorder.state)).toBe('idle');
    expect(await page.evaluate(() => window.__rec.engine.sent.filter((s) => s.cmd.t === 'recorder' || s.cmd.t === 'exportTracks').length)).toBe(0);
    await expect(takeRows(page)).toHaveCount(0);

    await page.evaluate(() => window.__rec.pod.setEnabled(true));
    await expect(page.locator('.recorder-pod')).not.toHaveClass(/is-disabled/);
    await expect(rec(page)).toHaveAttribute('aria-disabled', 'false');
    await recordTake(page, 400);
  });

  test('a take that is running can still be ended after the pod is disabled', async ({ page }) => {
    await open(page);
    await rec(page).click();
    await expect(rec(page)).toHaveClass(/is-on/);
    await page.waitForTimeout(400);
    await page.evaluate(() => window.__rec.pod.setEnabled(false));
    await expect(rec(page)).toHaveAttribute('aria-disabled', 'false'); // it can still end the take
    await rec(page).click();
    await expect(takeRows(page)).toHaveCount(1);
    await expect(rec(page)).toHaveAttribute('aria-disabled', 'true');
    await expect(rec(page)).not.toHaveClass(/is-on/);
  });
});
