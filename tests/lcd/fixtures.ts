import type { Framebuffer } from '../../src/lcd/framebuffer';
import { LCD_H, LCD_W } from '../../src/shared/constants';

/**
 * Turns a template literal drawing into exactly LCD_H rows of LCD_W characters.
 *
 * Authoring rules (so small fixtures stay readable):
 *  - only '#' (dark pixel) and '.' (light pixel) are allowed; whitespace around a row is ignored;
 *  - blank lines at the very start and end of the template are dropped (the newline after the opening
 *    backtick and before the closing one), blank lines in the middle count as empty rows;
 *  - rows shorter than LCD_W are padded on the right with '.', and missing rows at the bottom are all '.'.
 *    So a fixture only has to show the top-left region it cares about, and everything outside it is still
 *    asserted to be blank.
 */
export function normalizeScreen(expected: string): string[] {
  const lines = expected.split('\n').map((l) => l.trim());
  while (lines.length > 0 && lines[0] === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines.length > LCD_H) throw new Error(`expectScreen: ${lines.length} rows given, the screen has ${LCD_H}`);
  return Array.from({ length: LCD_H }, (_, y) => {
    const row = lines[y] ?? '';
    if (!/^[.#]*$/.test(row)) throw new Error(`expectScreen: row ${y} has characters other than '#' and '.': ${row}`);
    if (row.length > LCD_W) throw new Error(`expectScreen: row ${y} is ${row.length} wide, the screen is ${LCD_W}`);
    return row.padEnd(LCD_W, '.');
  });
}

/** Compares the framebuffer with a template drawing and throws an Error carrying a per-row diff on mismatch. */
export function expectScreen(fb: Framebuffer, expected: string): void {
  const want = normalizeScreen(expected);
  const got = fb.toAscii().split('\n');
  const bad: number[] = [];
  let pixels = 0;
  for (let y = 0; y < LCD_H; y++) {
    if (got[y] === want[y]) continue;
    bad.push(y);
    for (let x = 0; x < LCD_W; x++) if (got[y][x] !== want[y][x]) pixels++;
  }
  if (bad.length === 0) return;

  const shown = bad.slice(0, 12);
  const out = [`Screen mismatch: ${pixels} pixel(s) differ in ${bad.length} row(s)`];
  for (const y of shown) {
    let last = 0;
    for (let x = 0; x < LCD_W; x++) if (got[y][x] !== want[y][x] || got[y][x] === '#') last = x;
    const n = last + 1;
    const marks = Array.from({ length: n }, (_, x) => (got[y][x] !== want[y][x] ? '^' : ' ')).join('');
    out.push(`row ${String(y).padStart(2, '0')}`);
    out.push(`  expected  ${want[y].slice(0, n)}`);
    out.push(`  actual    ${got[y].slice(0, n)}`);
    out.push(`  diff      ${marks}`);
  }
  if (bad.length > shown.length) out.push(`... and ${bad.length - shown.length} more row(s)`);
  throw new Error(out.join('\n'));
}
