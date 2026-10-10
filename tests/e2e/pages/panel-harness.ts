/**
 * Playwright harness for the panel (tests/e2e/panel.spec.ts, tests/e2e/input.spec.ts). Mounts the SVG panel
 * full-screen and exposes `window.__panel` so specs can drive it with plain JSON from `page.evaluate`. It also attaches
 * the input layer and records what it emits in `window.__events`.
 */
import { mountPanel, type PanelView } from '../../../src/ui/panelView';
import { ALL_ABSOLUTE_IDS, ALL_BUTTON_IDS, LAYOUT, PANEL_VIEWBOX } from '../../../src/ui/panelLayout';
import { Framebuffer } from '../../../src/lcd/framebuffer';
import { bar, fillRect, hline, rect, text } from '../../../src/lcd/draw';
import { FONT_MEDIUM, FONT_SMALL } from '../../../src/lcd/fonts';
import { LCD_H, LCD_W } from '../../../src/shared/constants';
import type { PanelState, RingState } from '../../../src/shared/panel';
import type { ControlEvent } from '../../../src/shared/ids';
import { attachInput, showKeyOverlay } from '../../../src/ui/input';

/** A JSON-friendly PanelState: anything left out is off / blank / default. */
export interface HarnessState {
  leds?: PanelState['leds'];
  rings?: readonly (Partial<RingState> | null)[];
  /** 'demo' draws a play-screen-like test pattern; an array is 128*64 bytes. Default: blank. */
  lcd?: 'blank' | 'demo' | number[];
  contrast?: number;
  beatPhase?: number;
}

/** A stand-in play screen: memory name, tempo and five track meters. Only for exercising the canvas. */
function demoScreen(): Uint8Array {
  const fb = new Framebuffer();
  fillRect(fb, 0, 0, LCD_W, 9);
  text(fb, 2, 1, '01', FONT_SMALL, { invert: true });
  text(fb, 16, 1, 'MEMORY01', FONT_SMALL, { invert: true });
  text(fb, 88, 1, '4/4', FONT_SMALL, { invert: true });
  text(fb, 2, 13, 'TEMPO', FONT_SMALL);
  text(fb, 38, 12, '120.0', FONT_MEDIUM);
  text(fb, 92, 13, 'M  1', FONT_SMALL);
  hline(fb, 0, 26, LCD_W);
  const level = [0.8, 0.55, 0, 0.3, 0];
  for (let i = 0; i < 5; i++) {
    const x = 3 + i * 25;
    text(fb, x + 8, 30, String(i + 1), FONT_SMALL);
    rect(fb, x + 7, 40, 8, 22);
    // a vertical meter drawn as a short horizontal bar per row from the bottom
    const rows = Math.round(level[i] * 20);
    for (let r = 0; r < rows; r++) bar(fb, x + 8, 61 - r, 6, 1, 1);
  }
  return fb.data;
}

const blankRing = (): RingState => ({ color: 'off', blink: 'none', mode: 'status', amount: 0 });

export function makeState(s: HarnessState = {}): PanelState {
  const rings = [0, 1, 2, 3, 4].map((i) => ({ ...blankRing(), ...(s.rings?.[i] ?? {}) })) as PanelState['rings'];
  let lcd: Uint8Array;
  if (s.lcd === 'demo') lcd = demoScreen();
  else if (Array.isArray(s.lcd)) lcd = Uint8Array.from(s.lcd);
  else lcd = new Uint8Array(LCD_W * LCD_H);
  return { leds: { ...(s.leds ?? {}) }, rings, lcd, contrast: s.contrast ?? 5, beatPhase: s.beatPhase ?? 0 };
}

export interface PanelHarness {
  view: PanelView;
  render(s?: HarnessState, t?: number): void;
  makeState: typeof makeState;
  LAYOUT: typeof LAYOUT;
  PANEL_VIEWBOX: typeof PANEL_VIEWBOX;
  ALL_BUTTON_IDS: typeof ALL_BUTTON_IDS;
  ALL_ABSOLUTE_IDS: typeof ALL_ABSOLUTE_IDS;
}

/** The input layer (tests/e2e/input.spec.ts), attached to the panel with its events recorded in `window.__events`. */
export interface InputHarness {
  attach(): void;
  detach(): void;
  showKeyOverlay: typeof showKeyOverlay;
}

declare global {
  interface Window {
    __panel: PanelHarness;
    /** Every ControlEvent the input layer has emitted, in order. A spec empties it with `__events.length = 0`. */
    __events: ControlEvent[];
    /** The special keys seen: 'recorder' (Backquote) and 'overlay' (?). */
    __special: string[];
    __input: InputHarness;
  }
}

const root = document.getElementById('app');
if (!root) throw new Error('panel harness: #app missing');
const view = mountPanel(root);

window.__panel = {
  view,
  render(s: HarnessState = {}, t = 0) {
    view.render(makeState(s), t);
  },
  makeState,
  LAYOUT,
  PANEL_VIEWBOX,
  ALL_BUTTON_IDS,
  ALL_ABSOLUTE_IDS,
};

window.__events = [];
window.__special = [];
let detachInput: (() => void) | null = null;
window.__input = {
  attach() {
    detachInput ??= attachInput(view, (e) => window.__events.push(e), { onSpecialKey: (k) => window.__special.push(k) });
  },
  detach() {
    detachInput?.();
    detachInput = null;
  },
  showKeyOverlay,
};
window.__input.attach();
