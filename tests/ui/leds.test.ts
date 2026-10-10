import { describe, expect, it } from 'vitest';
import { LED_COLORS, SEG_HOT, SEG_OFF, SEG_ON, ledLit, ringLevels } from '../../src/ui/leds';
import { BLINK_FAST_HZ, BLINK_SLOW_HZ, RING_SEGMENTS } from '../../src/shared/constants';
import type { RingState } from '../../src/shared/panel';

const ring = (r: Partial<RingState>): RingState => ({ color: 'green', blink: 'none', mode: 'status', amount: 0, ...r });
const levels = (r: Partial<RingState>, t = 0, beatPhase = 0): number[] =>
  Array.from(ringLevels(ring(r), t, beatPhase, new Uint8Array(RING_SEGMENTS)));
const count = (a: number[], v: number): number => a.filter((x) => x === v).length;

describe('LED_COLORS', () => {
  it('has a core, hot and glow colour for each lit colour', () => {
    expect(Object.keys(LED_COLORS).sort()).toEqual(['blue', 'green', 'pink', 'red', 'yellow']);
    for (const c of Object.values(LED_COLORS) as { core: string; hot: string; glow: string }[]) {
      for (const v of [c.core, c.hot, c.glow]) expect(v).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe('ledLit', () => {
  it("'none' is always lit", () => {
    for (const t of [0, 37, 1000, 123456]) expect(ledLit('none', t, 0.9)).toBe(true);
  });

  it("'fast' blinks at BLINK_FAST_HZ: lit for the first half of each period", () => {
    const period = 1000 / BLINK_FAST_HZ;
    expect(ledLit('fast', 0, 0)).toBe(true);
    expect(ledLit('fast', period * 0.49, 0)).toBe(true);
    expect(ledLit('fast', period * 0.51, 0)).toBe(false);
    expect(ledLit('fast', period * 0.99, 0)).toBe(false);
    expect(ledLit('fast', period * 1.01, 0)).toBe(true);
    expect(ledLit('fast', period * 10.6, 0)).toBe(false);
  });

  it("'slow' blinks at BLINK_SLOW_HZ", () => {
    const period = 1000 / BLINK_SLOW_HZ;
    expect(ledLit('slow', 0, 0)).toBe(true);
    expect(ledLit('slow', period * 0.4, 0)).toBe(true);
    expect(ledLit('slow', period * 0.6, 0)).toBe(false);
    expect(ledLit('slow', period * 1.2, 0)).toBe(true);
    // at 150 ms fast (6 Hz) is in its dark half while slow (2 Hz) is still lit
    expect(ledLit('fast', period * 0.3, 0)).toBe(false);
    expect(ledLit('slow', period * 0.3, 0)).toBe(true);
  });

  it("'tempo' is lit while beatPhase < 0.5, whatever t is", () => {
    expect(ledLit('tempo', 999, 0)).toBe(true);
    expect(ledLit('tempo', 999, 0.49)).toBe(true);
    expect(ledLit('tempo', 0, 0.5)).toBe(false);
    expect(ledLit('tempo', 0, 0.99)).toBe(false);
  });
});

describe('ringLevels', () => {
  it('status lights every segment', () => {
    expect(levels({ mode: 'status' })).toEqual(new Array(RING_SEGMENTS).fill(SEG_ON));
  });

  it("an 'off' ring is dark in every mode", () => {
    for (const mode of ['status', 'position', 'level'] as const) {
      expect(levels({ color: 'off', mode, amount: 0.5 })).toEqual(new Array(RING_SEGMENTS).fill(SEG_OFF));
    }
  });

  it('position lights the segments before amount x 24 and the current segment brighter', () => {
    const half = levels({ mode: 'position', amount: 0.5 });
    expect(half.slice(0, 12)).toEqual(new Array(12).fill(SEG_ON));
    expect(half[12]).toBe(SEG_HOT);
    expect(half.slice(13)).toEqual(new Array(11).fill(SEG_OFF));

    const start = levels({ mode: 'position', amount: 0 });
    expect(start[0]).toBe(SEG_HOT);
    expect(count(start, SEG_OFF)).toBe(23);

    const inSeg = levels({ mode: 'position', amount: 3.5 / 24 });
    expect(inSeg.slice(0, 4)).toEqual([SEG_ON, SEG_ON, SEG_ON, SEG_HOT]);
    expect(count(inSeg, SEG_OFF)).toBe(20);

    const end = levels({ mode: 'position', amount: 1 });
    expect(count(end, SEG_ON)).toBe(23);
    expect(end[23]).toBe(SEG_HOT);
  });

  it('level lights round(amount x 24) segments from the top', () => {
    expect(count(levels({ mode: 'level', amount: 0 }), SEG_ON)).toBe(0);
    const q = levels({ mode: 'level', amount: 0.25 });
    expect(q.slice(0, 6)).toEqual(new Array(6).fill(SEG_ON));
    expect(count(q, SEG_OFF)).toBe(18);
    expect(count(levels({ mode: 'level', amount: 1 }), SEG_ON)).toBe(24);
    expect(count(levels({ mode: 'level', amount: 0.5 }), SEG_HOT)).toBe(0);
  });

  it('clamps amount to 0..1 and treats NaN as 0', () => {
    expect(levels({ mode: 'level', amount: 7 })).toEqual(levels({ mode: 'level', amount: 1 }));
    expect(levels({ mode: 'level', amount: -2 })).toEqual(levels({ mode: 'level', amount: 0 }));
    expect(levels({ mode: 'position', amount: Number.NaN })).toEqual(levels({ mode: 'position', amount: 0 }));
  });

  it('blinks the whole ring', () => {
    const offPhase = (1000 / BLINK_FAST_HZ) * 0.75;
    expect(count(levels({ blink: 'fast' }, offPhase), SEG_OFF)).toBe(24);
    expect(count(levels({ blink: 'fast' }, 0), SEG_ON)).toBe(24);
    expect(count(levels({ blink: 'tempo', mode: 'position', amount: 0.5 }, 0, 0.7), SEG_OFF)).toBe(24);
    expect(count(levels({ blink: 'tempo', mode: 'position', amount: 0.5 }, 0, 0.2), SEG_OFF)).toBe(11);
  });

  it('writes into and returns the given buffer (no allocation per frame)', () => {
    const out = new Uint8Array(RING_SEGMENTS).fill(9);
    expect(ringLevels(ring({ mode: 'level', amount: 0.5 }), 0, 0, out)).toBe(out);
    expect(Array.from(out)).toEqual([...new Array(12).fill(SEG_ON), ...new Array(12).fill(SEG_OFF)]);
  });
});
