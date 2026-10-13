import { expect, test, type Download, type Locator, type Page } from '@playwright/test';

const HARNESS = '/tests/e2e/pages/recorder.html';

const rec = (page: Page): Locator => page.locator('.rp-rec');
const clock = (page: Page): Locator => page.locator('.rp-clock');
const mix = (page: Page): Locator => page.locator('.rp-mix');
const takeRows = (page: Page): Locator => page.locator('.rp-take');

async function open(page: Page, db?: string): Promise<void> {
  await page.goto(db ? `${HARNESS}?db=${db}` : HARNESS);
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
