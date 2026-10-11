/**
 * The MIXER (Owner's Manual p. 8): input and output levels, four connectors to a page, ◀ ▶ switch pages. Knobs [1]-[4]
 * turn the level (0-200, x10 while pushed); pushing an input knob mutes it. A stereo-linked pair is one connector (and
 * moves both channels), an unlinked pair is two (INST1L, INST1R). The connectors are laid out in the order MIC 1, MIC 2,
 * INST 1, INST 2, MAIN, SUB 1, SUB 2, LOOP, RHYTHM, PHONES, MASTER and cut into pages of four, which gives the manual's
 * three pages with the default links.
 *
 * Each column (32 px; 36 when the page has fewer than four) draws, from the top: the level number, a fader whose cap
 * sits at the level, a segmented level meter with a peak-hold line, the scale bracket the peak should reach, MUTE
 * over the bottom when muted, and the two-line name. The meter reads the engine status: the mic level on MIC 1, the
 * output level on MAIN, PHONES and MASTER, the loudest track on LOOP; the other connectors have no signal in the app.
 */

import type { Controller } from '../../control/controller';
import type { ControlEvent } from '../../shared/ids';
import type { EngineStatus } from '../../shared/protocol';
import { findParam } from '../../schema/params';
import type { MixerSettings } from '../../schema/types';
import { fillRect, hline, rect, text, vline } from '../draw';
import { FONT_SMALL } from '../fonts';
import type { Framebuffer } from '../framebuffer';
import type { MenuSystem, Screen, ScreenResult } from '../menu';
import { PeakHolds, levelFraction } from '../meter';
import { PLAIN, drawPageArrows, drawTitleBar, knobIndex, turnSteps } from './common';

export const MIXER_KEYS = [
  'mic1In', 'mic2In', 'inst1LIn', 'inst1RIn', 'inst2LIn', 'inst2RIn',
  'mainLOut', 'mainROut', 'sub1LOut', 'sub1ROut', 'sub2LOut', 'sub2ROut',
  'loopOut', 'rhythmOut', 'phonesOut', 'masterOut',
] as const satisfies readonly (keyof MixerSettings)[];
export type MixerKey = (typeof MIXER_KEYS)[number];

const LEVEL_DEF = findParam('mixer.mic1In')!.def;
const LEVEL_MIN = LEVEL_DEF.min!;
const LEVEL_MAX = LEVEL_DEF.max!;
const NUMBERS: readonly string[] = Array.from({ length: LEVEL_MAX + 1 }, (_, i) => String(i));

type Meter = 'input' | 'output' | 'loop' | 'none';
interface Column {
  readonly keys: readonly MixerKey[];
  readonly labels: readonly [string, string];
  readonly input: boolean;
  readonly meter: Meter;
}

const SEGMENTS = 9;
const CENTER = { align: 'center', width: 32 } as const;
const MUTE_OPTS = { invert: true, width: 26, align: 'center' } as const;
const centered36 = { align: 'center', width: 36 } as const;

function peakOf(meter: Meter, st: EngineStatus | null): number {
  if (!st) return 0;
  switch (meter) {
    case 'input': return st.inputPeak;
    case 'output': return st.outputPeak;
    case 'loop': {
      let p = 0;
      for (const t of st.tracks) if (t.peak > p) p = t.peak;
      return p;
    }
    default: return 0;
  }
}

/** The columns for the current stereo-link settings. */
function buildColumns(ctx: Controller): Column[] {
  const { input, output } = ctx.session.system;
  const cols: Column[] = [];
  const pair = (linked: boolean, l: MixerKey, r: MixerKey, name: string, io: 'IN' | 'OUT', meter: Meter, second: Meter): void => {
    const isIn = io === 'IN';
    if (linked) cols.push({ keys: [l, r], labels: [name, io], input: isIn, meter });
    else {
      cols.push({ keys: [l], labels: [`${name}L`, io], input: isIn, meter });
      cols.push({ keys: [r], labels: [`${name}R`, io], input: isIn, meter: second });
    }
  };
  if (input.stereoLink.MIC) cols.push({ keys: ['mic1In', 'mic2In'], labels: ['MIC', 'IN'], input: true, meter: 'input' });
  else {
    cols.push({ keys: ['mic1In'], labels: ['MIC1', 'IN'], input: true, meter: 'input' });
    cols.push({ keys: ['mic2In'], labels: ['MIC2', 'IN'], input: true, meter: 'none' });
  }
  pair(input.stereoLink.INST1, 'inst1LIn', 'inst1RIn', 'INST1', 'IN', 'none', 'none');
  pair(input.stereoLink.INST2, 'inst2LIn', 'inst2RIn', 'INST2', 'IN', 'none', 'none');
  pair(output.stereoLink.MAIN, 'mainLOut', 'mainROut', 'MAIN', 'OUT', 'output', 'output');
  pair(output.stereoLink.SUB1, 'sub1LOut', 'sub1ROut', 'SUB1', 'OUT', 'none', 'none');
  pair(output.stereoLink.SUB2, 'sub2LOut', 'sub2ROut', 'SUB2', 'OUT', 'none', 'none');
  cols.push({ keys: ['loopOut'], labels: ['LOOP', 'OUT'], input: false, meter: 'loop' });
  cols.push({ keys: ['rhythmOut'], labels: ['RHYTHM', 'OUT'], input: false, meter: 'none' });
  cols.push({ keys: ['phonesOut'], labels: ['PHONES', 'OUT'], input: false, meter: 'output' });
  cols.push({ keys: ['masterOut'], labels: ['MASTER', 'OUT'], input: false, meter: 'output' });
  return cols;
}

export class MixerScreen implements Screen {
  readonly title = 'MIXER';
  private cols: Column[] = [];
  private layoutKey = -1;
  private current = 0;
  private readonly holds = new PeakHolds(MIXER_KEYS.length);

  constructor(private readonly menu: MenuSystem) {}

  /** The page showing, from 0. */
  get page(): number {
    return this.current;
  }
  get pageCount(): number {
    return Math.max(1, Math.ceil(this.cols.length / 4));
  }

  /** Rebuilds the columns when a stereo link changed. */
  private sync(ctx: Controller): void {
    const { input, output } = ctx.session.system;
    const key =
      (+input.stereoLink.MIC) | (+input.stereoLink.INST1 << 1) | (+input.stereoLink.INST2 << 2) |
      (+output.stereoLink.MAIN << 3) | (+output.stereoLink.SUB1 << 4) | (+output.stereoLink.SUB2 << 5);
    if (key !== this.layoutKey) {
      this.layoutKey = key;
      this.cols = buildColumns(ctx);
    }
    this.current = Math.min(this.current, this.pageCount - 1);
  }

  private column(n: number): Column | undefined {
    return this.cols[this.current * 4 + n];
  }

  render(fb: Framebuffer, ctx: Controller): void {
    this.sync(ctx);
    drawTitleBar(fb, 'MIXER');
    drawPageArrows(fb, this.current > 0, this.current < this.pageCount - 1);
    const first = this.current * 4;
    const n = Math.min(4, this.cols.length - first);
    const pitch = n < 4 ? 36 : 32;
    const mixer = ctx.session.system.mixer;
    for (let i = 0; i < n; i++) {
      const col = this.cols[first + i]!;
      const x0 = pitch * i;
      const level = mixer[col.keys[0]!];
      const keyIndex = MIXER_KEYS.indexOf(col.keys[0]!);
      const f = levelFraction(peakOf(col.meter, ctx.status));
      const hold = this.holds.feed(keyIndex, f, ctx.now);

      text(fb, x0 + 1, 11, NUMBERS[level] ?? String(level), FONT_SMALL, PLAIN);
      // the scale: the peak should reach the hook at the top of the bracket
      hline(fb, x0 + 27, 18, 4);
      vline(fb, x0 + 30, 18, 28);
      for (let y = 21; y <= 39; y += 6) fb.set(x0 + 29, y);
      // fader
      vline(fb, x0 + 4, 19, 27);
      const yc = 43 - Math.round((level / LEVEL_MAX) * 22);
      rect(fb, x0, yc - 2, 9, 5);
      fillRect(fb, x0 + 1, yc - 1, 7, 3, 0);
      // meter and peak hold
      const lit = Math.ceil(f * SEGMENTS);
      for (let k = 0; k < lit; k++) fillRect(fb, x0 + 12, 44 - 3 * k, 11, 2);
      const held = Math.ceil(hold * SEGMENTS);
      if (held > 0) hline(fb, x0 + 12, 45 - 3 * held, 11);
      if (col.input && this.menu.isMuted(col.keys)) {
        fillRect(fb, x0 + 3, 39, 26, 9);
        text(fb, x0 + 3, 40, 'MUTE', FONT_SMALL, MUTE_OPTS);
      }
      const opts = pitch === 32 ? CENTER : centered36;
      text(fb, x0, 49, col.labels[0], FONT_SMALL, opts);
      text(fb, x0, 57, col.labels[1], FONT_SMALL, opts);
    }
  }

  onEvent(e: ControlEvent, ctx: Controller): ScreenResult {
    this.sync(ctx);
    if (e.kind === 'turn') {
      const col = this.column(knobIndex(e.id));
      if (col) {
        const level = ctx.session.system.mixer[col.keys[0]!] + turnSteps(e, ctx);
        const next = Math.min(LEVEL_MAX, Math.max(LEVEL_MIN, level));
        for (const k of col.keys) ctx.setParam(`mixer.${k}`, next);
      }
      return 'handled';
    }
    if (e.kind !== 'press') return 'unhandled';
    switch (e.id) {
      case 'exit':
        return 'pop';
      case 'enter':
        return 'handled';
      case 'left':
        this.current = Math.max(0, this.current - 1);
        return 'handled';
      case 'right':
        this.current = Math.min(this.pageCount - 1, this.current + 1);
        return 'handled';
      case 'knob1': case 'knob2': case 'knob3': case 'knob4': {
        const col = this.column(knobIndex(e.id));
        if (col?.input) this.menu.toggleMute(col.keys);
        return 'handled';
      }
    }
    return 'unhandled';
  }
}
