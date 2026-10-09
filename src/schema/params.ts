/**
 * Parameter registry access for Sage MK1: lookup by dotted id, and getParam / setParam.
 *
 * Every parameter name, range and default in the app comes from this schema, transcribed from the BOSS RC-505mkII
 * Parameter Guide v1.3. MEMORY_PARAMS (memory.ts) and SYSTEM_PARAMS (system.ts) are the two registries; this module
 * re-exports them with the helpers that read and write the settings objects.
 *
 * ID CONVENTION
 *   - An id is a dotted path into MemorySettings or SystemSettings: 'rec.quantize', 'mixer.mic1In', 'setup.contrast'.
 *   - A `*` segment stands for an index. The ParamDef lists the allowed values in `indices`:
 *       'track.*.playLevel'          * = the track 0-4
 *       'rec.bounceTrack.*'          * = the track 0-4 (an element of a boolean[5])
 *       'input.eq.*.loGain'          * = the input channel 'MIC1' | 'MIC2' | 'INST1L' | 'INST1R' | 'INST2L' | 'INST2R'
 *       'output.eq.*.loGain'         * = the output channel 'MAINL' | 'MAINR' | 'SUB1L' | 'SUB1R' | 'SUB2L' | 'SUB2R'
 *       'output.routing.track.MAINL.*'        * = the track 0-4 sent to that jack
 *       'output.routing.inputRhythm.MAIN.*'   * = the source 'MIC1' ... 'INST2R' | 'RHYTHM' sent to that output
 *       'assign.*.target'            * = the ASSIGN number 0-15 (ASSIGN 1-16)
 *     An id has at most one `*`. Params whose defaults differ per index (the PANEL buttons, KNOB FUNC 1-4, EXP1/EXP2,
 *     STEREO LINK of INPUT) have no `*`: each index is its own id ('ctl.panelPlay.track.0', 'setup.knobFunc.3').
 *   - getParam(obj, id, index) / setParam(obj, id, value, index): pass the wildcard id and the index as the last
 *     argument ('track.*.pan', 2). `index` is the key itself ('MIC1', 2) or the position in `indices`, which for tracks
 *     is the track number. A concrete id works too: getParam(m, 'track.2.pan') and getParam(s, 'input.eq.MIC1.loGain').
 *   - The stored value is the one the guide shows: booleans for OFF/ON, numbers for numeric params, the value string for
 *     enums, 'OFF'/'AUTO'/'FLAT' strings where a numeric param also accepts a keyword, { note } / { measures } for
 *     MEASURE and FADE TIME, and a Beat for BEAT.
 *   - setParam validates and normalizes: numbers are rounded (ints) or snapped (steps, EQ series) and clamped to the
 *     range; an unknown enum value, a wrong type or a bad index throws (TypeError / RangeError). It mutates `obj` in
 *     place and returns the value that was stored.
 */

import { MEMORY_PARAMS } from './memory';
import { SYSTEM_PARAMS } from './system';
import { parseBeat } from './format';
import { NOTE_VALUES } from './types';
import type { MemorySettings, ParamDef, SystemSettings } from './types';

export { MEMORY_PARAMS, defaultMemory } from './memory';
export { SYSTEM_PARAMS, defaultSystem } from './system';
export { concreteIds, TRACK_INDICES } from './define';
export {
  PANEL_FUNCTIONS, CTL_FUNCTIONS, EXP_FUNCTIONS, KNOB_FUNCS, ASSIGN_SOURCES, ASSIGN_TARGETS, expand,
} from './functions';
export type { PanelFunction } from './functions';
export { RHYTHM_GENRES, RHYTHM_KITS, GUIDE_PATTERNS, FACTORY_RESET_TARGETS } from './lists';

type Index = number | string;
type Settings = MemorySettings | SystemSettings;

const ALL: readonly ParamDef[] = [...MEMORY_PARAMS, ...SYSTEM_PARAMS];
const exact = new Map<string, ParamDef>(ALL.map((d) => [d.id, d]));
const wild = ALL.filter((d) => d.id.includes('*')).map((def) => {
  const segs = def.id.split('.');
  return { def, segs, at: segs.indexOf('*') };
});

/** Finds a definition by its registered id ('track.*.pan') or by a concrete id ('track.2.pan'; `index` is then the matched key). */
export function findParam(id: string): { def: ParamDef; index?: string } | undefined {
  const def = exact.get(id);
  if (def) return { def };
  const segs = id.split('.');
  for (const w of wild) {
    if (w.segs.length !== segs.length) continue;
    if (!w.segs.every((s, i) => i === w.at || s === segs[i])) continue;
    const key = segs[w.at]!;
    if (w.def.indices!.some((k) => String(k) === key)) return { def: w.def, index: key };
  }
  return undefined;
}

function indexKey(def: ParamDef, index: Index | undefined): string {
  if (index === undefined) throw new Error(`parameter ${def.id} needs an index (${def.indices!.join(', ')})`);
  const list = def.indices!;
  if (typeof index === 'number') {
    const key = list[index];
    if (key === undefined) throw new RangeError(`${def.id}: index ${index} is out of range (0..${list.length - 1})`);
    return String(key);
  }
  if (!list.some((k) => String(k) === index)) throw new RangeError(`${def.id}: index ${index} is not one of ${list.join(', ')}`);
  return index;
}

function resolve(id: string, index: Index | undefined): { def: ParamDef; path: string[] } {
  const hit = findParam(id);
  if (!hit) throw new Error(`unknown parameter id: ${id}`);
  const segs = id.split('.');
  const at = hit.def.id.split('.').indexOf('*');
  if (at >= 0) segs[at] = hit.index ?? indexKey(hit.def, index);
  return { def: hit.def, path: segs };
}

function locate(obj: Settings, id: string, path: readonly string[]): { parent: Record<string, unknown>; key: string } {
  let node = obj as unknown as Record<string, unknown>;
  for (let i = 0; i < path.length - 1; i++) {
    const next = node[path[i]!];
    if (next === null || typeof next !== 'object') throw new Error(`parameter ${id} is not present in this settings object`);
    node = next as Record<string, unknown>;
  }
  const key = path[path.length - 1]!;
  if (!(key in node)) throw new Error(`parameter ${id} is not present in this settings object`);
  return { parent: node, key };
}

/** Reads a parameter. For object values (MEASURE, FADE TIME, BEAT) this is the live object, not a copy. */
export function getParam(obj: Settings, id: string, index?: Index): unknown {
  const { path } = resolve(id, index);
  const { parent, key } = locate(obj, id, path);
  return parent[key];
}

/** Validates and writes a parameter in place; returns the value that was stored (clamped, rounded or snapped). */
export function setParam(obj: Settings, id: string, value: unknown, index?: Index): unknown {
  const { def, path } = resolve(id, index);
  const stored = coerce(def, value);
  const { parent, key } = locate(obj, id, path);
  parent[key] = stored;
  return stored;
}

// ---------------------------------------------------------------------------------------------------------------------

function coerce(d: ParamDef, v: unknown): unknown {
  switch (d.kind) {
    case 'bool':
      if (typeof v !== 'boolean') throw new TypeError(`${d.id}: expected a boolean`);
      return v;
    case 'int':
    case 'float':
      return coerceNumber(d, v);
    case 'enum':
      if (typeof v !== 'string' || !d.values!.includes(v)) throw new RangeError(`${d.id}: ${String(v)} is not one of ${d.values!.join(', ')}`);
      return v;
    case 'text':
      if (typeof v !== 'string') throw new TypeError(`${d.id}: expected a string`);
      return v.slice(0, d.max);
    case 'note':
      return coerceNote(d, v);
    case 'beat':
      return coerceBeat(d, v);
  }
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

function coerceNumber(d: ParamDef, v: unknown): number | string {
  if (typeof v === 'string') {
    if (d.values?.includes(v) || d.choices?.includes(v)) return v;
    throw new RangeError(`${d.id}: ${v} is not a valid value`);
  }
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new TypeError(`${d.id}: expected a number`);
  if (d.choices) {
    // snap to the nearest numeric choice (the lower one on a tie)
    let best: number | undefined;
    for (const c of d.choices) {
      if (typeof c === 'number' && (best === undefined || Math.abs(c - v) < Math.abs(best - v))) best = c;
    }
    return best!;
  }
  if (d.kind === 'int') return clamp(Math.round(v), d.min!, d.max!);
  if (d.step) {
    const decimals = (String(d.step).split('.')[1] ?? '').length;
    const snapped = Math.round((clamp(v, d.min!, d.max!) - d.min!) / d.step) * d.step + d.min!;
    return clamp(Number(snapped.toFixed(decimals)), d.min!, d.max!);
  }
  return clamp(v, d.min!, d.max!);
}

function coerceNote(d: ParamDef, v: unknown): unknown {
  if (typeof v === 'string') {
    if (d.values?.includes(v)) return v;
    throw new RangeError(`${d.id}: ${v} is not a valid value`);
  }
  if (v !== null && typeof v === 'object') {
    const o = v as { note?: unknown; measures?: unknown };
    if (typeof o.note === 'string') {
      if (NOTE_VALUES.includes(o.note)) return { note: o.note };
      throw new RangeError(`${d.id}: ${o.note} is not a note length`);
    }
    if (typeof o.measures === 'number' && Number.isFinite(o.measures)) return { measures: clamp(Math.round(o.measures), d.min!, d.max!) };
  }
  throw new TypeError(`${d.id}: expected a note length or a number of measures`);
}

function coerceBeat(d: ParamDef, v: unknown): unknown {
  let label: string | undefined;
  if (typeof v === 'string') label = v;
  else if (v !== null && typeof v === 'object' && 'num' in v && 'den' in v) label = `${(v as { num: number }).num}/${(v as { den: number }).den}`;
  if (label === undefined) throw new TypeError(`${d.id}: expected a beat`);
  if (!d.values!.includes(label)) throw new RangeError(`${d.id}: ${label} is not a valid beat`);
  return parseBeat(label);
}
