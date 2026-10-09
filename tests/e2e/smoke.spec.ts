import { expect, test } from '@playwright/test';

test('page loads with the Sage MK1 title', async ({ page }) => {
  await page.goto('/');
  expect(await page.evaluate(() => document.title)).toBe('Sage MK1');
});
