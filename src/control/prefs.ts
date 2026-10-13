/**
 * PREFERENCE = MEMORY (ruling R26). Each PREFERENCE switch (MENU > INPUT/OUTPUT SETUP, CTL FUNC > PREFERENCE) decides
 * whether its group of settings comes from the system settings or from the current memory (`memory.prefs`).
 *
 *  - The settings in effect, what the engine is sent and what the screens and buttons read, are the system settings
 *    with every MEMORY group taken from `memory.prefs` (`effectiveSystem`). Where the memory holds nothing for a group
 *    (it was never written with that group on MEMORY) the system value stays in effect.
 *  - Editing a parameter of a MEMORY group writes `memory.prefs` and makes the memory unsaved; WRITE stores it.
 *  - WRITE snapshots the groups in effect into `memory.prefs` (`snapshotPrefs`).
 *
 * `memory.prefs` holds whole top-level system groups (`input`, `output`, `master`, `ctl`): that is what
 * `reconcileMemory` validates a stored or imported file against, and a whole copy keeps the values of the other
 * groups under the same key real (a partial copy would read back with defaults filled in).
 *
 * The guide only says "the MIC 1, 2 and INST 1, 2 settings", "the settings for each output jack", "the rhythm sounds",
 * "the MASTER FX settings" and the CTL FUNC tables. The parameters each group covers below are INFERRED from the MENU
 * pages those switches sit next to. The MIXER levels, INPUT THRU and the hardware-only setup switches stay system
 * settings.
 */

import { findParam } from '../schema/params';
import type { MemorySettings, SystemSettings } from '../schema/types';

type Top = 'input' | 'output' | 'master' | 'ctl';

export interface PrefGroup {
  /** The concrete id of the PREFERENCE switch. */
  readonly pref: string;
  /** The top-level system group the paths live in (the key of `memory.prefs`). */
  readonly top: Top;
  /** Dotted paths (a parameter, or a branch of them) the switch moves to the memory. */
  readonly paths: readonly string[];
  /** The switch is set to MEMORY in `s`. */
  on(s: SystemSettings): boolean;
}

const OUT_EQ_ROUTING = (jack: 'MAIN' | 'SUB1' | 'SUB2'): string[] => [
  `output.eq.${jack}L`, `output.eq.${jack}R`, `output.routing.track.${jack}L`, `output.routing.track.${jack}R`, `output.routing.inputRhythm.${jack}`,
];

export const PREF_GROUPS: readonly PrefGroup[] = [
  {
    pref: 'input.preference.MIC', top: 'input', on: (s) => s.input.preference.MIC === 'MEMORY',
    paths: ['input.eq.MIC1', 'input.eq.MIC2', 'input.dynamics.mic1Comp', 'input.dynamics.mic1Ns', 'input.dynamics.mic2Comp', 'input.dynamics.mic2Ns'],
  },
  {
    pref: 'input.preference.INST1', top: 'input', on: (s) => s.input.preference.INST1 === 'MEMORY',
    paths: ['input.eq.INST1L', 'input.eq.INST1R', 'input.dynamics.inst1Ns'],
  },
  {
    pref: 'input.preference.INST2', top: 'input', on: (s) => s.input.preference.INST2 === 'MEMORY',
    paths: ['input.eq.INST2L', 'input.eq.INST2R', 'input.dynamics.inst2Ns'],
  },
  { pref: 'output.preference.MAIN', top: 'output', on: (s) => s.output.preference.MAIN === 'MEMORY', paths: OUT_EQ_ROUTING('MAIN') },
  { pref: 'output.preference.SUB1', top: 'output', on: (s) => s.output.preference.SUB1 === 'MEMORY', paths: OUT_EQ_ROUTING('SUB1') },
  { pref: 'output.preference.SUB2', top: 'output', on: (s) => s.output.preference.SUB2 === 'MEMORY', paths: OUT_EQ_ROUTING('SUB2') },
  {
    pref: 'output.preference.PHONES', top: 'output', on: (s) => s.output.preference.PHONES === 'MEMORY',
    paths: ['output.routing.track.PHONES', 'output.routing.inputRhythm.PHONES', 'output.routing.phonesRhythm', 'output.routing.phonesOut', 'output.routing.phonesMonitor'],
  },
  { pref: 'output.preference.RHYTHM', top: 'output', on: (s) => s.output.preference.RHYTHM === 'MEMORY', paths: ['output.routing.rhythmOut'] },
  { pref: 'output.preference.MFX', top: 'master', on: (s) => s.output.preference.MFX === 'MEMORY', paths: ['master'] },
  { pref: 'ctl.preference.modePlay', top: 'ctl', on: (s) => s.ctl.preference.modePlay === 'MEMORY', paths: ['ctl.panelPlay'] },
  { pref: 'ctl.preference.modeUndo', top: 'ctl', on: (s) => s.ctl.preference.modeUndo === 'MEMORY', paths: ['ctl.panelUndo'] },
  { pref: 'ctl.preference.footswitch', top: 'ctl', on: (s) => s.ctl.preference.footswitch === 'MEMORY', paths: ['ctl.footswitch'] },
  { pref: 'ctl.preference.exp', top: 'ctl', on: (s) => s.ctl.preference.exp === 'MEMORY', paths: ['ctl.exp'] },
];

const within = (id: string, path: string): boolean => id === path || (id.startsWith(path) && id[path.length] === '.');

/** The group a concrete system parameter id belongs to, or undefined (it is always a system setting). */
export function prefGroupOf(id: string): PrefGroup | undefined {
  for (const g of PREF_GROUPS) for (const p of g.paths) if (within(id, p)) return g;
  return undefined;
}

/** Any PREFERENCE switch of `s` is on MEMORY. */
export function anyMemoryGroup(s: SystemSettings): boolean {
  for (const g of PREF_GROUPS) if (g.on(s)) return true;
  return false;
}

/**
 * The concrete id of a parameter: `id` itself when it has no `*` (or is already concrete), else its `*` replaced by
 * `index` (the key, or the position in the parameter's `indices`). Undefined for an unknown id or a bad index (the
 * schema reports those when the value is set).
 */
export function concreteId(id: string, index?: number | string): string | undefined {
  const hit = findParam(id);
  if (!hit) return undefined;
  if (!hit.def.id.includes('*') || hit.index !== undefined) return id;
  const list = hit.def.indices ?? [];
  const key = typeof index === 'number' ? list[index] : list.find((k) => String(k) === index);
  return key === undefined ? undefined : id.replace('*', String(key));
}

function getPath(root: unknown, path: string): unknown {
  let node = root;
  for (const key of path.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

function setPath(root: object, path: string, value: unknown): void {
  const keys = path.split('.');
  let node = root as Record<string, unknown>;
  for (let i = 0; i < keys.length - 1; i++) node = node[keys[i]!] as Record<string, unknown>;
  node[keys[keys.length - 1]!] = value;
}

const sameShape = (a: unknown, b: unknown): boolean =>
  typeof a === typeof b && Array.isArray(a) === Array.isArray(b) && (a === null) === (b === null);

/**
 * The system settings in effect: `system` with each MEMORY group's values taken from `prefs` where it has them. When
 * no switch is on MEMORY this is `system` itself; otherwise a fresh copy (neither argument is changed).
 */
export function effectiveSystem(system: SystemSettings, prefs: MemorySettings['prefs']): SystemSettings {
  if (!anyMemoryGroup(system)) return system;
  const out = structuredClone(system);
  for (const g of PREF_GROUPS) {
    if (!g.on(system)) continue;
    for (const path of g.paths) {
      const v = getPath(prefs, path);
      if (v === undefined || !sameShape(v, getPath(out, path))) continue;
      setPath(out, path, structuredClone(v));
    }
  }
  return out;
}

/**
 * Copies the top-level groups that hold a MEMORY switch from `effective` (the settings in effect) into `prefs`, in
 * place: what WRITE stores with the memory. Returns true when a group was copied.
 */
export function snapshotPrefs(system: SystemSettings, effective: SystemSettings, prefs: MemorySettings['prefs']): boolean {
  const tops = new Set<Top>();
  for (const g of PREF_GROUPS) if (g.on(system)) tops.add(g.top);
  const out = prefs as Record<string, unknown>;
  for (const top of tops) out[top] = structuredClone(effective[top]);
  return tops.size > 0;
}
