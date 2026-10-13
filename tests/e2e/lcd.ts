/**
 * Reading text off the LCD: the 128x64 framebuffer (1 = dark pixel) is searched for `s` drawn in `font` with the app's own
 * glyphs, every pixel of the text's cell compared (ink and the clear pixels between). Pure: Playwright specs pass the
 * framebuffer they read from the page, unit tests a Framebuffer's data.
 */
import { text, textWidth } from '../../src/lcd/draw';
import type { Font } from '../../src/lcd/fonts';
import { Framebuffer } from '../../src/lcd/framebuffer';
import { LCD_H, LCD_W } from '../../src/shared/constants';

/** Where `s` (in `font`, inverse video with `invert`) is on the LCD: the top-left of its cell, or null. */
export function findText(lcd: ArrayLike<number>, s: string, font: Font, invert = false): { x: number; y: number } | null {
  const w = textWidth(s, font);
  const h = font.height;
  const probe = new Framebuffer();
  text(probe, 0, 0, s, font);
  const want = invert ? 0 : 1;
  for (let y = 0; y + h <= LCD_H; y++) {
    for (let x = 0; x + w <= LCD_W; x++) {
      let ok = true;
      for (let j = 0; j < h && ok; j++) {
        for (let i = 0; i < w; i++) {
          const ink = probe.get(i, j) === 1;
          if ((lcd[(y + j) * LCD_W + x + i] === want) !== ink) {
            ok = false;
            break;
          }
        }
      }
      if (ok) return { x, y };
    }
  }
  return null;
}

/** True when `s` is on the LCD (see `findText`). */
export const lcdHas = (lcd: ArrayLike<number>, s: string, font: Font, invert = false): boolean => findText(lcd, s, font, invert) !== null;
