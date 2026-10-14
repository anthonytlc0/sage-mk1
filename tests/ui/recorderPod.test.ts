import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SAVE_CEILING_MS, withCeiling } from '../../src/ui/recorderPod';
import type { SaveResult } from '../../src/storage/share';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('SAVE / SAVE MIX in flight (ledger 348)', () => {
  it('the ceiling is between 30 and 60 s', () => {
    expect(SAVE_CEILING_MS).toBeGreaterThanOrEqual(30_000);
    expect(SAVE_CEILING_MS).toBeLessThanOrEqual(60_000);
  });

  it('a share sheet that never answers (navigator.share left pending) frees the button at the ceiling', async () => {
    let got: SaveResult | 'timeout' | null = null;
    void withCeiling(new Promise<SaveResult>(() => {}), SAVE_CEILING_MS).then((v) => (got = v));
    await vi.advanceTimersByTimeAsync(SAVE_CEILING_MS - 1);
    expect(got).toBeNull(); // still in flight: a second tap is ignored
    await vi.advanceTimersByTimeAsync(1);
    expect(got).toBe('timeout');
  });

  it('an answer before the ceiling passes through and leaves no timer behind; a late one after it is ignored', async () => {
    await expect(withCeiling(Promise.resolve<SaveResult>('saved'), SAVE_CEILING_MS)).resolves.toBe('saved');
    expect(vi.getTimerCount()).toBe(0);
    await expect(withCeiling(Promise.reject(new Error('share failed')), SAVE_CEILING_MS)).rejects.toThrow('share failed');
    expect(vi.getTimerCount()).toBe(0);

    let answer!: (r: SaveResult) => void;
    const late = withCeiling(new Promise<SaveResult>((res) => (answer = res)), 1000);
    await vi.advanceTimersByTimeAsync(1000);
    answer('saved');
    await expect(late).resolves.toBe('timeout');
  });
});
