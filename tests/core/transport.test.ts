import { describe, expect, it } from 'vitest';
import {
  Transport,
  beatFrames,
  deriveTempo,
  fadeFrames,
  measureFrames,
  nextBoundary,
  noteFrames,
  quarterFrames,
  snapLength,
} from '../../src/core/transport';
import { TEMPO_MAX, TEMPO_MIN } from '../../src/shared/constants';
import { NOTE_VALUES } from '../../src/schema/types';

const SR = 1000;
const FOUR_FOUR = { num: 4, den: 4 } as const;
const SIX_EIGHT = { num: 6, den: 8 } as const;

describe('frame math', () => {
  it('quarterFrames is one quarter note at the tempo', () => {
    expect(quarterFrames(SR, 120)).toBe(500);
    expect(quarterFrames(SR, 60)).toBe(1000);
  });

  it('measureFrames is num * 4/den quarter notes', () => {
    expect(measureFrames(SR, 120, FOUR_FOUR)).toBe(2000);
    expect(measureFrames(SR, 120, SIX_EIGHT)).toBe(1500);
    expect(measureFrames(SR, 120, { num: 3, den: 4 })).toBe(1500);
  });

  it('beatFrames is 4/den quarter notes', () => {
    expect(beatFrames(SR, 120, FOUR_FOUR)).toBe(500);
    expect(beatFrames(SR, 120, SIX_EIGHT)).toBe(250);
  });

  it('noteFrames covers 1/16, 1/8, 1/4 and 1/2', () => {
    expect(noteFrames(SR, 120, '1/16')).toBe(125);
    expect(noteFrames(SR, 120, '1/8')).toBe(250);
    expect(noteFrames(SR, 120, '1/4')).toBe(500);
    expect(noteFrames(SR, 120, '1/2')).toBe(1000);
  });

  it('noteFrames rejects a note the guide does not have', () => {
    expect(() => noteFrames(SR, 120, '1/32')).toThrow(RangeError);
  });

  it('noteFrames rejects inherited object keys, not just missing ones', () => {
    for (const key of ['toString', 'constructor', 'hasOwnProperty', '__proto__']) {
      expect(() => noteFrames(SR, 120, key)).toThrow(RangeError);
    }
  });

  it('every NOTE_VALUES entry gives a positive, finite noteFrames', () => {
    for (const note of NOTE_VALUES) {
      const frames = noteFrames(SR, 120, note);
      expect(Number.isFinite(frames)).toBe(true);
      expect(frames).toBeGreaterThan(0);
    }
  });

  it('fadeFrames is a note length or a count of measures', () => {
    expect(fadeFrames(SR, 120, FOUR_FOUR, { measures: 2 })).toBe(4000);
    expect(fadeFrames(SR, 120, SIX_EIGHT, { measures: 2 })).toBe(3000);
    expect(fadeFrames(SR, 120, FOUR_FOUR, { note: '1/4' })).toBe(500);
  });
});

describe('deriveTempo', () => {
  it('AUTO picks the measure count that lands the tempo in 80..160', () => {
    expect(deriveTempo(4000, SR, FOUR_FOUR, 'AUTO')).toEqual({ bpm: 120, measures: 2 });
  });

  it('takes the larger measure count when two candidates both fit (160 beats 80)', () => {
    expect(deriveTempo(1500, SR, FOUR_FOUR, 'AUTO')).toEqual({ measures: 1, bpm: 160 });
  });

  it('uses fractional measure counts for short loops', () => {
    expect(deriveTempo(500, SR, FOUR_FOUR, 'AUTO')).toEqual({ measures: 0.25, bpm: 120 });
  });

  it('FREE derives the same way as AUTO', () => {
    expect(deriveTempo(4000, SR, FOUR_FOUR, 'FREE')).toEqual(deriveTempo(4000, SR, FOUR_FOUR, 'AUTO'));
    expect(deriveTempo(1500, SR, FOUR_FOUR, 'FREE')).toEqual({ measures: 1, bpm: 160 });
  });

  it('accounts for the beat when scaling to quarter notes', () => {
    // 3000 frames of 6/8 (3 quarters per measure): 2 measures -> 120 bpm
    expect(deriveTempo(3000, SR, SIX_EIGHT, 'AUTO')).toEqual({ bpm: 120, measures: 2 });
  });

  it('a fixed measure count sets the tempo directly', () => {
    expect(deriveTempo(8000, SR, FOUR_FOUR, { measures: 3 })).toEqual({ bpm: 90, measures: 3 });
  });

  it('a note setting makes the loop exactly that note long', () => {
    // a 500 frame loop that is one quarter note -> 120 bpm; a quarter is a quarter of a 4/4 measure
    expect(deriveTempo(500, SR, FOUR_FOUR, { note: '1/4' })).toEqual({ bpm: 120, measures: 0.25 });
    expect(deriveTempo(500, SR, FOUR_FOUR, { note: '1/8' })).toEqual({ bpm: 60, measures: 0.125 });
  });

  it('clamps an out-of-range tempo to TEMPO_MIN..TEMPO_MAX', () => {
    // so long that even 64 measures is under 80 bpm
    expect(deriveTempo(1e9, SR, FOUR_FOUR, 'AUTO')).toEqual({ bpm: TEMPO_MIN, measures: 64 });
    // so short that even 1/4 measure is over 160 bpm
    expect(deriveTempo(10, SR, FOUR_FOUR, 'AUTO')).toEqual({ bpm: TEMPO_MAX, measures: 0.25 });
    expect(deriveTempo(1000, SR, FOUR_FOUR, { measures: 64 }).bpm).toBe(TEMPO_MAX);
    expect(deriveTempo(1e9, SR, FOUR_FOUR, { measures: 1 }).bpm).toBe(TEMPO_MIN);
  });
});

describe('nextBoundary', () => {
  it('returns the smallest boundary at or after the frame', () => {
    expect(nextBoundary(2001, 0, 2000)).toBe(4000);
    expect(nextBoundary(2000, 0, 2000)).toBe(2000);
    expect(nextBoundary(1, 0, 2000)).toBe(2000);
    expect(nextBoundary(0, 0, 2000)).toBe(0);
  });

  it('is measured from the origin', () => {
    expect(nextBoundary(2001, 500, 2000)).toBe(2500);
    expect(nextBoundary(2500, 500, 2000)).toBe(2500);
    expect(nextBoundary(100, 500, 2000)).toBe(500);
  });

  it('treats a frame computed as n * unit as sitting on boundary n', () => {
    const unit = (4 * 60 * 44100) / 117; // fractional measure length
    // (61 * unit) / unit is 61.0000000000000071, so without the epsilon this would jump to boundary 62.
    expect(nextBoundary(61 * unit, 0, unit)).toBe(61 * unit);
    for (let n = 1; n <= 200; n++) expect(nextBoundary(n * unit, 0, unit)).toBe(n * unit);
  });
});

describe('snapLength', () => {
  it('snaps to the nearest multiple of the unit', () => {
    expect(snapLength(2900, 2000)).toBe(2000);
    expect(snapLength(3100, 2000)).toBe(4000);
    expect(snapLength(4000, 2000)).toBe(4000);
  });

  it('never goes below one unit', () => {
    expect(snapLength(100, 2000)).toBe(2000);
    expect(snapLength(0, 2000)).toBe(2000);
  });
});

describe('Transport', () => {
  it('starts stopped at 120 bpm in 4/4 with the origin at 0', () => {
    const t = new Transport(SR);
    expect(t.sr).toBe(SR);
    expect(t.bpm).toBe(120);
    expect(t.beat).toEqual({ num: 4, den: 4 });
    expect(t.origin).toBe(0);
    expect(t.running).toBe(false);
  });

  it('setTempo clamps to TEMPO_MIN..TEMPO_MAX', () => {
    const t = new Transport(SR);
    t.setTempo(95.5);
    expect(t.bpm).toBe(95.5);
    t.setTempo(10);
    expect(t.bpm).toBe(TEMPO_MIN);
    t.setTempo(999);
    expect(t.bpm).toBe(TEMPO_MAX);
  });

  it('setTempo ignores a non-finite tempo and keeps the previous one', () => {
    const t = new Transport(SR);
    t.setTempo(95.5);
    for (const bad of [NaN, Infinity, -Infinity]) {
      t.setTempo(bad);
      expect(t.bpm).toBe(95.5);
    }
    expect(t.measureAt(1000).index).toBe(0); // the grid is still usable
  });

  it('measureAt gives the measure index and phase', () => {
    const t = new Transport(SR); // 2000 frames per measure
    expect(t.measureAt(0)).toEqual({ index: 0, phase: 0 });
    expect(t.measureAt(500)).toEqual({ index: 0, phase: 0.25 });
    expect(t.measureAt(2000)).toEqual({ index: 1, phase: 0 });
    expect(t.measureAt(5000)).toEqual({ index: 2, phase: 0.5 });
  });

  it('measureAt counts from the origin', () => {
    const t = new Transport(SR);
    t.origin = 1000;
    expect(t.measureAt(1000)).toEqual({ index: 0, phase: 0 });
    expect(t.measureAt(2000)).toEqual({ index: 0, phase: 0.5 });
    expect(t.measureAt(3000)).toEqual({ index: 1, phase: 0 });
    expect(t.measureAt(0)).toEqual({ index: -1, phase: 0.5 });
  });

  it('measureAt and beatPhaseAt follow tempo and beat changes', () => {
    const t = new Transport(SR);
    t.beat = { num: 6, den: 8 }; // 1500 frames per measure, 250 per beat
    expect(t.measureAt(1500)).toEqual({ index: 1, phase: 0 });
    expect(t.beatPhaseAt(125)).toBe(0.5);
    t.setTempo(60); // 3000 per measure, 500 per beat
    expect(t.measureAt(1500)).toEqual({ index: 0, phase: 0.5 });
    expect(t.beatPhaseAt(125)).toBe(0.25);
  });

  it('measureAt puts a frame computed as k * measureFrames on measure k, phase 0', () => {
    const t = new Transport(44100);
    t.setTempo(117);
    const unit = measureFrames(44100, 117, t.beat); // fractional
    for (let k = 1; k <= 200; k++) {
      expect(t.measureAt(k * unit)).toEqual({ index: k, phase: 0 });
    }
  });

  it('beatPhaseAt reads phase 0 on a frame computed as k * beatFrames', () => {
    const t = new Transport(44100);
    t.setTempo(117);
    const unit = beatFrames(44100, 117, t.beat);
    for (let k = 1; k <= 200; k++) expect(t.beatPhaseAt(k * unit)).toBe(0);
  });

  it('measureAt keeps phase in [0, 1) just before a boundary', () => {
    const t = new Transport(SR); // 2000 frames per measure
    const { index, phase } = t.measureAt(1999.9);
    expect(index).toBe(0);
    expect(phase).toBeGreaterThan(0.99);
    expect(phase).toBeLessThan(1);
  });

  it('beatPhaseAt is the position within the current beat', () => {
    const t = new Transport(SR); // 500 frames per beat
    expect(t.beatPhaseAt(0)).toBe(0);
    expect(t.beatPhaseAt(250)).toBe(0.5);
    expect(t.beatPhaseAt(500)).toBe(0);
    expect(t.beatPhaseAt(1125)).toBe(0.25);
    t.origin = 100;
    expect(t.beatPhaseAt(350)).toBe(0.5);
  });
});
