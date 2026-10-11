/**
 * What the edit screens (TRACK, REC, PLAY, RHYTHM) are built from, on top of Task 19's `paramPage`.
 *
 *  - `PageSet`: a stack of pages with ◀ ▶ between them. Each page is a screen of its own (a `paramPage` of up to four
 *    parameters, or a `switchPage`), so a screen can wrap one page to guard it (the RHYTHM screen locks BEAT that way).
 *  - `paramPages`: chunks a list of parameters into `paramPage`s of four.
 *  - `switchPage`: the pages `paramPage` cannot do. A parameter that is a row of on/off switches (TRACK INPUT, BOUNCE
 *    TRACK, ALL START TRK, ALL STOP TRK) is drawn as a group of small switches: knob TURN selects one, PUSH switches it
 *    (Owner's Manual p. 14: "Turn the [1] knob to select the input jack/connector or RHYTHM, and press the [1] knob to
 *    switch between ON/OFF"). Up to a screen's width is shared between the groups, left to right, by knob columns.
 */

import type { Controller } from '../../control/controller';
import { findParam } from '../../schema/params';
import type { ParamDef } from '../../schema/types';
import type { ControlEvent } from '../../shared/ids';
import { fillRect, hline, rect, text } from '../draw';
import type { TextOpts } from '../draw';
import { FONT_SMALL } from '../fonts';
import type { Framebuffer } from '../framebuffer';
import type { Screen, ScreenResult } from '../menu';
import { WrapCache } from '../wrap';
import { drawPageArrows, drawTitleBar, knobIndex } from './common';
import { paramPage } from './paramPage';

/** The definitions of the parameters with these (wildcard) ids. Throws for an unknown id. */
export function defsOf(ids: readonly string[]): ParamDef[] {
  return ids.map((id) => {
    const hit = findParam(id);
    if (!hit) throw new Error(`edit screen: unknown parameter ${id}`);
    return hit.def;
  });
}

/** `paramPage`s of four parameters each. A `*` in an id takes `index`. */
export function paramPages(title: string, defs: readonly ParamDef[], index?: number): Screen[] {
  const out: Screen[] = [];
  for (let i = 0; i < defs.length; i += 4) out.push(paramPage(title, defs.slice(i, i + 4), index === undefined ? {} : { index }));
  return out;
}

// ---- page set -------------------------------------------------------------------------------------------------------

export class PageSet implements Screen {
  private index = 0;

  constructor(readonly title: string, private readonly pages: readonly Screen[]) {
    if (pages.length === 0) throw new Error('PageSet needs a page');
  }

  /** The page showing, from 0. */
  get page(): number {
    return this.index;
  }

  goto(page: number): void {
    this.index = Math.min(this.pages.length - 1, Math.max(0, page));
  }

  render(fb: Framebuffer, ctx: Controller): void {
    this.pages[this.index]!.render(fb, ctx);
    drawPageArrows(fb, this.index > 0, this.index < this.pages.length - 1);
  }

  onEvent(e: ControlEvent, ctx: Controller): ScreenResult {
    if (e.kind === 'press') {
      if (e.id === 'left') {
        this.goto(this.index - 1);
        return 'handled';
      }
      if (e.id === 'right') {
        this.goto(this.index + 1);
        return 'handled';
      }
    }
    return this.pages[this.index]!.onEvent(e, ctx);
  }

  dispose(): void {
    for (const p of this.pages) p.dispose?.();
  }
}

// ---- switch pages ---------------------------------------------------------------------------------------------------

/** One switch: two short caption lines under it, and the parameters it sets (several for a stereo-linked pair). */
export interface SwitchItemSpec {
  readonly top: string;
  readonly bottom: string;
  /** Concrete memory parameter ids (`rec.bounceTrack.0`), all set together. */
  readonly ids: readonly string[];
}

export interface SwitchGroupSpec {
  /** The name under the group (wrapped onto two lines when it is wider than the group). */
  readonly label: string;
  /** The first knob column (0-3) the group covers, and how many columns it spans. Its knobs select and switch. */
  readonly knob: number;
  readonly cols: number;
  /** The switches: one list, or one per value `variant` returns (TRACK INPUT's list follows the stereo links). */
  readonly sets: readonly (readonly SwitchItemSpec[])[];
  readonly variant?: (ctx: Controller) => number;
}

export interface SwitchPageSpec {
  /** Ordinary parameters on the first knobs ([1] up), drawn and edited as on any parameter page. */
  readonly lead?: readonly ParamDef[];
  readonly leadIndex?: number;
  readonly groups: readonly SwitchGroupSpec[];
}

interface BoundItem {
  readonly top: string;
  readonly bottom: string;
  readonly ids: readonly string[];
  readonly paths: readonly (readonly string[])[];
}
interface BoundSet {
  readonly items: readonly BoundItem[];
  readonly pitch: number;
  readonly start: number;
  readonly caption: TextOpts;
  /** Some item has a second caption line: the marker sits a line lower. */
  readonly twoLines: boolean;
}

const SWITCH_W = 7;
const VALUE_Y = 11;
const MAX_PITCH = 24;

/**
 * Where the rows of a group sit: the switch (top and height), its caption (two lines for INPUT) and the marker under
 * the selected one. A page with ordinary parameters in front puts the switches at the height of `paramPage`'s own
 * on/off switch, so a lead parameter (BOUNCE SW) and the switches beside it line up.
 */
interface Rows {
  readonly switchY: number;
  readonly switchH: number;
  readonly captionY: number;
  readonly markerY: number;
}
const ROWS_ALONE: Rows = { switchY: 19, switchH: 12, captionY: 33, markerY: 47 };
const ROWS_BESIDE_LEAD: Rows = { switchY: 27, switchH: 13, captionY: 41, markerY: 48 };

function bindItem(spec: SwitchItemSpec): BoundItem {
  for (const id of spec.ids) {
    const hit = findParam(id);
    if (!hit || hit.def.kind !== 'bool' || hit.def.scope === 'system') throw new Error(`switch page: ${id} is not an on/off memory parameter`);
  }
  return { top: spec.top, bottom: spec.bottom, ids: spec.ids, paths: spec.ids.map((id) => id.split('.')) };
}

class Group {
  readonly x0: number;
  readonly width: number;
  readonly sets: readonly BoundSet[];
  readonly label: readonly string[];
  readonly valueOpts: TextOpts;
  readonly labelOpts: TextOpts;
  sel = 0;

  constructor(readonly spec: SwitchGroupSpec) {
    this.x0 = 32 * spec.knob;
    this.width = 32 * spec.cols;
    this.sets = spec.sets.map((items) => {
      const bound = items.map(bindItem);
      const pitch = Math.min(MAX_PITCH, Math.floor(this.width / Math.max(1, bound.length)));
      const start = this.x0 + Math.floor((this.width - pitch * bound.length) / 2);
      return { items: bound, pitch, start, caption: { align: 'center', width: pitch }, twoLines: bound.some((b) => b.bottom !== '') };
    });
    this.label = new WrapCache(FONT_SMALL, this.width - 2, 2, false).get(spec.label);
    this.valueOpts = { align: 'center', width: this.width };
    this.labelOpts = { align: 'center', width: this.width };
  }

  covers(knob: number): boolean {
    return knob >= this.spec.knob && knob < this.spec.knob + this.spec.cols;
  }

  set(ctx: Controller): BoundSet {
    return this.sets[this.spec.variant ? this.spec.variant(ctx) : 0]!;
  }

  selected(ctx: Controller): number {
    const n = this.set(ctx).items.length;
    return Math.min(this.sel, n - 1);
  }
}

/** True when every parameter of the item is ON. Walks the settings by pre-split paths, so drawing allocates nothing. */
function isOn(item: BoundItem, ctx: Controller): boolean {
  for (const path of item.paths) {
    let node: unknown = ctx.session.memory;
    for (const key of path) node = (node as Record<string, unknown>)[key];
    if (node !== true) return false;
  }
  return true;
}

class SwitchPage implements Screen {
  private readonly lead: Screen | null;
  private readonly groups: readonly Group[];
  private readonly rows: Rows;

  constructor(readonly title: string, spec: SwitchPageSpec) {
    this.lead = spec.lead && spec.lead.length > 0 ? paramPage(title, spec.lead, spec.leadIndex === undefined ? {} : { index: spec.leadIndex }) : null;
    this.groups = spec.groups.map((g) => new Group(g));
    this.rows = this.lead ? ROWS_BESIDE_LEAD : ROWS_ALONE;
  }

  render(fb: Framebuffer, ctx: Controller): void {
    if (this.lead) this.lead.render(fb, ctx);
    else drawTitleBar(fb, this.title);
    for (const g of this.groups) this.drawGroup(fb, ctx, g);
  }

  private drawGroup(fb: Framebuffer, ctx: Controller, g: Group): void {
    const set = g.set(ctx);
    const sel = g.selected(ctx);
    const items = set.items;
    const rows = this.rows;
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      const x = set.start + i * set.pitch;
      const on = isOn(item, ctx);
      if (i === sel) text(fb, g.x0, VALUE_Y, on ? 'ON' : 'OFF', FONT_SMALL, g.valueOpts);
      const sx = x + ((set.pitch - SWITCH_W) >> 1);
      rect(fb, sx, rows.switchY, SWITCH_W, rows.switchH);
      fillRect(fb, sx + 2, on ? rows.switchY + 2 : rows.switchY + rows.switchH - 5, 3, 4);
      text(fb, x, rows.captionY, item.top, FONT_SMALL, set.caption);
      if (item.bottom !== '') text(fb, x, rows.captionY + 7, item.bottom, FONT_SMALL, set.caption);
      if (i === sel) hline(fb, x + 1, rows.markerY + (set.twoLines ? 7 : 0), set.pitch - 2);
    }
    const lines = g.label;
    for (let k = 0; k < lines.length; k++) text(fb, g.x0, 57 - 8 * (lines.length - 1 - k), lines[k]!, FONT_SMALL, g.labelOpts);
  }

  onEvent(e: ControlEvent, ctx: Controller): ScreenResult {
    if (e.kind === 'turn' || (e.kind === 'press' && knobIndex(e.id) >= 0)) {
      const knob = knobIndex(e.id);
      const g = this.groups.find((x) => x.covers(knob));
      if (g) {
        if (e.kind === 'turn') {
          const n = g.set(ctx).items.length;
          g.sel = Math.min(n - 1, Math.max(0, g.selected(ctx) + e.steps));
        } else {
          const item = g.set(ctx).items[g.selected(ctx)]!;
          const next = !isOn(item, ctx);
          for (const id of item.ids) ctx.setParam(id, next);
        }
        return 'handled';
      }
    }
    if (this.lead) return this.lead.onEvent(e, ctx);
    if (e.kind === 'turn') return 'handled';
    if (e.kind === 'press' && e.id === 'exit') return 'pop';
    return e.kind === 'press' && knobIndex(e.id) >= 0 ? 'handled' : 'unhandled';
  }

  dispose(): void {
    this.lead?.dispose?.();
  }
}

/** A page of on/off switch groups, with up to three ordinary parameters on the knobs before them. */
export function switchPage(title: string, spec: SwitchPageSpec): Screen {
  return new SwitchPage(title, spec);
}

/** Switches 1-5 for the five tracks: `ids(track)` is the parameter of that track. */
export function trackSwitches(ids: (track: number) => string): readonly SwitchItemSpec[] {
  return [0, 1, 2, 3, 4].map((t) => ({ top: String(t + 1), bottom: '', ids: [ids(t)] }));
}
