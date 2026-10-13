import { expect } from 'vitest';
import type { Framebuffer } from '../../src/lcd/framebuffer';
import { LCD_H, LCD_W } from '../../src/shared/constants';
import { blank, footer } from './spec';

/** The top row of the label area: a two-line label starts here, a one-line label at 57. */
const LABEL_TOP = 49;

/** One knob's label drawn alone, where `footer` puts it (left edge, centred in its column, right edge). */
function alone(knob: number, lines: string[]): Framebuffer {
  const fb = blank();
  const all: (string[] | null)[] = [null, null, null, null];
  all[knob] = lines;
  footer(fb, all);
  return fb;
}

/** Columns of ink of `fb` in the label rows, as [first, last], or null when there is none. */
function extent(fb: Framebuffer): [number, number] | null {
  let lo = LCD_W, hi = -1;
  for (let y = LABEL_TOP; y < LCD_H; y++) {
    for (let x = 0; x < LCD_W; x++) {
      if (fb.get(x, y)) {
        lo = Math.min(lo, x);
        hi = Math.max(hi, x);
      }
    }
  }
  return hi < 0 ? null : [lo, hi];
}

/** True when some ink of `a` lies within one pixel (also diagonally) of ink of `b`: they overlap or touch. */
function touches(a: Framebuffer, b: Framebuffer): boolean {
  for (let y = LABEL_TOP; y < LCD_H; y++) {
    for (let x = 0; x < LCD_W; x++) {
      if (!a.get(x, y)) continue;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (b.get(x + dx, y + dy)) return true;
    }
  }
  return false;
}

/**
 * Checks the knob labels along the bottom of `screen` (rows 49-63), given the lines of each knob's label (null for none):
 *  - the screen draws exactly these labels there and nothing else;
 *  - each label stays inside its own knob column (32 px each);
 *  - no two labels overlap or touch (at least one clear pixel between them).
 */
export function expectLabelsApart(screen: Framebuffer, labels: readonly (string[] | null)[]): void {
  const singles = labels.map((lines, knob) => (lines ? alone(knob, lines) : null));

  const drawn = blank();
  for (const s of singles) {
    if (!s) continue;
    for (let y = LABEL_TOP; y < LCD_H; y++) for (let x = 0; x < LCD_W; x++) if (s.get(x, y)) drawn.set(x, y);
  }
  let wrong = 0;
  for (let y = LABEL_TOP; y < LCD_H; y++) for (let x = 0; x < LCD_W; x++) if (screen.get(x, y) !== drawn.get(x, y)) wrong++;
  expect(wrong, 'pixels of the label area that differ from the expected labels').toBe(0);

  singles.forEach((s, knob) => {
    const ext = s && extent(s);
    if (!ext) return;
    const name = labels[knob]!.join('/');
    expect(ext[0], `${name} starts left of its column`).toBeGreaterThanOrEqual(32 * knob);
    expect(ext[1], `${name} ends right of its column`).toBeLessThanOrEqual(32 * knob + 31);
  });

  for (let i = 0; i < singles.length; i++) {
    for (let j = i + 1; j < singles.length; j++) {
      const a = singles[i], b = singles[j];
      if (a && b) expect(touches(a, b), `${labels[i]!.join('/')} touches ${labels[j]!.join('/')}`).toBe(false);
    }
  }
}
