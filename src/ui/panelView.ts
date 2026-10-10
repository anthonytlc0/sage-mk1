/// <reference types="vite/client" />
import './panel.css';
import {
  ALL_ABSOLUTE_IDS,
  ALL_BUTTON_IDS,
  CENTER_X,
  LAYOUT,
  PANEL_VIEWBOX,
  ROW,
  TRACK_COL,
  TRACK_ROW,
  TRACK_X,
  type LayoutRect,
} from './panelLayout';
import {
  LED_COLORS,
  LIT_COLORS,
  RING_BAND,
  SEG_OFF,
  SEG_OFF_FILL,
  ledDefs,
  ledLit,
  ledPaint,
  ringLevels,
} from './leds';
import { DEFAULT_PALETTE, drawToCanvas, lcdColors, type LcdContext } from '../lcd/canvas';
import { Framebuffer } from '../lcd/framebuffer';
import { LCD_H, LCD_W, RING_SEGMENTS } from '../shared/constants';
import type { AbsoluteId, ButtonId } from '../shared/ids';
import type { PanelState } from '../shared/panel';

export interface PanelView {
  /** Draws `state` at time `t` (ms, drives 'fast'/'slow' blink). Touches only the attributes that changed. */
  render(state: PanelState, t: number): void;
  /** The control's <g data-id="…"> (its hit target). */
  elementFor(id: ButtonId | AbsoluteId): SVGElement;
  /** Moves a fader cap (0 = bottom, 1 = top) or knob pointer (0 = fully left, 1 = fully right). Clamped to 0..1. */
  setPhysical(id: AbsoluteId, value: number): void;
  /** What setPhysical last drew (faders rest at 1, knob pointers at 0.5). The input layer drags relative to it. */
  getPhysical(id: AbsoluteId): number;
  lcdCanvas: HTMLCanvasElement;
  rootSvg: SVGSVGElement;
}

const NS = 'http://www.w3.org/2000/svg';
const { w: VB_W, h: VB_H } = PANEL_VIEWBOX;

/** Knob pointer sweep: 0 → -150°, 1 → +150° from 12 o'clock. */
const KNOB_SWEEP = 300;

type Attrs = Record<string, string | number>;

/** Unlit light-pipe rim (A-D, EDIT, FX, TRACK, ■, ▶/● and the wide buttons) and the plain dark buttons' edge. */
const RIM_OFF = '#d3d7dc';
const RIM_DARK = '#0c0c0e';

interface LedSlot {
  glow: SVGElement;
  face: SVGElement;
  rim: SVGElement;
  rimOff: string;
  /** Applied state: -1 = dark, otherwise the index into LIT_COLORS. */
  code: number;
}

interface RingSlot {
  segs: SVGElement[];
  glows: SVGElement[];
  /** Applied state per segment: 0 = dark, else 1 + colourIndex * 2 + (hot ? 1 : 0). */
  codes: Int8Array;
  levels: Int8Array;
}

const COLOR_INDEX: Readonly<Record<string, number>> = Object.fromEntries(LIT_COLORS.map((c, i) => [c, i]));
// Paint references per colour index, built once so a frame allocates no strings.
const url = (id: string) => `url(#${id})`;
const GLOW_URL = LIT_COLORS.map((c) => url(ledPaint.glow(c)));
const FACE_URL = LIT_COLORS.map((c) => url(ledPaint.face(c)));
const RIM_LIT = LIT_COLORS.map((c) => LED_COLORS[c].core);
const SEG_URL = LIT_COLORS.map((c) => [url(ledPaint.seg(c, false)), url(ledPaint.seg(c, true))]);
const RING_GLOW_URL = LIT_COLORS.map((c) => [url(ledPaint.ringGlow(c, false)), url(ledPaint.ringGlow(c, true))]);
const LEVEL_ATTR = ['0', '1', '2'];

/**
 * An LcdContext for drawToCanvas that gathers each run of same-colour fillRects into one Path2D and fills it in a
 * single call. drawToCanvas issues one fillRect per dark pixel; batching them is ~5x cheaper in Chromium and ~2x in
 * WebKit, and pixel-identical because every rect is integer-aligned. Call flush() after drawToCanvas.
 * `multiplier` scales every rect by an integer, so drawToCanvas can paint at scale 1 (solid pixels, no grid) onto
 * a canvas of 128*m x 64*m.
 */
class BatchedLcdContext implements LcdContext {
  fillStyle: string | CanvasGradient | CanvasPattern = '#000';
  multiplier = 1;
  private path: Path2D | null = null;
  private style: string | CanvasGradient | CanvasPattern = '';

  constructor(private readonly ctx: CanvasRenderingContext2D) {}

  fillRect(x: number, y: number, w: number, h: number): void {
    if (this.path !== null && this.fillStyle !== this.style) this.flush();
    if (this.path === null) {
      this.path = new Path2D();
      this.style = this.fillStyle;
    }
    const m = this.multiplier;
    this.path.rect(x * m, y * m, w * m, h * m);
  }

  flush(): void {
    if (this.path === null) return;
    this.ctx.fillStyle = this.style;
    this.ctx.fill(this.path);
    this.path = null;
  }
}

/**
 * Builds the SVG replica of the top panel inside `root` (a full-viewport #tabletop is created there) and returns the
 * view. The LCD is an HTML canvas laid over LAYOUT.lcd, re-fitted on every resize.
 */
export function mountPanel(root: HTMLElement): PanelView {
  const doc = root.ownerDocument;
  const el = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Attrs = {}, parent?: Element): SVGElementTagNameMap[K] => {
    const e = doc.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, String(attrs[k]));
    parent?.appendChild(e);
    return e;
  };
  const text = (parent: Element, x: number, y: number, s: string, size: number, attrs: Attrs = {}): SVGTextElement => {
    const t = el('text', { x, y, 'font-size': size, 'text-anchor': 'middle', ...attrs }, parent);
    t.textContent = s;
    return t;
  };

  const tabletop = doc.createElement('div');
  tabletop.id = 'tabletop';
  const svg = el('svg', {
    class: 'panel-svg',
    viewBox: `0 0 ${VB_W} ${VB_H}`,
    preserveAspectRatio: 'xMidYMid meet',
    role: 'img',
    'aria-label': 'Sage MK1 panel',
  });
  tabletop.appendChild(svg);
  const canvas = doc.createElement('canvas');
  canvas.className = 'panel-lcd';
  canvas.width = LCD_W;
  canvas.height = LCD_H;
  tabletop.appendChild(canvas);

  // ---------------------------------------------------------------- paint servers (all static, defined once)
  const defs = el('defs', {}, svg);
  const linear = (id: string, stops: [number, string, number?][], dir: Attrs = { x1: 0, y1: 0, x2: 0, y2: 1 }) => {
    const g = el('linearGradient', { id, ...dir }, defs);
    for (const [o, c, a] of stops) el('stop', { offset: o, 'stop-color': c, 'stop-opacity': a ?? 1 }, g);
  };
  const radial = (id: string, stops: [number, string, number?][], attrs: Attrs = {}) => {
    const g = el('radialGradient', { id, ...attrs }, defs);
    for (const [o, c, a] of stops) el('stop', { offset: o, 'stop-color': c, 'stop-opacity': a ?? 1 }, g);
  };
  linear('g-chassis', [[0, '#36373b'], [0.04, '#2c2d31'], [0.5, '#242528'], [1, '#1d1e21']]);
  linear('g-top', [[0, '#1b1b1d'], [0.5, '#141415'], [1, '#101011']]);
  linear('g-ledge', [[0, '#4a4b50'], [0.35, '#323337'], [1, '#1a1b1d']]);
  linear('g-column', [[0, '#313236'], [0.06, '#2b2c30'], [1, '#222326']]);
  linear('g-bezel', [[0, '#e6e8eb'], [0.28, '#9a9ea4'], [0.52, '#d3d6da'], [0.78, '#7c8086'], [1, '#b5b9be']], {
    x1: 0, y1: 0, x2: 1, y2: 1,
  });
  linear('g-fader-cap', [[0, '#64666b'], [0.1, '#4a4c50'], [0.5, '#2e3034'], [1, '#1c1d20']]);
  linear('g-fader-frame', [[0, '#101113'], [1, '#1a1b1e']]);
  linear('g-pill-sheen', [[0, '#ffffff', 0.1], [0.5, '#ffffff', 0], [1, '#000000', 0.15]]);
  radial('g-shadow', [[0, '#000', 0.7], [0.55, '#000', 0.38], [1, '#000', 0]]);
  radial('g-toplight', [[0, '#ffffff', 0.05], [1, '#ffffff', 0]], { cx: 0.5, cy: 0, r: 0.75 });
  radial('g-cap', [[0, '#404146'], [0.55, '#232428'], [1, '#121315']], { fx: 0.38, fy: 0.3 });
  radial('g-cap-dark', [[0, '#4a4b50'], [0.6, '#2c2d31'], [1, '#18191b']], { fx: 0.38, fy: 0.3 });
  radial('g-knob', [[0, '#4d4e53'], [0.45, '#2c2d31'], [1, '#161719']], { fx: 0.36, fy: 0.28 });
  radial('g-skirt', [[0, '#1e1f22'], [0.78, '#222327'], [0.97, '#2d2e33'], [1, '#3a3b40']]);
  radial('g-ring-disk', [[0, '#1d1e21'], [0.66, '#222327'], [0.92, '#2b2c30'], [1, '#3a3b40']]);
  for (const g of ledDefs(doc)) defs.appendChild(g);

  // ---------------------------------------------------------------- chassis
  const chassis = el('g', { class: 'deco' }, svg);
  const wingBottom = 659;
  const trackLeft = 69, trackRight = VB_W - 69, bottom = 933, top = 14;
  // Jack housings peeking out behind the top edge.
  for (const x of [147, 236, 272, 356, 386, 648, 1054, 1114, 1377, 1454]) {
    el('rect', { x: x - 15, y: top - 9, width: 30, height: 14, rx: 3, fill: '#1b1b1d', stroke: '#2b2b2e' }, chassis);
  }
  const body =
    `M ${26} ${top} H ${VB_W - 26} A 26 26 0 0 1 ${VB_W} ${top + 26} V ${wingBottom - 14} ` +
    `A 14 14 0 0 1 ${VB_W - 14} ${wingBottom} H ${trackRight} V ${bottom - 16} A 16 16 0 0 1 ${trackRight - 16} ${bottom} ` +
    `H ${trackLeft + 16} A 16 16 0 0 1 ${trackLeft} ${bottom - 16} V ${wingBottom} H 14 A 14 14 0 0 1 0 ${wingBottom - 14} ` +
    `V ${top + 26} A 26 26 0 0 1 26 ${top} Z`;
  el('path', { d: body, fill: '#000', opacity: 0.35, transform: 'translate(0 3)' }, chassis);
  el('path', { d: body, fill: 'url(#g-chassis)', stroke: '#3d3e43', 'stroke-width': 1.5 }, chassis);
  // Recessed track area and the five raised column panels.
  el('rect', { x: trackLeft + 4, y: 372, width: trackRight - trackLeft - 8, height: bottom - 376, rx: 12, fill: '#161719' }, chassis);
  for (const x of TRACK_X) {
    const hw = TRACK_COL.halfWidth;
    el('rect', { x: x - hw, y: 378, width: 2 * hw, height: bottom - 386, rx: 10, fill: 'url(#g-column)', stroke: '#38393e', 'stroke-width': 1 }, chassis);
  }
  // The printed top band, its front ledge and the shade it casts on the track area.
  el('rect', { x: 24, y: 38, width: VB_W - 48, height: 322, rx: 14, fill: 'url(#g-top)', stroke: '#09090a', 'stroke-width': 2 }, chassis);
  el('rect', { x: 24, y: 38, width: VB_W - 48, height: 322, rx: 14, fill: 'url(#g-toplight)' }, chassis);
  el('rect', { x: 24, y: 358, width: VB_W - 48, height: 14, rx: 3, fill: 'url(#g-ledge)' }, chassis);
  el('rect', { x: trackLeft + 4, y: 372, width: trackRight - trackLeft - 8, height: 10, fill: '#000', opacity: 0.28 }, chassis);

  // ---------------------------------------------------------------- printed legends
  const ink = el('g', { class: 'deco' }, svg);
  drawLegends(ink);

  function drawLegends(g: SVGGElement): void {
    // Rear-panel jack legends along the top edge.
    const jack = (x: number, s: string) => text(g, x, 50, s, 9.5, { class: 'lbl-jack' });
    const group = (x0: number, x1: number, name: string, mid: number, gap: number) => {
      el('path', { d: `M ${x0} 54 H ${mid - gap} M ${mid + gap} 54 H ${x1}`, stroke: '#8e9298', 'stroke-width': 1 }, g);
      text(g, mid, 58.5, name, 8.5, { class: 'lbl-jack' });
    };
    jack(178, 'MIC 1'); jack(306, 'MIC 2'); jack(475, 'L — INST 1 — R'); jack(606, 'L — INST 2 — R');
    group(160, 652, 'INPUT', 409, 18);
    jack(714, 'MAIN'); jack(783, 'SUB 1'); jack(855, 'SUB 2'); jack(928, 'PHONES');
    group(700, 946, 'OUTPUT', 821, 22);
    jack(999, 'CTL/EXP');
    jack(1141, 'IN'); jack(1247, 'OUT');
    group(1130, 1262, 'MIDI', 1194, 15);
    jack(1377, 'USB'); jack(1453, 'POWER'); jack(1528, 'DC IN');

    // Red stripe with its centre tab (left blank: no model name on this panel).
    el('rect', { x: 159, y: 64.5, width: VB_W - 318, height: 3.6, fill: '#e2252d' }, g);
    el('path', { d: 'M 516 68 C 538 68 543 85 566 85 H 1114 C 1137 85 1142 68 1164 68 Z', fill: '#e2252d' }, g);

    // Brand plate.
    const bx = 251, by = 81;
    el('rect', { x: bx, y: by, width: 23, height: 23, rx: 4, fill: 'none', stroke: '#d9dce0', 'stroke-width': 2.4 }, g);
    el('path', { d: `M ${bx + 17} ${by + 9} A 6.5 6.5 0 1 0 ${bx + 17.6} ${by + 13.5}`, fill: 'none', stroke: '#d9dce0', 'stroke-width': 2.4, 'stroke-linecap': 'round' }, g);
    el('path', { d: `M ${bx + 13.5} ${by + 8.6} L ${bx + 18.6} ${by + 5.2} L ${bx + 19.2} ${by + 11} Z`, fill: '#d9dce0' }, g);
    text(g, bx + 32, by + 21, 'Sage MK1', 27, { 'text-anchor': 'start', class: 'lbl-brand', 'letter-spacing': 0.4 });

    // INPUT FX and TRACK FX blocks (mirror images).
    for (const side of ['in', 'tr'] as const) {
      const knob = LAYOUT[`${side}.knob`], edit = LAYOUT[`${side}.edit`];
      const kx = knob.x + knob.w / 2, ky = knob.y + knob.h / 2;
      const ex = edit.x + edit.w / 2;
      const right = side === 'in';
      const r = 95;
      el('path', {
        d: `M ${kx} ${ky - r} A ${r} ${r} 0 0 ${right ? 1 : 0} ${kx} ${ky + r}`,
        fill: 'none', stroke: '#c3c6cb', 'stroke-width': 3,
      }, g);
      el('rect', { x: ex - 27, y: 146, width: 54, height: 18, rx: 9, fill: 'none', stroke: '#b7bbc1', 'stroke-width': 1.4 }, g);
      text(g, ex, 160, 'EDIT', 13);
      text(g, ex, 177, '(FX BANK: HOLD)', 8.6);
      const ux0 = right ? kx : CENTER_X * 2 - 339;
      el('rect', { x: ux0, y: ky + r - 0.5, width: 180, height: 3.5, fill: '#e2252d' }, g);
      text(g, right ? 338 : CENTER_X * 2 - 338, ky + r - 6, right ? 'INPUT FX' : 'TRACK FX', 19.5, {
        'text-anchor': right ? 'end' : 'start', class: 'lbl-red', 'letter-spacing': 0.3,
      });
    }

    // MENU / LOOP legends: a printed pill that the round button sits in.
    for (const [id, s] of [['menu', 'MENU'], ['loop', 'LOOP']] as const) {
      const b = LAYOUT[id], cy = b.y + b.h / 2;
      el('rect', { x: 555, y: cy - 20, width: 100, height: 40, rx: 20, fill: 'none', stroke: '#a9adb3', 'stroke-width': 1.6 }, g);
      text(g, 592, cy + 4.8, s, 13.5);
    }
    // EXIT / ENTER (WRITE) and the cursor arrows.
    const ex = LAYOUT.exit, en = LAYOUT.enter;
    const exX = ex.x + ex.w / 2, enX = en.x + en.w / 2;
    text(g, exX, 116, 'EXIT', 13.5);
    text(g, enX, 116, 'ENTER', 13.5);
    el('path', { d: `M ${exX + 15} 150 L ${exX + 22} 158 H ${enX - 22} L ${enX - 15} 150`, fill: 'none', stroke: '#a9adb3', 'stroke-width': 1.4 }, g);
    text(g, (exX + enX) / 2, 155.5, 'WRITE', 9.5);
    el('path', { d: `M ${exX - 9} 181 L ${exX + 8} 175 V 187 Z`, fill: '#c7cacf' }, g);
    el('path', { d: `M ${enX + 9} 181 L ${enX - 8} 175 V 187 Z`, fill: '#c7cacf' }, g);

    // OUTPUT LEVEL.
    const ol = LAYOUT.outputLevel, olx = ol.x + ol.w / 2;
    text(g, olx - 64, 86, 'OUTPUT', 12.5);
    text(g, olx - 64, 99, 'LEVEL', 12.5);
    el('circle', { cx: olx - 27, cy: 169, r: 2.6, fill: '#cfd2d6' }, g);
    el('circle', { cx: olx + 27, cy: 169, r: 2.6, fill: '#cfd2d6' }, g);

    // RHYTHM: EDIT pill behind the round button, the RHYTHM legend with ▲ ▼.
    const re = LAYOUT.rhythmEdit, rx = re.x + re.w / 2, rss = LAYOUT.rhythmStartStop, rsx = rss.x + rss.w / 2;
    el('rect', { x: rx, y: ROW.middle - 10, width: 78, height: 20, rx: 10, fill: 'none', stroke: '#b7bbc1', 'stroke-width': 1.4 }, g);
    text(g, rx + 46, ROW.middle + 5, 'EDIT', 13);
    text(g, rsx, 262, 'RHYTHM', 16.5);
    el('path', { d: `M ${rsx} 235 L ${rsx + 6} 243 H ${rsx - 6} Z`, fill: '#c7cacf' }, g);
    el('path', { d: `M ${rsx} 282 L ${rsx + 6} 274 H ${rsx - 6} Z`, fill: '#c7cacf' }, g);

    // Track columns: CLEAR: HOLD over ■, and the track number.
    TRACK_X.forEach((x, i) => {
      text(g, x + TRACK_COL.buttons, TRACK_ROW.clearLabel + 3, 'CLEAR: HOLD', 9.5, { class: 'lbl-small' });
      text(g, x + TRACK_COL.number, TRACK_ROW.number + 11, String(i + 1), 31, { class: 'lbl-num' });
    });
  }

  // ---------------------------------------------------------------- LCD bezel (the canvas is laid over the glass)
  const lcdG = el('g', { class: 'deco' }, svg);
  let lcdGlass: SVGRectElement;
  {
    const L = LAYOUT.lcd;
    el('rect', { x: L.x - 37, y: L.y - 11, width: L.w + 74, height: L.h + 24, rx: 6, fill: '#000', opacity: 0.5, transform: 'translate(0 3)' }, lcdG);
    el('rect', { x: L.x - 37, y: L.y - 11, width: L.w + 74, height: L.h + 24, rx: 6, fill: 'url(#g-bezel)' }, lcdG);
    el('rect', { x: L.x - 10, y: L.y - 7, width: L.w + 20, height: L.h + 15, rx: 3, fill: '#0a0b0c' }, lcdG);
    lcdGlass = el('rect', { x: L.x, y: L.y, width: L.w, height: L.h, fill: DEFAULT_PALETTE.pixelOff }, lcdG);
  }

  // ---------------------------------------------------------------- controls
  const controls = el('g', {}, svg);
  const elements = new Map<string, SVGGElement>();
  const ledSlots: [ButtonId, LedSlot][] = [];
  const faderCaps = new Map<AbsoluteId, { g: SVGGElement; travel: number; value: number }>();
  const knobPointers = new Map<AbsoluteId, { g: SVGGElement; cx: number; cy: number; value: number }>();
  const ringSlots: RingSlot[] = [];

  const center = (r: LayoutRect) => ({ cx: r.x + r.w / 2, cy: r.y + r.h / 2 });
  const group = (id: ButtonId | AbsoluteId, kind: string): SVGGElement => {
    const g = el('g', { class: `ctl ctl-${kind}`, 'data-id': id }, controls);
    elements.set(id, g);
    return g;
  };
  const shadow = (g: Element, cx: number, cy: number, rx: number, ry: number, dy: number) =>
    el('ellipse', { cx, cy: cy + dy, rx, ry, fill: 'url(#g-shadow)', class: 'nohit' }, g);

  type RoundStyle = 'ring' | 'dark' | 'stop' | 'rec';
  function roundButton(id: ButtonId, style: RoundStyle, glyph?: (g: SVGGElement, cx: number, cy: number) => void): void {
    const r = LAYOUT[id];
    const { cx, cy } = center(r);
    const R = r.w / 2;
    const g = group(id, 'button');
    const dark = style === 'dark';
    shadow(g, cx, cy, R * 1.28, R * 1.22, R * 0.16);
    const glowR = style === 'rec' ? 82 : style === 'stop' ? R * 1.7 : R * 2.05;
    const glow = el('circle', { cx, cy, r: glowR, fill: 'none', class: 'led-glow nohit' }, g);
    el('circle', { cx, cy, r: R + (style === 'rec' ? 7 : dark ? 3 : 5), fill: '#060607', stroke: '#2c2d31', 'stroke-width': 1.2 }, g);
    const capR = dark ? R - 1.5 : R - 4.5;
    el('circle', { cx, cy, r: capR, fill: dark ? 'url(#g-cap-dark)' : 'url(#g-cap)' }, g);
    const face = el('circle', { cx, cy, r: capR, fill: 'none', class: 'led-face' }, g);
    const rimW = dark ? 2.2 : style === 'rec' ? 5 : style === 'stop' ? 4.6 : 4;
    const rimOff = dark ? RIM_DARK : RIM_OFF;
    const rim = el('circle', { cx, cy, r: R - rimW / 2, fill: 'none', stroke: rimOff, 'stroke-width': rimW, class: 'led-rim' }, g);
    if (!dark) el('circle', { cx, cy, r: R - rimW - 0.6, fill: 'none', stroke: '#000', 'stroke-opacity': 0.55, 'stroke-width': 1.2 }, g);
    glyph?.(g, cx, cy);
    ledSlots.push([id, { glow, face, rim, rimOff, code: -1 }]);
  }

  function pillButton(id: ButtonId, lines: string[], size: number): void {
    const r = LAYOUT[id];
    const { cx, cy } = center(r);
    const g = group(id, 'button');
    shadow(g, cx, cy, r.w * 0.62, r.h * 0.72, 4);
    const glow = el('ellipse', { cx, cy, rx: r.w / 2 + 26, ry: r.h / 2 + 24, fill: 'none', class: 'led-glow nohit' }, g);
    el('rect', { x: r.x - 4, y: r.y - 4, width: r.w + 8, height: r.h + 8, rx: r.h / 2 + 4, fill: '#060607', stroke: '#2c2d31', 'stroke-width': 1.2 }, g);
    const inset = 4.5;
    const cap = { x: r.x + inset, y: r.y + inset, width: r.w - 2 * inset, height: r.h - 2 * inset, rx: (r.h - 2 * inset) / 2 };
    el('rect', { ...cap, fill: 'url(#g-cap)' }, g);
    const face = el('rect', { ...cap, fill: 'none', class: 'led-face' }, g);
    el('rect', { ...cap, fill: 'url(#g-pill-sheen)' }, g);
    const rim = el('rect', { x: r.x + 2, y: r.y + 2, width: r.w - 4, height: r.h - 4, rx: r.h / 2 - 2, fill: 'none', stroke: RIM_OFF, 'stroke-width': 4, class: 'led-rim' }, g);
    el('rect', { x: r.x + 4.6, y: r.y + 4.6, width: r.w - 9.2, height: r.h - 9.2, rx: r.h / 2 - 4.6, fill: 'none', stroke: '#000', 'stroke-opacity': 0.55, 'stroke-width': 1.2 }, g);
    const lh = size * 1.02;
    const y0 = cy - ((lines.length - 1) * lh) / 2 + size * 0.36;
    lines.forEach((s, i) => text(g, cx, y0 + i * lh, s, size, { class: 'lbl-cap' }));
    ledSlots.push([id, { glow, face, rim, rimOff: RIM_OFF, code: -1 }]);
  }

  /** A knob: well, knurled skirt, cap. Absolute knobs get a pointer line that setPhysical rotates. */
  function knob(id: ButtonId | AbsoluteId, opts: { halo: number; well: number; knurl: number; cap: number; pointer?: [number, number, number] }): void {
    const r = LAYOUT[id];
    const { cx, cy } = center(r);
    const g = group(id, 'knob');
    el('circle', { cx, cy, r: opts.halo, fill: 'url(#g-skirt)', stroke: '#2a2b2f', 'stroke-width': 1 }, g);
    shadow(g, cx, cy, opts.well * 1.08, opts.well * 1.05, opts.well * 0.12);
    el('circle', { cx, cy, r: opts.well, fill: '#060607' }, g);
    const dash = (Math.PI * 2 * opts.knurl) / Math.round((Math.PI * 2 * opts.knurl) / 4.4) / 2;
    el('circle', { cx, cy, r: opts.knurl, fill: '#18191b', stroke: '#33343a', 'stroke-width': (opts.knurl - opts.cap) * 1.6, 'stroke-dasharray': `${dash} ${dash}` }, g);
    el('circle', { cx, cy, r: opts.cap, fill: 'url(#g-knob)', stroke: '#0b0b0c', 'stroke-width': 1.2 }, g);
    el('circle', { cx, cy, r: opts.cap - 2, fill: 'none', stroke: '#ffffff', 'stroke-opacity': 0.06, 'stroke-width': 1.5 }, g);
    if (opts.pointer) {
      const [from, to, width] = opts.pointer;
      const p = el('g', { class: 'knob-pointer' }, g);
      el('line', { x1: cx, y1: cy - from, x2: cx, y2: cy - to, stroke: '#f3f4f5', 'stroke-width': width, 'stroke-linecap': 'round' }, p);
      knobPointers.set(id as AbsoluteId, { g: p, cx, cy, value: Number.NaN });
    }
  }

  function fader(id: AbsoluteId): void {
    const r = LAYOUT[id];
    const fx = r.x + r.w / 2;
    const g = group(id, 'fader');
    const frameTop = r.y - 43, frameBottom = r.y + r.h + 39;
    el('rect', { x: r.x, y: frameTop, width: r.w, height: frameBottom - frameTop, rx: 5, fill: 'url(#g-fader-frame)', stroke: '#2b2c30', 'stroke-width': 1 }, g);
    el('rect', { x: r.x + 4, y: frameTop + 1, width: r.w - 8, height: 14, rx: 2, fill: '#070708' }, g);
    el('rect', { x: r.x + 6, y: frameBottom - 15, width: r.w - 12, height: 13, rx: 2, fill: '#070708' }, g);
    el('rect', { x: r.x + 6, y: frameBottom - 15, width: 7, height: 13, rx: 1, fill: '#cfd2d6' }, g);
    el('rect', { x: r.x + r.w - 13, y: frameBottom - 15, width: 7, height: 13, rx: 1, fill: '#cfd2d6' }, g);
    el('rect', { x: fx - 7, y: r.y + 8, width: 14, height: r.h + 4, rx: 3, fill: '#040405', stroke: '#26272b', 'stroke-width': 1 }, g);
    // The cap is drawn at value 1 (top) and translated down by (1 - value) * travel.
    const cap = el('g', { class: 'fader-cap' }, g);
    const cw = 80, ch = 48;
    el('rect', { x: fx - cw / 2 - 2, y: r.y - ch / 2 + 4, width: cw + 4, height: ch + 4, rx: 5, fill: '#000', opacity: 0.55 }, cap);
    el('rect', { x: fx - cw / 2, y: r.y - ch / 2, width: cw, height: ch, rx: 4, fill: 'url(#g-fader-cap)', stroke: '#111214', 'stroke-width': 1 }, cap);
    el('rect', { x: fx - cw / 2 + 3, y: r.y - ch / 2 + 2, width: cw - 6, height: 2, rx: 1, fill: '#ffffff', opacity: 0.18 }, cap);
    el('rect', { x: fx - cw / 2 + 5, y: r.y - 6.5, width: cw - 10, height: 1.5, fill: '#121315' }, cap);
    el('rect', { x: fx - cw / 2 + 5, y: r.y - 1.8, width: cw - 10, height: 3.6, rx: 1.2, fill: '#eef0f2' }, cap);
    el('rect', { x: fx - cw / 2 + 5, y: r.y + 5, width: cw - 10, height: 1.5, fill: '#121315' }, cap);
    faderCaps.set(id, { g: cap, travel: r.h, value: 1 });
  }

  function ring(n: 1 | 2 | 3 | 4 | 5): void {
    const r = LAYOUT[`ring${n}`];
    const { cx, cy } = center(r);
    const g = el('g', { class: 'deco ring', 'data-ring': n, transform: `translate(${cx} ${cy})` }, controls);
    el('circle', { r: 118, fill: 'url(#g-ring-disk)', stroke: '#3b3c41', 'stroke-width': 1.5 }, g);
    el('circle', { r: RING_BAND.outer + 4, fill: '#141517' }, g);
    const glows: SVGElement[] = [], segs: SVGElement[] = [];
    const glowLayer = el('g', {}, g);
    const segLayer = el('g', {}, g);
    const step = 360 / RING_SEGMENTS, gap = 2.6;
    for (let i = 0; i < RING_SEGMENTS; i++) {
      glows.push(el('path', { d: sector(RING_BAND.glowInner, RING_BAND.glowOuter, i * step, (i + 1) * step), fill: 'none' }, glowLayer));
      segs.push(el('path', {
        d: sector(RING_BAND.inner, RING_BAND.outer, i * step + gap / 2, (i + 1) * step - gap / 2),
        fill: SEG_OFF_FILL, class: 'ring-seg', 'data-level': 0,
      }, segLayer));
    }
    el('circle', { r: RING_BAND.inner - 3, fill: '#111214', stroke: '#2a2b2f', 'stroke-width': 1.2 }, g);
    ringSlots.push({ segs, glows, codes: new Int8Array(RING_SEGMENTS), levels: new Int8Array(RING_SEGMENTS) });
  }

  // Glyphs on caps.
  const letter = (s: string, size = 19) => (g: SVGGElement, cx: number, cy: number) => {
    text(g, cx, cy + size * 0.35, s, size, { class: 'lbl-cap lbl-glyph' });
  };
  const stopGlyph = (g: SVGGElement, cx: number, cy: number) => {
    el('rect', { x: cx - 9.5, y: cy - 9.5, width: 19, height: 19, rx: 1, fill: '#eceef0' }, g);
  };
  const recGlyph = (g: SVGGElement, cx: number, cy: number) => {
    el('path', {
      d: `M ${cx - 40} ${cy - 14} L ${cx - 9} ${cy} L ${cx - 40} ${cy + 14} Z M ${cx - 4} ${cy + 14} L ${cx + 6} ${cy - 14} ` +
        `L ${cx + 11.5} ${cy - 14} L ${cx + 1.5} ${cy + 14} Z`,
      fill: '#eceef0',
    }, g);
    el('circle', { cx: cx + 30, cy, r: 12.5, fill: '#eceef0' }, g);
  };

  // Top band.
  knob('in.knob', { halo: 84, well: 68, knurl: 62.5, cap: 56, pointer: [52, 40, 4.5] });
  knob('tr.knob', { halo: 84, well: 68, knurl: 62.5, cap: 56, pointer: [52, 40, 4.5] });
  roundButton('in.edit', 'ring');
  roundButton('tr.edit', 'ring');
  for (const s of ['A', 'B', 'C', 'D'] as const) {
    roundButton(`in.${s}`, 'ring', letter(s));
    roundButton(`tr.${s}`, 'ring', letter(s));
  }
  for (const id of ['menu', 'loop', 'exit', 'enter', 'left', 'right', 'rhythmEdit'] as const) roundButton(id, 'dark');
  knob('outputLevel', { halo: 44, well: 35.5, knurl: 31.5, cap: 27, pointer: [24, 15, 3.2] });
  for (const id of ['knob1', 'knob2', 'knob3', 'knob4'] as const) knob(id, { halo: 42, well: 36, knurl: 30.5, cap: 25.5 });
  pillButton('allStartStop', ['ALL', 'START/STOP'], 12.5);
  pillButton('undoRedo', ['UNDO/', 'REDO'], 14);
  pillButton('tapTempo', ['TAP', 'TEMPO'], 14);
  pillButton('rhythmStartStop', ['START/', 'STOP'], 14);

  // Track columns: rings first so each REC/PLAY button sits on top of its ring.
  for (const n of [1, 2, 3, 4, 5] as const) {
    ring(n);
    pillButton(`trk${n}.fx`, ['FX'], 16);
    pillButton(`trk${n}.track`, ['TRACK'], 16);
    roundButton(`trk${n}.stop`, 'stop', stopGlyph);
    fader(`trk${n}.fader`);
    roundButton(`trk${n}.rec`, 'rec', recGlyph);
  }

  for (const id of [...ALL_BUTTON_IDS, ...ALL_ABSOLUTE_IDS]) {
    if (!elements.has(id)) throw new Error(`panel: no element built for ${id}`);
  }

  root.appendChild(tabletop);

  // ---------------------------------------------------------------- LCD canvas: fit, scale, paint
  const ctx = canvas.getContext('2d');
  const lcdCtx = ctx ? new BatchedLcdContext(ctx) : null;
  const fb = new Framebuffer();
  const lastLcd = new Uint8Array(LCD_W * LCD_H);
  let lcdScale = 0; // device pixels per LCD pixel; 0 until laid out
  let lcdContrast = 5;
  let lcdHasState = false; // nothing to paint until the first render()
  let lcdPainted = false;

  function paintLcd(): void {
    if (!lcdCtx || lcdScale === 0 || !lcdHasState) return;
    fb.data = lastLcd;
    // drawToCanvas adds its 1-px pixel grid from scale 3; we only want it from 4, where it reads as a grid rather
    // than as stripes. Below 4, paint at scale 1 and let the context multiply up to solid s x s pixels.
    const grid = lcdScale >= 4;
    lcdCtx.multiplier = grid ? 1 : lcdScale;
    drawToCanvas(fb, lcdCtx, grid ? lcdScale : 1, lcdContrast, DEFAULT_PALETTE);
    lcdCtx.flush();
    lcdPainted = true;
  }

  /**
   * Fits the canvas to the glass so each LCD pixel is exactly s x s device pixels with no browser resampling:
   * s = max(1, floor(glass device width / 128)), the canvas is 128s x 64s device pixels (backing and display),
   * centred in the glass and snapped to the device-pixel grid. The glass shows around it as backlight.
   */
  function layoutLcd(): void {
    const tt = tabletop.getBoundingClientRect();
    const sr = svg.getBoundingClientRect();
    if (sr.width <= 0 || sr.height <= 0) return;
    const k = Math.min(sr.width / VB_W, sr.height / VB_H);
    const L = LAYOUT.lcd;
    const glassW = L.w * k, glassH = L.h * k;
    const glassLeft = sr.left + (sr.width - VB_W * k) / 2 + L.x * k;
    const glassTop = sr.top + (sr.height - VB_H * k) / 2 + L.y * k;
    const dpr = doc.defaultView?.devicePixelRatio || 1;
    const scale = Math.max(1, Math.floor((glassW * dpr) / LCD_W + 1e-6));
    const cssW = (LCD_W * scale) / dpr, cssH = (LCD_H * scale) / dpr;
    const snap = (v: number) => Math.round(v * dpr) / dpr;
    const style = canvas.style;
    style.left = `${snap(glassLeft + (glassW - cssW) / 2) - tt.left}px`;
    style.top = `${snap(glassTop + (glassH - cssH) / 2) - tt.top}px`;
    style.width = `${cssW}px`;
    style.height = `${cssH}px`;
    if (scale !== lcdScale) {
      lcdScale = scale;
      canvas.width = LCD_W * scale; // resizing clears the canvas
      canvas.height = LCD_H * scale;
      paintLcd();
    }
  }

  function updateLcd(lcd: Uint8Array, contrast: number): void {
    const n = lastLcd.length;
    let changed = !lcdPainted || !Object.is(contrast, lcdContrast);
    if (!changed) {
      const m = Math.min(n, lcd.length);
      for (let i = 0; i < m; i++) {
        if (lcd[i] !== lastLcd[i]) {
          changed = true;
          break;
        }
      }
    }
    if (!changed) return;
    lastLcd.set(lcd.length > n ? lcd.subarray(0, n) : lcd);
    if (!Object.is(contrast, lcdContrast)) {
      const glass = lcdColors(contrast, DEFAULT_PALETTE).pixelOff;
      if (glass !== lcdGlass.getAttribute('fill')) lcdGlass.setAttribute('fill', glass);
    }
    lcdContrast = contrast;
    lcdHasState = true;
    paintLcd();
  }

  layoutLcd();
  const win = doc.defaultView;
  if (win && 'ResizeObserver' in win) new win.ResizeObserver(() => layoutLcd()).observe(tabletop);
  win?.addEventListener('resize', layoutLcd);

  // ---------------------------------------------------------------- render
  function applyLed(slot: LedSlot, code: number): void {
    slot.code = code;
    if (code < 0) {
      slot.glow.setAttribute('fill', 'none');
      slot.face.setAttribute('fill', 'none');
      slot.rim.setAttribute('stroke', slot.rimOff);
      return;
    }
    slot.glow.setAttribute('fill', GLOW_URL[code]);
    slot.face.setAttribute('fill', FACE_URL[code]);
    slot.rim.setAttribute('stroke', RIM_LIT[code]);
  }

  const levels = new Uint8Array(RING_SEGMENTS);

  function render(state: PanelState, t: number): void {
    const beat = state.beatPhase;
    for (let i = 0; i < ledSlots.length; i++) {
      const [id, slot] = ledSlots[i];
      const led = state.leds[id];
      let code = -1;
      if (led !== undefined && led.color !== 'off' && ledLit(led.blink, t, beat)) code = COLOR_INDEX[led.color] ?? -1;
      if (code !== slot.code) applyLed(slot, code);
    }

    for (let r = 0; r < ringSlots.length; r++) {
      const slot = ringSlots[r];
      const rs = state.rings[r];
      ringLevels(rs, t, beat, levels);
      const ci = COLOR_INDEX[rs.color] ?? 0;
      for (let s = 0; s < RING_SEGMENTS; s++) {
        const lv = levels[s];
        const code = lv === SEG_OFF ? 0 : 1 + ci * 2 + (lv - 1);
        if (code === slot.codes[s]) continue;
        slot.codes[s] = code;
        const seg = slot.segs[s], glow = slot.glows[s];
        if (lv === SEG_OFF) {
          seg.setAttribute('fill', SEG_OFF_FILL);
          glow.setAttribute('fill', 'none');
        } else {
          seg.setAttribute('fill', SEG_URL[ci][lv - 1]);
          glow.setAttribute('fill', RING_GLOW_URL[ci][lv - 1]);
        }
        if (lv !== slot.levels[s]) {
          slot.levels[s] = lv;
          seg.setAttribute('data-level', LEVEL_ATTR[lv]);
        }
      }
    }

    updateLcd(state.lcd, state.contrast);
  }

  function setPhysical(id: AbsoluteId, value: number): void {
    const v = value > 0 ? Math.min(1, value) : 0; // also maps NaN to 0
    const f = faderCaps.get(id);
    if (f) {
      if (f.value !== v) {
        f.value = v;
        f.g.setAttribute('transform', `translate(0 ${((1 - v) * f.travel).toFixed(2)})`);
      }
      return;
    }
    const k = knobPointers.get(id);
    if (k && k.value !== v) {
      k.value = v;
      k.g.setAttribute('transform', `rotate(${(-KNOB_SWEEP / 2 + KNOB_SWEEP * v).toFixed(2)} ${k.cx} ${k.cy})`);
    }
  }

  // Resting positions as drawn in the manual: faders up, knob pointers at 12 o'clock.
  for (const id of ALL_ABSOLUTE_IDS) setPhysical(id, faderCaps.has(id) ? 1 : 0.5);

  return {
    render,
    elementFor(id) {
      const e = elements.get(id);
      if (!e) throw new Error(`panel: unknown control ${id}`);
      return e;
    },
    setPhysical,
    getPhysical(id) {
      return faderCaps.get(id)?.value ?? knobPointers.get(id)?.value ?? 0;
    },
    lcdCanvas: canvas,
    rootSvg: svg,
  };
}

/** Annular sector between radii r0 < r1, from angle a0 to a1 (degrees clockwise from 12 o'clock), around (0, 0). */
function sector(r0: number, r1: number, a0: number, a1: number): string {
  const p = (r: number, a: number) => {
    const rad = (a * Math.PI) / 180;
    return `${(Math.sin(rad) * r).toFixed(2)} ${(-Math.cos(rad) * r).toFixed(2)}`;
  };
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M ${p(r1, a0)} A ${r1} ${r1} 0 ${large} 1 ${p(r1, a1)} L ${p(r0, a1)} A ${r0} ${r0} 0 ${large} 0 ${p(r0, a0)} Z`;
}
