/** Level meters: peak amplitude to a 0..1 position, and the peak-hold that falls slowly behind it. */

/** The bottom of a meter, in dB (0 dB = full scale). INFERRED: the manual shows no scale numbers. */
export const METER_FLOOR_DB = -48;
/** How fast a peak-hold falls, in meter fractions per second. INFERRED. */
export const HOLD_FALL_PER_S = 0.5;

/** A linear peak (1 = full scale) as a position 0..1 on the meter's dB scale. */
export function levelFraction(peak: number): number {
  if (!(peak > 0)) return 0;
  const f = (20 * Math.log10(peak) - METER_FLOOR_DB) / -METER_FLOOR_DB;
  return f < 0 ? 0 : f > 1 ? 1 : f;
}

/**
 * Peak-hold values for a screen's meters. `feed(i, f, now)` returns the hold of meter `i` after seeing level `f` at
 * `now` (ms): it jumps up with the level and falls HOLD_FALL_PER_S behind it. Each meter keeps its own time, so one
 * that was off screen for a while has fallen by the time it is drawn again.
 */
export class PeakHolds {
  private readonly value: Float32Array;
  private readonly at: Float64Array;

  constructor(n: number) {
    this.value = new Float32Array(n);
    this.at = new Float64Array(n).fill(Number.NaN);
  }

  feed(i: number, f: number, now: number): number {
    const last = this.at[i]!;
    const dt = last === last && now > last ? (now - last) / 1000 : 0;
    const v = Math.max(f, this.value[i]! - dt * HOLD_FALL_PER_S);
    this.value[i] = v;
    this.at[i] = now;
    return v;
  }
}
