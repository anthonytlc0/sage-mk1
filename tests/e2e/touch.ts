/**
 * Synthetic touch for WebKit, where Playwright has neither multi-touch nor a touch drag (page.touchscreen only taps one
 * finger, and there is no CDP). Each finger event is a `PointerEvent` (pointerType 'touch', its own pointerId,
 * isPrimary on the first finger) dispatched on the element under the finger when it went down, which stands in for
 * the capture a real finger gets. setPointerCapture throws for a synthetic pointerId, which the input layer tolerates.
 * Shared by input.spec.ts (its `Touch` class) and helpers.ts (`Panel`).
 */
import type { Page } from '@playwright/test';

export type FingerEventType = 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel';

/** One finger event at (x, y) CSS px. */
export interface FingerEvent {
  type: FingerEventType;
  id: number;
  x: number;
  y: number;
  primary: boolean;
}

/**
 * Dispatches the events in order, all in one page round trip, so no stall between them can stretch a gesture (a drag
 * that took longer than HOLD_MS to start moving would become a push-and-turn).
 */
export function fingers(page: Page, events: readonly FingerEvent[]): Promise<void> {
  return page.evaluate((events) => {
    const w = window as unknown as { __fingerTarget?: Map<number, Element> };
    const targets = (w.__fingerTarget ??= new Map());
    for (const { type, id, x, y, primary } of events) {
      const fresh = document.elementFromPoint(x, y) ?? document.body;
      const target = type === 'pointerdown' ? fresh : (targets.get(id) ?? fresh);
      if (type === 'pointerdown') targets.set(id, target);
      if (type === 'pointerup' || type === 'pointercancel') targets.delete(id);
      target.dispatchEvent(
        new PointerEvent(type, {
          pointerId: id,
          pointerType: 'touch',
          isPrimary: primary,
          clientX: x,
          clientY: y,
          button: type === 'pointermove' ? -1 : 0,
          buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1,
          width: 20,
          height: 20,
          bubbles: true,
          cancelable: true,
          composed: true,
        }),
      );
    }
  }, events);
}

/** One finger event (see `fingers`). */
export const finger = (page: Page, type: FingerEventType, f: { id: number; x: number; y: number }, primary: boolean): Promise<void> =>
  fingers(page, [{ type, id: f.id, x: f.x, y: f.y, primary }]);
