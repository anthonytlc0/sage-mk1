/**
 * The LOOP screen (Owner's Manual p. 13) and the REC and PLAY screens it opens.
 *
 *   page 1:  TRACK  REC  PLAY      (knob [1] turned picks the track, TRK1 shows over its icon; pushed, it opens TRACK)
 *   page 2:  INPUT FX  TRACK FX  RHYTHM  NAME
 *
 * Pushing a knob opens its item. INPUT FX and TRACK FX show "FX: PHASE 2" until the effects framework lands. The track
 * picked here only chooses what TRACK edits; it is not the current track (INFERRED: the manual does not say).
 */

import type { Controller } from '../../control/controller';
import type { ControlEvent } from '../../shared/ids';
import { TRACKS } from '../../shared/ids';
import { fillRect, hline, rect, text, vline } from '../draw';
import { FONT_SMALL } from '../fonts';
import type { Framebuffer } from '../framebuffer';
import type { Screen, ScreenResult } from '../menu';
import { drawLabelLines, drawPageArrows, drawTitleBar, knobIndex } from './common';
import { PageSet, defsOf, paramPages, switchPage, trackSwitches } from './editPages';
import { nameScreen } from './name';
import { rhythmScreen } from './rhythm';
import { trackScreen } from './track';

export const MSG_FX_PHASE2 = 'FX: PHASE 2';

// ---- REC and PLAY ---------------------------------------------------------------------------------------------------

/** REC (Parameter Guide p. 4): four parameters, then BOUNCE SW with the five BOUNCE TRACK switches. */
export function recScreen(): Screen {
  const pages = [
    ...paramPages('REC', defsOf(['rec.recAction', 'rec.quantize', 'rec.autoRecSw', 'rec.autoRecSens'])),
    switchPage('REC', {
      lead: defsOf(['rec.bounceSw']),
      groups: [{ label: 'BOUNCE TRACK', knob: 1, cols: 3, sets: [trackSwitches((t) => `rec.bounceTrack.${t}`)] }],
    }),
  ];
  return new PageSet('REC', pages);
}

/** PLAY (Parameter Guide p. 4): four parameters, the two ALL START / ALL STOP TRK rows, then three more. */
export function playScreen(): Screen {
  const pages = [
    ...paramPages('PLAY', defsOf(['play.sTrkChange', 'play.currentTrack', 'play.fadeIn', 'play.fadeOut'])),
    switchPage('PLAY', {
      groups: [
        { label: 'ALL START TRK', knob: 0, cols: 2, sets: [trackSwitches((t) => `play.allStartTrk.${t}`)] },
        { label: 'ALL STOP TRK', knob: 2, cols: 2, sets: [trackSwitches((t) => `play.allStopTrk.${t}`)] },
      ],
    }),
    ...paramPages('PLAY', defsOf(['play.loopLength', 'play.speedChange', 'play.syncAdjust'])),
  ];
  return new PageSet('PLAY', pages);
}

// ---- pictures (16 x 16, original) ------------------------------------------------------------------------------------

const ICON = 16;

/** A ring of outer radius 8 (centre at (x + 8, y + 8)) and inner `r2in` squared. */
function ring(fb: Framebuffer, x: number, y: number, r2in: number): void {
  for (let dy = -8; dy < 8; dy++) {
    for (let dx = -8; dx < 8; dx++) {
      const d = (dx + 0.5) * (dx + 0.5) + (dy + 0.5) * (dy + 0.5);
      if (d <= 60 && d > r2in) fb.set(x + 8 + dx, y + 8 + dy);
    }
  }
}

/** A triangle pointing right, `h` rows high (odd), its base on column `x`. */
function playArrow(fb: Framebuffer, x: number, y: number, h: number): void {
  for (let k = 0; k <= (h - 1) / 2; k++) vline(fb, x + k, y + k, h - 2 * k);
}

/** A loop with an arrowhead: select the track. */
function trackIcon(fb: Framebuffer, x: number, y: number): void {
  ring(fb, x, y, 32);
  hline(fb, x + 11, y + 6, 5);
  hline(fb, x + 12, y + 7, 3);
  fb.set(x + 13, y + 8);
}

/** A record dot and a play arrow. */
function recIcon(fb: Framebuffer, x: number, y: number): void {
  for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) if (dx * dx + dy * dy <= 18) fb.set(x + 5 + dx, y + 8 + dy);
  playArrow(fb, x + 10, y + 4, 9);
}

/** A play arrow in a ring. */
function playIcon(fb: Framebuffer, x: number, y: number): void {
  ring(fb, x, y, 40);
  playArrow(fb, x + 6, y + 4, 9);
}

/** A stompbox: two knobs and a footswitch. */
function fxIcon(fb: Framebuffer, x: number, y: number): void {
  rect(fb, x + 2, y, 12, ICON);
  fillRect(fb, x + 4, y + 3, 3, 3);
  fillRect(fb, x + 9, y + 3, 3, 3);
  rect(fb, x + 5, y + 9, 6, 5);
}

/** A drum with two sticks. */
function rhythmIcon(fb: Framebuffer, x: number, y: number): void {
  rect(fb, x + 1, y + 5, 14, 10);
  hline(fb, x + 1, y + 8, 14);
  for (let k = 0; k < 4; k++) {
    fb.set(x + 3 + k, y + k);
    fb.set(x + 12 - k, y + k);
  }
}

/** A name card: a head, shoulders and two lines. */
function nameIcon(fb: Framebuffer, x: number, y: number): void {
  rect(fb, x, y + 2, ICON, 12);
  fillRect(fb, x + 3, y + 5, 3, 3);
  hline(fb, x + 2, y + 10, 5);
  hline(fb, x + 9, y + 6, 5);
  hline(fb, x + 9, y + 9, 5);
}

// ---- the screen -----------------------------------------------------------------------------------------------------

const TRK_LABELS: readonly string[] = TRACKS.map((t) => `TRK${t + 1}`);
const TRK_LABEL = { align: 'center', width: 32 } as const;
const FX_LABEL = { align: 'center', width: 64 } as const;

const LABELS: readonly (readonly (readonly string[])[])[] = [
  [['TRACK'], ['REC'], ['PLAY'], []],
  [['INPUT'], ['TRACK'], ['RHYTHM'], ['NAME']],
];

const ICON_Y = 22;

class LoopScreen implements Screen {
  readonly title = 'LOOP';
  private page = 0;
  /** The track TRACK edits; read from the memory's current track the first time. */
  private track = -1;

  private sync(ctx: Controller): void {
    if (this.track < 0) this.track = ctx.session.memory.play.currentTrack;
  }

  render(fb: Framebuffer, ctx: Controller): void {
    this.sync(ctx);
    drawTitleBar(fb, 'LOOP');
    drawPageArrows(fb, this.page > 0, this.page < 1);
    if (this.page === 0) {
      text(fb, 0, 12, TRK_LABELS[this.track]!, FONT_SMALL, TRK_LABEL);
      trackIcon(fb, 8, ICON_Y);
      recIcon(fb, 40, ICON_Y);
      playIcon(fb, 72, ICON_Y);
    } else {
      fxIcon(fb, 8, ICON_Y);
      fxIcon(fb, 40, ICON_Y);
      rhythmIcon(fb, 72, ICON_Y);
      nameIcon(fb, 104, ICON_Y);
      // the bracket that says the first two are effects
      hline(fb, 2, 44, 60);
      vline(fb, 2, 44, 4);
      vline(fb, 61, 44, 4);
      fillRect(fb, 25, 40, 14, 9, 0);
      text(fb, 0, 41, 'FX', FONT_SMALL, FX_LABEL);
    }
    const labels = LABELS[this.page]!;
    for (let i = 0; i < 4; i++) drawLabelLines(fb, i, labels[i]!);
  }

  onEvent(e: ControlEvent, ctx: Controller): ScreenResult {
    this.sync(ctx);
    if (e.kind === 'turn') {
      if (this.page === 0 && e.id === 'knob1') this.track = Math.min(TRACKS.length - 1, Math.max(0, this.track + e.steps));
      return 'handled';
    }
    if (e.kind !== 'press') return 'unhandled';
    switch (e.id) {
      case 'exit':
        return 'pop';
      case 'left':
        this.page = 0;
        return 'handled';
      case 'right':
        this.page = 1;
        return 'handled';
      case 'knob1': case 'knob2': case 'knob3': case 'knob4':
        return this.open(knobIndex(e.id), ctx);
    }
    return 'unhandled';
  }

  /** Pushing knob `n` opens its item. */
  private open(n: number, ctx: Controller): ScreenResult {
    if (this.page === 0) {
      if (n === 0) return { push: trackScreen(this.track) };
      if (n === 1) return { push: recScreen() };
      if (n === 2) return { push: playScreen() };
      return 'handled';
    }
    if (n <= 1) {
      ctx.showMessage(MSG_FX_PHASE2); // TODO(phase 2): INPUT FX / TRACK FX settings
      return 'handled';
    }
    return { push: n === 2 ? rhythmScreen() : nameScreen() };
  }
}

export function loopScreen(): Screen {
  return new LoopScreen();
}
