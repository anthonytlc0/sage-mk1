/**
 * LOOP MIX against the live engine (ruling R64, final review I5): from one live status, LOOP MIX hands the renderer each
 * track's playhead, and the mix it renders is the live output from the press onward, sample for sample, over a whole
 * cycle (zero latency, the exact path). The renderer's output is tapped before MASTER FX and the 44.1 kHz converter,
 * which follow it unchanged.
 */
import { describe, expect, it } from 'vitest';
import { makeStatus } from '../../src/control/fakeEngine';
import { Session } from '../../src/control/session';
import { LooperCore } from '../../src/core/looper';
import type { CoreOutput } from '../../src/core/looper';
import { mixRenderer } from '../../src/core/render';
import type { MixRenderer } from '../../src/core/render';
import { Mixer } from '../../src/dsp/mixer';
import { exportLoopMix } from '../../src/recorder/loopMix';
import type { LoopMixSource, RenderMixFn } from '../../src/recorder/loopMix';
import type { SystemSettings } from '../../src/schema/types';
import { TRACKS } from '../../src/shared/ids';
import type { TrackAudio } from '../../src/shared/protocol';

const SR = 8000;
const B = 128;

function loop(frames: number, f: (k: number) => number): TrackAudio {
  const L = new Float32Array(frames);
  const R = new Float32Array(frames);
  for (let k = 0; k < frames; k++) {
    L[k] = f(k);
    R[k] = -0.5 * f(k);
  }
  return { L, R, sampleRate: SR, recordedTempo: 120, measures: null };
}

function output(): CoreOutput {
  return {
    tracks: TRACKS.map((): [Float32Array, Float32Array] => [new Float32Array(B), new Float32Array(B)]),
    click: [new Float32Array(B), new Float32Array(B)],
  };
}

/** Run the live core `n` frames, keeping only what the Mixer makes of it when `keep` (faders at unity). */
function runLive(core: LooperCore, system: SystemSettings, n: number, keep = false): { L: Float32Array; R: Float32Array } {
  const mixer = new Mixer(SR);
  mixer.configure(system);
  const out = output();
  const z = new Float32Array(B);
  const quiet: [Float32Array, Float32Array] = [z, z];
  const mixOut: [Float32Array, Float32Array] = [new Float32Array(B), new Float32Array(B)];
  const L = new Float32Array(keep ? n : 0);
  const R = new Float32Array(keep ? n : 0);
  for (let done = 0; done < n; done += B) {
    const m = Math.min(B, n - done);
    core.process(z, z, z, z, out, m);
    if (!keep) continue;
    mixer.process(out.tracks, quiet, quiet, mixOut, null, m);
    L.set(mixOut[0].subarray(0, m), done);
    R.set(mixOut[1].subarray(0, m), done);
  }
  return { L, R };
}

/** `mixRenderer`, with everything it hands out kept (before MASTER FX and the converter). */
function tapped(): { render: RenderMixFn; L: number[]; R: number[] } {
  const L: number[] = [];
  const R: number[] = [];
  const render: RenderMixFn = (...args) => {
    const r = mixRenderer(...args);
    const tee: MixRenderer = {
      frames: r.frames,
      cut: r.cut,
      render(l: Float32Array, rr: Float32Array, n: number): void {
        r.render(l, rr, n);
        for (let k = 0; k < n; k++) {
          L.push(l[k]!);
          R.push(rr[k]!);
        }
      },
    };
    return tee;
  };
  return { render, L, R };
}

describe('LOOP MIX from the live playheads (R64)', () => {
  it('the mix is the live output from the press onward, sample for sample, over one cycle', async () => {
    const session = new Session();
    const memory = session.memory;
    for (const t of memory.track) t.loopSyncSw = false;
    memory.track[1].pan = 30;
    memory.track[2].reverse = true;
    memory.track[3].playLevel = 70;
    const system = session.system;

    // 4 bars, a 2-bar layer started at bar 1, a REVERSE layer and a 1-bar layer started off the bar (120 BPM at 8 kHz:
    // a measure is 16000 frames).
    const tracks: (TrackAudio | null)[] = [
      loop(64000, (k) => 0.3 * Math.sin(k / 17) + k / 640000),
      loop(32000, (k) => 0.2 * Math.sin(k / 5) - 0.05),
      loop(24000, (k) => 0.1 * Math.cos(k / 3) + k / 480000),
      loop(16000, (k) => 0.15 * Math.sin(k / 41)),
      null,
    ];
    const live = new LooperCore({ sampleRate: SR, memoryBudgetBytes: 64 * 1024 * 1024 });
    live.setSettings(memory, system);
    tracks.forEach((t, i) => {
      if (t) live.setTrackAudio(TRACKS[i], t);
    });
    live.command({ t: 'recPlay', track: 0 });
    runLive(live, system, 16000);
    live.command({ t: 'recPlay', track: 1 }); // bar 1
    runLive(live, system, 7000);
    live.command({ t: 'recPlay', track: 2 });
    runLive(live, system, 9100);
    live.command({ t: 'recPlay', track: 3 });
    runLive(live, system, 20000 + 37); // LOOP MIX pressed here, mid-block

    const status = makeStatus({ sampleRate: SR, frame: live.frame });
    Object.assign(status, live.status()); // the engine's status at the press
    const src: LoopMixSource & { session: Session } = {
      session,
      status,
      faderGain: () => 1,
      requestTracks: async () => tracks,
    };
    const tap = tapped();
    await exportLoopMix(src, tap.render, { touch: false });

    const cycle = 192000; // lcm(64000, 32000, 24000, 16000)
    expect(tap.L.length).toBe(cycle);
    const heard = runLive(live, system, cycle, true);
    let differ = 0;
    for (let f = 0; f < cycle; f++) if (tap.L[f] !== heard.L[f] || tap.R[f] !== heard.R[f]) differ++;
    expect(differ).toBe(0);
  });
});
