import type { ParamDef } from './types';
import { formatBeat, formatNoteOrMeasures, onOff, plain } from './format';

/** Builders for ParamDef tables (used by memory.ts and system.ts) and the helpers that turn a table into default objects. */

export type Scope = ParamDef['scope'];
export type Phase = ParamDef['phase'];
export type Index = string | number;

/** The `*` of per-track ids: tracks 1-5 as 0-4. */
export const TRACK_INDICES: readonly number[] = [0, 1, 2, 3, 4];

export interface Opts {
  phase?: Phase;
  scope?: Scope;
  indices?: readonly Index[];
  display?: (v: unknown) => string;
  /** int/float: numeric step (float rounds to it). */
  step?: number;
  /** int/float: complete ordered list of allowed values. */
  choices?: readonly Index[];
  /** int/float/note: keyword values accepted besides the numbers. */
  keywords?: readonly string[];
  hidden?: boolean;
}

export class ParamTable {
  readonly defs: ParamDef[] = [];
  constructor(readonly scope: Scope) {}
  /** Starts a section (a guide page/heading). `base` options apply to every param of the section. */
  section(name: string, phase: Phase = 1, base: Opts = {}): Section {
    return new Section(this, name, phase, base);
  }
  add(def: ParamDef): ParamDef {
    if (this.defs.some((d) => d.id === def.id)) throw new Error(`duplicate parameter id ${def.id}`);
    if (def.id.split('.').filter((s) => s === '*').length > 1) throw new Error(`more than one * in ${def.id}`);
    this.defs.push(def);
    return def;
  }
}

export class Section {
  constructor(private readonly t: ParamTable, private readonly name: string, private readonly phase: Phase, private readonly base: Opts) {}

  private make(id: string, label: string, kind: ParamDef['kind'], defaultValue: unknown, display: (v: unknown) => string, o: Opts | undefined, extra: Partial<ParamDef> = {}): ParamDef {
    const opt: Opts = { ...this.base, ...o };
    const def: ParamDef = {
      id, label, kind, default: defaultValue, scope: opt.scope ?? this.t.scope, display: opt.display ?? display,
      phase: opt.phase ?? this.phase, section: this.name, ...extra,
    };
    if (opt.indices) def.indices = opt.indices;
    if (opt.choices) def.choices = opt.choices;
    if (opt.step !== undefined) def.step = opt.step;
    if (opt.keywords) def.values = opt.keywords;
    if (opt.hidden) def.hidden = true;
    return this.t.add(def);
  }

  bool(id: string, label: string, defaultValue: boolean, o?: Opts): ParamDef {
    return this.make(id, label, 'bool', defaultValue, onOff, o);
  }
  int(id: string, label: string, min: number, max: number, defaultValue: number | string, o?: Opts): ParamDef {
    return this.make(id, label, 'int', defaultValue, plain, o, { min, max });
  }
  float(id: string, label: string, min: number, max: number, defaultValue: number | string, o?: Opts): ParamDef {
    return this.make(id, label, 'float', defaultValue, plain, o, { min, max });
  }
  enum(id: string, label: string, values: readonly string[], defaultValue: string, o?: Opts): ParamDef {
    if (!values.includes(defaultValue)) throw new Error(`${id}: default ${defaultValue} is not one of its values`);
    return this.make(id, label, 'enum', defaultValue, plain, o, { values });
  }
  /** A MeasureSetting / FadeTime: keywords, a note from NOTE_VALUES, or `{ measures }` in min..max. */
  note(id: string, label: string, keywords: readonly string[], min: number, max: number, defaultValue: unknown, o?: Opts & { suffix?: string }): ParamDef {
    return this.make(id, label, 'note', defaultValue, formatNoteOrMeasures(o?.suffix ?? ''), o, { min, max, values: keywords });
  }
  /** Text up to `maxLen` characters. */
  text(id: string, label: string, maxLen: number, defaultValue: string, o?: Opts): ParamDef {
    return this.make(id, label, 'text', defaultValue, plain, o, { max: maxLen });
  }
  beat(id: string, label: string, values: readonly string[], defaultValue: unknown, o?: Opts): ParamDef {
    return this.make(id, label, 'beat', defaultValue, formatBeat, o, { values });
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Table helpers
// ---------------------------------------------------------------------------------------------------------------------

/** All concrete ids of a param: its `*` replaced by each index, or the id itself when it has no `*`. */
export function concreteIds(def: ParamDef): string[] {
  if (!def.id.includes('*')) return [def.id];
  return (def.indices ?? []).map((i) => def.id.replace('*', String(i)));
}

/** Writes `value` at `path`, creating the containers: an array when the next segment is a number, otherwise an object. */
export function setPathCreating(root: Record<string, unknown>, path: readonly string[], value: unknown): void {
  let node: Record<string, unknown> = root;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]!;
    let next = node[key];
    if (next === undefined) {
      next = /^\d+$/.test(path[i + 1]!) ? [] : {};
      node[key] = next;
    }
    node = next as Record<string, unknown>;
  }
  node[path[path.length - 1]!] = value;
}

/** Builds the nested default object of a table. Every default is cloned, so the result shares nothing with the registry. */
export function buildDefaults(defs: readonly ParamDef[]): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const d of defs) {
    for (const id of concreteIds(d)) setPathCreating(root, id.split('.'), structuredClone(d.default));
  }
  return root;
}
