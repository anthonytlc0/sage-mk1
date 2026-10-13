/**
 * Playwright harness for the recorder pod (tests/e2e/recorder.spec.ts): the real Recorder, Takes (IndexedDB), Controller,
 * saveFile and pod, with a fake engine that posts a 440 Hz sine in real time while the recorder is on. The database is
 * named by the `?db=` query parameter, so a spec can reload the page and find its takes again.
 *
 * It also stands in for the shell: Backquote calls `toggleRecord()`, as the input layer's `onSpecialKey('recorder')` will.
 */
import { Controller } from '../../../src/control/controller';
import { FakeEngine, makeStatus } from '../../../src/control/fakeEngine';
import type { RenderMixFn } from '../../../src/recorder/loopMix';
import { Recorder } from '../../../src/recorder/recorder';
import type { EngineCommand } from '../../../src/shared/protocol';
import type { TrackAudio } from '../../../src/shared/protocol';
import { openDb } from '../../../src/storage/db';
import { Takes } from '../../../src/storage/takes';
import { mountRecorderPod, toggleRecord } from '../../../src/ui/recorderPod';
import type { RecorderPod } from '../../../src/ui/recorderPod';
import { FakeLcd, memStores } from '../../control/helpers';

const SR = 48000;
const BLOCK = 4096;

/** Posts `recorderBlock`s at the real-time rate while the recorder is on, and answers `recorder off` like the worklet. */
class HarnessEngine extends FakeEngine {
  /** How long `exportTracks` takes to answer (ms), so a spec can see PREPARING. */
  exportDelayMs = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private frame = 0;

  constructor() {
    super();
    this.exportReply = null; // answered below
  }

  private block(n: number): void {
    const L = new Float32Array(n);
    const R = new Float32Array(n);
    for (let i = 0; i < n; i++) L[i] = R[i] = 0.4 * Math.sin((2 * Math.PI * 440 * (this.frame + i)) / SR);
    this.frame += n;
    this.emit({ t: 'recorderBlock', L, R });
  }

  override send(cmd: EngineCommand, eventTime?: number): void {
    super.send(cmd, eventTime);
    if (cmd.t === 'recorder' && cmd.on) {
      this.frame = 0;
      this.timer = setInterval(() => this.block(BLOCK), (BLOCK / SR) * 1000);
    } else if (cmd.t === 'recorder') {
      clearInterval(this.timer);
      setTimeout(() => {
        this.block(1000);
        this.emit({ t: 'status', status: makeStatus({ recorderFrames: null }) });
      }, 0);
    } else if (cmd.t === 'exportTracks') {
      const reqId = cmd.reqId;
      const tone = (frames: number, v: number): TrackAudio => ({
        L: new Float32Array(frames).fill(v),
        R: new Float32Array(frames).fill(v),
        sampleRate: SR,
        recordedTempo: 120,
        measures: 1,
      });
      setTimeout(() => this.emit({ t: 'tracks', reqId, tracks: [tone(SR, 0.2), tone(2 * SR, 0.1), null, null, null] }), this.exportDelayMs);
    }
  }
}

/** Stands in for Task 9's renderMix: the playing tracks looped to the longest and summed. */
const render: RenderMixFn = (_m, _s, tracks, playing) => {
  const n = Math.max(0, ...tracks.map((t, i) => (playing[i] && t ? t.L.length : 0)));
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  tracks.forEach((t, i) => {
    if (!playing[i] || !t) return;
    for (let k = 0; k < n; k++) {
      L[k] += t.L[k % t.L.length]!;
      R[k] += t.R[k % t.R.length]!;
    }
  });
  return { L, R };
};

export interface RecorderHarness {
  recorder: Recorder;
  takes: Takes;
  controller: Controller;
  engine: HarnessEngine;
  pod: RecorderPod;
  /** Every object URL created and revoked since the page loaded. */
  urls: { created: string[]; revoked: string[] };
  /** The `code` of every keydown the page saw (the pod must not need, or take, any key). */
  keyPresses: string[];
}

declare global {
  interface Window {
    __rec: RecorderHarness;
  }
}

const urls = { created: [] as string[], revoked: [] as string[] };
const create = URL.createObjectURL.bind(URL);
const revoke = URL.revokeObjectURL.bind(URL);
URL.createObjectURL = (obj: Blob | MediaSource): string => {
  const url = create(obj);
  urls.created.push(url);
  return url;
};
URL.revokeObjectURL = (url: string): void => {
  urls.revoked.push(url);
  revoke(url);
};

const root = document.getElementById('app');
if (!root) throw new Error('recorder harness: #app missing');
const dbName = new URLSearchParams(location.search).get('db') ?? `recorder-e2e-${Math.random().toString(36).slice(2)}`;

const db = await openDb(dbName);
const takes = new Takes(db);
const engine = new HarnessEngine();
const controller = new Controller(engine, memStores(), new FakeLcd());
engine.emit({ t: 'status', status: makeStatus({ sampleRate: SR }, [{ state: 'playing' }, { state: 'playing' }]) });
const recorder = new Recorder(engine, takes, SR);
const pod = mountRecorderPod(root, recorder, controller, { render });

const keyPresses: string[] = [];
window.addEventListener('keydown', (e) => {
  keyPresses.push(e.code);
  if (e.code === 'Backquote' && !e.repeat) void toggleRecord();
});

window.__rec = { recorder, takes, controller, engine, pod, urls, keyPresses };
document.documentElement.dataset.ready = '1';
