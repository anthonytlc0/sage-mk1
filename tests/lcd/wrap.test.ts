import { describe, expect, it } from 'vitest';
import { textWidth } from '../../src/lcd/draw';
import { FONT_SMALL } from '../../src/lcd/fonts';
import { WrapCache, wrapLines } from '../../src/lcd/wrap';

describe('wrapLines', () => {
  it('keeps a short text on one line', () => {
    expect(wrapLines('MEMORY', 36, FONT_SMALL, 2, false)).toEqual(['MEMORY']);
  });

  it('breaks at spaces', () => {
    expect(wrapLines('MFX REVERB', 36, FONT_SMALL, 2, false)).toEqual(['MFX', 'REVERB']);
    expect(wrapLines('PLAY LEVEL', 31, FONT_SMALL, 3, true)).toEqual(['PLAY', 'LEVEL']);
  });

  it('hyphenates a word that does not fit when asked to (the way the hardware prints IMME-DIATE)', () => {
    expect(wrapLines('IMMEDIATE', 31, FONT_SMALL, 2, true)).toEqual(['IMME-', 'DIATE']);
    expect(wrapLines('RESONANCE', 31, FONT_SMALL, 2, true)).toEqual(['RESO-', 'NANCE']);
  });

  it('clips a word that does not fit when not hyphenating', () => {
    const [line] = wrapLines('INST1(R),', 36, FONT_SMALL, 2, false);
    expect(textWidth(line!, FONT_SMALL)).toBeLessThanOrEqual(36);
    expect(line!.startsWith('INST1')).toBe(true);
  });

  it('keeps the first and the last line when there are more than maxLines', () => {
    expect(wrapLines('AA BB CC', 12, FONT_SMALL, 2, false)).toEqual(['AA', 'CC']);
  });

  it('gives no lines for an empty text', () => {
    expect(wrapLines('', 36, FONT_SMALL, 2, false)).toEqual([]);
  });
});

describe('WrapCache', () => {
  it('returns the same array for the same text, so a frame allocates nothing', () => {
    const cache = new WrapCache(FONT_SMALL, 36, 2, false);
    const a = cache.get('MFX REVERB');
    expect(a).toEqual(['MFX', 'REVERB']);
    expect(cache.get('MFX REVERB')).toBe(a);
  });
});
