/**
 * MENU > SETUP > LATENCY (non-hardware addition): turns the engine's calibration capture into a round-trip latency.
 *
 * The engine plays 8 clicks 500 ms apart through the output, after a 500 ms lead-in, and records the mic for the whole
 * window plus 500 ms (see engine/calibration.ts). `computeLatency` finds each click in the recording and returns the
 * median delay in frames, which becomes SETUP LATENCY, or refuses (CALIB FAILED) rather than store a wrong value.
 */

/** A click is heard at the first sample whose magnitude exceeds this many times the noise RMS. */
export const ONSET_FACTOR = 6;
/** Fewer agreeing clicks than this (of 8) and the measurement is refused: CALIB FAILED. */
export const MIN_DETECTED = 5;
/** Detections agree when they lie within this many seconds (1 ms) of the median of all detections. */
export const AGREE_S = 0.001;
/** Each click's noise floor is the RMS of this window just before it (seconds). */
export const NOISE_WINDOW_S = 0.02;
/** Less lead-in than this before the first click leaves no noise floor to measure: the measurement is refused. */
export const MIN_LEAD_IN_S = 0.01;
/** Below this the threshold is float dust, not signal (a capture of digital silence has an RMS of 0). */
const MIN_THRESHOLD = 1e-5;

function median(sorted: readonly number[]): number {
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * The round-trip latency in frames, or null when it cannot be trusted.
 *
 *  - Each click is looked for from its own frame (`clickFrames`, frames of `capture`) up to the next click (the last
 *    one up to the end of the capture), so an echo is never taken for the next click.
 *  - Its onset is the first sample over ONSET_FACTOR x the RMS of the NOISE_WINDOW_S just before that click. Measuring
 *    the floor per click lets the reverberant tail of the previous click (or a steady noise) raise the bar for this one.
 *  - Only detections within AGREE_S (1 ms) of the median of all detections count: a real round trip is the same every
 *    time, while speech, knocks or a room's tail land anywhere. At least MIN_DETECTED must agree.
 *  - The result is the median of the agreeing delays. Null when fewer agree, or when the lead-in before the first click
 *    is shorter than MIN_LEAD_IN_S. `sr` is the capture's sample rate.
 */
export function computeLatency(capture: Float32Array, clickFrames: readonly number[], sr: number): number | null {
  if (clickFrames.length === 0 || !(sr > 0)) return null;
  if (Math.floor(clickFrames[0]!) < Math.round(MIN_LEAD_IN_S * sr)) return null;
  const window = Math.max(1, Math.round(NOISE_WINDOW_S * sr));

  const delays: number[] = [];
  for (let c = 0; c < clickFrames.length; c++) {
    const start = Math.max(0, Math.floor(clickFrames[c]!));
    if (start >= capture.length) break;
    const previous = c > 0 ? Math.max(0, Math.floor(clickFrames[c - 1]!)) : 0;
    const from = Math.max(previous, start - window);
    let sum = 0;
    for (let i = from; i < start; i++) sum += capture[i]! * capture[i]!;
    const rms = start > from ? Math.sqrt(sum / (start - from)) : 0;
    const threshold = Math.max(ONSET_FACTOR * rms, MIN_THRESHOLD);

    const next = c + 1 < clickFrames.length ? Math.floor(clickFrames[c + 1]!) : capture.length;
    const end = Math.min(capture.length, next);
    for (let f = start; f < end; f++) {
      const v = capture[f]!;
      if (v > threshold || -v > threshold) {
        delays.push(f - start);
        break;
      }
    }
  }
  if (delays.length < MIN_DETECTED) return null;
  delays.sort((a, b) => a - b);
  const centre = median(delays);
  const tolerance = Math.max(1, Math.round(AGREE_S * sr));
  const agreeing = delays.filter((d) => Math.abs(d - centre) <= tolerance);
  if (agreeing.length < MIN_DETECTED) return null;
  return Math.round(median(agreeing));
}
