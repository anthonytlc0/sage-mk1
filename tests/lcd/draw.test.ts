import { describe, expect, it } from 'vitest';
import { Framebuffer } from '../../src/lcd/framebuffer';
import { FONT_LARGE, FONT_MEDIUM, FONT_SMALL, glyphOf } from '../../src/lcd/fonts';
import type { Font } from '../../src/lcd/fonts';
import { bar, fillRect, hline, rect, text, textWidth, vline } from '../../src/lcd/draw';
import { ICON_NAMES, icon, iconSize } from '../../src/lcd/icons';
import { LCD_H, LCD_W } from '../../src/shared/constants';
import { expectScreen, normalizeScreen } from './fixtures';

function count(fb: Framebuffer): number {
  let n = 0;
  for (const v of fb.data) n += v;
  return n;
}

/** Bounding box [x0, y0, x1, y1] of the dark pixels, or null for a blank screen. */
function bounds(fb: Framebuffer): [number, number, number, number] | null {
  let x0 = LCD_W, y0 = LCD_H, x1 = -1, y1 = -1;
  for (let y = 0; y < LCD_H; y++)
    for (let x = 0; x < LCD_W; x++)
      if (fb.get(x, y)) {
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      }
  return x1 < 0 ? null : [x0, y0, x1, y1];
}

describe('Framebuffer', () => {
  it('is 128x64 and its data is the PanelState.lcd layout (row-major bytes, 1 = dark)', () => {
    const fb = new Framebuffer();
    expect(fb.w).toBe(128);
    expect(fb.h).toBe(64);
    expect(fb.data).toBeInstanceOf(Uint8Array);
    expect(fb.data.length).toBe(128 * 64);
    fb.set(3, 2);
    expect(fb.data[2 * 128 + 3]).toBe(1);
    expect(count(fb)).toBe(1);
  });

  it('toAscii() has 64 lines of 128 characters, all # or .', () => {
    const fb = new Framebuffer();
    fb.set(0, 0);
    fb.set(127, 63);
    const lines = fb.toAscii().split('\n');
    expect(lines).toHaveLength(64);
    for (const l of lines) expect(l).toMatch(/^[.#]{128}$/);
    expect(lines[0][0]).toBe('#');
    expect(lines[63][127]).toBe('#');
    expect(lines[0][1]).toBe('.');
  });

  it('set/get honour the on flag and ignore out-of-range coordinates', () => {
    const fb = new Framebuffer();
    fb.set(5, 5);
    expect(fb.get(5, 5)).toBe(1);
    fb.set(5, 5, 0);
    expect(fb.get(5, 5)).toBe(0);
    for (const [x, y] of [[-1, 0], [0, -1], [128, 0], [0, 64], [-5, -5], [999, 999]]) {
      fb.set(x, y);
      expect(fb.get(x, y)).toBe(0);
    }
    expect(count(fb)).toBe(0);
  });

  it('clear() blanks the screen', () => {
    const fb = new Framebuffer();
    fillRect(fb, 0, 0, 128, 64);
    expect(count(fb)).toBe(8192);
    fb.clear();
    expect(count(fb)).toBe(0);
  });

  it('invert flips pixels in the rectangle only, and twice restores', () => {
    const fb = new Framebuffer();
    fb.set(1, 1);
    fb.set(2, 1);
    fb.invert(1, 1, 3, 2);
    expectScreen(fb, `
      .....
      ...#.
      .###.
    `);
    fb.invert(1, 1, 3, 2);
    expectScreen(fb, `
      .....
      .##..
    `);
  });

  it('invert clips to the screen', () => {
    const fb = new Framebuffer();
    fb.invert(-3, -3, 5, 5);
    expect(bounds(fb)).toEqual([0, 0, 1, 1]);
    fb.clear();
    fb.invert(126, 62, 10, 10);
    expect(bounds(fb)).toEqual([126, 62, 127, 63]);
  });
});

describe('expectScreen fixture', () => {
  it('pads short rows and missing rows with light pixels', () => {
    const rows = normalizeScreen(`
      #..
      .#
    `);
    expect(rows).toHaveLength(64);
    expect(rows[0]).toBe('#' + '.'.repeat(127));
    expect(rows[1]).toBe('.#' + '.'.repeat(126));
    expect(rows[2]).toBe('.'.repeat(128));
  });

  it('throws a row diff on mismatch', () => {
    const fb = new Framebuffer();
    fb.set(1, 0);
    expect(() => expectScreen(fb, '#.#')).toThrowError(/1 row\(s\)[\s\S]*row 00[\s\S]*expected[\s\S]*actual[\s\S]*\^/);
    expect(() => expectScreen(fb, '.#')).not.toThrow();
  });

  it('rejects malformed templates', () => {
    const fb = new Framebuffer();
    expect(() => expectScreen(fb, '.#x')).toThrowError(/other than/);
    expect(() => expectScreen(fb, '.'.repeat(129))).toThrowError(/129 wide/);
    expect(() => expectScreen(fb, Array(65).fill('.').join('\n'))).toThrowError(/65 rows/);
  });
});

describe('fonts', () => {
  it('FONT_SMALL is 5x7 and covers ASCII 32-126', () => {
    expect(FONT_SMALL.height).toBe(7);
    for (let c = 32; c <= 126; c++) {
      const g = glyphOf(FONT_SMALL, String.fromCharCode(c));
      expect(g, `glyph for ${JSON.stringify(String.fromCharCode(c))}`).toBeDefined();
      expect(g!.h).toBe(7);
      expect(g!.w).toBeGreaterThanOrEqual(1);
      expect(g!.w).toBeLessThanOrEqual(5);
    }
  });

  it('FONT_SMALL has no duplicate printable glyphs (guards copy-paste slips)', () => {
    const seen = new Map<string, string>();
    for (let c = 33; c <= 126; c++) {
      const ch = String.fromCharCode(c);
      const g = glyphOf(FONT_SMALL, ch)!;
      const key = `${g.w}x${g.h}:${Array.from(g.px).join('')}`;
      expect(seen.get(key), `${ch} duplicates ${seen.get(key)}`).toBeUndefined();
      seen.set(key, ch);
    }
  });

  it('FONT_MEDIUM is 7x11 and covers digits, A-Z, . : - / and space', () => {
    expect(FONT_MEDIUM.height).toBe(11);
    for (const ch of '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ.:-/ ') {
      const g = glyphOf(FONT_MEDIUM, ch);
      expect(g, `glyph for ${JSON.stringify(ch)}`).toBeDefined();
      expect(g!.h).toBe(11);
      expect(g!.w).toBeLessThanOrEqual(7);
    }
    for (const ch of '0123456789') expect(glyphOf(FONT_MEDIUM, ch)!.w).toBe(7);
  });

  it('FONT_MEDIUM has no duplicate glyphs', () => {
    const seen = new Map<string, string>();
    for (const ch of '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ.:-/') {
      const g = glyphOf(FONT_MEDIUM, ch)!;
      const key = `${g.w}x${g.h}:${Array.from(g.px).join('')}`;
      expect(seen.get(key), `${ch} duplicates ${seen.get(key)}`).toBeUndefined();
      seen.set(key, ch);
    }
  });

  it('FONT_LARGE is 14x24 digits plus space, all distinct', () => {
    expect(FONT_LARGE.height).toBe(24);
    const seen = new Set<string>();
    for (const ch of '0123456789') {
      const g = glyphOf(FONT_LARGE, ch);
      expect(g, `glyph for ${ch}`).toBeDefined();
      expect([g!.w, g!.h]).toEqual([14, 24]);
      const key = Array.from(g!.px).join('');
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
    expect(glyphOf(FONT_LARGE, ' ')).toBeDefined();
  });

  it('glyphOf has no case fallback: a character is drawn as itself or not at all', () => {
    // the medium font has lower case of its own (ruling R43), so a name shows as it was typed
    expect(glyphOf(FONT_MEDIUM, 'a')).toBeDefined();
    expect(glyphOf(FONT_MEDIUM, 'a')).not.toBe(glyphOf(FONT_MEDIUM, 'A'));
    expect(glyphOf(FONT_SMALL, 'a')).not.toBe(glyphOf(FONT_SMALL, 'A'));
    // a font without the character does not borrow its other case (the large font has digits only)
    expect(glyphOf(FONT_LARGE, 'x')).toBeUndefined();
    expect(glyphOf(FONT_LARGE, 'X')).toBeUndefined();
    expect(glyphOf(FONT_SMALL, 'é')).toBeUndefined();
    // and a font with capitals only draws no "a" for an "A"
    const capsOnly: Font = { name: 'caps', height: 7, gap: 1, glyphs: new Map([['A', glyphOf(FONT_SMALL, 'A')!]]) };
    expect(glyphOf(capsOnly, 'A')).toBeDefined();
    expect(glyphOf(capsOnly, 'a')).toBeUndefined();
  });
});

describe('text', () => {
  it("text(fb,0,0,'A',FONT_SMALL) sets exactly the glyph's pixels", () => {
    const fb = new Framebuffer();
    const adv = text(fb, 0, 0, 'A', FONT_SMALL);
    expect(adv).toBe(5);
    expectScreen(fb, `
      .###.
      #...#
      #...#
      #####
      #...#
      #...#
      #...#
    `);
  });

  it('draws at the given origin and advances proportionally', () => {
    const fb = new Framebuffer();
    const adv = text(fb, 10, 20, 'I.', FONT_SMALL);
    // 'I' is 3 wide, '.' is 1 wide, one pixel gap between glyphs.
    expect(adv).toBe(3 + 1 + 1);
    expect(textWidth('I.', FONT_SMALL)).toBe(5);
    expect(bounds(fb)).toEqual([10, 20, 10 + adv - 1, 26]);
  });

  it('returns 0 for empty text and draws nothing', () => {
    const fb = new Framebuffer();
    expect(text(fb, 5, 5, '', FONT_SMALL)).toBe(0);
    expect(count(fb)).toBe(0);
  });

  it('right-aligned text ends at x + width - 1', () => {
    const fb = new Framebuffer();
    text(fb, 10, 0, 'AB', FONT_SMALL, { align: 'right', width: 40 });
    const b = bounds(fb)!;
    expect(b[2]).toBe(10 + 40 - 1);
    expect(b[0]).toBe(10 + 40 - textWidth('AB', FONT_SMALL));
  });

  it('left-aligned text with a width starts at x', () => {
    const fb = new Framebuffer();
    text(fb, 10, 0, 'AB', FONT_SMALL, { align: 'left', width: 40 });
    expect(bounds(fb)![0]).toBe(10);
  });

  it('centres text in the width, rounding the spare space down', () => {
    const fb = new Framebuffer();
    const w = textWidth('AB', FONT_SMALL); // 11
    text(fb, 10, 0, 'AB', FONT_SMALL, { align: 'center', width: 32 });
    expect(bounds(fb)![0]).toBe(10 + Math.floor((32 - w) / 2));
    expect(bounds(fb)![2]).toBe(10 + Math.floor((32 - w) / 2) + w - 1);
  });

  it('align without a width is ignored (text starts at x)', () => {
    const fb = new Framebuffer();
    text(fb, 30, 0, 'A', FONT_SMALL, { align: 'right' });
    expect(bounds(fb)![0]).toBe(30);
  });

  it('invert draws a dark box with the glyph pixels cleared', () => {
    const fb = new Framebuffer();
    const adv = text(fb, 0, 0, 'A', FONT_SMALL, { invert: true });
    expect(adv).toBe(5);
    expectScreen(fb, `
      #...#
      .###.
      .###.
      .....
      .###.
      .###.
      .###.
    `);
  });

  it('invert with a width fills the whole box and the text sits inside it', () => {
    const fb = new Framebuffer();
    text(fb, 4, 2, 'A', FONT_SMALL, { invert: true, width: 15, align: 'center' });
    expect(bounds(fb)).toEqual([4, 2, 18, 8]);
    expect(fb.get(4, 2)).toBe(1);  // box corner, outside the glyph
    expect(fb.get(18, 8)).toBe(1);
    // 'A' is centred at x = 4 + floor((15 - 5) / 2) = 9; its top row '.###.' clears x = 10..12
    expect(fb.get(9, 2)).toBe(1);
    expect(fb.get(10, 2)).toBe(0);
    expect(fb.get(12, 2)).toBe(0);
    expect(fb.get(13, 2)).toBe(1);
  });

  it('the medium font draws lower case differently from upper case, and both 11 rows tall at most', () => {
    const a = new Framebuffer();
    const b = new Framebuffer();
    text(a, 0, 0, 'play', FONT_MEDIUM);
    text(b, 0, 0, 'PLAY', FONT_MEDIUM);
    expect(a.toAscii()).not.toBe(b.toAscii());
    expect(bounds(a)![3]).toBe(10); // 11 rows tall (the descenders of p and y end on the last row)
    expect(bounds(b)![3]).toBe(10);
  });

  it('the large font draws digits', () => {
    const c = new Framebuffer();
    const adv = text(c, 0, 0, '01', FONT_LARGE);
    expect(adv).toBe(14 + FONT_LARGE.gap + 14);
    expect(bounds(c)![3]).toBe(23);
  });

  it('unknown characters leave a blank the width of a space', () => {
    const fb = new Framebuffer();
    const sp = glyphOf(FONT_LARGE, ' ')!.w;
    const adv = text(fb, 0, 0, 'é', FONT_LARGE);
    expect(adv).toBe(sp);
    expect(count(fb)).toBe(0);
  });

  it('clips at the screen edges without throwing', () => {
    const fb = new Framebuffer();
    expect(() => text(fb, 125, 61, 'AAA', FONT_SMALL)).not.toThrow();
    expect(() => text(fb, -3, -3, 'AAA', FONT_SMALL)).not.toThrow();
    expect(bounds(fb)![2]).toBe(127);
    expect(bounds(fb)![3]).toBe(63);
  });
});

describe('primitives', () => {
  it('hline and vline draw one-pixel lines of the given length', () => {
    const fb = new Framebuffer();
    hline(fb, 2, 1, 4);
    vline(fb, 0, 0, 3);
    expectScreen(fb, `
      #.....
      #.####
      #.....
    `);
  });

  it('rect draws a one-pixel outline', () => {
    const fb = new Framebuffer();
    rect(fb, 1, 1, 4, 3);
    expectScreen(fb, `
      .....
      .####
      .#..#
      .####
    `);
  });

  it('rect handles degenerate sizes', () => {
    const fb = new Framebuffer();
    rect(fb, 0, 0, 1, 1);
    rect(fb, 5, 0, 3, 1);
    rect(fb, 0, 4, 0, 5);
    expectScreen(fb, `
      #....###
    `);
  });

  it('fillRect fills solidly, and on = 0 erases', () => {
    const fb = new Framebuffer();
    fillRect(fb, 1, 1, 3, 2);
    expectScreen(fb, `
      .....
      .###.
      .###.
    `);
    fillRect(fb, 2, 1, 1, 2, 0);
    expectScreen(fb, `
      .....
      .#.#.
      .#.#.
    `);
  });

  it('primitives clip to the screen', () => {
    const fb = new Framebuffer();
    fillRect(fb, 120, 60, 20, 20);
    expect(bounds(fb)).toEqual([120, 60, 127, 63]);
    hline(fb, -10, 0, 12);
    vline(fb, 0, -10, 12);
    expect(fb.get(0, 0)).toBe(1);
    expect(fb.get(1, 0)).toBe(1);
    expect(fb.get(2, 0)).toBe(0);
  });

  it('bar(..., 0.5) fills half the width, full height, from the left', () => {
    const fb = new Framebuffer();
    bar(fb, 10, 10, 40, 6, 0.5);
    expect(count(fb)).toBe(20 * 6);
    expect(bounds(fb)).toEqual([10, 10, 29, 15]);
  });

  it('bar clamps its fraction and rounds to whole pixels', () => {
    const at = (frac: number) => {
      const fb = new Framebuffer();
      bar(fb, 0, 0, 10, 2, frac);
      return count(fb) / 2;
    };
    expect(at(0)).toBe(0);
    expect(at(1)).toBe(10);
    expect(at(-1)).toBe(0);
    expect(at(2)).toBe(10);
    expect(at(Number.NaN)).toBe(0);
    expect(at(0.25)).toBe(3); // 2.5 rounds up
    expect(at(0.04)).toBe(0);
  });
});

describe('icons', () => {
  const names = ['trkPlay', 'trkStop', 'trkEmpty', 'current', 'phantom', 'lock', 'note'] as const;

  it('exposes exactly the seven icon names', () => {
    expect([...ICON_NAMES].sort()).toEqual([...names].sort());
  });

  it('each icon draws within its reported size and is not blank', () => {
    for (const name of names) {
      const fb = new Framebuffer();
      icon(fb, 30, 20, name);
      const { w, h } = iconSize(name);
      const b = bounds(fb);
      expect(b, name).not.toBeNull();
      expect(b![0], name).toBeGreaterThanOrEqual(30);
      expect(b![1], name).toBeGreaterThanOrEqual(20);
      expect(b![2], name).toBeLessThanOrEqual(30 + w - 1);
      expect(b![3], name).toBeLessThanOrEqual(20 + h - 1);
    }
  });

  it('the three track icons share a 20x20 footprint and differ from each other', () => {
    const shots = (['trkPlay', 'trkStop', 'trkEmpty'] as const).map((n) => {
      expect(iconSize(n)).toEqual({ w: 20, h: 20 });
      const fb = new Framebuffer();
      icon(fb, 0, 0, n);
      return fb.toAscii();
    });
    expect(new Set(shots).size).toBe(3);
  });

  it('trkStop is solid (stopped, phrase exists) and trkEmpty is hollow', () => {
    const stop = new Framebuffer();
    const empty = new Framebuffer();
    icon(stop, 0, 0, 'trkStop');
    icon(empty, 0, 0, 'trkEmpty');
    expect(stop.get(10, 10)).toBe(1);
    expect(empty.get(10, 10)).toBe(0);
    expect(count(stop)).toBeGreaterThan(count(empty));
  });

  it('invert option erases the icon shape instead of drawing it', () => {
    const fb = new Framebuffer();
    icon(fb, 0, 0, 'trkStop');
    const before = count(fb);
    icon(fb, 7, 7, 'current', { invert: true });
    expect(count(fb)).toBeLessThan(before);
    expect(fb.get(9, 9)).toBe(0); // centre of the track icon is now a light dot
    expect(fb.get(2, 10)).toBe(1);
  });

  it('clips at the screen edges without throwing', () => {
    const fb = new Framebuffer();
    expect(() => icon(fb, 120, 60, 'trkPlay')).not.toThrow();
    expect(() => icon(fb, -10, -10, 'phantom')).not.toThrow();
  });
});
