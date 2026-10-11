/**
 * MENU > SETUP > LATENCY (non-hardware addition): turns the engine's calibration capture into a round-trip latency.
 *
 * The engine plays 8 clicks 500 ms apart through the output, after a 500 ms lead-in, and records the mic for the whole
 * window plus 500 ms (see engine/calibration.ts). `computeLatency` finds each click in the recording and returns the
 * median delay in frames, which becomes SETUP LATENCY. The lead-in is silent, so it gives the noise floor.
 */

/** A click is heard at the first sample whose magnitude exceeds this many times the noise RMS. */
export const ONSET_FACTOR = 6;
/** Fewer clicks heard than this (of 8) and the measurement is refused: CALIB FAILED. */
export const MIN_DETECTED = 5;
/** Below this the threshold is float dust, not signal (a capture of digital silence has an RMS of 0). */
const MIN_THRESHOLD = 1e-5;

/**
 * The round-trip latency in frames: the median, over the clicks that were heard, of the delay from the frame a click
 * was played (`clickFrames`, frames of `capture`) to its onset in `capture`. The onset is the first sample over
 * ONSET_FACTOR x the RMS of the noise before the first click; each click is looked for from its own frame up to the
 * next click (the last one up to the end of the capture), so an echo is never taken for the next click. Null when
 * fewer than MIN_DETECTED clicks are found (no mic, headphones on, too quiet). `sr` is the capture's sample rate.
 */
export function computeLatency(capture: Float32Array, clickFrames: readonly number[], sr: number): number | null {
  if (clickFrames.length === 0 || !(sr > 0)) return null;
  const noiseEnd = Math.max(0, Math.min(capture.length, Math.floor(clickFrames[0]!)));
  let sum = 0;
  for (let i = 0; i < noiseEnd; i++) sum += capture[i]! * capture[i]!;
  const rms = noiseEnd > 0 ? Math.sqrt(sum / noiseEnd) : 0;
  const threshold = Math.max(ONSET_FACTOR * rms, MIN_THRESHOLD);

  const delays: number[] = [];
  for (let c = 0; c < clickFrames.length; c++) {
    const start = Math.max(0, Math.floor(clickFrames[c]!));
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
  const mid = delays.length >> 1;
  const median = delays.length % 2 === 1 ? delays[mid]! : (delays[mid - 1]! + delays[mid]!) / 2;
  return Math.round(median);
}
