/**
 * Transport and timing math. Pure functions over frames (samples), sample rate and tempo, plus the small `Transport`
 * that tracks the tempo, beat and measure grid. No browser APIs, so it runs the same in the audio worklet, the main
 * thread and node tests.
 */
import { TEMPO_MAX, TEMPO_MIN } from '../shared/constants';
import type { Beat, FadeTime, MeasureSetting, NoteLen } from '../schema/types';

const DEFAULT_BPM = 120;
const DEFAULT_BEAT: Beat = { num: 4, den: 4 };

/** A note's length in quarter notes. The guide has these four (NOTE_VALUES); no 1/32 or triplets. */
const NOTE_QUARTERS: Readonly<Record<string, number>> = { '1/16': 0.25, '1/8': 0.5, '1/4': 1, '1/2': 2 };

/** AUTO/FREE tempo targets: the loop is taken to be `m` measures long, with the bpm landing in this window. */
const AUTO_BPM_MIN = 80;
const AUTO_BPM_MAX = 160;
const AUTO_MEASURES = [1 / 4, 1 / 2, 1, 2, 4, 8, 16, 32, 64] as const;

/** Relative slack so a frame computed as `n * unit` still counts as sitting on boundary n despite float rounding. */
const BOUNDARY_EPSILON = 1e-9;

function clampTempo(bpm: number): number {
  return Math.min(TEMPO_MAX, Math.max(TEMPO_MIN, bpm));
}

function noteQuarters(note: NoteLen): number {
  const q = NOTE_QUARTERS[note];
  if (q === undefined) throw new RangeError(`Unknown note length: ${note}`);
  return q;
}

/** Quarter notes in one measure of `beat`: `num * 4/den`. */
function measureQuarters(beat: Beat): number {
  return (beat.num * 4) / beat.den;
}

/** Frames in one quarter note. */
export function quarterFrames(sr: number, bpm: number): number {
  return (sr * 60) / bpm;
}

/** Frames in one measure. Fractional, since a measure is rarely a whole number of frames. */
export function measureFrames(sr: number, bpm: number, beat: Beat): number {
  return (quarterFrames(sr, bpm) * beat.num * 4) / beat.den;
}

/** Frames in one beat of `beat`, which is `4/den` quarter notes. */
export function beatFrames(sr: number, bpm: number, beat: Beat): number {
  return (quarterFrames(sr, bpm) * 4) / beat.den;
}

/** Frames in a note of the given length (1/16, 1/8, 1/4 or 1/2 of a whole note). */
export function noteFrames(sr: number, bpm: number, note: NoteLen): number {
  return quarterFrames(sr, bpm) * noteQuarters(note);
}

/** Frames in a FADE TIME: a note length or a count of measures. */
export function fadeFrames(sr: number, bpm: number, beat: Beat, f: FadeTime): number {
  return 'note' in f ? noteFrames(sr, bpm, f.note) : f.measures * measureFrames(sr, bpm, beat);
}

/**
 * Work out the tempo of a recorded loop and how many measures it spans.
 *
 * With `{ measures: k }` the loop is k measures, so `bpm = k * num * (4/den) * 60 * sr / len`. With `{ note }` (INFERRED)
 * the loop is exactly that note long, and `measures` is the note's share of one measure. For 'AUTO' and 'FREE'
 * (INFERRED), the measure count `m` comes from {1/4, 1/2, 1, 2, 4, ..., 64}: the bpm formula above gives each `m` a
 * tempo, and the largest `m` whose tempo is in 80..160 wins. If none is in the window, the `m` with the tempo nearest
 * it wins. Every tempo is clamped to TEMPO_MIN..TEMPO_MAX; the measure count is left as chosen.
 */
export function deriveTempo(
  lengthFrames: number,
  sr: number,
  beat: Beat,
  measure: MeasureSetting,
): { bpm: number; measures: number } {
  const bpmFor = (quarters: number): number => (quarters * 60 * sr) / lengthFrames;
  const perMeasure = measureQuarters(beat);

  if (measure !== 'AUTO' && measure !== 'FREE') {
    if ('note' in measure) {
      const q = noteQuarters(measure.note);
      return { bpm: clampTempo(bpmFor(q)), measures: q / perMeasure };
    }
    return { bpm: clampTempo(bpmFor(measure.measures * perMeasure)), measures: measure.measures };
  }

  // INFERRED: the guide gives no AUTO/FREE rule beyond "the tempo follows the loop". Prefer a musical tempo.
  let best = AUTO_MEASURES[0];
  let bestDistance = Infinity;
  for (const m of AUTO_MEASURES) {
    const bpm = bpmFor(m * perMeasure);
    const distance = bpm < AUTO_BPM_MIN ? AUTO_BPM_MIN - bpm : bpm > AUTO_BPM_MAX ? bpm - AUTO_BPM_MAX : 0;
    // `<=`: m ascends, so a tie goes to the larger m.
    if (distance <= bestDistance) {
      best = m;
      bestDistance = distance;
    }
  }
  return { bpm: clampTempo(bpmFor(best * perMeasure)), measures: best };
}

/** The first boundary (`originFrame + k * unitFrames`, k an integer) at or after `frame`. */
export function nextBoundary(frame: number, originFrame: number, unitFrames: number): number {
  const k = Math.ceil((frame - originFrame) / unitFrames - BOUNDARY_EPSILON);
  return originFrame + k * unitFrames;
}

/** Round a length to the nearest whole number of units, never fewer than one. */
export function snapLength(lengthFrames: number, unitFrames: number): number {
  return Math.max(1, Math.round(lengthFrames / unitFrames)) * unitFrames;
}

/** Position within a grid of `unit`-frame cells counted from `origin`: the cell number and how far through it. */
function cellAt(frame: number, origin: number, unit: number): { index: number; phase: number } {
  const cells = (frame - origin) / unit;
  const index = Math.floor(cells);
  return { index, phase: cells - index };
}

/** The shared tempo and time signature, and the measure grid they lay over the timeline from `origin`. */
export class Transport {
  sr: number;
  bpm = DEFAULT_BPM;
  beat: Beat = { ...DEFAULT_BEAT };
  /** Frame at which measure 0 begins. */
  origin = 0;
  running = false;

  constructor(sr: number) {
    this.sr = sr;
  }

  /** Set the tempo, clamped to TEMPO_MIN..TEMPO_MAX. */
  setTempo(bpm: number): void {
    this.bpm = clampTempo(bpm);
  }

  /** Which measure `frame` is in (negative before the origin) and how far through it, in 0..1. */
  measureAt(frame: number): { index: number; phase: number } {
    return cellAt(frame, this.origin, measureFrames(this.sr, this.bpm, this.beat));
  }

  /** How far through the current beat `frame` is, in 0..1. */
  beatPhaseAt(frame: number): number {
    return cellAt(frame, this.origin, beatFrames(this.sr, this.bpm, this.beat)).phase;
  }
}
