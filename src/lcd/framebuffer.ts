import { LCD_H, LCD_W } from '../shared/constants';

/** A small 1-bit image: `px` is row-major, `w * h` bytes, 1 = dark pixel. Used for glyphs and icons. */
export interface Bitmap {
  readonly w: number;
  readonly h: number;
  readonly px: Uint8Array;
}

/**
 * Parses a drawing into a Bitmap. Rows are separated by whitespace (newlines or spaces), '#' is a dark pixel
 * and '.' is a light one, so glyph data stays readable in source. Throws on ragged rows or other characters,
 * which makes a typo in a font or icon fail at module load instead of drawing garbage.
 */
export function parseBitmap(src: string): Bitmap {
  const rows = src.trim().split(/\s+/);
  const w = rows[0].length;
  if (w === 0) throw new Error('parseBitmap: empty bitmap');
  const px = new Uint8Array(w * rows.length);
  rows.forEach((row, y) => {
    if (row.length !== w) throw new Error(`parseBitmap: row ${y} is ${row.length} wide, expected ${w}: ${row}`);
    for (let x = 0; x < w; x++) {
      const c = row[x];
      if (c !== '#' && c !== '.') throw new Error(`parseBitmap: row ${y} has '${c}', only '#' and '.' are allowed`);
      px[y * w + x] = c === '#' ? 1 : 0;
    }
  });
  return { w, h: rows.length, px };
}

/**
 * The 128x64 monochrome LCD. `data` has exactly the layout of `PanelState.lcd`: one byte per pixel, row-major,
 * 1 = dark. Every drawing call clips to the screen, so callers never need bounds checks.
 */
export class Framebuffer {
  readonly w = LCD_W;
  readonly h = LCD_H;
  data: Uint8Array = new Uint8Array(LCD_W * LCD_H);

  clear(): void {
    this.data.fill(0);
  }

  set(x: number, y: number, on = 1): void {
    if (x < 0 || y < 0 || x >= LCD_W || y >= LCD_H) return;
    this.data[Math.floor(y) * LCD_W + Math.floor(x)] = on ? 1 : 0;
  }

  /** 1 for a dark pixel, 0 for a light one or anything off-screen. */
  get(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= LCD_W || y >= LCD_H) return 0;
    return this.data[Math.floor(y) * LCD_W + Math.floor(x)];
  }

  /** Flips every pixel in the rectangle (clipped to the screen). */
  invert(x: number, y: number, w: number, h: number): void {
    const x0 = Math.max(x, 0), x1 = Math.min(x + w, LCD_W);
    const y0 = Math.max(y, 0), y1 = Math.min(y + h, LCD_H);
    for (let yy = y0; yy < y1; yy++) {
      for (let xx = x0; xx < x1; xx++) this.data[yy * LCD_W + xx] ^= 1;
    }
  }

  /** Draws the dark pixels of `bm` with its top-left at (x, y); light pixels are transparent. `on = 0` erases instead. */
  blit(bm: Bitmap, x: number, y: number, on = 1): void {
    for (let j = 0; j < bm.h; j++) {
      for (let i = 0; i < bm.w; i++) if (bm.px[j * bm.w + i]) this.set(x + i, y + j, on);
    }
  }

  /** 64 lines of 128 characters, '#' for a dark pixel and '.' for a light one, joined with '\n'. */
  toAscii(): string {
    const lines: string[] = [];
    for (let y = 0; y < LCD_H; y++) {
      let line = '';
      for (let x = 0; x < LCD_W; x++) line += this.data[y * LCD_W + x] ? '#' : '.';
      lines.push(line);
    }
    return lines.join('\n');
  }
}
