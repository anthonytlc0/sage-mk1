import { describe, it, expect } from 'vitest';
import { Reverb } from '../../src/dsp/reverb';
import { SR, allFinite, inBlocks, noise, rms, peak } from './helpers';

function runStereo(rev: Reverb, l: Float32Array, r: Float32Array): void {
  inBlocks(l.length, (o, len) => rev.process(l.subarray(o, o + len), r.subarray(o, o + len), len));
}

function impulse(seconds: number, depth: number): { l: Float32Array; r: Float32Array } {
  const rev = new Reverb(SR);
  rev.setDepth(depth);
  const l = new Float32Array(Math.round(SR * seconds)), r = new Float32Array(l.length);
  l[0] = 1; r[0] = 1;
  runStereo(rev, l, r);
  return { l, r };
}

describe('Reverb', () => {
  it('depth 0 is a bit-exact passthrough', () => {
    const rev = new Reverb(SR);
    rev.setDepth(0);
    const l = noise(4096, -12, 1), r = noise(4096, -12, 2);
    const l0 = l.slice(), r0 = r.slice();
    runStereo(rev, l, r);
    expect(Array.from(l)).toEqual(Array.from(l0));
    expect(Array.from(r)).toEqual(Array.from(r0));
  });

  it('leaves the dry signal untouched before the first reflection', () => {
    const { l } = impulse(0.05, 20);
    expect(l[0]).toBe(1);
    for (let i = 1; i < 400; i++) expect(l[i]).toBe(0);
  });

  it('adds a tail after an impulse, with decorrelated left and right', () => {
    const { l, r } = impulse(1, 20);
    expect(rms(l, 2400, 24000)).toBeGreaterThan(1e-3);
    let diff = 0;
    for (let i = 2400; i < 24000; i++) diff += Math.abs(l[i]! - r[i]!);
    expect(diff).toBeGreaterThan(0.01);
  });

  it('a deeper setting rings longer', () => {
    const tailRatio = (depth: number): number => {
      const { l } = impulse(3, depth);
      return rms(l, SR * 2, SR * 3) / rms(l, SR * 0.2, SR * 0.7);
    };
    expect(tailRatio(40)).toBeGreaterThan(tailRatio(5));
  });

  it('the tail decays and stays bounded under sustained loud input', () => {
    const rev = new Reverb(SR);
    rev.setDepth(40);
    const l = noise(SR * 5, -3, 7), r = noise(SR * 5, -3, 8);
    runStereo(rev, l, r);
    expect(allFinite(l) && allFinite(r)).toBe(true);
    expect(peak(l)).toBeLessThan(4);
    const sil = new Float32Array(SR * 6), sir = new Float32Array(SR * 6);
    runStereo(rev, sil, sir);
    expect(rms(sil, SR * 5, SR * 6)).toBeLessThan(rms(sil, 0, SR) * 0.1);
  });

  it('fades the tail out when the depth is set back to 0, then bypasses exactly', () => {
    const rev = new Reverb(SR);
    rev.setDepth(30);
    const l = noise(SR, -12, 3), r = noise(SR, -12, 4);
    runStereo(rev, l, r);
    rev.setDepth(0);
    const l2 = new Float32Array(SR), r2 = new Float32Array(SR);
    runStereo(rev, l2, r2);
    expect(allFinite(l2)).toBe(true);
    expect(rms(l2, 0, 480)).toBeGreaterThan(0);   // the tail does not stop dead
    for (let i = SR * 0.5; i < SR; i++) expect(l2[i]).toBe(0);
    const l3 = noise(512, -12, 5), r3 = noise(512, -12, 6);
    const l30 = l3.slice();
    runStereo(rev, l3, r3);
    expect(Array.from(l3)).toEqual(Array.from(l30));
  });

  it('returns finite values for a 1e-30 input', () => {
    const rev = new Reverb(SR);
    rev.setDepth(40);
    const l = new Float32Array(SR).fill(1e-30), r = l.slice();
    runStereo(rev, l, r);
    expect(allFinite(l) && allFinite(r)).toBe(true);
  });

  it('flushes the tail to exactly zero (no denormals) after a long silence', () => {
    const { l, r } = impulse(40, 20);
    expect(l[l.length - 1]).toBe(0);
    expect(r[r.length - 1]).toBe(0);
  });
});
