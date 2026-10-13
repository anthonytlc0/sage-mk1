import { FakeEngine, makeStatus } from '../../src/control/fakeEngine';
import type { EngineCommand } from '../../src/shared/protocol';
import { StreamingResampler } from '../../src/storage/resample';
import { EXPORT_RATE } from '../../src/shared/constants';

export const BLOCK = 4096;

/** `frames` frames of a sine at `freq` Hz and `sr`, starting at absolute frame `start`; the right channel is half as loud. */
export function sine(frames: number, freq: number, sr: number, start = 0, amp = 0.5): [Float32Array, Float32Array] {
  const L = new Float32Array(frames);
  const R = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const v = amp * Math.sin((2 * Math.PI * freq * (start + i)) / sr);
    L[i] = v;
    R[i] = v / 2;
  }
  return [L, R];
}

/** The engine the recorder talks to: after `recorder off` it answers like the real one (a last partial block, then a status without recorderFrames). */
export class RecEngine extends FakeEngine {
  /** Frames of the partial block posted when the recorder goes off (0: none). */
  tail = 0;
  /** False: never answer `recorder off` (a suspended audio context). */
  answerOff = true;
  private tailAt = 0;
  private sr = 48000;

  emitBlock(L: Float32Array, R: Float32Array): void {
    this.tailAt += L.length;
    this.emit({ t: 'recorderBlock', L, R });
  }

  override send(cmd: EngineCommand, eventTime?: number): void {
    super.send(cmd, eventTime);
    if (cmd.t === 'recorder' && !cmd.on && this.answerOff) {
      queueMicrotask(() => {
        if (this.tail > 0) {
          const [L, R] = sine(this.tail, 440, this.sr, this.tailAt);
          this.emitBlock(L, R);
        }
        this.emit({ t: 'status', status: makeStatus({ recorderFrames: null }) });
      });
    }
  }
}

/** The whole signal through a fresh resampler in one go (the reference for what a streaming encode must equal). */
export function resampleAll(L: Float32Array, R: Float32Array, inRate: number): [Float32Array, Float32Array] {
  const rs = new StreamingResampler(inRate, EXPORT_RATE, 2);
  const [aL, aR] = rs.push(L, R);
  const [bL, bR] = rs.flush();
  const outL = new Float32Array(aL.length + bL.length);
  const outR = new Float32Array(aR.length + bR.length);
  outL.set(aL, 0);
  outL.set(bL, aL.length);
  outR.set(aR, 0);
  outR.set(bR, aR.length);
  return [outL, outR];
}

export async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
