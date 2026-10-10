/**
 * Touch, pen and mouse on the SVG panel → ControlEvents.
 *
 * One Pointer Events path serves all three. Each pointer is tracked on its own, keyed by pointerId, and captured
 * (setPointerCapture) so it keeps reporting after it leaves its control: simultaneous touches never interfere.
 * What a pointer means depends on the control it landed on, found through the control's `data-id` group
 * (PanelView.elementFor's element), not through the LAYOUT rects: a fader's slot artwork is grabbable although it
 * extends past its rect.
 *  - buttons: `press` on down, `release` on up or cancel;
 *  - encoders [1]-[4]: see EncoderGesture (turn, tap, or push-and-turn);
 *  - absolute knobs and faders: AbsoluteDrag, with `view.setPhysical` drawing the new position.
 * pointercancel is always handled: iPadOS cancels 4-5 finger touches even with its system gestures off, and a
 * cancel releases whatever that pointer was holding so nothing sticks down. A window blur or the page going hidden
 * (app switch, Control Center, lock screen) can lose a pointerup altogether, so they cancel every active pointer
 * the same way. The user agent is never sniffed.
 */
import type { AbsoluteId, ButtonId, EncoderId } from '../../shared/ids';
import { ALL_ABSOLUTE_IDS, ALL_BUTTON_IDS, LAYOUT, PANEL_VIEWBOX } from '../panelLayout';
import type { PanelView } from '../panelView';
import { AbsoluteDrag, EncoderGesture, HOLD_MS, KNOB_DRAG_PX, WHEEL_STEP, WheelStepper, type Emit } from './gestures';

type Target =
  | { kind: 'button'; id: ButtonId }
  | { kind: 'encoder'; id: EncoderId }
  | { kind: 'knob' | 'fader'; id: AbsoluteId };

const ENCODERS: ReadonlySet<string> = new Set(['knob1', 'knob2', 'knob3', 'knob4']);

const TARGETS: ReadonlyMap<string, Target> = new Map<string, Target>([
  ...ALL_BUTTON_IDS.map((id): [string, Target] => [
    id,
    ENCODERS.has(id) ? { kind: 'encoder', id: id as EncoderId } : { kind: 'button', id },
  ]),
  ...ALL_ABSOLUTE_IDS.map((id): [string, Target] => [id, { kind: id.endsWith('.fader') ? 'fader' : 'knob', id }]),
]);

type Active =
  | { kind: 'button'; id: ButtonId }
  | { kind: 'encoder'; gesture: EncoderGesture; timer: number }
  | { kind: 'absolute'; drag: AbsoluteDrag };

const clamp01 = (v: number): number => (v > 0 ? Math.min(1, v) : 0);

/** Returns a function that detaches every listener and releases whatever is still held. */
export function attachPointer(view: PanelView, emit: Emit): () => void {
  const svg = view.rootSvg;
  const doc = svg.ownerDocument;
  const win = doc.defaultView;
  if (!win) return () => {};

  const active = new Map<number, Active>();

  /** The control under an event, if any. Decorative layers have pointer-events: none, so they never get here. */
  const controlAt = (e: Event): { el: Element; target: Target } | null => {
    const el = (e.target as Element | null)?.closest?.('[data-id]');
    const target = el ? TARGETS.get(el.getAttribute('data-id') ?? '') : undefined;
    return el && target ? { el, target } : null;
  };

  /** CSS px per viewBox unit (the SVG is fitted with xMidYMid meet). */
  const unitPx = (): number => {
    const r = svg.getBoundingClientRect();
    const k = Math.min(r.width / PANEL_VIEWBOX.w, r.height / PANEL_VIEWBOX.h);
    return k > 0 ? k : 1;
  };

  /** A `set` redraws the control before the controller hears about it. */
  const emitSet: Emit = (e) => {
    if (e.kind === 'set') view.setPhysical(e.id, e.value);
    emit(e);
  };

  /** Ends a pointer's hold on its control: a lift (with its final position) or a cancel. */
  const finish = (pointerId: number, t: number, lift: PointerEvent | null): void => {
    const a = active.get(pointerId);
    if (!a) return;
    active.delete(pointerId);
    if (a.kind === 'button') {
      emit({ kind: 'release', id: a.id, t });
    } else if (a.kind === 'encoder') {
      win.clearTimeout(a.timer);
      if (lift) a.gesture.up(t, lift.clientX, lift.clientY);
      else a.gesture.cancel(t);
    } else if (lift) {
      a.drag.move(t, lift.clientY);
    }
  };

  const onDown = (e: PointerEvent): void => {
    e.preventDefault();
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const hit = controlAt(e);
    if (!hit) return;
    finish(e.pointerId, e.timeStamp, null); // a pointer we still hold (its up never came) is cancelled first
    try {
      hit.el.setPointerCapture(e.pointerId);
    } catch {
      // No such active pointer (a synthetic event, or one already gone): carry on without capture.
    }

    const { target } = hit;
    if (target.kind === 'button') {
      active.set(e.pointerId, { kind: 'button', id: target.id });
      emit({ kind: 'press', id: target.id, t: e.timeStamp });
    } else if (target.kind === 'encoder') {
      const gesture = new EncoderGesture(target.id, emit, e.timeStamp, e.clientX, e.clientY);
      const timer = win.setTimeout(() => gesture.holdElapsed(), HOLD_MS);
      active.set(e.pointerId, { kind: 'encoder', gesture, timer });
    } else {
      const travel = target.kind === 'fader' ? LAYOUT[target.id].h * unitPx() : KNOB_DRAG_PX;
      const drag = new AbsoluteDrag(target.id, view.getPhysical(target.id), e.clientY, travel, emitSet);
      active.set(e.pointerId, { kind: 'absolute', drag });
    }
  };

  const onMove = (e: PointerEvent): void => {
    e.preventDefault();
    const a = active.get(e.pointerId);
    if (!a) return;
    if (a.kind === 'encoder') a.gesture.move(e.timeStamp, e.clientX, e.clientY);
    else if (a.kind === 'absolute') a.drag.move(e.timeStamp, e.clientY);
  };

  const onUp = (e: PointerEvent): void => {
    e.preventDefault();
    finish(e.pointerId, e.timeStamp, e);
  };

  const onCancel = (e: PointerEvent): void => {
    e.preventDefault();
    finish(e.pointerId, e.timeStamp, null);
  };

  /** Everything the user's focus leaving the page can strand: cancel every active pointer, as pointercancel does. */
  const cancelAll = (t: number): void => {
    for (const id of [...active.keys()]) finish(id, t, null);
  };
  const onBlur = (e: Event): void => cancelAll(e.timeStamp);
  const onVisibility = (e: Event): void => {
    if (doc.visibilityState === 'hidden') cancelAll(e.timeStamp);
  };

  /** One WheelStepper per control (its own accumulator and step-rate cap). */
  const wheels = new Map<string, WheelStepper>();

  /** Wheel over an encoder is one detent; over a knob or fader, WHEEL_STEP. Wheel up is more. See WheelStepper. */
  const onWheel = (e: WheelEvent): void => {
    const hit = controlAt(e);
    if (!hit || hit.target.kind === 'button') return;
    e.preventDefault(); // every wheel event over a control is ours, including the ones that give no step
    const { target } = hit;
    let stepper = wheels.get(target.id);
    if (!stepper) wheels.set(target.id, (stepper = new WheelStepper()));
    const dir = stepper.feed(e.timeStamp, e.deltaY, e.deltaMode);
    if (dir === 0) return;
    if (target.kind === 'encoder') {
      emit({ kind: 'turn', id: target.id, steps: dir, t: e.timeStamp });
      return;
    }
    const before = view.getPhysical(target.id);
    const value = Math.round(clamp01(before + dir * WHEEL_STEP) * 1000) / 1000; // 0.02 steps without float dust
    if (value !== before) emitSet({ kind: 'set', id: target.id, value, t: e.timeStamp });
  };

  const onContextMenu = (e: Event): void => e.preventDefault();

  svg.addEventListener('pointerdown', onDown);
  svg.addEventListener('pointermove', onMove);
  svg.addEventListener('pointerup', onUp);
  svg.addEventListener('pointercancel', onCancel);
  svg.addEventListener('lostpointercapture', onCancel);
  svg.addEventListener('wheel', onWheel, { passive: false });
  svg.addEventListener('contextmenu', onContextMenu);
  win.addEventListener('blur', onBlur);
  doc.addEventListener('visibilitychange', onVisibility);

  return () => {
    svg.removeEventListener('pointerdown', onDown);
    svg.removeEventListener('pointermove', onMove);
    svg.removeEventListener('pointerup', onUp);
    svg.removeEventListener('pointercancel', onCancel);
    svg.removeEventListener('lostpointercapture', onCancel);
    svg.removeEventListener('wheel', onWheel);
    svg.removeEventListener('contextmenu', onContextMenu);
    win.removeEventListener('blur', onBlur);
    doc.removeEventListener('visibilitychange', onVisibility);
    cancelAll(win.performance.now());
  };
}
