import { describe, expect, it } from 'vitest';
import {
  ALL_ABSOLUTE_IDS,
  ALL_BUTTON_IDS,
  LAYOUT,
  PANEL_VIEWBOX,
  type LayoutId,
  type LayoutRect,
} from '../../src/ui/panelLayout';
import type { AbsoluteId, ButtonId } from '../../src/shared/ids';

type ControlId = ButtonId | AbsoluteId;
const CONTROLS: readonly ControlId[] = [...ALL_BUTTON_IDS, ...ALL_ABSOLUTE_IDS];
const RINGS = ['ring1', 'ring2', 'ring3', 'ring4', 'ring5'] as const;
const TRK = [1, 2, 3, 4, 5] as const;

const cx = (r: LayoutRect): number => r.x + r.w / 2;
const cy = (r: LayoutRect): number => r.y + r.h / 2;

/** True when the two rects share any area (touching edges do not count). */
function overlaps(a: LayoutRect, b: LayoutRect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function contains(outer: LayoutRect, inner: LayoutRect): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
}

describe('PANEL_VIEWBOX', () => {
  it('is 4 units per mm of the 420 x 234 mm unit', () => {
    expect(PANEL_VIEWBOX).toEqual({ w: 1680, h: 936 });
  });
});

describe('id lists', () => {
  it('ALL_BUTTON_IDS lists all 45 ButtonIds once each', () => {
    expect(ALL_BUTTON_IDS).toHaveLength(45);
    expect(new Set(ALL_BUTTON_IDS).size).toBe(45);
    for (const n of TRK) {
      for (const k of ['rec', 'stop', 'track', 'fx']) expect(ALL_BUTTON_IDS).toContain(`trk${n}.${k}`);
    }
    for (const id of ['in.A', 'in.D', 'in.edit', 'tr.A', 'tr.D', 'tr.edit', 'allStartStop', 'undoRedo', 'menu', 'loop',
      'exit', 'enter', 'left', 'right', 'tapTempo', 'rhythmEdit', 'rhythmStartStop', 'knob1', 'knob4']) {
      expect(ALL_BUTTON_IDS).toContain(id);
    }
  });

  it('ALL_ABSOLUTE_IDS lists all 8 AbsoluteIds once each', () => {
    expect([...ALL_ABSOLUTE_IDS].sort()).toEqual(
      ['in.knob', 'outputLevel', 'tr.knob', 'trk1.fader', 'trk2.fader', 'trk3.fader', 'trk4.fader', 'trk5.fader'],
    );
  });
});

describe('LAYOUT', () => {
  it('has a finite, positive-size rect inside the viewBox for every ButtonId, AbsoluteId, the LCD and the rings', () => {
    const ids: LayoutId[] = [...CONTROLS, 'lcd', ...RINGS];
    for (const id of ids) {
      const r = LAYOUT[id];
      expect(r, id).toBeDefined();
      for (const v of [r.x, r.y, r.w, r.h]) expect(Number.isFinite(v), `${id} ${JSON.stringify(r)}`).toBe(true);
      expect(r.w, id).toBeGreaterThan(0);
      expect(r.h, id).toBeGreaterThan(0);
      expect(r.x, id).toBeGreaterThanOrEqual(0);
      expect(r.y, id).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w, id).toBeLessThanOrEqual(PANEL_VIEWBOX.w);
      expect(r.y + r.h, id).toBeLessThanOrEqual(PANEL_VIEWBOX.h);
    }
    expect(Object.keys(LAYOUT)).toHaveLength(CONTROLS.length + 1 + RINGS.length);
  });

  it('no two controls overlap, and none overlaps the LCD', () => {
    const ids: LayoutId[] = [...CONTROLS, 'lcd'];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        expect(overlaps(LAYOUT[ids[i]], LAYOUT[ids[j]]), `${ids[i]} overlaps ${ids[j]}`).toBe(false);
      }
    }
  });

  it('each loop-indicator ring surrounds its REC/PLAY button and overlaps nothing else', () => {
    for (const n of TRK) {
      const ring = LAYOUT[`ring${n}`];
      expect(contains(ring, LAYOUT[`trk${n}.rec`]), `ring${n}`).toBe(true);
      expect(cx(ring)).toBeCloseTo(cx(LAYOUT[`trk${n}.rec`]), 6);
      expect(cy(ring)).toBeCloseTo(cy(LAYOUT[`trk${n}.rec`]), 6);
      for (const id of [...CONTROLS, 'lcd' as const]) {
        if (id === `trk${n}.rec`) continue;
        expect(overlaps(ring, LAYOUT[id]), `ring${n} overlaps ${id}`).toBe(false);
      }
    }
  });

  it('gives knobs, faders, the LCD and the rings their shapes; every other button is round or rect', () => {
    for (const id of ['in.knob', 'tr.knob', 'outputLevel', 'knob1', 'knob2', 'knob3', 'knob4'] as const) {
      expect(LAYOUT[id].shape, id).toBe('knob');
    }
    for (const n of TRK) expect(LAYOUT[`trk${n}.fader`].shape).toBe('fader');
    expect(LAYOUT.lcd.shape).toBe('lcd');
    for (const id of RINGS) expect(LAYOUT[id].shape).toBe('ring');
    for (const id of ALL_BUTTON_IDS) {
      if (id.startsWith('knob')) continue;
      expect(['round', 'rect'], id).toContain(LAYOUT[id].shape);
    }
    for (const id of [...CONTROLS, 'lcd' as const, ...RINGS]) {
      const r = LAYOUT[id];
      if (r.shape === 'round' || r.shape === 'knob' || r.shape === 'ring') expect(r.w, `${id} is square`).toBeCloseTo(r.h, 6);
    }
    expect(LAYOUT.lcd.w / LAYOUT.lcd.h).toBeCloseTo(2, 6); // 128 x 64 pixels
  });

  it('follows the hardware arrangement of Owner’s Manual p.4', () => {
    const L = LAYOUT;
    // Five track columns, left to right; in each: FX above TRACK above STOP above REC/PLAY, fader beside the buttons.
    for (const n of TRK) {
      const fx = L[`trk${n}.fx`], track = L[`trk${n}.track`], stop = L[`trk${n}.stop`], rec = L[`trk${n}.rec`];
      const fader = L[`trk${n}.fader`];
      expect(cy(fx)).toBeLessThan(cy(track));
      expect(cy(track)).toBeLessThan(cy(stop));
      expect(cy(stop)).toBeLessThan(cy(rec));
      expect(cx(fx)).toBeCloseTo(cx(track), 6);
      expect(cx(fx)).toBeCloseTo(cx(stop), 6);
      expect(fader.x).toBeGreaterThan(fx.x + fx.w);
      expect(fader.h).toBeGreaterThan(fader.w);
      if (n > 1) expect(cx(rec)).toBeGreaterThan(cx(L[`trk${(n - 1) as 1 | 2 | 3 | 4}.rec`]));
      // Track columns sit below the whole top band.
      expect(fx.y).toBeGreaterThan(L.knob1.y + L.knob1.h);
    }
    // INPUT FX on the left of the LCD, TRACK FX on the right, mirrored about the centre line.
    const mid = PANEL_VIEWBOX.w / 2;
    expect(cx(L.lcd)).toBeCloseTo(mid, 6);
    expect(cx(L['trk3.rec'])).toBeCloseTo(mid, 6);
    const mirror: [ControlId, ControlId][] = [
      ['in.knob', 'tr.knob'], ['in.edit', 'tr.edit'], ['in.A', 'tr.D'], ['in.B', 'tr.C'], ['in.C', 'tr.B'], ['in.D', 'tr.A'],
      ['menu', 'exit'], ['loop', 'left'], ['allStartStop', 'rhythmStartStop'], ['undoRedo', 'tapTempo'],
      ['knob1', 'knob4'], ['knob2', 'knob3'], ['trk1.rec', 'trk5.rec'], ['trk2.rec', 'trk4.rec'],
    ];
    for (const [a, b] of mirror) {
      expect(cx(L[a]) + cx(L[b]), `${a} mirrors ${b}`).toBeCloseTo(2 * mid, 6);
      expect(cy(L[a]), `${a} level with ${b}`).toBeCloseTo(cy(L[b]), 6);
    }
    for (const s of ['in', 'tr'] as const) {
      expect(cx(L[`${s}.A`])).toBeLessThan(cx(L[`${s}.B`]));
      expect(cx(L[`${s}.B`])).toBeLessThan(cx(L[`${s}.C`]));
      expect(cx(L[`${s}.C`])).toBeLessThan(cx(L[`${s}.D`]));
      expect(cy(L[`${s}.knob`])).toBeLessThan(cy(L[`${s}.A`]));
    }
    expect(cx(L['in.knob'])).toBeLessThan(L.lcd.x);
    expect(cx(L.menu)).toBeLessThan(L.lcd.x);
    expect(cx(L.exit)).toBeGreaterThan(L.lcd.x + L.lcd.w);
    expect(cy(L.menu)).toBeLessThan(cy(L.loop));
    expect(cx(L.exit)).toBeLessThan(cx(L.enter));
    expect(cx(L.left)).toBeLessThan(cx(L.right));
    // OUTPUT LEVEL at the top right of the centre block; knobs [1]-[4] in a row under the LCD.
    expect(cx(L.outputLevel)).toBeGreaterThan(cx(L.enter));
    expect(cx(L.outputLevel)).toBeLessThan(cx(L['tr.knob']));
    for (const k of [1, 2, 3, 4] as const) {
      expect(L[`knob${k}`].y).toBeGreaterThan(L.lcd.y + L.lcd.h);
      if (k > 1) expect(cx(L[`knob${k}`])).toBeGreaterThan(cx(L[`knob${(k - 1) as 1 | 2 | 3}`]));
    }
    expect(cx(L.knob1)).toBeGreaterThan(cx(L.undoRedo));
    expect(cx(L.knob4)).toBeLessThan(cx(L.tapTempo));
  });
});
