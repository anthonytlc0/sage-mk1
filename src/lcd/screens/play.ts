/**
 * The seven play screens (Owner's Manual p. 8). One `PlayScreen` sits at the bottom of the menu stack; ◀ ▶ switch its
 * variant, ENTER opens the MIXER, and the [1]-[4] knobs act as SETUP KNOB FUNC 1-4 say (knob 1 is MEMORY by default).
 *
 * Layout at 128x64 (the manual's illustrations, read off at that size; where one is too small to read it is approximated):
 *   y  0-8   status row, right aligned: knob lock, phantom power, note + tempo
 *   y 10-20  "[01] Memory name" (all variants but MEMORY NUMBER, which has the big number at y 10-33 and the name at y 36)
 *   y 22-47  the body of the variant
 *   y 49-63  the knob labels, one line at y 57 or two lines at y 49 and 57
 */

import type { Controller } from '../../control/controller';
import type { ControlEvent } from '../../shared/ids';
import type { TrackState } from '../../shared/protocol';
import { DISPLAY_MODES } from '../../schema/lists';
import { fillRect, text, textWidth } from '../draw';
import { FONT_LARGE, FONT_MEDIUM, FONT_SMALL, glyphOf } from '../fonts';
import { type Framebuffer, parseBitmap } from '../framebuffer';
import { icon } from '../icons';
import type { IconName } from '../icons';
import { applyKnobPush, applyKnobTurn, knobAction } from '../knobFunc';
import type { MenuSystem, Screen, ScreenResult } from '../menu';
import { PeakHolds, levelFraction } from '../meter';
import { WrapCache } from '../wrap';
import { KNOBS, KNOB_LABELS, PLAIN, drawLabelLines, drawStatusRow, knobIndex, turnSteps } from './common';

/** Turns of knob 1 (MEMORY) are collected for this long before the memory is loaded. */
export const MEMORY_DEBOUNCE_MS = 150;
/** A value shown in place of a knob's label after a turn stays this long. */
const FLASH_MS = 1500;

const SLOTS: readonly string[] = Array.from({ length: 100 }, (_, i) => String(i).padStart(2, '0'));
const DIGITS: readonly string[] = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

const TAG_OPTS = { invert: true, width: 17, align: 'center' } as const;
const NAME_CENTER = { align: 'center', width: 128 } as const;
const TILE_ON = { align: 'center', width: 30, invert: true } as const;
const TILE_OFF = { align: 'center', width: 30, invert: false } as const;

const ERASE = { invert: true } as const;
const DRAW = { invert: false } as const;
const TRACK_X = (i: number): number => 1 + 21 * i;
const ICON_Y = 25;

const BASE_ICON: Record<TrackState, IconName> = {
  empty: 'trkEmpty', stopped: 'trkStop', playing: 'trkPlay', recording: 'trkPlay', overdubbing: 'trkPlay',
};
const STATE_WORD: Record<TrackState, string> = {
  empty: 'EMPTY', stopped: 'STOP', playing: 'PLAY', recording: 'REC', overdubbing: 'DUB',
};

const PILL_OFF = parseBitmap(`
  ..#############..
  .#.............#.
  #...............#
  .#.............#.
  ..#############..
`);
const PILL_ON = parseBitmap(`
  ..#############..
  .###############.
  #################
  .###############.
  ..#############..
`);

/**
 * For each pixel of a 20x20 track icon: how far round the circle it lies, 0..1, starting at 6 o'clock and going
 * clockwise on the screen (toward the left). LOOP TRACKS clears the pixels beyond the playhead.
 */
const PIE: Float32Array = (() => {
  const t = new Float32Array(400);
  for (let j = 0; j < 20; j++) {
    for (let i = 0; i < 20; i++) {
      const dx = i + 0.5 - 10, dy = j + 0.5 - 10;
      t[j * 20 + i] = (((Math.atan2(-dx, dy) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) / (2 * Math.PI);
    }
  }
  return t;
})();

const FX_LABEL = {
  in: { A: 'INPUT FX-A', B: 'INPUT FX-B', C: 'INPUT FX-C', D: 'INPUT FX-D' },
  tr: { A: 'TRACK FX-A', B: 'TRACK FX-B', C: 'TRACK FX-C', D: 'TRACK FX-D' },
} as const;
const TILE_NAMES = new WrapCache(FONT_SMALL, 30, 2, true);

const BAR_BASE = 46;
const BAR_MAX = 24;

/** Draws `s` at twice the size of FONT_MEDIUM (the big "PLAY" of LOOP STATUS). */
function drawScaled(fb: Framebuffer, x: number, y: number, s: string): void {
  let px = x;
  for (const ch of s) {
    const g = glyphOf(FONT_MEDIUM, ch) ?? glyphOf(FONT_MEDIUM, ' ')!;
    for (let j = 0; j < g.h; j++) for (let i = 0; i < g.w; i++) if (g.px[j * g.w + i]) fillRect(fb, px + 2 * i, y + 2 * j, 2, 2);
    px += (g.w + 1) * 2;
  }
}
const scaledWidth = (s: string): number => textWidth(s, FONT_MEDIUM) * 2;

// ---------------------------------------------------------------------------------------------------------------------

/** Knob 1's MEMORY function: turns are collected, then the final slot is loaded once. */
class MemoryKnob {
  /** The slot turned to and not yet loaded (or still loading), else null. */
  pending: number | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private gen = 0;

  turn(ctx: Controller, steps: number): void {
    const { min, max } = ctx.session.system.setup.memoryExt;
    const lo = Math.min(min, max), hi = Math.max(min, max);
    const n = hi - lo + 1;
    const base = this.pending ?? ctx.session.slot;
    this.pending = lo + ((((base - lo + steps) % n) + n) % n);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.commit(ctx), MEMORY_DEBOUNCE_MS);
  }

  private commit(ctx: Controller): void {
    this.timer = undefined;
    const slot = this.pending;
    if (slot === null) return;
    if (slot === ctx.session.slot) {
      this.pending = null; // back where it started: nothing to load, and unsaved edits stay
      return;
    }
    const gen = ++this.gen;
    const settle = (): void => {
      if (gen === this.gen && this.timer === undefined) this.pending = null;
    };
    ctx.selectMemory(slot).then(settle, (err: unknown) => {
      console.error('loading memory failed', err);
      ctx.showMessage('DATA READ ERR');
      settle();
    });
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}

export class PlayScreen implements Screen {
  private variant = -1;
  private readonly memory = new MemoryKnob();
  private readonly holds = new PeakHolds(5);

  // what LOOP STATUS shows: the track operated last
  private shown = -1;
  private prevCurrent = -1;
  private seen = false;
  private readonly prevStates: TrackState[] = ['empty', 'empty', 'empty', 'empty', 'empty'];

  // the value flashed in place of a knob label
  private flashCol = -1;
  private flashUntil = 0;
  private flashLines: readonly string[] = [];

  constructor(private readonly menu: MenuSystem) {}

  get title(): string {
    return DISPLAY_MODES[this.variant < 0 ? 0 : this.variant]!;
  }

  /** Takes the start screen from SETUP DISPLAY MODE the first time it is needed. */
  sync(ctx: Controller): void {
    if (this.variant < 0) this.variant = Math.max(0, DISPLAY_MODES.indexOf(ctx.session.system.setup.displayMode));
  }

  /** The next start screen comes from SETUP DISPLAY MODE again. */
  reset(): void {
    this.variant = -1;
  }

  cycle(d: number): string {
    const n = DISPLAY_MODES.length;
    this.variant = ((((this.variant < 0 ? 0 : this.variant) + d) % n) + n) % n;
    return this.title;
  }

  dispose(): void {
    this.memory.dispose();
  }

  // ---- events -------------------------------------------------------------------------------------------------------

  onEvent(e: ControlEvent, ctx: Controller): ScreenResult {
    if (e.kind === 'press') {
      switch (e.id) {
        case 'left':
          this.cycle(-1);
          return 'handled';
        case 'right':
          this.cycle(1);
          return 'handled';
        case 'enter':
          return { push: this.menu.newMixer() };
        case 'knob1': case 'knob2': case 'knob3': case 'knob4': {
          if (this.menu.knobLock) return 'handled';
          const n = knobIndex(e.id);
          const label = ctx.session.system.setup.knobFunc[n]!;
          const action = knobAction(label);
          if (action) this.flash(n, label, applyKnobPush(action, ctx, this.menu), e.t);
          return 'handled';
        }
      }
      return 'unhandled';
    }
    if (e.kind === 'turn' && (KNOBS as readonly string[]).includes(e.id)) {
      if (this.menu.knobLock) return 'handled';
      const n = knobIndex(e.id);
      const label = ctx.session.system.setup.knobFunc[n]!;
      const steps = turnSteps(e, ctx);
      if (label === 'MEMORY') this.memory.turn(ctx, steps);
      else {
        const action = knobAction(label);
        if (action) this.flash(n, label, applyKnobTurn(action, ctx, this.menu, steps), e.t);
      }
      return 'handled';
    }
    return 'unhandled';
  }

  /** Shows `value` under knob `col` in place of the second line of its label, for a moment. */
  private flash(col: number, label: string, value: string | null, t: number): void {
    if (value === null) return;
    this.flashCol = col;
    this.flashUntil = t + FLASH_MS;
    this.flashLines = [KNOB_LABELS.get(label)[0] ?? '', value];
  }

  // ---- drawing ------------------------------------------------------------------------------------------------------

  render(fb: Framebuffer, ctx: Controller): void {
    this.observe(ctx);
    const status = ctx.status;
    drawStatusRow(fb, ctx, status?.tempo ?? ctx.session.memory.tempo, this.menu.knobLock);
    const v = this.variant < 0 ? 0 : this.variant;
    const pending = this.memory.pending;
    const num = SLOTS[pending ?? ctx.session.slot] ?? '--';
    const name = pending !== null ? '' : ctx.session.memory.name;

    if (v === 0) {
      text(fb, Math.floor((128 - textWidth(num, FONT_LARGE)) / 2), 10, num, FONT_LARGE, PLAIN);
      text(fb, 0, 36, name, FONT_MEDIUM, NAME_CENTER);
    } else {
      text(fb, 1, 10, num, FONT_MEDIUM, TAG_OPTS);
      text(fb, 20, 10, name, FONT_MEDIUM, PLAIN);
      switch (v) {
        case 1: this.drawTrackIcons(fb, ctx, false); break;
        case 2: this.drawTrackIcons(fb, ctx, true); break;
        case 3: this.drawLoopStatus(fb, ctx); break;
        case 4: this.drawLoopLevel(fb, ctx); break;
        case 5: this.drawFx(fb, ctx, 'in'); break;
        case 6: this.drawFx(fb, ctx, 'tr'); break;
      }
    }
    this.drawLabels(fb, ctx);
  }

  /** Keeps track of which track changed state (LOOP STATUS shows the one operated last) and of the current track. */
  private observe(ctx: Controller): void {
    const st = ctx.status;
    if (st) {
      if (!this.seen) {
        for (let i = 0; i < 5; i++) this.prevStates[i] = st.tracks[i]?.state ?? 'empty';
        this.seen = true;
      } else {
        let changed = -1, n = 0;
        for (let i = 0; i < 5; i++) {
          const s = st.tracks[i]?.state ?? 'empty';
          if (s !== this.prevStates[i]) {
            this.prevStates[i] = s;
            changed = i;
            n++;
          }
        }
        // several at once (ALL START/STOP, a memory load) say nothing about which one was operated
        if (n === 1) this.shown = changed;
      }
    }
    const cur = ctx.session.memory.play.currentTrack;
    if (cur !== this.prevCurrent) {
      if (this.prevCurrent >= 0) this.shown = cur;
      this.prevCurrent = cur;
    }
  }

  private trackState(ctx: Controller, i: number): TrackState {
    return ctx.status?.tracks[i]?.state ?? 'empty';
  }

  /** TRACK STATUS and LOOP TRACKS: five 20x20 icons and the rhythm indicator. */
  private drawTrackIcons(fb: Framebuffer, ctx: Controller, progress: boolean): void {
    const current = ctx.session.memory.play.currentTrack;
    for (let i = 0; i < 5; i++) {
      const x = TRACK_X(i);
      const s = this.trackState(ctx, i);
      if (progress && (s === 'playing' || s === 'recording' || s === 'overdubbing')) {
        icon(fb, x, ICON_Y, 'trkStop');
        const p = ctx.status!.tracks[i]!.position;
        for (let j = 2; j < 18; j++) for (let k = 2; k < 18; k++) if (PIE[j * 20 + k]! >= p) fb.set(x + k, ICON_Y + j, 0);
      } else {
        icon(fb, x, ICON_Y, BASE_ICON[s]);
      }
      // the current track's dot: dark on a light icon, light on a dark one
      if (i === current) icon(fb, x + 7, ICON_Y + 7, 'current', fb.get(x + 9, ICON_Y + 9) === 1 ? ERASE : DRAW);
    }
    const rhythm = ctx.status?.rhythm ?? 'off';
    const on = rhythm === 'on' || (rhythm === 'standby' && (Math.floor(ctx.now / 250) & 1) === 1);
    fb.blit(on ? PILL_ON : PILL_OFF, 107, 36);
  }

  /** LOOP STATUS: "TRK5: PLAY" in big letters. */
  private drawLoopStatus(fb: Framebuffer, ctx: Controller): void {
    const track = this.shown >= 0 ? this.shown : ctx.session.memory.play.currentTrack;
    const word = STATE_WORD[this.trackState(ctx, track)];
    const trkW = textWidth('TRK', FONT_MEDIUM);
    const total = trkW + 2 + 14 + 2 + scaledWidth(':') + 4 + scaledWidth(word);
    let x = Math.floor((128 - total) / 2);
    text(fb, x, 37, 'TRK', FONT_MEDIUM, PLAIN);
    x += trkW + 2;
    text(fb, x, 24, DIGITS[track + 1]!, FONT_LARGE, PLAIN);
    x += 14 + 2;
    drawScaled(fb, x, 26, ':');
    x += scaledWidth(':') + 4;
    drawScaled(fb, x, 26, word);
  }

  /** LOOP LEVEL: two bars per track from the track's peak, with a peak-hold line above. */
  private drawLoopLevel(fb: Framebuffer, ctx: Controller): void {
    const now = ctx.now;
    for (let i = 0; i < 5; i++) {
      const f = levelFraction(ctx.status?.tracks[i]?.peak ?? 0);
      const hold = this.holds.feed(i, f, now);
      const h = Math.max(1, Math.round(f * BAR_MAX));
      const hp = Math.round(hold * BAR_MAX);
      const x = 4 + 25 * i;
      fillRect(fb, x, BAR_BASE - h + 1, 8, h);
      fillRect(fb, x + 9, BAR_BASE - h + 1, 8, h);
      if (hp > 0) {
        fillRect(fb, x, BAR_BASE - hp - 1, 8, 1);
        fillRect(fb, x + 9, BAR_BASE - hp - 1, 8, 1);
      }
    }
  }

  /** INPUT FX and TRACK FX: the bank and four tiles, inverse video for an effect that is on. */
  private drawFx(fb: Framebuffer, ctx: Controller, side: 'in' | 'tr'): void {
    const bank = this.menu.fx(side, ctx);
    text(fb, 1, 23, FX_LABEL[side][bank.bank], FONT_SMALL, PLAIN);
    for (let i = 0; i < 4; i++) {
      const slot = bank.slots[i];
      if (!slot) continue;
      const x = 32 * i + 1;
      if (slot.on) fillRect(fb, x, 31, 30, 15);
      const lines = TILE_NAMES.get(slot.name);
      for (let k = 0; k < lines.length; k++) {
        text(fb, x, lines.length === 1 ? 35 : 31 + 8 * k, lines[k]!, FONT_SMALL, slot.on ? TILE_ON : TILE_OFF);
      }
    }
  }

  private drawLabels(fb: Framebuffer, ctx: Controller): void {
    const funcs = ctx.session.system.setup.knobFunc;
    const flashing = ctx.now < this.flashUntil;
    for (let i = 0; i < 4; i++) {
      if (flashing && i === this.flashCol) drawLabelLines(fb, i, this.flashLines);
      else if (funcs[i] !== 'OFF') drawLabelLines(fb, i, KNOB_LABELS.get(funcs[i]!));
    }
  }
}
