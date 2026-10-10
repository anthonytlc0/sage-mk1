import { TEMPO_MAX, TEMPO_MIN } from '../shared/constants';

/** A pause longer than this between taps starts a new series. */
export const TAP_RESET_MS = 2000;
/** How many of the latest tap intervals are averaged. */
export const TAP_INTERVALS = 4;

/**
 * Tap tempo: the tempo from the average of the last TAP_INTERVALS intervals between taps. A gap over TAP_RESET_MS, or a
 * timestamp that goes backwards, starts a new series. Results are clamped to the memory tempo range but not rounded:
 * the caller stores them through `setParam('tempo', ...)`, which snaps to the 0.1 BPM step.
 */
export class TapTempo {
  /** Times of the taps of the current series, oldest first; at most TAP_INTERVALS + 1. */
  private readonly times: number[] = [];

  /** Registers a tap at `t` (ms). Returns the tapped tempo in BPM, or null for the first tap of a series. */
  tap(t: number): number | null {
    const last = this.times[this.times.length - 1];
    if (last !== undefined && (t - last > TAP_RESET_MS || t <= last)) this.times.length = 0;
    this.times.push(t);
    if (this.times.length > TAP_INTERVALS + 1) this.times.shift();
    if (this.times.length < 2) return null;
    const avgMs = (t - this.times[0]!) / (this.times.length - 1);
    return Math.min(TEMPO_MAX, Math.max(TEMPO_MIN, 60000 / avgMs));
  }

  reset(): void {
    this.times.length = 0;
  }
}
