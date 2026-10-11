/**
 * The expected art of the screens, composed with the LCD primitives at fixed coordinates read off the Owner's Manual
 * illustrations (pp. 8 and 11) at 128x64. This is deliberately written out in numbers here and does not import any
 * layout constant from the screens, so a layout change has to be made in both places.
 */
import { fillRect, hline, rect, text, textWidth, vline } from '../../src/lcd/draw';
import { FONT_LARGE, FONT_MEDIUM, FONT_SMALL, glyphOf } from '../../src/lcd/fonts';
import { Framebuffer, parseBitmap } from '../../src/lcd/framebuffer';
import { icon } from '../../src/lcd/icons';

export const blank = (): Framebuffer => new Framebuffer();

/** Top-right status row: lock, phantom (P1 / P2) and the tempo, right-aligned to x = 126. */
export function statusRow(fb: Framebuffer, o: { tempo?: string; lock?: boolean; p1?: boolean; p2?: boolean } = {}): void {
  const tempo = `=${o.tempo ?? '120.0'}`;
  let x = 127 - (6 + 1 + textWidth(tempo, FONT_SMALL));
  icon(fb, x, 0, 'note');
  text(fb, x + 7, 1, tempo, FONT_SMALL);
  if (o.p1 || o.p2) {
    x -= 2 + 23;
    icon(fb, x, 1, 'phantom');
    if (!o.p1) fillRect(fb, x, 1, 12, 7, 0);
    if (!o.p2) fillRect(fb, x + 12, 1, 11, 7, 0);
  }
  if (o.lock) {
    x -= 2 + 7;
    icon(fb, x, 0, 'lock');
  }
}

/** Knob labels along the bottom: one line sits at y = 57, two lines at y = 49 and 57. */
export function footer(fb: Framebuffer, labels: (string[] | null)[]): void {
  labels.forEach((lines, i) => {
    if (!lines) return;
    lines.forEach((s, k) => {
      const y = 57 - 8 * (lines.length - 1 - k);
      if (i === 0) text(fb, 1, y, s, FONT_SMALL);
      else if (i === 3) text(fb, 95, y, s, FONT_SMALL, { align: 'right', width: 32 });
      else text(fb, 32 * i, y, s, FONT_SMALL, { align: 'center', width: 32 });
    });
  });
}
/** The default KNOB FUNC labels: MEMORY, OFF, OFF, MFX REVERB. */
export const DEFAULT_FOOTER: (string[] | null)[] = [['MEMORY'], null, null, ['MFX', 'REVERB']];

/** "[01] NAME" under the status row, as on every play screen but the first. */
export function header(fb: Framebuffer, num: string, name: string): void {
  text(fb, 1, 10, num, FONT_MEDIUM, { invert: true, width: 17, align: 'center' });
  text(fb, 20, 10, name, FONT_MEDIUM);
}

/** A glyph row drawn at 2x for the big LOOP STATUS words. */
export function scaled(fb: Framebuffer, x: number, y: number, s: string): number {
  let px = x;
  for (const ch of s) {
    const g = glyphOf(FONT_MEDIUM, ch)!;
    for (let j = 0; j < g.h; j++) for (let i = 0; i < g.w; i++) if (g.px[j * g.w + i]) fillRect(fb, px + 2 * i, y + 2 * j, 2, 2);
    px += (g.w + 1) * 2;
  }
  return px - x - 2;
}
export const scaledWidth = (s: string): number => textWidth(s, FONT_MEDIUM) * 2;

const PILL_OFF = parseBitmap(`
  ..#############..
  .#.............#.
  #...............#
  .#.............#.
  ..#############..
`);
const PILL_ON = parseBitmap(`
  ..#############..
  .###############.
  #################
  .###############.
  ..#############..
`);
export const rhythmPill = (fb: Framebuffer, on: boolean): void => fb.blit(on ? PILL_ON : PILL_OFF, 107, 36);

export const bigNumber = (fb: Framebuffer, s: string): void => {
  text(fb, Math.floor((128 - textWidth(s, FONT_LARGE)) / 2), 10, s, FONT_LARGE);
};

// ---- paramPage / MIXER pieces ---------------------------------------------------------------------------------------

export const ARROW_L = parseBitmap(`
  ..#
  .##
  ###
  .##
  ..#
`);
export const ARROW_R = parseBitmap(`
  #..
  ##.
  ###
  ##.
  #..
`);

/** The MIXER column geometry: fader, meter and the scale bracket, then labels. `lit` = lit meter segments (0-9). */
export function mixerColumn(
  fb: Framebuffer, x0: number, pitch: number,
  c: { value: string; level: number; lit: number; hold?: number; muted?: boolean; labels: [string, string] },
): void {
  text(fb, x0 + 1, 11, c.value, FONT_SMALL);
  hline(fb, x0 + 27, 18, 4);
  vline(fb, x0 + 30, 18, 28);
  for (const y of [21, 27, 33, 39]) fb.set(x0 + 29, y);
  vline(fb, x0 + 4, 19, 27);
  const yc = 43 - Math.round((c.level / 200) * 22);
  rect(fb, x0, yc - 2, 9, 5);
  fillRect(fb, x0 + 1, yc - 1, 7, 3, 0);
  for (let k = 0; k < c.lit; k++) fillRect(fb, x0 + 12, 44 - 3 * k, 11, 2);
  if ((c.hold ?? 0) > 0) hline(fb, x0 + 12, 45 - 3 * c.hold!, 11);
  if (c.muted) {
    fillRect(fb, x0 + 3, 39, 26, 9);
    text(fb, x0 + 3, 40, 'MUTE', FONT_SMALL, { invert: true, width: 26, align: 'center' });
  }
  text(fb, x0, 49, c.labels[0], FONT_SMALL, { align: 'center', width: pitch });
  text(fb, x0, 57, c.labels[1], FONT_SMALL, { align: 'center', width: pitch });
}

/** MIXER title row with the page arrows (`left` / `right`: which neighbours exist). */
export function mixerTitle(fb: Framebuffer, left: boolean, right: boolean): void {
  text(fb, 1, 0, 'MIXER', FONT_SMALL);
  hline(fb, 0, 8, 128);
  if (left) fb.blit(ARROW_L, 116, 2);
  if (right) fb.blit(ARROW_R, 122, 2);
}

/** A 20x20 pie of progress `p` (0.25 / 0.5 / 0.75 only, so no pixel sits on a boundary) over the solid track icon. */
export function pieCleared(i: number, j: number, p: number): boolean {
  // the pie starts at 6 o'clock and sweeps clockwise on screen (toward the left)
  const dx = i + 0.5 - 10, dy = j + 0.5 - 10;
  const turn = (((Math.atan2(-dx, dy) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) / (2 * Math.PI);
  return turn >= p;
}
