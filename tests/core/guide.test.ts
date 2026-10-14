import { afterEach, describe, expect, it, vi } from 'vitest';
import { BEAT_HZ, CLICK_LEVEL, CLICK_MS, DOWNBEAT_HZ, GuideClick } from '../../src/core/guide';
import { Transport } from '../../src/core/transport';
import { LooperCore } from '../../src/core/looper';
import { at, dc, makeCore, makeOutput, recPlay, SR } from './harness';
import { freeSettings, makeProcessor, run as runProcessor, send } from '../engine/helpers';

/** Renders `n` frames of the click from frame `from` in blocks of `block`. */
function renderClick(t: Transport, sr: number, from: number, n: number, block = 128): { L: Float32Array; R: Float32Array } {
  const g = new GuideClick(sr);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const bl = new Float32Array(block);
  const br = new Float32Array(block);
  for (let done = 0; done < n; done += block) {
    const m = Math.min(block, n - done);
    g.render(t, from + done, m, bl, br);
    L.set(bl.subarray(0, m), done);
    R.set(br.subarray(0, m), done);
  }
  return { L, R };
}

/** The frames where a click starts: nonzero after a zero (or at the first frame). */
function onsets(x: Float32Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < x.length; i++) if (x[i] !== 0 && (i === 0 || x[i - 1] === 0)) out.push(i);
  return out;
}

/** Sign changes in `x[from, from + n)`: twice the frequency times the duration. */
function crossings(x: Float32Array, from: number, n: number): number {
  let c = 0;
  for (let i = from + 1; i < from + n; i++) if ((x[i - 1] < 0 && x[i] >= 0) || (x[i - 1] >= 0 && x[i] < 0)) c++;
  return c;
}

function running(sr: number, bpm = 120): Transport {
  const t = new Transport(sr);
  t.setTempo(bpm);
  t.running = true;
  return t;
}

describe('GuideClick', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('at tempo 120 and 48 kHz the onsets fall on multiples of 24000 frames, and the downbeat is higher', () => {
    const sr = 48000;
    const { L, R } = renderClick(running(sr), sr, 0, 8 * 24000);
    expect(onsets(L)).toEqual([0, 1, 2, 3, 4, 5, 6, 7].map((k) => k * 24000));
    expect(R).toEqual(L); // centred

    const win = Math.round((CLICK_MS / 1000) * sr);
    const down = crossings(L, 0, win);
    const beat = crossings(L, 24000, win);
    expect(down).toBeGreaterThan(beat);
    // 2 kHz and 1 kHz over 20 ms: 80 and 40 sign changes.
    expect(Math.abs(down - (2 * DOWNBEAT_HZ * CLICK_MS) / 1000)).toBeLessThanOrEqual(2);
    expect(Math.abs(beat - (2 * BEAT_HZ * CLICK_MS) / 1000)).toBeLessThanOrEqual(2);
    // The fifth beat is the next downbeat (4/4).
    expect(crossings(L, 4 * 24000, win)).toBe(down);
  });

  it('is a 20 ms decaying sine at -12 dBFS, silent between clicks', () => {
    const sr = 48000;
    const { L } = renderClick(running(sr), sr, 0, 24000);
    const win = Math.round((CLICK_MS / 1000) * sr);
    let peak = 0;
    for (let i = 0; i < win; i++) peak = Math.max(peak, Math.abs(L[i]));
    expect(CLICK_LEVEL).toBeCloseTo(10 ** (-12 / 20), 9);
    expect(peak).toBeLessThanOrEqual(CLICK_LEVEL + 1e-6);
    expect(peak).toBeGreaterThan(0.8 * CLICK_LEVEL);
    // It decays: the last 5 ms are far quieter than the first.
    let early = 0;
    let late = 0;
    for (let i = 0; i < win / 4; i++) early = Math.max(early, Math.abs(L[i]));
    for (let i = (3 * win) / 4; i < win; i++) late = Math.max(late, Math.abs(L[i]));
    expect(late).toBeLessThan(early / 10);
    expect(L.subarray(win).every((v) => v === 0)).toBe(true);
  });

  it('is silent while the transport is not running', () => {
    const t = running(SR);
    t.running = false;
    expect(renderClick(t, SR, 0, 4000).L.every((v) => v === 0)).toBe(true);
  });

  it('gives the same samples whatever the block size and start frame', () => {
    const t = running(1000, 97);
    const a = renderClick(t, 1000, 0, 5000, 128).L;
    const b = renderClick(t, 1000, 0, 5000, 7).L;
    expect(b).toEqual(a);
    const c = renderClick(t, 1000, 1234, 2000, 50).L;
    expect(c).toEqual(a.subarray(1234, 3234));
  });

  it('follows the beat: 3/4 has a downbeat every 3 beats, 6/8 clicks on eighth notes', () => {
    const t = running(1000);
    t.beat = { num: 3, den: 4 };
    const L = renderClick(t, 1000, 0, 3000).L; // beats of 500 frames at 120
    expect(onsets(L)).toEqual([0, 500, 1000, 1500, 2000, 2500]);
    const c = (k: number) => crossings(L, k * 500, 20);
    expect(c(0)).toBeGreaterThan(c(1));
    expect(c(3)).toBe(c(0));
    expect(c(2)).toBe(c(1));

    t.beat = { num: 6, den: 8 };
    expect(onsets(renderClick(t, 1000, 0, 1500).L)).toEqual([0, 250, 500, 750, 1000, 1250]);
  });

  it('counts beats from the grid origin, and a fractional beat clicks on the first whole frame at or after it', () => {
    const t = running(1000, 110); // a beat is 545.45... frames
    t.origin = 100;
    const L = renderClick(t, 1000, 0, 2400).L;
    expect(onsets(L)).toEqual([100, 646, 1191, 1737, 2282]);
    expect(crossings(L, 100, 20)).toBeGreaterThan(crossings(L, 646, 20));
    // Before the origin: beat -1 (the last of the measure before), a plain beat.
    const before = renderClick(t, 1000, -1000, 1000).L;
    expect(onsets(before).map((f) => f - 1000)).toEqual([-990, -445]);
  });

  it('render allocates nothing', () => {
    const t = running(48000);
    const g = new GuideClick(48000);
    const L = new Float32Array(128);
    const R = new Float32Array(128);
    g.render(t, 0, 128, L, R);
    const made: unknown[] = [];
    const Real = Float32Array;
    vi.stubGlobal('Float32Array', new Proxy(Real, {
      construct(target, args: unknown[]) {
        made.push(args);
        return Reflect.construct(target, args) as object;
      },
    }));
    for (let f = 128; f < 48000; f += 128) g.render(t, f, 128, L, R);
    expect(made).toHaveLength(0);
  });
});

describe('RHYTHM START/STOP (phase 1: the GUIDE click)', () => {
  const rhythm = (core: LooperCore): void => core.command({ t: 'rhythmStartStop' });

  /** The click output of `n` frames. */
  function clickOut(core: LooperCore, n: number): Float32Array {
    const out = makeOutput(128);
    const L = new Float32Array(n);
    const z = new Float32Array(128);
    for (let done = 0; done < n; done += 128) {
      const m = Math.min(128, n - done);
      core.process(z, z, z, z, out, m);
      L.set(out.click[0].subarray(0, m), done);
    }
    return L;
  }

  it('cycles off -> on -> off: the click plays and the transport runs only while on', () => {
    const core = makeCore(); // sr 1000, tempo 120: a beat is 500 frames
    expect(core.status().rhythm).toBe('off');
    expect(clickOut(core, 1000).every((v) => v === 0)).toBe(true);

    rhythm(core); // at frame 1000: nothing else keeps time, so the grid starts here
    expect(core.status().rhythm).toBe('on');
    const on = clickOut(core, 2000);
    expect(onsets(on)).toEqual([0, 500, 1000, 1500]);
    expect(crossings(on, 0, 20)).toBeGreaterThan(crossings(on, 500, 20)); // a downbeat first

    rhythm(core);
    expect(core.status().rhythm).toBe('off');
    expect(clickOut(core, 1500).every((v) => v === 0)).toBe(true);

    rhythm(core);
    expect(core.status().rhythm).toBe('on');
    expect(onsets(clickOut(core, 1000))).toEqual([0, 500]);
  });

  it('a rhythm started mid-block clicks from its exact frame', () => {
    const core = makeCore();
    clickOut(core, 1000);
    core.command({ t: 'rhythmStartStop' }, 1050);
    const L = clickOut(core, 600);
    expect(onsets(L)).toEqual([50, 550]);
  });

  it('joins the running grid of a synced loop, in step with its measures', () => {
    const core = makeCore({ track: [{ loopSyncSw: true, measure: { measures: 1 } }], rec: { recAction: 'REC->PLAY' } });
    at(core, 0, recPlay(), dc(0.1));
    at(core, 2000, recPlay(), dc(0.1)); // one measure of 2000 frames at 120: the grid's origin is 0
    at(core, 2700, { t: 'rhythmStartStop' });
    const L = clickOut(core, 2000); // frames 2700..4699
    expect(onsets(L).map((f) => f + 2700)).toEqual([3000, 3500, 4000, 4500]);
    expect(crossings(L, 4000 - 2700, 20)).toBeGreaterThan(crossings(L, 3000 - 2700, 20)); // 4000 is a measure line
  });
});

describe('the engine plays the GUIDE click', () => {
  it('rhythm on: the click comes out of the engine at the RHYTHM OUT level, on the beats', () => {
    const { p, port } = makeProcessor(); // 48 kHz
    send(port, freeSettings());
    send(port, { t: 'rhythmStartStop' });
    const out = runProcessor(p, 48000);
    expect(onsets(out.L)).toEqual([0, 24000]);
    let peak = 0;
    for (let i = 0; i < 960; i++) peak = Math.max(peak, Math.abs(out.L[i]));
    expect(peak).toBeGreaterThan(0.8 * CLICK_LEVEL);
    expect(peak).toBeLessThanOrEqual(CLICK_LEVEL + 1e-6);

    send(port, freeSettings((_m, s) => {
      s.mixer.rhythmOut = 50;
    }));
    const half = runProcessor(p, 48000);
    let peak2 = 0; // the second click: the mixer ramps a level change across one block
    for (let i = 24000; i < 24960; i++) peak2 = Math.max(peak2, Math.abs(half.L[i]));
    let plain = 0; // the same kind of click (a beat, not a downbeat) at full level
    for (let i = 24000; i < 24960; i++) plain = Math.max(plain, Math.abs(out.L[i]));
    expect(peak2).toBeCloseTo(plain / 2, 6);

    send(port, { t: 'rhythmStartStop' });
    expect(runProcessor(p, 48000).L.every((v) => v === 0)).toBe(true);
  });
});
