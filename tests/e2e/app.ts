/** Helpers for specs that drive the real app (index.html) through its dev-only `window.__sage` hook. */
import { expect, type Locator, type Page } from '@playwright/test';
import type { SageDebug } from '../../src/app';
import type { PowerState } from '../../src/app/unit';
import type { Font } from '../../src/lcd/fonts';
import type { ButtonId } from '../../src/shared/ids';
import { lcdHas } from '../lcd/text';

declare global {
  interface Window {
    __sage?: SageDebug;
  }
}

export const powerSwitch = (page: Page): Locator => page.locator('.power-switch');

/** Loads the app and waits for its hook. */
export async function openApp(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => window.__sage !== undefined);
}

/** A touch tap on the iPad (WebKit), a mouse click on the desktop. */
export async function tap(page: Page, target: Locator, browserName: string): Promise<void> {
  if (browserName === 'webkit') await target.tap();
  else await target.click();
}

/** Taps a panel control. */
export const pressControl = (page: Page, id: ButtonId, browserName: string): Promise<void> =>
  tap(page, page.locator(`[data-id="${id}"]`), browserName);

export const powerState = (page: Page): Promise<PowerState> => page.evaluate(() => window.__sage!.unit.state);

/** The LCD framebuffer the panel shows now. */
export const readLcd = (page: Page): Promise<number[]> => page.evaluate(() => Array.from(window.__sage!.lcd()));

export async function lcdShows(page: Page, s: string, font: Font): Promise<boolean> {
  return lcdHas(await readLcd(page), s, font);
}

/** The title of the top screen of the menu stack, or null when off. */
export const topScreen = (page: Page): Promise<string | null> => page.evaluate(() => window.__sage!.unit.menu?.top.title ?? null);
export const menuDepth = (page: Page): Promise<number> => page.evaluate(() => window.__sage!.unit.menu?.depth ?? 0);

/** The colour an LED shows ('red', 'green', ...), or 'off' (from its glow paint). */
export const ledColor = (page: Page, id: ButtonId): Promise<string> =>
  page.evaluate((id) => {
    const fill = document.querySelector(`[data-id="${id}"] .led-glow`)?.getAttribute('fill') ?? 'none';
    return fill === 'none' ? 'off' : (/glow-(\w+)/.exec(fill)?.[1] ?? fill);
  }, id);

/** Waits until the LED is lit in `color` (a blinking LED is caught in its lit half). */
export async function expectLed(page: Page, id: ButtonId, color: string, timeout = 4000): Promise<void> {
  await expect.poll(() => ledColor(page, id), { timeout, intervals: [20] }).toBe(color);
}
