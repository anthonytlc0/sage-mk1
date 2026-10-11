/** What the play screens, the MIXER and the TEMPO screen share: the status row, the knob labels, the title bar. */

import type { Controller } from '../../control/controller';
import type { ControlEvent } from '../../shared/ids';
import { fillRect, hline, text, textWidth } from '../draw';
import { FONT_SMALL } from '../fonts';
import { type Bitmap, type Framebuffer, parseBitmap } from '../framebuffer';
import { icon } from '../icons';
import { WrapCache } from '../wrap';

/** Detents a press-and-turn counts for (the controller sends raw detents; the screens ask `ctx.isHeld`). */
export const COARSE = 10;

/** Detents of a turn event, x10 while the knob is held (press-and-turn). */
export function turnSteps(e: Extract<ControlEvent, { kind: 'turn' }>, ctx: Controller): number {
  return ctx.isHeld(e.id) ? e.steps * COARSE : e.steps;
}

/** Passed where a draw call takes no options, so the default `{}` is not allocated on every frame. */
export const PLAIN = {} as const;

/** Passed to `icon()` so its default options object is not allocated on every frame. */
export const ICON_DRAW = { invert: false } as const;
export const ICON_ERASE = { invert: true } as const;

export const KNOBS = ['knob1', 'knob2', 'knob3', 'knob4'] as const;
export function knobIndex(id: string): number {
  return id === 'knob1' ? 0 : id === 'knob2' ? 1 : id === 'knob3' ? 2 : id === 'knob4' ? 3 : -1;
}

// ---- status row -----------------------------------------------------------------------------------------------------

const tempoCache = { bpm: Number.NaN, label: '' };

/** "=120.0": the tempo rounded to 0.1 (the engine may derive one with many decimals). */
export function tempoLabel(bpm: number): string {
  const r = Math.round(bpm * 10) / 10;
  if (r !== tempoCache.bpm) {
    tempoCache.bpm = r;
    tempoCache.label = `=${r.toFixed(1)}`;
  }
  return tempoCache.label;
}

/** Top right of a play screen: knob lock, phantom power (P1 / P2) and the tempo, right-aligned to x = 126. */
export function drawStatusRow(fb: Framebuffer, ctx: Controller, bpm: number, knobLock: boolean): void {
  const label = tempoLabel(bpm);
  let x = 127 - (6 + 1 + textWidth(label, FONT_SMALL));
  icon(fb, x, 0, 'note', ICON_DRAW);
  text(fb, x + 7, 1, label, FONT_SMALL, PLAIN);
  const phantom = ctx.session.system.input.phantom;
  if (phantom.MIC1 || phantom.MIC2) {
    x -= 2 + 23;
    icon(fb, x, 1, 'phantom', ICON_DRAW);
    // the artwork holds both boxes; an input that is off loses its own
    if (!phantom.MIC1) fillRect(fb, x, 1, 12, 7, 0);
    if (!phantom.MIC2) fillRect(fb, x + 12, 1, 11, 7, 0);
  }
  if (knobLock) {
    x -= 2 + 7;
    icon(fb, x, 0, 'lock', ICON_DRAW);
  }
}

// ---- knob labels ----------------------------------------------------------------------------------------------------

/** KNOB FUNC labels in at most two lines of 40 px along the bottom (the first and the last line of a longer one). */
export const KNOB_LABELS = new WrapCache(FONT_SMALL, 40, 2, false);

const LEFT = {} as const;
const CENTER = { align: 'center', width: 32 } as const;
const RIGHT = { align: 'right', width: 32 } as const;

/**
 * Draws knob `col`'s label lines, bottom-aligned: one line at y = 57, two at y = 49 and 57. Knob [1] sits at the left
 * edge, knob [4] at the right edge, [2] and [3] centred in their quarter. `lastOnly` draws just the bottom line.
 */
export function drawLabelLines(fb: Framebuffer, col: number, lines: readonly string[], lastOnly = false): void {
  const n = lines.length;
  for (let k = lastOnly ? n - 1 : 0; k < n; k++) {
    const y = 57 - 8 * (n - 1 - k);
    const s = lines[k]!;
    if (col === 0) text(fb, 1, y, s, FONT_SMALL, LEFT);
    else if (col === 3) text(fb, 95, y, s, FONT_SMALL, RIGHT);
    else text(fb, 32 * col, y, s, FONT_SMALL, CENTER);
  }
}

// ---- title bar and page arrows --------------------------------------------------------------------------------------

export const ARROW_LEFT: Bitmap = parseBitmap(`
  ..#
  .##
  ###
  .##
  ..#
`);
export const ARROW_RIGHT: Bitmap = parseBitmap(`
  #..
  ##.
  ###
  ##.
  #..
`);

/** Title at the top left with an underline across the screen. */
export function drawTitleBar(fb: Framebuffer, title: string): void {
  text(fb, 1, 0, title, FONT_SMALL, PLAIN);
  hline(fb, 0, 8, 128);
}

/** The page arrows at the top right: ◀ when there is an earlier page, ▶ when there is a later one. */
export function drawPageArrows(fb: Framebuffer, hasPrev: boolean, hasNext: boolean): void {
  if (hasPrev) fb.blit(ARROW_LEFT, 116, 2);
  if (hasNext) fb.blit(ARROW_RIGHT, 122, 2);
}
