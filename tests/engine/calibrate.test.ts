import { describe, expect, it } from 'vitest';
import { computeLatency } from '../../src/control/calibrate';
import { CALIB_CLICKS, CALIB_INTERVAL_S, CALIB_TAIL_S, CLICK_GAIN, CLICK_S, calibrationClickFrames } from '../../src/engine/calibration';
import type { SageProcessor } from '../../src/engine/processor';
import type { FakePort } from '../../src/engine/fakePort';
import { BLOCK, SR, freeSettings, makeProcessor, maxAbs, run, send } from './helpers';

/**
 * Runs the processor with its own output fed back to its input `delay` frames later (a speaker heard by the mic), for
 * `frames` frames. Returns the output. `delay` must be at least one block, as in a real round trip.
 */
function loopback(p: SageProcessor, frames: number, delay: number, gain = 0.5, contextStart?: number): Float32Array {
  const out = new Float32Array(frames);
  let done = 0;
  while (done < frames) {
    const n = Math.min(BLOCK, frames - done);
    const mic = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      const src = done + k - delay;
      mic[k] = src >= 0 ? out[src]! * gain : 0;
    }
    const oL = new Float32Array(n);
    const oR = new Float32Array(n);
    p.process([[mic]], [[oL, oR]], contextStart === undefined ? undefined : contextStart + done);
    out.set(oL, done);
    done += n;
  }
  return out;
}

const captureFrames = Math.round((CALIB_CLICKS * CALIB_INTERVAL_S + CALIB_TAIL_S) * SR);

function calibrationEvents(port: FakePort) {
  return port.events('calibration');
}

describe('SageProcessor calibrate', () => {
  it('plays 8 clicks 500 ms apart and posts the mic capture of the whole window plus 500 ms', () => {
    const { p, port } = makeProcessor();
    send(port, { t: 'calibrate', reqId: 42 });
    const out = loopback(p, captureFrames + 2 * BLOCK, 1234);

    const events = calibrationEvents(port);
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.reqId).toBe(42);
    expect(ev.clickFrames).toEqual(calibrationClickFrames(SR));
    expect(ev.clickFrames).toHaveLength(8);
    for (let i = 1; i < 8; i++) expect(ev.clickFrames[i]! - ev.clickFrames[i - 1]!).toBe(CALIB_INTERVAL_S * SR);
    expect(ev.capture).toHaveLength(captureFrames);

    // The output holds the bursts at the click frames (20 ms each, starting at their peak) and nothing else.
    const burst = Math.round(CLICK_S * SR);
    for (const c of ev.clickFrames) {
      expect(out[c]).toBeCloseTo(CLICK_GAIN, 5);
      expect(maxAbs(out, c - 200, c)).toBe(0);
      expect(maxAbs(out, c + burst, c + burst + 200)).toBe(0);
    }
    // The capture is the mic, so the round trip comes out exactly.
    expect(computeLatency(ev.capture, ev.clickFrames, SR)).toBe(1234);
    // The capture buffer was transferred, not copied.
    const posted = port.posted.find((x) => (x.data as { t?: string }).t === 'calibration')!;
    expect(posted.transfer).toHaveLength(1);
  });

  it('clickFrames index the capture (capture-relative), wherever the processor timeline is when it starts', () => {
    const { p, port } = makeProcessor();
    const before = 100 * BLOCK; // the engine has been running a while: its own frame count is far from 0
    const out = new Float32Array(before + captureFrames + 2 * BLOCK);
    out.set(loopback(p, before, 300), 0);
    send(port, { t: 'calibrate', reqId: 5 });
    out.set(loopback(p, captureFrames + 2 * BLOCK, 1234), before);
    const ev = calibrationEvents(port)[0]!;
    // Same values as a calibration started at frame 0: they count from the start of the capture.
    expect(ev.clickFrames).toEqual(calibrationClickFrames(SR));
    // Each click left the output at the capture's start + its click frame...
    for (const c of ev.clickFrames) expect(out[before + c]).toBeCloseTo(CLICK_GAIN, 5);
    // ...and the capture holds it 1234 frames later at the same base, so the delay comes out exactly.
    expect(ev.capture[ev.clickFrames[0]! + 1234]).toBeCloseTo(CLICK_GAIN * 0.5, 5);
    expect(ev.capture[ev.clickFrames[0]! + 1233]).toBe(0);
    expect(computeLatency(ev.capture, ev.clickFrames, SR)).toBe(1234);
    // The status timeline is another base: it is not used here.
    expect(port.events('status').at(-1)!.status.frame).toBeGreaterThan(before + captureFrames);
  });

  it('clickFrames are not shifted by the context-frame offset (the status timeline) when the worklet runs late', () => {
    const { p, port } = makeProcessor();
    const contextStart = 5_000_000; // the AudioContext had run ~104 s before the engine's first block
    send(port, { t: 'calibrate', reqId: 8 });
    loopback(p, captureFrames + 2 * BLOCK, 1234, 0.5, contextStart);
    const ev = calibrationEvents(port)[0]!;
    expect(ev.clickFrames).toEqual(calibrationClickFrames(SR)); // capture-relative, as without an offset
    expect(computeLatency(ev.capture, ev.clickFrames, SR)).toBe(1234);
    expect(port.events('status').at(-1)!.status.frame).toBeGreaterThan(contextStart); // the offset is in effect
  });

  it('mutes the normal output while it runs (no loops or monitoring under the clicks), then restores it', () => {
    const { p, port } = makeProcessor();
    send(port, freeSettings((_m, s) => {
      s.output.routing.inputThru = true;
    }));
    expect(run(p, 1024, 0.25).L[1023]).toBeCloseTo(0.25, 4);
    send(port, { t: 'calibrate', reqId: 1 });
    const during = run(p, Math.round(0.4 * SR), 0.25); // before the first click: silence (after the 5 ms fade), though the mic is monitored
    const fade = Math.round(0.005 * SR);
    expect(maxAbs(during.L, fade)).toBe(0);
    expect(maxAbs(during.R, fade)).toBe(0);
    run(p, captureFrames, 0.25);
    expect(calibrationEvents(port)).toHaveLength(1);
    expect(run(p, 1024, 0.25).L[1023]).toBeCloseTo(0.25, 4);
  });

  it('fades the normal output out over 5 ms at the start and back in over 5 ms after the capture (no pops)', () => {
    const { p, port } = makeProcessor();
    send(port, freeSettings((_m, s) => {
      s.output.routing.inputThru = true; // the mic is heard: 0.25 on the output
    }));
    run(p, 1024, 0.25);
    send(port, { t: 'calibrate', reqId: 4 });
    const fade = Math.round(0.005 * SR);
    const out = run(p, captureFrames + fade + 2 * BLOCK, 0.25).L;
    // out: from 0.25 down to silence in `fade` frames, a straight line
    for (let k = 0; k < fade; k++) expect(out[k]).toBeCloseTo(0.25 * (1 - k / fade), 5);
    expect(maxAbs(out, fade, calibrationClickFrames(SR)[0]!)).toBe(0);
    // in: from silence back to 0.25 in `fade` frames after the last captured frame
    expect(calibrationEvents(port)).toHaveLength(1);
    for (let k = 0; k < fade; k++) expect(out[captureFrames + k]).toBeCloseTo(0.25 * ((k + 1) / fade), 5);
    expect(out[captureFrames + fade]).toBeCloseTo(0.25, 5);
    // no step anywhere larger than one ramp step (the clicks aside)
    const clicks = calibrationClickFrames(SR);
    const burst = Math.round(CLICK_S * SR);
    for (let k = 1; k < out.length; k++) {
      if (clicks.some((c) => k >= c && k <= c + burst)) continue;
      expect(Math.abs(out[k]! - out[k - 1]!)).toBeLessThanOrEqual(0.25 / fade + 1e-6);
    }
  });

  it('a calibrate during a calibration starts muted (no fade back up in between)', () => {
    const { p, port } = makeProcessor();
    send(port, freeSettings((_m, s) => {
      s.output.routing.inputThru = true;
    }));
    send(port, { t: 'calibrate', reqId: 1 });
    run(p, 4800, 0.25);
    send(port, { t: 'calibrate', reqId: 2 });
    const out = run(p, 4800, 0.25).L;
    expect(maxAbs(out)).toBe(0);
  });

  it('without a mic the capture is silent, so no latency can be measured', () => {
    const { p, port } = makeProcessor();
    send(port, { t: 'calibrate', reqId: 3 });
    run(p, captureFrames + BLOCK, null);
    const ev = calibrationEvents(port)[0]!;
    expect(maxAbs(ev.capture)).toBe(0);
    expect(computeLatency(ev.capture, ev.clickFrames, SR)).toBeNull();
  });

  it('a second calibrate restarts the measurement under its own request id', () => {
    const { p, port } = makeProcessor();
    send(port, { t: 'calibrate', reqId: 1 });
    run(p, SR);
    send(port, { t: 'calibrate', reqId: 2 });
    run(p, captureFrames + BLOCK);
    expect(calibrationEvents(port).map((e) => e.reqId)).toEqual([2]);
  });

  it('works at 44.1 kHz too', () => {
    const { p, port } = makeProcessor({}, 44100);
    send(port, { t: 'calibrate', reqId: 9 });
    const frames = Math.round((CALIB_CLICKS * CALIB_INTERVAL_S + CALIB_TAIL_S) * 44100);
    loopback(p, frames + BLOCK, 777);
    const ev = calibrationEvents(port)[0]!;
    expect(ev.clickFrames).toEqual(calibrationClickFrames(44100));
    expect(computeLatency(ev.capture, ev.clickFrames, 44100)).toBe(777);
  });
});
