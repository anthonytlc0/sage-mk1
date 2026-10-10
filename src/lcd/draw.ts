import type { Framebuffer } from './framebuffer';
import { type Font, glyphOf } from './fonts';
import { LCD_H, LCD_W } from '../shared/constants';

export interface TextOpts {
  /** Inverse video: a dark box behind the text with the glyph pixels cleared. */
  invert?: boolean;
  /** Where the text sits inside `width`. Has no effect unless `width` is given. */
  align?: 'left' | 'center' | 'right';
  /** Width of the box the text is aligned in (and the width of the inverse-video box). */
  width?: number;
}

/** Advance of one character: its glyph width, or the width of a space when the font has no glyph for it. */
function advanceOf(font: Font, ch: string): number {
  return (glyphOf(font, ch) ?? glyphOf(font, ' '))?.w ?? font.gap + 1;
}

/** Pixel width of `s` set in `font`: glyph widths plus the gap between neighbours, no trailing gap. */
export function textWidth(s: string, font: Font): number {
  let w = 0;
  let n = 0;
  for (const ch of s) {
    w += advanceOf(font, ch);
    n++;
  }
  return n === 0 ? 0 : w + font.gap * (n - 1);
}

/**
 * Draws `s` with the top-left of its cell at (x, y) and returns the advance width (see textWidth).
 * Characters the font does not cover leave a blank the width of a space. With `opts.width`, the text is aligned
 * inside [x, x + width): right-aligned text ends exactly at x + width - 1.
 */
export function text(fb: Framebuffer, x: number, y: number, s: string, font: Font, opts: TextOpts = {}): number {
  const tw = textWidth(s, font);
  const { width, align = 'left', invert = false } = opts;

  let px = x;
  if (width !== undefined) {
    if (align === 'center') px = x + Math.floor((width - tw) / 2);
    else if (align === 'right') px = x + width - tw;
  }

  if (invert) fillRect(fb, x, y, width ?? tw, font.height);
  const on = invert ? 0 : 1;
  for (const ch of s) {
    const g = glyphOf(font, ch);
    if (g) fb.blit(g, px, y, on);
    px += advanceOf(font, ch) + font.gap;
  }
  return tw;
}

/** Horizontal line of `len` pixels starting at (x, y). `on = 0` erases. */
export function hline(fb: Framebuffer, x: number, y: number, len: number, on = 1): void {
  fillRect(fb, x, y, len, 1, on);
}

/** Vertical line of `len` pixels starting at (x, y). `on = 0` erases. */
export function vline(fb: Framebuffer, x: number, y: number, len: number, on = 1): void {
  fillRect(fb, x, y, 1, len, on);
}

/** One-pixel outline of the w x h rectangle whose top-left is (x, y). */
export function rect(fb: Framebuffer, x: number, y: number, w: number, h: number, on = 1): void {
  if (w <= 0 || h <= 0) return;
  hline(fb, x, y, w, on);
  hline(fb, x, y + h - 1, w, on);
  vline(fb, x, y + 1, h - 2, on);
  vline(fb, x + w - 1, y + 1, h - 2, on);
}

/** Solid w x h rectangle (clipped to the screen). `on = 0` erases. */
export function fillRect(fb: Framebuffer, x: number, y: number, w: number, h: number, on = 1): void {
  const x0 = Math.max(x, 0), x1 = Math.min(x + w, LCD_W);
  const y0 = Math.max(y, 0), y1 = Math.min(y + h, LCD_H);
  if (x1 <= x0) return;
  const v = on ? 1 : 0;
  for (let yy = y0; yy < y1; yy++) fb.data.fill(v, yy * LCD_W + x0, yy * LCD_W + x1);
}

/**
 * Horizontal meter: fills round(w * frac) columns from the left edge, full height h, with no frame of its own
 * (draw a `rect` around it if you want one). `frac` is clamped to 0..1 and NaN counts as 0.
 */
export function bar(fb: Framebuffer, x: number, y: number, w: number, h: number, frac: number): void {
  const f = Number.isNaN(frac) ? 0 : Math.min(1, Math.max(0, frac));
  fillRect(fb, x, y, Math.round(w * f), h);
}
