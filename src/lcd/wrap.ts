import { textWidth } from './draw';
import type { Font } from './fonts';

/** The longest prefix of `word` that, with `tail` appended, fits in `maxW` pixels (at least one character). */
function fit(word: string, maxW: number, font: Font, tail: string): string {
  let n = word.length;
  while (n > 1 && textWidth(word.slice(0, n) + tail, font) > maxW) n--;
  return word.slice(0, n);
}

/**
 * Breaks `text` into lines of at most `maxW` pixels, at spaces. A word that does not fit on a line of its own is
 * hyphenated the way the hardware prints IMME-DIATE (`hyphen`), or clipped. When there are more than `maxLines` lines
 * the first ones are kept together with the last, so a label still ends with its last word. An empty text gives no lines.
 */
export function wrapLines(text: string, maxW: number, font: Font, maxLines: number, hyphen: boolean): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const word of text.split(' ')) {
    if (word === '') continue;
    let rest = word;
    // A word that is too wide ends the line before it and is cut up.
    while (textWidth(rest, font) > maxW) {
      if (cur !== '') {
        lines.push(cur);
        cur = '';
      }
      const head = fit(rest, maxW, font, hyphen ? '-' : '');
      if (!hyphen || head.length >= rest.length) {
        rest = head; // clipped
        break;
      }
      lines.push(head + '-');
      rest = rest.slice(head.length);
    }
    if (cur === '') cur = rest;
    else if (textWidth(`${cur} ${rest}`, font) <= maxW) cur += ` ${rest}`;
    else {
      lines.push(cur);
      cur = rest;
    }
  }
  if (cur !== '') lines.push(cur);
  if (lines.length > maxLines) return [...lines.slice(0, maxLines - 1), lines[lines.length - 1]!];
  return lines;
}

/** `wrapLines` with one fixed setup that remembers its answers, so drawing the same label every frame allocates nothing. */
export class WrapCache {
  private readonly cache = new Map<string, readonly string[]>();

  constructor(
    private readonly font: Font,
    private readonly maxW: number,
    private readonly maxLines: number,
    private readonly hyphen: boolean,
  ) {}

  get(text: string): readonly string[] {
    let lines = this.cache.get(text);
    if (lines === undefined) {
      if (this.cache.size >= 1024) this.cache.clear(); // values like measures are bounded, but never let it grow for good
      lines = wrapLines(text, this.maxW, this.font, this.maxLines, this.hyphen);
      this.cache.set(text, lines);
    }
    return lines;
  }
}
