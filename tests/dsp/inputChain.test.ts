import { describe, it, expect } from 'vitest';
import { InputChain } from '../../src/dsp/inputChain';
import { defaultSystem } from '../../src/schema/params';
import type { SystemSettings } from '../../src/schema/types';
import { SR, allFinite, fill, linToDb, noise, rms, sine } from './helpers';

const BLOCK = 128;

/** Runs `mic` through a chain in worklet-sized blocks. Returns the output channels and the last block's peak. */
function run(edit: ((s: SystemSettings) => void) | undefined, mic: Float32Array, chain?: InputChain) {
  const sys = defaultSystem();
  edit?.(sys);
  const ic = chain ?? new InputChain(SR);
  ic.configure(sys);
  const L = new Float32Array(mic.length), R = new Float32Array(mic.length);
  let lastPeak = 0;
  for (let o = 0; o < mic.length; o += BLOCK) {
    const n = Math.min(BLOCK, mic.length - o);
    lastPeak = ic.process(mic.subarray(o, o + n), L.subarray(o, o + n), R.subarray(o, o + n), n);
  }
  return { L, R, peak: lastPeak, ic };
}

describe('InputChain', () => {
  it('puts the mono mic at the centre of both channels at unity (MIC 1 IN = 100)', () => {
    const mic = sine(SR / 4, 440, -12);
    const { L, R } = run(undefined, mic);
    expect(Array.from(R)).toEqual(Array.from(L));
    expect(rms(L, 4800, 12000)).toBeCloseTo(rms(mic, 4800, 12000), 4);
  });

  it('passes DC at unity (no DC blocker in the chain)', () => {
    const { L } = run(undefined, fill(SR, 0.5));
    expect(L[SR - 1]).toBeCloseTo(0.5, 5);
  });

  it('MIC 1 IN 200 doubles and 50 halves the level; 0 is silent', () => {
    const mic = sine(SR / 2, 440, -20);
    const base = rms(mic, 12000, 24000);
    expect(rms(run((s) => { s.mixer.mic1In = 200; }, mic).L, 12000, 24000) / base).toBeCloseTo(2, 3);
    expect(rms(run((s) => { s.mixer.mic1In = 50; }, mic).L, 12000, 24000) / base).toBeCloseTo(0.5, 3);
    const zero = run((s) => { s.mixer.mic1In = 0; }, mic).L;
    expect(rms(zero, 12000, 24000)).toBe(0);
  });

  it('setMute silences the chain and unmuting restores it', () => {
    const mic = sine(SR / 2, 440, -20);
    const first = run(undefined, mic);
    first.ic.setMute(true);
    const muted = run(undefined, mic, first.ic);
    expect(rms(muted.L, 12000, 24000)).toBe(0);
    first.ic.setMute(false);
    const back = run(undefined, mic, first.ic);
    expect(rms(back.L, 12000, 24000)).toBeCloseTo(rms(mic, 12000, 24000), 4);
  });

  it('returns the input peak after the gain stage', () => {
    const mic = sine(SR / 4, 440, -6);   // peak ~0.5
    expect(run(undefined, mic).peak).toBeGreaterThan(0.45);
    expect(run(undefined, mic).peak).toBeLessThan(0.51);
    expect(run((s) => { s.mixer.mic1In = 200; }, mic).peak).toBeGreaterThan(0.9);
    expect(run(undefined, new Float32Array(1024)).peak).toBe(0);
  });

  it('applies the MIC1 input EQ', () => {
    const mic = sine(SR, 50, -20);
    const flat = run(undefined, mic);
    const boosted = run((s) => { const e = s.input.eq.MIC1; e.sw = true; e.loGain = 12; }, mic);
    const g = linToDb(rms(boosted.L, SR / 2, SR) / rms(flat.L, SR / 2, SR));
    expect(g).toBeGreaterThan(11);
    expect(g).toBeLessThan(13);
  });

  it('applies the mic compressor (MIC1 COMP)', () => {
    const mic = sine(SR, 1000, -6);
    const off = run(undefined, mic);
    const on = run((s) => { s.input.dynamics.mic1Comp = 100; }, mic);
    expect(rms(on.L, SR / 2, SR)).toBeLessThan(rms(off.L, SR / 2, SR) * 0.7);
  });

  it('applies the noise suppressor (MIC1 NS)', () => {
    const mic = noise(SR * 2, -70);
    const open = run((s) => { s.input.dynamics.mic1Ns = 0; }, mic);
    const gated = run((s) => { s.input.dynamics.mic1Ns = 100; }, mic);
    expect(linToDb(rms(open.L, SR, SR * 2) / rms(gated.L, SR, SR * 2))).toBeGreaterThan(20);
  });

  it('leaves a normal-level voice-sized signal untouched with the default settings', () => {
    const mic = sine(SR, 300, -18);
    const { L } = run(undefined, mic);
    expect(Math.abs(linToDb(rms(L, SR / 2, SR) / rms(mic, SR / 2, SR)))).toBeLessThan(0.1);
  });

  it('returns finite values for a 1e-30 input', () => {
    const { L, R, peak } = run((s) => {
      s.input.eq.MIC1.sw = true; s.input.eq.MIC1.loGain = 12; s.input.dynamics.mic1Comp = 100; s.input.dynamics.mic1Ns = 100;
    }, new Float32Array(SR).fill(1e-30));
    expect(allFinite(L) && allFinite(R)).toBe(true);
    expect(Number.isFinite(peak)).toBe(true);
  });

  it('survives a non-finite sample without poisoning later output', () => {
    const mic = sine(2048, 440, -12);
    mic[100] = NaN; mic[101] = Infinity;
    const { L } = run((s) => { s.input.eq.MIC1.sw = true; s.input.eq.MIC1.loGain = 6; s.input.dynamics.mic1Comp = 50; }, mic);
    expect(allFinite(L)).toBe(true);
  });
});
