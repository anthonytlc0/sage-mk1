/**
 * The input layer: pointer (touch, pen, mouse) and keyboard on the panel → ControlEvents. It emits press, release,
 * turn and set events with timestamps; holds, chords and long-presses are the controller's to interpret.
 */
import type { ControlEvent } from '../../shared/ids';
import { isKeyOverlayShown, showKeyOverlay } from '../overlay';
import type { PanelView } from '../panelView';
import { createPressGate } from './gestures';
import { attachKeyboard, type SpecialKey } from './keyboard';
import { attachPointer } from './pointer';

export { KEYMAP, type SpecialKey } from './keyboard';
export { showKeyOverlay } from '../overlay';

export interface InputOptions {
  /** Backquote → 'recorder'; `?` → 'overlay' (the overlay is also toggled here). Neither is a ControlEvent. */
  onSpecialKey?: (k: SpecialKey) => void;
}

/**
 * Wires the panel's pointers and the window's keyboard to `emit`. A button held by several things at once (two
 * fingers, a key and a click) is one press and one release. Returns a function that detaches everything, releasing
 * whatever is still held and removing the key overlay.
 */
export function attachInput(view: PanelView, emit: (e: ControlEvent) => void, opts: InputOptions = {}): () => void {
  const win = view.rootSvg.ownerDocument.defaultView;
  const gated = createPressGate(emit);
  const stopPointer = attachPointer(view, gated);
  const stopKeys = win
    ? attachKeyboard(win, gated, (k) => {
        if (k === 'overlay') showKeyOverlay(view, !isKeyOverlayShown(view));
        opts.onSpecialKey?.(k);
      })
    : () => {};
  return () => {
    stopPointer();
    stopKeys();
    showKeyOverlay(view, false);
  };
}
