import { describe, expect, it } from 'vitest';
import { TapTempo } from '../../src/control/tapTempo';
import { TEMPO_MAX, TEMPO_MIN } from '../../src/shared/constants';

describe('TapTempo', () => {
  it('taps at 0, 500, 1000, 1500 ms give 120.0', () => {
    const tt = new TapTempo();
    expect(tt.tap(0)).toBeNull();
    expect(tt.tap(500)).toBe(120);
    expect(tt.tap(1000)).toBe(120);
    expect(tt.tap(1500)).toBe(120);
  });

  it('a gap of more than 2 s starts a new series', () => {
    const tt = new TapTempo();
    tt.tap(0);
    tt.tap(500);
    expect(tt.tap(3000)).toBeNull(); // 2.5 s gap: reset, this is the first tap of a new series
    expect(tt.tap(3400)).toBe(150);
  });

  it('averages the last 4 intervals only', () => {
    const tt = new TapTempo();
    tt.tap(0);
    tt.tap(1000); // a slow first interval that drops out once 4 newer ones exist
    tt.tap(1500);
    tt.tap(2000);
    expect(tt.tap(2500)).toBeCloseTo(60000 / ((1000 + 500 + 500 + 500) / 4), 9);
    expect(tt.tap(3000)).toBe(120);
  });

  it('clamps to the tempo range', () => {
    const fast = new TapTempo();
    fast.tap(0);
    expect(fast.tap(100)).toBe(TEMPO_MAX);
    const slow = new TapTempo();
    slow.tap(0);
    expect(slow.tap(1990)).toBe(TEMPO_MIN);
  });

  it('reset() forgets earlier taps; a timestamp going backwards also restarts', () => {
    const tt = new TapTempo();
    tt.tap(0);
    tt.tap(500);
    tt.reset();
    expect(tt.tap(700)).toBeNull();
    expect(tt.tap(600)).toBeNull();
    expect(tt.tap(1000)).toBe(150);
  });
});
