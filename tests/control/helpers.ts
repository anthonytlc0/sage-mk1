import { Controller } from '../../src/control/controller';
import type { LcdHost, Stores } from '../../src/control/controller';
import type { ScreenRequest } from '../../src/control/buttons';
import { FakeEngine } from '../../src/control/fakeEngine';
import { QuotaError } from '../../src/storage/db';
import { defaultSystem } from '../../src/schema/params';
import type { Framebuffer } from '../../src/lcd/framebuffer';
import type { MemorySettings, SystemSettings } from '../../src/schema/types';
import type { TrackAudio } from '../../src/shared/protocol';
import type { AbsoluteId, ButtonId, ControlEvent, EncoderId } from '../../src/shared/ids';

/** In-memory stand-ins for the IndexedDB stores, shaped like `Stores`. */
export class MemMemories {
  readonly slots = new Map<number, { settings: MemorySettings; tracks: (TrackAudio | null)[] }>();
  /** When true, `save` rejects with QuotaError (MEMORY FULL). */
  full = false;
  saves = 0;
  async load(slot: number): Promise<{ settings: MemorySettings; tracks: (TrackAudio | null)[] } | null> {
    const rec = this.slots.get(slot);
    return rec ? { settings: structuredClone(rec.settings), tracks: rec.tracks.slice() } : null;
  }
  async save(slot: number, settings: MemorySettings, tracks: (TrackAudio | null)[]): Promise<void> {
    if (this.full) throw new QuotaError();
    this.saves++;
    this.slots.set(slot, { settings: structuredClone(settings), tracks: tracks.slice() });
  }
  async clear(slot: number): Promise<void> {
    this.slots.delete(slot);
  }
  async isEmpty(slot: number): Promise<boolean> {
    return !this.slots.has(slot);
  }
}

export class MemSystem {
  stored: SystemSettings | null = null;
  saves = 0;
  async load(): Promise<SystemSettings> {
    return this.stored ? structuredClone(this.stored) : defaultSystem();
  }
  async save(settings: SystemSettings): Promise<void> {
    this.saves++;
    this.stored = structuredClone(settings);
  }
}

export class MemRecovery {
  readonly checkpoints: { slot: number; settings: MemorySettings; tracks: (TrackAudio | null)[] }[] = [];
  discards = 0;
  cleanShutdowns = 0;
  async checkpoint(slot: number, settings: MemorySettings, tracks: (TrackAudio | null)[]): Promise<void> {
    this.checkpoints.push({ slot, settings: structuredClone(settings), tracks });
  }
  async discard(): Promise<void> {
    this.discards++;
  }
  async markCleanShutdown(): Promise<void> {
    this.cleanShutdowns++;
  }
}

export interface MemStores extends Stores {
  memories: MemMemories;
  system: MemSystem;
  recovery: MemRecovery;
}

export function memStores(): MemStores {
  return { memories: new MemMemories(), system: new MemSystem(), recovery: new MemRecovery() };
}

/** Records everything the controller hands the menu system. */
export class FakeLcd implements LcdHost {
  readonly events: ControlEvent[] = [];
  readonly shows: ScreenRequest[] = [];
  renders = 0;
  /** What onEvent returns. */
  handled = true;
  onEvent(e: ControlEvent): boolean {
    this.events.push(e);
    return this.handled;
  }
  show(req: ScreenRequest): void {
    this.shows.push(req);
  }
  render(fb: Framebuffer): void {
    this.renders++;
    fb.set(3, 2, 1);
  }
  /** The events as compact strings, e.g. 'press:enter', 'turn:knob1:10'. */
  log(): string[] {
    return this.events.map((e) => (e.kind === 'turn' ? `turn:${e.id}:${e.steps}` : e.kind === 'set' ? `set:${e.id}:${e.value}` : `${e.kind}:${e.id}`));
  }
}

export function setup(): { engine: FakeEngine; stores: MemStores; lcd: FakeLcd; c: Controller; events: EventTarget } {
  const engine = new FakeEngine();
  const stores = memStores();
  const lcd = new FakeLcd();
  const events = new EventTarget();
  const c = new Controller(engine, stores, lcd, { events });
  return { engine, stores, lcd, c, events };
}

export const press = (c: Controller, id: ButtonId, t = 0): void => c.handle({ kind: 'press', id, t });
export const release = (c: Controller, id: ButtonId, t = 0): void => c.handle({ kind: 'release', id, t });
export const click = (c: Controller, id: ButtonId, t = 0): void => {
  press(c, id, t);
  release(c, id, t + 50);
};
export const turn = (c: Controller, id: EncoderId, steps: number, t = 0): void => c.handle({ kind: 'turn', id, steps, t });
export const set = (c: Controller, id: AbsoluteId, value: number, t = 0): void => c.handle({ kind: 'set', id, value, t });

/** A short stereo take whose samples identify it. */
export function take(seed: number, frames = 8): TrackAudio {
  const L = new Float32Array(frames).fill(seed);
  const R = new Float32Array(frames).fill(-seed);
  return { L, R, sampleRate: 48000, recordedTempo: 120, measures: 1 };
}
