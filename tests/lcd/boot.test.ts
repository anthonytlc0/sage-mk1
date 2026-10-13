import { describe, expect, it } from 'vitest';
import pkg from '../../package.json';
import { FONT_SMALL } from '../../src/lcd/fonts';
import { Framebuffer } from '../../src/lcd/framebuffer';
import { APP_VERSION, BOOT_MS, drawBootScreen } from '../../src/lcd/screens/boot';
import { LCD_H, LCD_W } from '../../src/shared/constants';
import { findText } from '../e2e/lcd';

describe('the LCD boot screen', () => {
  it('APP_VERSION is the package version', () => {
    expect(APP_VERSION).toBe(pkg.version);
  });

  it('shows for about 1.5 s', () => {
    expect(BOOT_MS).toBe(1500);
  });

  it('draws "Sage MK1" large and centred above the version', () => {
    const fb = new Framebuffer();
    drawBootScreen(fb);
    const at = findText(fb.data, `VER ${APP_VERSION}`, FONT_SMALL);
    expect(at).not.toBeNull();

    // The title: ink above the version line, at least 16 rows tall (twice the medium font), its cell centred (the ink can
    // sit a scaled pixel or so off, as glyphs have their own side bearings).
    let top = LCD_H, bottom = -1, left = LCD_W, right = -1;
    for (let y = 0; y < at!.y - 1; y++) {
      for (let x = 0; x < LCD_W; x++) {
        if (!fb.get(x, y)) continue;
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
        left = Math.min(left, x);
        right = Math.max(right, x);
      }
    }
    expect(bottom - top + 1).toBeGreaterThanOrEqual(16);
    expect(Math.abs(left - (LCD_W - 1 - right))).toBeLessThanOrEqual(3);
    expect(right - left + 1).toBeGreaterThan(80);
  });
});
