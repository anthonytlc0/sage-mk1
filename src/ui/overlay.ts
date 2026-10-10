/**
 * The keyboard cheat-sheet: a small badge with the key's name over every control that has a key. It lives in one
 * <g class="key-overlay"> at the end of the panel SVG (so it paints above the controls) with pointer-events none, so
 * a touch or click goes straight through a badge to the control under it.
 */
import { KEYMAP, SHIFT_KEYMAP } from './input/keyboard';
import { LAYOUT } from './panelLayout';
import type { PanelView } from './panelView';

const NS = 'http://www.w3.org/2000/svg';
const LAYER = 'key-overlay';

/** The text on a badge for a KeyboardEvent.code. */
export function keyLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code === 'ArrowLeft') return '←';
  if (code === 'ArrowRight') return '→';
  if (code === 'Escape') return 'Esc';
  return code; // Space, Tab, Enter
}

const layerOf = (view: PanelView): Element | null => view.rootSvg.querySelector(`:scope > g.${LAYER}`);

export function isKeyOverlayShown(view: PanelView): boolean {
  return layerOf(view) !== null;
}

/** Idempotent: showing twice leaves one layer, hiding twice is a no-op. */
export function showKeyOverlay(view: PanelView, on: boolean): void {
  const svg = view.rootSvg;
  const existing = layerOf(view);
  if (!on) {
    existing?.remove();
    return;
  }
  if (existing) {
    if (svg.lastElementChild !== existing) svg.append(existing); // keep it above anything added since
    return;
  }

  const doc = svg.ownerDocument;
  const el = (tag: string, attrs: Record<string, string | number>, parent?: Element): SVGElement => {
    const e = doc.createElementNS(NS, tag) as SVGElement;
    for (const k in attrs) e.setAttribute(k, String(attrs[k]));
    parent?.append(e);
    return e;
  };

  const layer = el('g', { class: LAYER, 'pointer-events': 'none', 'aria-hidden': 'true' });
  const badges: [string, string][] = [
    ...Object.entries(KEYMAP).map(([code, id]): [string, string] => [keyLabel(code), id]),
    ...Object.entries(SHIFT_KEYMAP).map(([code, id]): [string, string] => [`⇧${keyLabel(code)}`, id]),
  ];
  const FONT = 22;
  const H = 30;
  for (const [label, id] of badges) {
    const r = LAYOUT[id as keyof typeof LAYOUT];
    const w = Math.max(H, 16 + label.length * 11);
    const g = el('g', { 'data-key-for': id, transform: `translate(${r.x + r.w / 2} ${r.y + r.h / 2})` }, layer);
    el('rect', { x: -w / 2, y: -H / 2, width: w, height: H, rx: 6, fill: '#0b0b0c', 'fill-opacity': 0.88, stroke: '#ffd166', 'stroke-width': 2 }, g);
    // Inline style: the panel stylesheet's `.panel-svg text` rule would override presentation attributes.
    const t = el('text', { x: 0, y: FONT * 0.36, 'text-anchor': 'middle', style: `fill:#ffd166;font-size:${FONT}px;font-weight:700;` }, g);
    t.textContent = label;
  }
  svg.append(layer);
}
