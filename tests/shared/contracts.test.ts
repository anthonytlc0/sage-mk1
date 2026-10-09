import { describe, expect, it } from 'vitest';
import { TRACKS } from '../../src/shared/ids';
import { LCD_H, LCD_W } from '../../src/shared/constants';

describe('shared contracts', () => {
  it('TRACKS lists the five track indices in order', () => {
    expect(TRACKS).toEqual([0, 1, 2, 3, 4]);
  });

  it('LCD is 128x64 = 8192 pixels', () => {
    expect(LCD_W * LCD_H).toBe(8192);
  });
});
