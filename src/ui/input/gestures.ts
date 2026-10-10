/**
 * Pure gesture recognisers for the input layer: no DOM, fed plain samples (a time in ms and CSS-pixel coordinates).
 * pointer.ts owns the pointers and the timers; these classes only decide what a stream of samples means. Nothing
 * here interprets holds or chords for the looper: that is the controller's job. They emit press, release, turn and
 * set events, nothing more.
 */
import type { AbsoluteId, ButtonId, ControlEvent, EncoderId } from '../../shared/ids';

export type Emit = (e: ControlEvent) => void;

/** Vertical travel, in CSS px, for one encoder detent. */
export const DETENT_PX = 12;
/** A touch that travels this far (or further) is a drag, not a tap. */
export const TAP_MAX_MOVE_PX = 10;
/** A touch that stays put this long is a push-and-hold of the encoder. */
export const HOLD_MS = 300;
/** Vertical travel, in CSS px, for a full 0..1 sweep of an absolute knob. */
export const KNOB_DRAG_PX = 200;
/** Mouse wheel over an absolute knob or fader. */
export const WHEEL_STEP = 0.02;

const clamp01 = (v: number): number => (v > 0 ? Math.min(1, v) : 0); // also maps NaN to 0

type Phase = 'pending' | 'drag' | 'held' | 'done';

/**
 * One finger (or mouse button) on a rotary encoder, which is also a push button. Until the touch has clearly
 * become something, nothing is emitted:
 *  - lifted still and under HOLD_MS: a tap, so `press` and `release` of the knob (emitted together at the lift);
 *  - dragged 10 px or more inside HOLD_MS: turns only, one detent per 12 px, up is +;
 *  - held still for HOLD_MS (the owner calls `holdElapsed`, or the first move after it): `press` at once, then any
 *    turns, then `release` on lift. This is the hardware's push-and-turn.
 * A press is always stamped with the time the finger went down, so release minus press is the true hold time.
 */
export class EncoderGesture {
  private phase: Phase = 'pending';
  /** The y of the last detent boundary: turns are counted from here, so a partial detent is never lost. */
  private anchorY: number;

  constructor(
    private readonly id: EncoderId,
    private readonly emit: Emit,
    private readonly t0: number,
    private readonly x0: number,
    private readonly y0: number,
  ) {
    this.anchorY = y0;
  }

  /** True while the knob is being pushed (the press has been emitted and not yet the release). */
  get pushed(): boolean {
    return this.phase === 'held';
  }

  /** The hold timer fired: a still finger becomes a push. No effect once the touch is a drag or has ended. */
  holdElapsed(): void {
    if (this.phase === 'pending') this.beginHold();
  }

  move(t: number, x: number, y: number): void {
    if (this.phase === 'done') return;
    if (this.phase === 'pending') {
      if (Math.hypot(x - this.x0, y - this.y0) < TAP_MAX_MOVE_PX) return;
      if (t - this.t0 >= HOLD_MS) this.beginHold();
      else this.phase = 'drag';
    }
    const steps = Math.trunc((this.anchorY - y) / DETENT_PX);
    if (steps === 0) return;
    this.anchorY -= steps * DETENT_PX;
    this.emit({ kind: 'turn', id: this.id, steps, t });
  }

  up(t: number, x: number, y: number): void {
    if (this.phase === 'done') return;
    this.move(t, x, y); // a lift can carry the final position (and a synthetic one may be the only sample)
    const phase = this.phase;
    this.phase = 'done';
    if (phase === 'held') {
      this.emit({ kind: 'release', id: this.id, t });
    } else if (phase === 'pending') {
      // Never moved: a tap, or a hold lifted before the timer was reported. Either way, one push.
      this.emit({ kind: 'press', id: this.id, t: this.t0 });
      this.emit({ kind: 'release', id: this.id, t });
    }
  }

  /** The pointer was cancelled (pointercancel, lost capture, teardown): release the knob if it is pushed. */
  cancel(t: number): void {
    if (this.phase === 'done') return;
    const pushed = this.phase === 'held';
    this.phase = 'done';
    if (pushed) this.emit({ kind: 'release', id: this.id, t });
  }

  private beginHold(): void {
    this.phase = 'held';
    this.emit({ kind: 'press', id: this.id, t: this.t0 });
  }
}

/**
 * A drag on an absolute knob or fader. The value moves relative to where the drag started (no jump on touch-down),
 * up is more, and `pxPerRange` CSS px of vertical travel sweep the whole 0..1 range. `set` is emitted only when the
 * clamped value actually changes.
 */
export class AbsoluteDrag {
  private readonly start: number;
  private readonly pxPerRange: number;
  private last: number;

  constructor(
    private readonly id: AbsoluteId,
    start: number,
    private readonly y0: number,
    pxPerRange: number,
    private readonly emit: Emit,
  ) {
    this.start = clamp01(start);
    this.last = this.start;
    this.pxPerRange = pxPerRange > 0 ? pxPerRange : KNOB_DRAG_PX;
  }

  move(t: number, y: number): void {
    const value = clamp01(this.start + (this.y0 - y) / this.pxPerRange);
    if (value === this.last) return;
    this.last = value;
    this.emit({ kind: 'set', id: this.id, value, t });
  }
}

/**
 * Wraps `emit` so a button reads as down once however many things hold it: two fingers on one pad, or a key and a
 * click, give one `press` when the first goes down and one `release` when the last lets go. A `release` with no
 * matching `press` is dropped. Turns and sets pass through untouched.
 */
export function createPressGate(emit: Emit): Emit {
  const holds = new Map<ButtonId, number>();
  return (e) => {
    if (e.kind === 'press') {
      const n = holds.get(e.id) ?? 0;
      holds.set(e.id, n + 1);
      if (n === 0) emit(e);
    } else if (e.kind === 'release') {
      const n = holds.get(e.id) ?? 0;
      if (n === 0) return;
      if (n === 1) {
        holds.delete(e.id);
        emit(e);
      } else {
        holds.set(e.id, n - 1);
      }
    } else {
      emit(e);
    }
  };
}
