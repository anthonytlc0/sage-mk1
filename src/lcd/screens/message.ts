import { fillRect, rect, text, textWidth } from '../draw';
import { FONT_MEDIUM } from '../fonts';
import type { Framebuffer } from '../framebuffer';
import { WrapCache } from '../wrap';

const LINES = new WrapCache(FONT_MEDIUM, 116, 3, false);
const OPTS = { align: 'center' as const, width: 0 };

/**
 * The popup message (EXECUTING..., NOT EMPTY, STOP LOOPER, ...): a framed box in the middle of the screen over whatever
 * is there, the text in FONT_MEDIUM, wrapped onto up to three lines. How long it stays is up to `Controller.showMessage`.
 */
export function drawMessage(fb: Framebuffer, message: string): void {
  const lines = LINES.get(message);
  if (lines.length === 0) return;
  let widest = 0;
  for (const s of lines) widest = Math.max(widest, textWidth(s, FONT_MEDIUM));
  const w = widest + 12;
  const h = 11 + 12 * (lines.length - 1) + 10;
  const x = Math.floor((128 - w) / 2);
  const y = Math.floor((64 - h) / 2);
  fillRect(fb, x, y, w, h, 0);
  rect(fb, x, y, w, h);
  // a notch at each corner rounds the frame
  fb.set(x, y, 0);
  fb.set(x + w - 1, y, 0);
  fb.set(x, y + h - 1, 0);
  fb.set(x + w - 1, y + h - 1, 0);
  OPTS.width = w;
  for (let k = 0; k < lines.length; k++) text(fb, x, y + 5 + 12 * k, lines[k]!, FONT_MEDIUM, OPTS);
}
