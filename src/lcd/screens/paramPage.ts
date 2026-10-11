/**
 * The generic parameter page of the edit screens (Owner's Manual pp. 13-17): a title with an underline, four columns
 * for knobs [1]-[4] (value on top, a dial or switch, the parameter name below), ◀ ▶ for the next page of four.
 *
 * A turn steps the value by one step (x10 while the knob is held), a push toggles an on/off parameter. Values are
 * written through the controller, so the schema validates them and the engine is sent the new settings.
 */

import type { Controller } from '../../control/controller';
import type { ControlEvent } from '../../shared/ids';
import { type ParamDef, NOTE_VALUES } from '../../schema/types';
import { text } from '../draw';
import { FONT_SMALL } from '../fonts';
import { type Framebuffer, parseBitmap } from '../framebuffer';
import { beatLabel } from '../../schema/format';
import { findParam } from '../../schema/params';
import type { Screen, ScreenResult } from '../menu';
import { WrapCache } from '../wrap';
import { drawPageArrows, drawTitleBar, knobIndex, turnSteps } from './common';

// ---- stepping a value -----------------------------------------------------------------------------------------------
// Every kind of value but on/off and text lies on a numbered line: a keyword or a note, a step of a range, a choice of a
// list. A turn moves along it by whole positions and stops at its ends, as a hardware encoder does.

/** Keywords that come before the numbers of an int/float or the notes of a note value. */
const keywordCount = (d: ParamDef): number => d.values?.length ?? 0;

/** Largest position on the value's line (positions run 0..last). */
function lastPos(d: ParamDef): number {
  switch (d.kind) {
    case 'enum':
    case 'beat':
      return d.values!.length - 1;
    case 'note':
      return keywordCount(d) + NOTE_VALUES.length + (d.max! - d.min!);
    case 'int':
    case 'float':
      if (d.choices) return d.choices.length - 1;
      return keywordCount(d) + Math.floor((d.max! - d.min!) / (d.step ?? 1) + 1e-9);
    default:
      return 0;
  }
}

/** Where `v` lies on the value's line. */
function positionOf(d: ParamDef, v: unknown): number {
  switch (d.kind) {
    case 'enum':
      return Math.max(0, d.values!.indexOf(v as string));
    case 'beat':
      return Math.max(0, d.values!.indexOf(typeof v === 'string' ? v : beatLabel(v as { num: number; den: 4 | 8 })));
    case 'note': {
      const k = keywordCount(d);
      if (typeof v === 'string') return Math.max(0, d.values!.indexOf(v));
      const o = v as { note?: string; measures?: number };
      if (o.note !== undefined) return k + Math.max(0, NOTE_VALUES.indexOf(o.note));
      return k + NOTE_VALUES.length + ((o.measures ?? d.min!) - d.min!);
    }
    case 'int':
    case 'float': {
      if (d.choices) {
        if (typeof v === 'string') return Math.max(0, d.choices.indexOf(v));
        let best = 0, bestDist = Infinity;
        for (let i = 0; i < d.choices.length; i++) {
          const c = d.choices[i];
          if (typeof c === 'number' && Math.abs(c - (v as number)) < bestDist) {
            best = i;
            bestDist = Math.abs(c - (v as number));
          }
        }
        return best;
      }
      if (typeof v === 'string') return Math.max(0, d.values!.indexOf(v));
      return keywordCount(d) + Math.round(((v as number) - d.min!) / (d.step ?? 1));
    }
    default:
      return 0;
  }
}

/** The value at position `pos` of the line (as `setParam` accepts it). */
function valueAt(d: ParamDef, pos: number): unknown {
  switch (d.kind) {
    case 'enum':
    case 'beat':
      return d.values![pos];
    case 'note': {
      const k = keywordCount(d);
      if (pos < k) return d.values![pos];
      if (pos < k + NOTE_VALUES.length) return { note: NOTE_VALUES[pos - k] };
      return { measures: d.min! + (pos - k - NOTE_VALUES.length) };
    }
    default: {
      if (d.choices) return d.choices[pos];
      const k = keywordCount(d);
      if (pos < k) return d.values![pos];
      const step = d.step ?? 1;
      const decimals = (String(step).split('.')[1] ?? '').length;
      return Number((d.min! + (pos - k) * step).toFixed(decimals));
    }
  }
}

/**
 * `current` moved by `steps` positions along the parameter's values, stopping at the ends. An on/off parameter goes ON
 * for a turn up and OFF for a turn down; text is left alone (the NAME screen edits it).
 */
export function stepParam(d: ParamDef, current: unknown, steps: number): unknown {
  if (d.kind === 'bool') return steps > 0 ? true : steps < 0 ? false : current;
  if (d.kind === 'text') return current;
  const pos = Math.min(lastPos(d), Math.max(0, positionOf(d, current) + steps));
  return valueAt(d, pos);
}

/** Where `current` lies in the parameter's range or list, 0..1 (the angle of the dial). */
export function paramFraction(d: ParamDef, current: unknown): number {
  if (d.kind === 'bool') return current ? 1 : 0;
  const last = lastPos(d);
  return last > 0 ? positionOf(d, current) / last : 0;
}

// ---- the screen -----------------------------------------------------------------------------------------------------

const SWITCH_ON = parseBitmap(`
  .#####.
  #.....#
  #.###.#
  #.###.#
  #.###.#
  #.###.#
  #.....#
  #.....#
  #.....#
  #.....#
  #.....#
  #.....#
  .#####.
`);
const SWITCH_OFF = parseBitmap(`
  .#####.
  #.....#
  #.....#
  #.....#
  #.....#
  #.....#
  #.....#
  #.###.#
  #.###.#
  #.###.#
  #.###.#
  #.....#
  .#####.
`);

/** Values of up to 6 characters stay on one line (CENTER); longer ones break, hyphenated (IMME-DIATE). */
const VALUES = new WrapCache(FONT_SMALL, 35, 2, true);
/** Names break at spaces and hyphenate, up to three lines above the bottom edge. */
const LABELS = new WrapCache(FONT_SMALL, 31, 3, true);

const CENTER = { align: 'center', width: 32 } as const;
const RIGHT = { align: 'right', width: 32 } as const;
const LEFT = {} as const;

export interface ParamPageOptions {
  /** The `*` of the wildcard ids (a track 0-4, a channel name): one for all of them, or one per parameter. */
  index?: string | number | ((def: ParamDef) => string | number);
  /** The page to start on. */
  page?: number;
}

/** A parameter bound to its place in the settings, resolved once so that drawing walks a short path and allocates nothing. */
interface Bound {
  readonly def: ParamDef;
  readonly id: string;
  readonly path: readonly string[];
  readonly system: boolean;
  lastValue: unknown;
  lastText: string;
}

function bind(def: ParamDef, index: string | number | undefined): Bound {
  let id = def.id;
  if (id.includes('*')) {
    if (index === undefined) throw new Error(`paramPage: ${def.id} needs an index`);
    id = id.replace('*', String(index));
  }
  if (!findParam(id)) throw new Error(`paramPage: unknown parameter ${id}`);
  return { def, id, path: id.split('.'), system: def.scope === 'system', lastValue: undefined, lastText: '' };
}

function read(p: Bound, ctx: Controller): unknown {
  // the settings in effect: a PREFERENCE = MEMORY group shows (and steps from) the memory's value
  let node: unknown = p.system ? ctx.session.effectiveSystem : ctx.session.memory;
  for (const key of p.path) node = (node as Record<string, unknown>)[key];
  return node;
}

class ParamPage implements Screen {
  private readonly bound: Bound[];
  private page: number;

  constructor(readonly title: string, params: readonly ParamDef[], opts: ParamPageOptions) {
    const idx = opts.index;
    this.bound = params.map((d) => bind(d, typeof idx === 'function' ? idx(d) : idx));
    this.page = Math.min(Math.max(0, opts.page ?? 0), Math.max(0, this.pageCount - 1));
  }

  private get pageCount(): number {
    return Math.max(1, Math.ceil(this.bound.length / 4));
  }

  render(fb: Framebuffer, ctx: Controller): void {
    drawTitleBar(fb, this.title);
    drawPageArrows(fb, this.page > 0, this.page < this.pageCount - 1);
    for (let i = 0; i < 4; i++) {
      const p = this.bound[this.page * 4 + i];
      if (!p) break;
      const x0 = 32 * i;
      const v = read(p, ctx);
      if (v !== p.lastValue || p.lastText === '') {
        p.lastValue = v;
        p.lastText = p.def.display(v);
      }
      // value: wider than its quarter, it starts at the left edge in knob [1]'s column and ends at the right in [4]'s
      const lines = VALUES.get(p.lastText);
      for (let k = 0; k < lines.length; k++) {
        const s = lines[k]!;
        const wide = s.length > 5;
        if (wide && i === 0) text(fb, 0, 11 + 8 * k, s, FONT_SMALL, LEFT);
        else if (wide && i === 3) text(fb, x0, 11 + 8 * k, s, FONT_SMALL, RIGHT);
        else text(fb, x0, 11 + 8 * k, s, FONT_SMALL, CENTER);
      }
      if (p.def.kind === 'bool') fb.blit(v ? SWITCH_ON : SWITCH_OFF, x0 + 12, 27);
      else drawDial(fb, x0 + 16, 33, paramFraction(p.def, v));
      const name = LABELS.get(p.def.label);
      for (let k = 0; k < name.length; k++) text(fb, x0, 57 - 8 * (name.length - 1 - k), name[k]!, FONT_SMALL, CENTER);
    }
  }

  onEvent(e: ControlEvent, ctx: Controller): ScreenResult {
    if (e.kind === 'turn') {
      const i = knobIndex(e.id);
      const p = i >= 0 ? this.bound[this.page * 4 + i] : undefined;
      if (p) {
        const next = stepParam(p.def, read(p, ctx), turnSteps(e, ctx));
        ctx.setParam(p.id, next);
      }
      return 'handled';
    }
    if (e.kind !== 'press') return 'unhandled';
    switch (e.id) {
      case 'exit':
        return 'pop';
      case 'left':
        this.page = Math.max(0, this.page - 1);
        return 'handled';
      case 'right':
        this.page = Math.min(this.pageCount - 1, this.page + 1);
        return 'handled';
      case 'knob1': case 'knob2': case 'knob3': case 'knob4': {
        const p = this.bound[this.page * 4 + knobIndex(e.id)];
        if (p && p.def.kind === 'bool') ctx.setParam(p.id, !read(p, ctx));
        return 'handled';
      }
    }
    return 'unhandled';
  }
}

/** A round knob drawn as a disc with a pointer, swept from 7 o'clock (0) to 5 o'clock (1), and a dot at each end. */
function drawDial(fb: Framebuffer, cx: number, cy: number, f: number): void {
  for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) if (dx * dx + dy * dy <= 38) fb.set(cx + dx, cy + dy);
  const a = ((-135 + 270 * f) * Math.PI) / 180;
  const sx = Math.sin(a), sy = -Math.cos(a);
  for (let t = 0; t <= 5; t++) fb.set(cx + Math.round(sx * t), cy + Math.round(sy * t), 0);
  fb.set(cx - 7, cy + 6);
  fb.set(cx + 7, cy + 6);
}

/**
 * A page of parameters on knobs [1]-[4] (more than four paginate: ◀ ▶). `params` with a `*` in their id need `opts.index`.
 * EXIT pops the screen; the caller supplies the title (e.g. "TRACK1").
 */
export function paramPage(title: string, params: readonly ParamDef[], opts: ParamPageOptions = {}): Screen {
  return new ParamPage(title, params, opts);
}


