/**
 * Device-rate stereo float blocks in, 44.1 kHz 24-bit stereo WAV payload bytes out, a block at a time.
 *
 * One `Pcm24Stream` is one recording: it owns a resampler and its own dither stream, so a long take never has to exist
 * as a whole in memory and the dither of one take does not depend on anything else that was encoded (`pcm24Bytes`'s
 * default dither is shared by the whole module, so every caller that encodes in chunks passes its own).
 */

import { EXPORT_RATE } from '../shared/constants';
import { StreamingResampler } from '../storage/resample';
import { createDither, pcm24Bytes } from '../storage/wav';
import type { Dither } from '../storage/wav';

export class Pcm24Stream {
  private readonly resampler: StreamingResampler;
  private readonly dither: Dither = createDither();
  private _frames = 0;

  constructor(inRate: number) {
    this.resampler = new StreamingResampler(inRate, EXPORT_RATE, 2);
  }

  /** 44.1 kHz frames produced so far (the bytes returned by `push` and `flush` hold this many frames, 6 bytes each). */
  get frames(): number {
    return this._frames;
  }

  /** Converts one block. The result is empty until the resampler has seen enough input to settle its first output. */
  push(L: Float32Array, R: Float32Array): Uint8Array {
    return this.encode(this.resampler.push(L, R));
  }

  /** Ends the stream: the tail the resampler held back. Call it once. */
  flush(): Uint8Array {
    return this.encode(this.resampler.flush());
  }

  private encode([L, R]: [Float32Array, Float32Array]): Uint8Array {
    this._frames += L.length;
    return pcm24Bytes(L, R, L.length, this.dither);
  }
}
