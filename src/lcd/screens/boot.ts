/**
 * The LCD boot screen (power-on): "Sage MK1" in large letters and the version under it. The app shell shows it from
 * the POWER tap until the unit is ready, and for at least BOOT_MS, then the play screen (or a power-on prompt) appears.
 */

import { fillRect, text, textWidth } from '../draw';
import { FONT_MEDIUM, FONT_SMALL, glyphOf } from '../fonts';
import type { Framebuffer } from '../framebuffer';

/** The app's version (package.json; a test keeps the two equal). */
export const APP_VERSION = '0.1.0';
/** How long the boot screen stays up at least. */
export const BOOT_MS = 1500;

const TITLE = 'Sage MK1';
const VERSION_OPTS = { align: 'center', width: 128 } as const;

/** Draws `s` in FONT_MEDIUM at `scale` times its size (each pixel a scale x scale block). */
function drawScaled(fb: Framebuffer, x: number, y: number, s: string, scale: number): void {
  let px = x;
  for (const ch of s) {
    const g = glyphOf(FONT_MEDIUM, ch) ?? glyphOf(FONT_MEDIUM, ' ')!;
    for (let j = 0; j < g.h; j++) {
      for (let i = 0; i < g.w; i++) if (g.px[j * g.w + i]) fillRect(fb, px + scale * i, y + scale * j, scale, scale);
    }
    px += (g.w + FONT_MEDIUM.gap) * scale;
  }
}

/** Draws the boot screen into `fb` (which should be clear). */
export function drawBootScreen(fb: Framebuffer): void {
  const w1 = textWidth(TITLE, FONT_MEDIUM);
  const scale = w1 * 2 <= 124 ? 2 : 1;
  const w = w1 * scale;
  drawScaled(fb, Math.floor((128 - w) / 2), 12, TITLE, scale);
  text(fb, 0, 44, `VER ${APP_VERSION}`, FONT_SMALL, VERSION_OPTS);
}
