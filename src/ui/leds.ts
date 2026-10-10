import { BLINK_FAST_HZ, BLINK_SLOW_HZ, RING_SEGMENTS } from '../shared/constants';
import type { Blink, LedColor, RingState } from '../shared/panel';

export type LitColor = Exclude<LedColor, 'off'>;

/**
 * LED tones per colour: `core` is the lit segment / rim, `hot` the over-bright centre (and the current segment of a
 * position ring), `glow` the light that spills onto the panel around it.
 */
export const LED_COLORS: Readonly<Record<LitColor, { core: string; hot: string; glow: string }>> = {
  red: { core: '#ff2a1f', hot: '#ffb4a4', glow: '#ff2f1c' },
  green: { core: '#2bef68', hot: '#c4ffd4', glow: '#1fe85c' },
  yellow: { core: '#ffcf1a', hot: '#fff3b4', glow: '#ffc000' },
  pink: { core: '#ff4cb6', hot: '#ffc4e8', glow: '#ff38aa' },
  blue: { core: '#3a8cff', hot: '#bedaff', glow: '#2d7bff' },
};

export const LIT_COLORS: readonly LitColor[] = ['red', 'green', 'yellow', 'pink', 'blue'];

/** Fill of an unlit ring segment: the milky diffuser with no light behind it. */
export const SEG_OFF_FILL = '#3a3c41';

export const SEG_OFF = 0;
export const SEG_ON = 1;
export const SEG_HOT = 2;
export type SegLevel = typeof SEG_OFF | typeof SEG_ON | typeof SEG_HOT;

/** Lit for the first half of each 1/hz-second period, counted from t = 0 (ms). */
function firstHalf(t: number, hz: number): boolean {
  const phase = (t * hz) / 1000;
  return phase - Math.floor(phase) < 0.5;
}

/**
 * Whether an LED with this blink mode shows light at time `t` (ms). 'fast' and 'slow' blink at BLINK_FAST_HZ /
 * BLINK_SLOW_HZ full on-off cycles per second (50% duty); 'tempo' is lit for the first half of each beat.
 */
export function ledLit(blink: Blink, t: number, beatPhase: number): boolean {
  switch (blink) {
    case 'none':
      return true;
    case 'fast':
      return firstHalf(t, BLINK_FAST_HZ);
    case 'slow':
      return firstHalf(t, BLINK_SLOW_HZ);
    case 'tempo':
      return beatPhase < 0.5;
  }
}

/**
 * Per-segment brightness of a loop-indicator ring, segment 0 at 12 o'clock and counting clockwise. Writes into and
 * returns `out` (RING_SEGMENTS long) so the render loop allocates nothing.
 *  - 'status': every segment lit;
 *  - 'position': segments before amount x 24 lit and the segment holding the play position hot;
 *  - 'level': the first round(amount x 24) segments lit.
 * An 'off' ring, or one in the dark half of its blink, is all SEG_OFF. `amount` is clamped to 0..1; NaN counts as 0.
 */
export function ringLevels(ring: RingState, t: number, beatPhase: number, out: Uint8Array): Uint8Array {
  out.fill(SEG_OFF);
  if (ring.color === 'off' || !ledLit(ring.blink, t, beatPhase)) return out;
  const a = ring.amount > 0 ? Math.min(1, ring.amount) : 0; // also maps NaN to 0
  switch (ring.mode) {
    case 'status':
      out.fill(SEG_ON);
      break;
    case 'position': {
      const cur = Math.min(RING_SEGMENTS - 1, Math.floor(a * RING_SEGMENTS));
      out.fill(SEG_ON, 0, cur);
      out[cur] = SEG_HOT;
      break;
    }
    case 'level':
      out.fill(SEG_ON, 0, Math.round(a * RING_SEGMENTS));
      break;
  }
  return out;
}

/** Ring radii (viewBox units, around the REC/PLAY centre): the lit band and the halo drawn behind it. */
export const RING_BAND = { inner: 87, outer: 105, glowInner: 70, glowOuter: 124 } as const;

const SVG_NS = 'http://www.w3.org/2000/svg';

function grad(doc: Document, tag: 'radialGradient', id: string, attrs: Record<string, string>, stops: [number, string, number][]): SVGElement {
  const g = doc.createElementNS(SVG_NS, tag);
  g.setAttribute('id', id);
  for (const [k, v] of Object.entries(attrs)) g.setAttribute(k, v);
  for (const [offset, color, opacity] of stops) {
    const s = doc.createElementNS(SVG_NS, 'stop');
    s.setAttribute('offset', String(offset));
    s.setAttribute('stop-color', color);
    s.setAttribute('stop-opacity', String(opacity));
    g.appendChild(s);
  }
  return g;
}

/** Paint-server ids for one LED colour (use as `url(#id)`). */
export const ledPaint = {
  /** Halo around a lit button (objectBoundingBox: works on any circle, ellipse or rect behind the button). */
  glow: (c: LitColor) => `glow-${c}`,
  /** Light coming through a lit button cap. */
  face: (c: LitColor) => `face-${c}`,
  /** Lit ring segment, and the brighter current segment. userSpaceOnUse around (0, 0): rings are drawn translated. */
  seg: (c: LitColor, hot: boolean) => `seg-${c}${hot ? '-hot' : ''}`,
  /** Light spilling around a lit ring segment (same coordinate system as `seg`). */
  ringGlow: (c: LitColor, hot: boolean) => `ringglow-${c}${hot ? '-hot' : ''}`,
};

/**
 * The pre-rendered LED light: radial gradients per colour, defined once in <defs>. Glows are gradient fills on
 * plain shapes, never live blur filters, so lighting an LED costs one attribute change and no filter pass.
 */
export function ledDefs(doc: Document): SVGElement[] {
  const out: SVGElement[] = [];
  const { inner, outer, glowInner, glowOuter } = RING_BAND;
  const mid = (inner + outer) / 2;
  const r = (v: number) => v / glowOuter;
  for (const c of LIT_COLORS) {
    const { core, hot, glow } = LED_COLORS[c];
    out.push(grad(doc, 'radialGradient', ledPaint.glow(c), { cx: '0.5', cy: '0.5', r: '0.5' }, [
      [0, glow, 0.9], [0.42, glow, 0.62], [0.62, glow, 0.26], [0.82, glow, 0.07], [1, glow, 0],
    ]));
    out.push(grad(doc, 'radialGradient', ledPaint.face(c), { cx: '0.5', cy: '0.45', r: '0.55', fx: '0.45', fy: '0.35' }, [
      [0, hot, 0.95], [0.4, core, 0.88], [0.85, core, 0.7], [1, core, 0.55],
    ]));
    const band = (h: boolean): [number, string, number][] => [
      [inner / outer, core, 1], [mid / outer, h ? '#ffffff' : hot, 1], [1, core, 1],
    ];
    const user = { gradientUnits: 'userSpaceOnUse', cx: '0', cy: '0', r: String(outer) };
    out.push(grad(doc, 'radialGradient', ledPaint.seg(c, false), user, band(false)));
    out.push(grad(doc, 'radialGradient', ledPaint.seg(c, true), user, band(true)));
    const halo = (peak: number): [number, string, number][] => [
      [r(glowInner), glow, 0], [r(inner - 4), glow, peak * 0.55], [r(mid), glow, peak], [r(outer + 4), glow, peak * 0.5],
      [r(outer + 11), glow, peak * 0.16], [1, glow, 0],
    ];
    const userGlow = { gradientUnits: 'userSpaceOnUse', cx: '0', cy: '0', r: String(glowOuter) };
    out.push(grad(doc, 'radialGradient', ledPaint.ringGlow(c, false), userGlow, halo(0.62)));
    out.push(grad(doc, 'radialGradient', ledPaint.ringGlow(c, true), userGlow, halo(0.95)));
  }
  return out;
}
