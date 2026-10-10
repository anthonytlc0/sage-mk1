import { defaultMemory, defaultSystem, findParam, getParam, setParam } from '../schema/params';
import type { MemorySettings, SystemSettings } from '../schema/types';

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
 */
export class Session {
  /** The current memory slot, 1-99. */
  slot: number;
  memory: MemorySettings;
  system: SystemSettings;
  /** The tempo stored in the memory as loaded or last written: TAP TEMPO's long-press returns to it. */
  savedTempo: number;
  /** A memory parameter changed since load/write. */
  paramsDirty = false;
  /** The engine reported changed audio since load/write. */
  audioDirty = false;

  constructor(slot = 1, memory: MemorySettings = defaultMemory(), system: SystemSettings = defaultSystem()) {
    this.slot = slot;
    this.memory = memory;
    this.system = system;
    this.savedTempo = memory.tempo;
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

  get(id: string, index?: number | string): unknown {
    return getParam(this.objectFor(this.scopeOf(id)), id, index);
  }

  /**
   * Validates and stores a parameter in the memory or the system settings, by its schema scope. A memory parameter that
   * actually changed marks the memory dirty. Throws (TypeError / RangeError / Error) for a bad id, index or value.
   */
  set(id: string, value: unknown, index?: number | string): { scope: SettingsScope; changed: boolean } {
    const scope = this.scopeOf(id);
    const obj = this.objectFor(scope);
    const before = getParam(obj, id, index);
    const after = setParam(obj, id, value, index);
    const changed = !sameValue(before, after);
    if (changed && scope === 'memory') this.paramsDirty = true;
    return { scope, changed };
  }

  /** Makes `memory` the current memory of `slot`, unchanged and saved. */
  load(slot: number, memory: MemorySettings): void {
    this.slot = slot;
    this.memory = memory;
    this.savedTempo = memory.tempo;
    this.paramsDirty = false;
    this.audioDirty = false;
  }

  /** The current memory was just written to `slot`. */
  markSaved(slot: number): void {
    this.slot = slot;
    this.savedTempo = this.memory.tempo;
    this.paramsDirty = false;
    this.audioDirty = false;
  }

  private objectFor(scope: SettingsScope): MemorySettings | SystemSettings {
    return scope === 'system' ? this.system : this.memory;
  }
}

/** Equality of stored parameter values: primitives by value, MEASURE / FADE TIME / BEAT objects by content. */
function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}
