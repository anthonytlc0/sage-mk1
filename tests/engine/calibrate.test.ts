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
function loopback(p: SageProcessor, frames: number, delay: number, gain = 0.5): Float32Array {
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
    p.process([[mic]], [[oL, oR]]);
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

  it('mutes the normal output while it runs (no loops or monitoring under the clicks), then restores it', () => {
    const { p, port } = makeProcessor();
    send(port, freeSettings((_m, s) => {
      s.output.routing.inputThru = true;
    }));
    expect(run(p, 1024, 0.25).L[1023]).toBeCloseTo(0.25, 4);
    send(port, { t: 'calibrate', reqId: 1 });
    const during = run(p, Math.round(0.4 * SR), 0.25); // before the first click: silence, though the mic is monitored
    expect(maxAbs(during.L)).toBe(0);
    expect(maxAbs(during.R)).toBe(0);
    run(p, captureFrames, 0.25);
    expect(calibrationEvents(port)).toHaveLength(1);
    expect(run(p, 1024, 0.25).L[1023]).toBeCloseTo(0.25, 4);
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
