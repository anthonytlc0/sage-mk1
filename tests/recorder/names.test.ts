import { describe, expect, it } from 'vitest';
import { formatClock, mixFilename, takeFilename } from '../../src/recorder/names';

describe('formatClock', () => {
  it('shows whole seconds as mm:ss, counting frames at 44.1 kHz', () => {
    expect(formatClock(0)).toBe('00:00');
    expect(formatClock(44100)).toBe('00:01');
    expect(formatClock(44100 * 59 + 44099)).toBe('00:59');
    expect(formatClock(44100 * 60)).toBe('01:00');
    expect(formatClock(44100 * (12 * 60 + 5))).toBe('12:05');
  });

  it('lets the minutes run past two digits for a very long set', () => {
    expect(formatClock(44100 * (100 * 60 + 7))).toBe('100:07');
  });

  it('treats a negative or non-finite count as zero', () => {
    expect(formatClock(-5)).toBe('00:00');
    expect(formatClock(Number.NaN)).toBe('00:00');
  });
});

describe('file names', () => {
  it('names a take Sage MK1 take YYYY-MM-DD HH-MM.wav in local time, zero padded', () => {
    expect(takeFilename(new Date(2026, 9, 12, 7, 5, 59))).toBe('Sage MK1 take 2026-10-12 07-05.wav');
    expect(takeFilename(new Date(2026, 0, 3, 23, 0).getTime())).toBe('Sage MK1 take 2026-01-03 23-00.wav');
  });

  it('names a loop mix the same way', () => {
    expect(mixFilename(new Date(2026, 11, 31, 0, 9))).toBe('Sage MK1 loop mix 2026-12-31 00-09.wav');
  });
});
