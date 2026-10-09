import { describe, expect, it } from 'vitest';
import { DEFAULT_PALETTE, drawToCanvas, lcdColors, type LcdContext, type LcdPalette } from '../../src/lcd/canvas';
import { Framebuffer } from '../../src/lcd/framebuffer';

interface Fill { style: string; x: number; y: number; w: number; h: number }

/** A recording stand-in for CanvasRenderingContext2D: logs each fillRect with the fillStyle in force. */
function fakeContext(): { ctx: LcdContext; fills: Fill[] } {
  const fills: Fill[] = [];
  const ctx = {
    fillStyle: '' as string | CanvasGradient | CanvasPattern,
    fillRect(x: number, y: number, w: number, h: number) {
      fills.push({ style: String(this.fillStyle), x, y, w, h });
    },
  };
  return { ctx, fills };
}

const luma = (hex: string): number => {
  const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.299 * v[0] + 0.587 * v[1] + 0.114 * v[2];
};

describe('lcdColors', () => {
  it('returns the palette untouched at the default contrast 5', () => {
    expect(lcdColors(5)).toEqual(DEFAULT_PALETTE);
    expect(lcdColors(5, { backlight: 'red', pixelOn: 'black', pixelOff: 'white' })).toEqual({
      backlight: 'red', pixelOn: 'black', pixelOff: 'white',
    });
  });

  it('low contrast washes the dark pixels out; high contrast darkens the glass', () => {
    const lo = lcdColors(1);
    const mid = lcdColors(5);
    const hi = lcdColors(10);
    expect(luma(lo.pixelOn)).toBeGreaterThan(luma(mid.pixelOn));
    expect(luma(hi.pixelOff)).toBeLessThan(luma(mid.pixelOff));
    expect(luma(hi.backlight)).toBeLessThan(luma(mid.backlight));
    expect(luma(lo.pixelOff)).toBeGreaterThan(luma(mid.pixelOff));
    expect(luma(hi.pixelOn)).toBeLessThanOrEqual(luma(mid.pixelOn));
  });

  it('is monotonic across 1..10 and the dark pixels always stay darker than the glass', () => {
    let prevOn = Infinity;
    for (let c = 1; c <= 5; c++) {
      const p = lcdColors(c);
      expect(luma(p.pixelOn)).toBeLessThanOrEqual(prevOn);
      prevOn = luma(p.pixelOn);
    }
    for (let c = 1; c <= 10; c++) {
      const p = lcdColors(c);
      expect(luma(p.pixelOn)).toBeLessThan(luma(p.pixelOff) - 40);
    }
  });

  it('clamps out-of-range contrast and treats NaN as 5', () => {
    expect(lcdColors(0)).toEqual(lcdColors(1));
    expect(lcdColors(99)).toEqual(lcdColors(10));
    expect(lcdColors(Number.NaN)).toEqual(lcdColors(5));
  });

  it('leaves non-hex palettes alone and accepts #rgb shorthand', () => {
    const named: LcdPalette = { backlight: 'silver', pixelOn: 'black', pixelOff: 'white' };
    expect(lcdColors(1, named)).toEqual(named);
    const short = lcdColors(1, { backlight: '#ccc', pixelOn: '#000', pixelOff: '#fff' });
    expect(short.pixelOn).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('drawToCanvas', () => {
  it('paints the glass, then one rect per dark pixel (scale 2: no grid)', () => {
    const fb = new Framebuffer();
    fb.set(0, 0);
    fb.set(127, 63);
    const { ctx, fills } = fakeContext();
    drawToCanvas(fb, ctx, 2, 5, DEFAULT_PALETTE);
    expect(fills[0]).toEqual({ style: DEFAULT_PALETTE.pixelOff, x: 0, y: 0, w: 256, h: 128 });
    const dark = fills.filter((f) => f.style === DEFAULT_PALETTE.pixelOn);
    expect(dark).toEqual([
      { style: DEFAULT_PALETTE.pixelOn, x: 0, y: 0, w: 2, h: 2 },
      { style: DEFAULT_PALETTE.pixelOn, x: 254, y: 126, w: 2, h: 2 },
    ]);
    expect(fills.some((f) => f.style === DEFAULT_PALETTE.backlight)).toBe(false);
  });

  it('from scale 3 up draws a one-pixel backlight gap between pixels', () => {
    const fb = new Framebuffer();
    fb.set(2, 1);
    const { ctx, fills } = fakeContext();
    drawToCanvas(fb, ctx, 4, 5, DEFAULT_PALETTE);
    const grid = fills.filter((f) => f.style === DEFAULT_PALETTE.backlight);
    expect(grid).toHaveLength(128 + 64);
    expect(grid.filter((f) => f.h === 64 * 4)).toHaveLength(128); // vertical lines
    expect(grid.every((f) => f.w === 1 || f.h === 1)).toBe(true);
    const dark = fills.filter((f) => f.style === DEFAULT_PALETTE.pixelOn);
    expect(dark).toEqual([{ style: DEFAULT_PALETTE.pixelOn, x: 8, y: 4, w: 3, h: 3 }]);
  });

  it('a blank screen costs only the glass and the grid', () => {
    const { ctx, fills } = fakeContext();
    drawToCanvas(new Framebuffer(), ctx, 3, 5, DEFAULT_PALETTE);
    expect(fills).toHaveLength(1 + 128 + 64);
  });

  it('applies contrast to the colours it paints with', () => {
    const fb = new Framebuffer();
    fb.set(0, 0);
    const { ctx, fills } = fakeContext();
    drawToCanvas(fb, ctx, 3, 1, DEFAULT_PALETTE);
    expect(fills[0].style).toBe(lcdColors(1).pixelOff);
    expect(fills[fills.length - 1].style).toBe(lcdColors(1).pixelOn);
  });

  it('defaults to contrast 5 and the default palette', () => {
    const { ctx, fills } = fakeContext();
    drawToCanvas(new Framebuffer(), ctx, 2);
    expect(fills[0].style).toBe(DEFAULT_PALETTE.pixelOff);
  });
});
