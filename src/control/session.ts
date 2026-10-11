import { defaultMemory, defaultSystem, findParam, getParam, setParam } from '../schema/params';
import type { MemorySettings, SystemSettings } from '../schema/types';
import { anyMemoryGroup, concreteId, effectiveSystem, prefGroupOf, snapshotPrefs } from './prefs';
import type { PrefGroup } from './prefs';

/** Which settings object a parameter lives in. */
export type SettingsScope = 'memory' | 'system';

/**
 * The working state of the unit: the current memory (slot, settings, unsaved flags) and the system settings.
 *
 * You work in the current memory; WRITE saves it and changing memory discards unsaved edits, as on the hardware.
 * `dirty` is true when a memory parameter changed or the engine reported a change to the audio (`audioDirty`) since the
 * memory was loaded or written. System settings are saved on their own (the controller persists them on change), so
 * they never make the memory dirty.
 *
 * Every write goes through the schema's `setParam`, which validates, clamps and snaps in one place.
 *
 * PREFERENCE = MEMORY (prefs.ts, ruling R26): `system` holds the system settings as stored; `effectiveSystem` is what
 * is in effect, with the groups whose PREFERENCE is MEMORY taken from `memory.prefs`. `get` reads the settings in
 * effect, and `set` on a parameter of a MEMORY group writes `memory.prefs` (a memory change). Change the settings
 * through `set` (or by assigning `memory` / `system`), not by writing into the objects, or `effectiveSystem` goes stale.
 */
export class Session {
  /** The current memory slot, 1-99. */
  slot: number;
  private _memory: MemorySettings;
  private _system: SystemSettings;
  /** Bumped by every change, so the cached settings in effect are rebuilt only when something changed. */
  private rev = 0;
  private effective: { rev: number; value: SystemSettings } | null = null;
  /** The tempo stored in the memory as loaded or last written: TAP TEMPO's long-press returns to it. */
  savedTempo: number;
  /** A memory parameter changed since load/write. */
  paramsDirty = false;
  /** The engine reported changed audio since load/write. */
  audioDirty = false;

  constructor(slot = 1, memory: MemorySettings = defaultMemory(), system: SystemSettings = defaultSystem()) {
    this.slot = slot;
    this._memory = memory;
    this._system = system;
    this.savedTempo = memory.tempo;
  }

  get memory(): MemorySettings {
    return this._memory;
  }
  set memory(m: MemorySettings) {
    this._memory = m;
    this.rev++;
  }

  /** The system settings as stored (what the system store saves). */
  get system(): SystemSettings {
    return this._system;
  }
  set system(s: SystemSettings) {
    this._system = s;
    this.rev++;
  }

  /**
   * The system settings in effect: `system` with the PREFERENCE = MEMORY groups taken from `memory.prefs`. It is
   * `system` itself while every switch is SYSTEM; otherwise a copy, cached until the next change. Read it, never write it.
   */
  get effectiveSystem(): SystemSettings {
    if (!anyMemoryGroup(this._system)) return this._system;
    if (this.effective === null || this.effective.rev !== this.rev) {
      this.effective = { rev: this.rev, value: effectiveSystem(this._system, this._memory.prefs) };
    }
    return this.effective.value;
  }

  get dirty(): boolean {
    return this.paramsDirty || this.audioDirty;
  }

  /** Where `id` is stored. Throws for an unknown id. */
  scopeOf(id: string): SettingsScope {
    const hit = findParam(id);
    if (!hit) throw new Error(`unknown parameter id: ${id}`);
    return hit.def.scope === 'system' ? 'system' : 'memory';
  }

  /** A parameter's value in effect (a system parameter of a MEMORY group reads `memory.prefs`). */
  get(id: string, index?: number | string): unknown {
    const scope = this.scopeOf(id);
    return getParam(scope === 'system' ? this.effectiveSystem : this._memory, id, index);
  }

  /**
   * Validates and stores a parameter in the memory or the system settings, by its schema scope. A system parameter
   * whose PREFERENCE group is on MEMORY is stored in `memory.prefs` instead, and reported with scope 'memory'. A memory
   * change marks the memory dirty. Throws (TypeError / RangeError / Error) for a bad id, index or value.
   */
  set(id: string, value: unknown, index?: number | string): { scope: SettingsScope; changed: boolean } {
    const scope = this.scopeOf(id);
    if (scope === 'system') {
      const concrete = concreteId(id, index);
      const group = concrete === undefined ? undefined : prefGroupOf(concrete);
      if (group && group.on(this._system)) return this.setPref(group, id, value, index);
    }
    const obj = this.objectFor(scope);
    const before = getParam(obj, id, index);
    const after = setParam(obj, id, value, index);
    const changed = !sameValue(before, after);
    if (changed) this.rev++;
    if (changed && scope === 'memory') this.paramsDirty = true;
    return { scope, changed };
  }

  /**
   * Copies the PREFERENCE = MEMORY groups in effect into `memory.prefs` (what WRITE stores). The settings in effect
   * do not change, so neither does `dirty`.
   */
  snapshotPrefs(): void {
    if (snapshotPrefs(this._system, this.effectiveSystem, this._memory.prefs)) this.rev++;
  }

  /** Makes `memory` the current memory of `slot`, unchanged and saved. */
  load(slot: number, memory: MemorySettings): void {
    this.slot = slot;
    this.memory = memory;
    this.savedTempo = memory.tempo;
    this.paramsDirty = false;
    this.audioDirty = false;
  }

  /**
   * `saved`, a snapshot of the current memory, was just written to `slot`. Edits made after the snapshot stay unsaved,
   * and so does the audio when `audioChangedSince` (the engine reported a change after the tracks were requested).
   */
  markSaved(slot: number, saved: MemorySettings, audioChangedSince: boolean): void {
    this.slot = slot;
    this.savedTempo = saved.tempo;
    this.paramsDirty = JSON.stringify(saved) !== JSON.stringify(this.memory);
    this.audioDirty = audioChangedSince;
  }

  private objectFor(scope: SettingsScope): MemorySettings | SystemSettings {
    return scope === 'system' ? this._system : this._memory;
  }

  /** `set` for a parameter of a MEMORY group: the value goes into `memory.prefs`, the group copied in first if needed. */
  private setPref(group: PrefGroup, id: string, value: unknown, index?: number | string): { scope: SettingsScope; changed: boolean } {
    const effective = this.effectiveSystem;
    const before = getParam(effective, id, index);
    const prefs = this._memory.prefs as unknown as SystemSettings;
    try {
      getParam(prefs, id, index);
    } catch {
      // the memory holds nothing for this group yet: start from the values in effect
      (prefs as unknown as Record<string, unknown>)[group.top] = structuredClone(effective[group.top]);
    }
    const after = setParam(prefs, id, value, index);
    const changed = !sameValue(before, after);
    this.rev++;
    if (changed) this.paramsDirty = true;
    return { scope: 'memory', changed };
  }
}

/** Equality of stored parameter values: primitives by value, MEASURE / FADE TIME / BEAT objects by content. */
function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}
