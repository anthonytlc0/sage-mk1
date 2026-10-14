/**
 * Playwright global setup: warms the dev server once before any test runs. A cold Vite transforms the app's module
 * graph, and builds the AudioWorklet bundle, on first request; a dependency it discovers then makes it reload every
 * open page (an "Execution context was destroyed" in whichever tests happen to be first). One page loads the app and
 * powers it on (the fake mic, so no prompt), which requests everything the tests will.
 * Runs after `webServer` has started (or found) the server.
 */
import { chromium, type FullConfig } from '@playwright/test';
import { fakeMic } from './fakeMic';

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL) return;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.addInitScript(fakeMic);
    await page.goto(baseURL);
    await page.waitForFunction(() => window.__sage !== undefined, null, { timeout: 60_000 });
    await page.locator('.power-switch').click(); // the engine: its AudioWorklet module
    await page.waitForFunction(() => window.__sage?.unit.state === 'on', null, { timeout: 60_000 });
  } finally {
    await browser.close();
  }
}
