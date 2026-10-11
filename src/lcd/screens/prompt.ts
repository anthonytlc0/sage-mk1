/**
 * Pieces the MENU, STORAGE, LATENCY, FACTORY RESET and RECOVER screens share: a list of up to four rows, one per knob
 * [1]-[4] (push a knob to pick its row), and a prompt screen that shows one popup-style question and waits for
 * ENTER or EXIT.
 */

import type { Controller } from '../../control/controller';
import type { ControlEvent } from '../../shared/ids';
import { fillRect, text } from '../draw';
import { FONT_SMALL } from '../fonts';
import type { Framebuffer } from '../framebuffer';
import type { Screen, ScreenResult } from '../menu';
import { drawMessage } from './message';
import { PLAIN } from './common';

/** The top of each row (13 px apart below the title bar). */
export const ROW_Y: readonly number[] = [12, 25, 38, 51];
const KNOB_NUMBERS = ['1', '2', '3', '4'] as const;
const NUMBER_BOX = { invert: true, width: 7, align: 'center' } as const;
const SELECTED = { invert: true, width: 115 } as const;

/**
 * Up to four rows under the title bar: the knob number in a dark box, then the label. `selected` is drawn in
 * inverse video. A null label leaves its row (and number) out.
 */
export function drawRows(fb: Framebuffer, labels: readonly (string | null | undefined)[], selected: number | null = null): void {
  for (let i = 0; i < 4; i++) {
    const label = labels[i];
    if (label === null || label === undefined) continue;
    const y = ROW_Y[i]!;
    text(fb, 1, y, KNOB_NUMBERS[i]!, FONT_SMALL, NUMBER_BOX);
    if (i === selected) {
      fillRect(fb, 10, y - 1, 118, 9);
      text(fb, 12, y, label, FONT_SMALL, SELECTED);
    } else {
      text(fb, 12, y, label, FONT_SMALL, PLAIN);
    }
  }
}

/** A track records, overdubs or plays, or the rhythm plays: what STOP ALL refuses (Owner's Manual p. 23). */
export function looperBusy(ctx: Controller): boolean {
  const s = ctx.status;
  if (s === null) return false;
  if (s.rhythm === 'on') return true;
  for (const t of s.tracks) if (t.state === 'recording' || t.state === 'overdubbing' || t.state === 'playing') return true;
  return false;
}

export interface PromptHandlers {
  enter(ctx: Controller): ScreenResult;
  exit(ctx: Controller): ScreenResult;
}

/** One question in the popup box (CALIBRATE? ENTER/EXIT, RECOVER? ENTER/EXIT). Other input does nothing. */
export class PromptScreen implements Screen {
  constructor(readonly title: string, readonly text: string, private readonly handlers: PromptHandlers) {}

  render(fb: Framebuffer): void {
    drawMessage(fb, this.text);
  }

  onEvent(e: ControlEvent, ctx: Controller): ScreenResult {
    if (e.kind !== 'press') return e.kind === 'turn' ? 'handled' : 'unhandled';
    if (e.id === 'enter') return this.handlers.enter(ctx);
    if (e.id === 'exit') return this.handlers.exit(ctx);
    return 'handled';
  }
}
