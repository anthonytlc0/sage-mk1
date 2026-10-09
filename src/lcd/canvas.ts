import type { Framebuffer } from './framebuffer';

/** The only parts of a 2D canvas context that drawToCanvas touches (so a recording fake works in tests). */
export type LcdContext = Pick<CanvasRenderingContext2D, 'fillStyle' | 'fillRect'>;

/**
 * LCD tones as `#rgb` / `#rrggbb` colours.
 *  - `backlight`: the glow showing between pixels (the grid lines at scale 3 and up);
 *  - `pixelOff`: a light pixel cell;
 *  - `pixelOn`: a dark pixel.
 * Contrast adjusts these by blending, which needs hex colours; anything else is drawn unchanged.
 */
export interface LcdPalette {
  backlight: string;
  pixelOn: string;
  pixelOff: string;
}

/** Cool white-grey backlit glass with near-black pixels. Drawn exactly as written at contrast 5. */
export const DEFAULT_PALETTE: LcdPalette = {
  backlight: '#b9c4cb',
  pixelOff: '#dfe7eb',
  pixelOn: '#10161a',
};

export const CONTRAST_MIN = 1;
export const CONTRAST_MAX = 10;
export const CONTRAST_DEFAULT = 5;

type Rgb = [number, number, number];

function parseHex(color: string): Rgb | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function toHex(c: Rgb): string {
  return '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
}

/** Linear blend: t = 0 gives `a`, t = 1 gives `b`. */
function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/**
 * The palette as seen at a given contrast (1..10, clamped; NaN counts as the default 5). Contrast 5 returns the
 * palette untouched. Below it the dark pixels wash out toward the light cell and the glass brightens a little;
 * above it the glass darkens toward the pixel colour, as an over-driven LCD does, while the pixels stay full strength.
 */
export function lcdColors(contrast: number, palette: LcdPalette = DEFAULT_PALETTE): LcdPalette {
  const c = Number.isNaN(contrast) ? CONTRAST_DEFAULT : Math.min(CONTRAST_MAX, Math.max(CONTRAST_MIN, contrast));
  if (c === CONTRAST_DEFAULT) return { ...palette };
  const on = parseHex(palette.pixelOn);
  const off = parseHex(palette.pixelOff);
  const back = parseHex(palette.backlight);
  if (!on || !off || !back) return { ...palette };

  if (c < CONTRAST_DEFAULT) {
    const t = (CONTRAST_DEFAULT - c) / (CONTRAST_DEFAULT - CONTRAST_MIN); // 0..1
    const white: Rgb = [255, 255, 255];
    return {
      pixelOn: toHex(mix(on, off, 0.65 * t)),
      pixelOff: toHex(mix(off, white, 0.2 * t)),
      backlight: toHex(mix(back, white, 0.2 * t)),
    };
  }
  const t = (c - CONTRAST_DEFAULT) / (CONTRAST_MAX - CONTRAST_DEFAULT); // 0..1
  return {
    pixelOn: palette.pixelOn,
    pixelOff: toHex(mix(off, on, 0.3 * t)),
    backlight: toHex(mix(back, on, 0.3 * t)),
  };
}

/**
 * Paints the framebuffer onto a canvas at an integer `scale` (device pixels per LCD pixel), top-left at (0, 0);
 * the canvas should be 128*scale by 64*scale. From scale 3 up, a one-pixel gap of backlight separates the pixels
 * for a subtle grid look. Cost per frame: two fills for the glass and grid, plus one fill per dark pixel.
 */
export function drawToCanvas(
  fb: Framebuffer,
  ctx: LcdContext,
  scale: number,
  contrast: number = CONTRAST_DEFAULT,
  palette: LcdPalette = DEFAULT_PALETTE,
): void {
  const s = Math.max(1, Math.floor(scale));
  const colors = lcdColors(contrast, palette);
  const gap = s >= 3 ? 1 : 0;
  const cell = s - gap;

  ctx.fillStyle = colors.pixelOff;
  ctx.fillRect(0, 0, fb.w * s, fb.h * s);

  if (gap > 0) {
    ctx.fillStyle = colors.backlight;
    for (let x = 1; x <= fb.w; x++) ctx.fillRect(x * s - gap, 0, gap, fb.h * s);
    for (let y = 1; y <= fb.h; y++) ctx.fillRect(0, y * s - gap, fb.w * s, gap);
  }

  ctx.fillStyle = colors.pixelOn;
  for (let y = 0; y < fb.h; y++) {
    for (let x = 0; x < fb.w; x++) {
      if (fb.data[y * fb.w + x]) ctx.fillRect(x * s, y * s, cell, cell);
    }
  }
}
