/// <reference types="vite/client" />
/**
 * The app shell: `bootApp` builds the page and wires every module to the browser.
 *
 *  - The panel replica (full-viewport #tabletop), and outside it the shelf along the bottom: the POWER switch on the
 *    left, the recorder pod on the right once the unit is on (outside #tabletop, whose touch-action: none would stop
 *    the takes list from scrolling). The TAP POWER TO RESUME prompt and the rotate screen go on top.
 *  - The power cycle itself is `SageUnit` (app/unit.ts); this file gives it the real engine (EngineHost), the
 *    IndexedDB stores (opened at load, so the POWER tap only has to start the engine), the pod, the wake lock, and
 *    `window` / `document` for pagehide and visibility.
 *  - Panel input (pointer and keyboard) goes to the unit; Backquote toggles the pod's REC, `?` the key overlay.
 *  - One requestAnimationFrame loop draws `unit.frame(t)`: the controller's panel state while on.
 *  - iPad: pinch is stopped at gesturestart / gesturechange (Safari ignores user-scalable=no). There is no hash or
 *    pushState routing anywhere (changing the URL can drop mic capture in a Home Screen app).
 *
 * In development `window.__sage` exposes the unit, the view and the LCD for the end-to-end tests.
 */

import { getLoopMixRenderer } from './app/renderAdapter';
import { SageUnit, openStores } from './app/unit';
import type { WakeLockApi } from './app/wakeLock';
import { EngineHost } from './engine/host';
import { registerMenuScreens } from './lcd/screens/menuTree';
import { registerEditScreens } from './lcd/screens/register';
import { LCD_H, LCD_W } from './shared/constants';
import type { PanelState } from './shared/panel';
import { requestPersistence } from './storage/db';
import { attachInput } from './ui/input';
import { mountPanel } from './ui/panelView';
import type { PanelView } from './ui/panelView';
import { mountPowerSwitch } from './ui/power';
import { mountRecorderPod } from './ui/recorderPod';
import { mountRotateScreen } from './ui/rotate';
import './ui/shell.css';

/** The development hook the end-to-end tests read (`window.__sage`). */
export interface SageDebug {
  unit: SageUnit;
  view: PanelView;
  /** A copy of the LCD framebuffer last drawn (128 x 64, 1 = dark pixel). */
  lcd(): Uint8Array;
}

let screensRegistered = false;

/** The screens later tasks built, plugged into the menu system once per page. */
function registerScreens(): void {
  if (screensRegistered) return;
  screensRegistered = true;
  registerEditScreens(); // WRITE / CLEAR, TRACK, LOOP, RHYTHM (Task 20)
  registerMenuScreens(); // MENU (Task 21)
}

/**
 * Mounts the panel, the shelf with the POWER switch (the recorder pod joins it at power-on), the resume prompt and the
 * rotate screen into `root`, and starts drawing. A tap on POWER powers the unit on (see SageUnit). Resolves once the
 * stored settings have been read, so a POWER tap from then on opens the mic with the right MIC PROCESS.
 */
export async function bootApp(root: HTMLElement): Promise<void> {
  registerScreens();
  const doc = root.ownerDocument;
  const win = doc.defaultView;
  if (!win) throw new Error('bootApp: the root is not in a window');
  root.classList.add('sage-shell');

  const view = mountPanel(root);
  const tabletop = root.querySelector<HTMLElement>('#tabletop')!;
  const shelf = doc.createElement('div');
  shelf.className = 'shelf';
  root.append(shelf);

  const unit = new SageUnit({
    stores: openStores(),
    startEngine: (system) => EngineHost.start(system ? { system } : {}),
    requestPersistence,
    mountPod: (recorder, controller) => mountRecorderPod(shelf, recorder, controller, { render: getLoopMixRenderer() }),
    win,
    doc,
    wakeLock: (win.navigator as Navigator & { wakeLock?: WakeLockApi }).wakeLock,
  });

  const power = mountPowerSwitch(
    shelf,
    root,
    () => unit.tap(),
    () => unit.retryResume(),
  );
  const sync = (): void => {
    tabletop.dataset.power = unit.state;
    power.setState(unit.state);
    power.setResume(unit.resumePrompt);
    power.setNote(unit.error);
  };
  unit.onChange(sync);
  sync();

  attachInput(view, (e) => unit.handle(e), {
    onSpecialKey: (k) => {
      if (k === 'recorder') unit.toggleRecord(); // '?' (the key overlay) is toggled by the input layer itself
    },
  });

  // Safari ignores user-scalable=no: stop pinch-zoom at the gesture events.
  const noGesture = (e: Event): void => e.preventDefault();
  doc.addEventListener('gesturestart', noGesture, { passive: false });
  doc.addEventListener('gesturechange', noGesture, { passive: false });

  mountRotateScreen(root);

  let last: PanelState | null = null;
  const frame = (t: number): void => {
    last = unit.frame(t);
    view.render(last, t);
    win.requestAnimationFrame(frame);
  };
  win.requestAnimationFrame(frame);

  if (import.meta.env.DEV) {
    const hook: SageDebug = { unit, view, lcd: () => (last ? last.lcd.slice() : new Uint8Array(LCD_W * LCD_H)) };
    (win as Window & { __sage?: SageDebug }).__sage = hook;
  }

  await unit.ready();
}
