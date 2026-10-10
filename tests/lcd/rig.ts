import { Controller } from '../../src/control/controller';
import { FakeEngine, makeStatus } from '../../src/control/fakeEngine';
import { Framebuffer } from '../../src/lcd/framebuffer';
import { MenuSystem } from '../../src/lcd/menu';
import type { MenuOptions } from '../../src/lcd/menu';
import type { EngineStatus, TrackStatus } from '../../src/shared/protocol';
import type { ButtonId, ControlEvent, EncoderId } from '../../src/shared/ids';
import { memStores } from '../control/helpers';

/** A real Controller with a fake engine, in-memory stores and the real MenuSystem as its LCD host. */
export function rig(opts?: MenuOptions) {
  const engine = new FakeEngine();
  const stores = memStores();
  const menu = new MenuSystem(opts);
  const c = new Controller(engine, stores, menu, { events: new EventTarget() });
  return { engine, stores, menu, c };
}
export type Rig = ReturnType<typeof rig>;

/** What the LCD shows at time `t`, as a Framebuffer (a copy, so it survives the next frame). */
export function frame(c: Controller, t = 0): Framebuffer {
  const fb = new Framebuffer();
  fb.data.set(c.panelState(t).lcd);
  return fb;
}

/** Feeds the controller an engine status (tracks[i] overrides track i). */
export function status(r: Rig, over: Partial<Omit<EngineStatus, 'tracks'>> = {}, tracks: Partial<TrackStatus>[] = []): void {
  r.engine.emit({ t: 'status', status: makeStatus(over, tracks) });
}

/** Events as the LCD host receives them from the controller. */
export const pressEv = (id: ButtonId, t = 0): ControlEvent => ({ kind: 'press', id, t });
export const releaseEv = (id: ButtonId, t = 0): ControlEvent => ({ kind: 'release', id, t });
/** A raw turn: `steps` detents, no coarse multiplication (screens ask `ctx.isHeld`). */
export const turnEv = (id: EncoderId, steps: number, t = 0): ControlEvent => ({ kind: 'turn', id, steps, t });

/** Offers a button push (press then release, as the controller does) straight to the menu. Returns true if used. */
export function push(r: Rig, id: ButtonId, t = 0): boolean {
  const a = r.menu.onEvent(pressEv(id, t), r.c);
  const b = r.menu.onEvent(releaseEv(id, t), r.c);
  return a || b;
}
export const turn = (r: Rig, id: EncoderId, steps: number, t = 0): boolean => r.menu.onEvent(turnEv(id, steps, t), r.c);

/** True when the two framebuffers hold the same pixels inside the rectangle. */
export function sameRegion(a: Framebuffer, b: Framebuffer, x: number, y: number, w: number, h: number): boolean {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) if (a.get(xx, yy) !== b.get(xx, yy)) return false;
  return true;
}
