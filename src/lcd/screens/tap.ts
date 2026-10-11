/**
 * The TEMPO screen (Owner's Manual p. 11): a frame with "TEMPO" over the tempo in big digits, the status row above and
 * the knob labels below. Knob [4] sets the tempo, 1.0 BPM a detent, or 0.1 while it is pushed (press and turn: the
 * underline moves from the units digit to the tenths). It closes on EXIT or ENTER, and by itself after a while.
 */

import type { Controller } from '../../control/controller';
import type { ControlEvent } from '../../shared/ids';
import { fillRect, rect, text } from '../draw';
import { FONT_LARGE, FONT_MEDIUM } from '../fonts';
import type { Framebuffer } from '../framebuffer';
import type { MenuSystem, Screen, ScreenResult } from '../menu';
import { KNOB_LABELS, PLAIN, drawLabelLines, drawStatusRow, knobIndex } from './common';

/** The screen closes this long after the last tap or turn. INFERRED: the manual gives no time. */
export const TEMPO_SCREEN_MS = 3000;

const CENTER = { align: 'center', width: 128 } as const;
const DIGIT_X = [30, 46, 62] as const;
const TENTHS_X = 84;
const TEMPO_LABEL: readonly string[] = ['TEMPO'];

export class TapTempoScreen implements Screen {
  readonly title = 'TAP TEMPO';
  private timer: ReturnType<typeof setTimeout> | undefined;
  // the digits of the tempo shown, rebuilt only when it changes
  private shown = Number.NaN;
  private whole = '';
  private tenth = '';

  constructor(private readonly menu: MenuSystem) {}

  /** (Re)starts the countdown to closing. */
  open(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.menu.remove(this);
    }, TEMPO_SCREEN_MS);
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  render(fb: Framebuffer, ctx: Controller): void {
    const tempo = ctx.session.memory.tempo;
    if (tempo !== this.shown) {
      this.shown = tempo;
      const [w, t] = tempo.toFixed(1).split('.') as [string, string];
      this.whole = w.padStart(3, ' ');
      this.tenth = t;
    }
    drawStatusRow(fb, ctx, tempo, this.menu.knobLock);
    rect(fb, 3, 10, 122, 44);
    fb.set(3, 10, 0); // a notch at each corner rounds the frame
    fb.set(124, 10, 0);
    fb.set(3, 53, 0);
    fb.set(124, 53, 0);
    text(fb, 0, 13, 'TEMPO', FONT_MEDIUM, CENTER);
    for (let i = 0; i < 3; i++) if (this.whole[i] !== ' ') text(fb, DIGIT_X[i]!, 25, this.whole[i]!, FONT_LARGE, PLAIN);
    fillRect(fb, 79, 46, 3, 3);
    text(fb, TENTHS_X, 25, this.tenth, FONT_LARGE, PLAIN);
    fillRect(fb, ctx.isHeld('knob4') ? TENTHS_X : DIGIT_X[2], 50, 14, 2);
    // the labels show only their bottom line under the frame; knob [4] is the tempo here
    const funcs = ctx.session.system.setup.knobFunc;
    for (let i = 0; i < 3; i++) if (funcs[i] !== 'OFF') drawLabelLines(fb, i, KNOB_LABELS.get(funcs[i]!), true);
    drawLabelLines(fb, 3, TEMPO_LABEL, true);
  }

  onEvent(e: ControlEvent, ctx: Controller): ScreenResult {
    if (e.kind === 'turn') {
      if (e.id === 'knob4') {
        const delta = e.steps * (ctx.isHeld('knob4') ? 0.1 : 1);
        ctx.setParam('tempo', ctx.session.memory.tempo + delta);
        this.open();
      }
      return 'handled';
    }
    if (e.kind !== 'press') return 'unhandled';
    switch (e.id) {
      case 'exit':
      case 'enter':
        return 'pop';
      case 'knob1': case 'knob2': case 'knob3': case 'knob4':
        return knobIndex(e.id) >= 0 ? 'handled' : 'unhandled';
    }
    return 'unhandled';
  }
}
