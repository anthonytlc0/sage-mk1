/**
 * LOOP MIX: the loops that are playing right now, mixed down to one cycle and written as a 44.1 kHz 24-bit stereo WAV.
 *
 *   exportTracks (the engine) -> render one cycle a block at a time (fader gains applied) -> MASTER FX -> 44.1 kHz ->
 *   pcm24 WAV
 *
 * The mixing itself is `mixRenderer` (src/core/render.ts, Task 9). It is handed in as `render`, so this module does not
 * depend on the core and a test can use a stand-in.
 *
 * Streamed (ruling R63): the cycle is never held as floats. Each 4096-frame step is rendered into two reused buffers,
 * run through MASTER FX and converted; the bytes are folded into a Blob every few megabytes (a Blob made of Blobs copies
 * nothing), so the page holds the WAV once, plus a few megabytes. The render yields to the page's other tasks every
 * YIELD_MS, so the UI stays live and the pod keeps showing PREPARING... On a touch device the cycle is cut so that its
 * WAV stays within TOUCH_MIX_WAV_BYTES (the iPad's tab shares its memory with the audio pool), and `onCut` says where.
 */

import type { Controller } from '../control/controller';
import type { MixOptions, MixRenderer } from '../core/render';
import { MasterFx } from '../dsp/master';
import { isTouch } from '../engine/config';
import type { MemorySettings, SystemSettings } from '../schema/types';
import { EXPORT_RATE } from '../shared/constants';
import type { TrackAudio } from '../shared/protocol';
import { wavHeader } from '../storage/wav';
import { Pcm24Stream } from './encode';

/** The shape of `mixRenderer`: one full cycle of the playing tracks at the context's sample rate `sr`, block by block. */
export type RenderMixFn = (
  memory: MemorySettings,
  system: SystemSettings,
  tracks: (TrackAudio | null)[],
  playing: boolean[],
  faderGains: number[],
  sr: number,
  opts?: MixOptions,
) => MixRenderer;

/** The part of the controller a loop mix reads. */
export type LoopMixSource = Pick<Controller, 'requestTracks' | 'status' | 'faderGain' | 'session'>;

export interface LoopMixOptions {
  /** A touch device (an iPad): the mix is capped at TOUCH_MIX_WAV_BYTES. Default: `isTouch(navigator)`. */
  touch?: boolean;
  /** The cycle was longer than the cap: the mix was cut after `seconds`. */
  onCut?: (seconds: number) => void;
}

/** No loop is playing (or the render came back empty): there is nothing to mix. */
export class NothingToMixError extends Error {
  constructor() {
    super('nothing is playing');
    this.name = 'NothingToMixError';
  }
}

/** Frames per step through the render, MASTER FX and the converter: small enough for the DSP, big enough to be cheap. */
const STEP = 4096;
/** The longest mix on a desktop (the brief's cap, as `renderMix`'s). */
const DESKTOP_MIX_SECONDS = 10 * 60;
/** The largest WAV a touch device makes (ruling R63): 100 MB, header included. */
export const TOUCH_MIX_WAV_BYTES = 100_000_000;
const WAV_HEADER_BYTES = 44;
/** 44.1 kHz 24-bit stereo. */
const BYTES_PER_FRAME = 6;
/** Hand the thread back this often (ms) while rendering. */
const YIELD_MS = 16;
/** Fold the encoded bytes into a Blob once this many are waiting. */
const FOLD_BYTES = 4 * 1024 * 1024;

/**
 * The most frames at `sr` whose 44.1 kHz WAV stays within TOUCH_MIX_WAV_BYTES (the converter rounds its length up).
 * About 6:17 of audio at any rate.
 */
export function touchMixFrames(sr: number): number {
  const out = Math.floor((TOUCH_MIX_WAV_BYTES - WAV_HEADER_BYTES) / BYTES_PER_FRAME) - 1;
  return Math.floor((out * sr) / EXPORT_RATE);
}

/** The pod's note for a mix cut after `seconds`: 'MIX CUT AT 6:17'. */
export function mixCutNote(seconds: number): string {
  const s = Math.floor(seconds);
  return `MIX CUT AT ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** A renderer that hands out `L`/`R` (a stand-in renderer, or one already rendered). */
export function mixFromArrays(L: Float32Array, R: Float32Array, cut = false): MixRenderer {
  const frames = Math.min(L.length, R.length);
  let at = 0;
  return {
    frames,
    cut,
    render(outL: Float32Array, outR: Float32Array, n: number): void {
      const m = Math.max(0, Math.min(n, frames - at));
      outL.set(L.subarray(at, at + m));
      outR.set(R.subarray(at, at + m));
      outL.fill(0, m, n);
      outR.fill(0, m, n);
      at += m;
    },
  };
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const macrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Renders the playing loops to a WAV Blob. Rejects with `NothingToMixError` when no track with audio is playing.
 * The tracks come from the engine (`exportTracks`); which of them sound is read from the engine status (playing or
 * overdubbing), as is the engine's exact tempo, and the fader positions and the settings from the controller. MASTER FX
 * runs on the mix with a fresh instance configured from the system settings, so a mix does not depend on what was
 * exported before.
 */
export async function exportLoopMix(controller: LoopMixSource, render: RenderMixFn, opts: LoopMixOptions = {}): Promise<Blob> {
  const tracks = await controller.requestTracks();
  const status = controller.status;
  const playing = tracks.map((t, i) => {
    if (!t) return false;
    const state = status?.tracks[i]?.state;
    return status ? state === 'playing' || state === 'overdubbing' : true;
  });
  if (!playing.includes(true)) throw new NothingToMixError();

  const sr = status?.sampleRate ?? tracks.find((t) => t)!.sampleRate;
  const gains = tracks.map((_, i) => controller.faderGain(i));
  const { memory, system } = controller.session;
  const touch = opts.touch ?? isTouch(globalThis.navigator);
  const maxFrames = touch ? touchMixFrames(sr) : Math.round(DESKTOP_MIX_SECONDS * sr);
  const mix = render(memory, system, tracks, playing, gains, sr, { tempo: status?.tempo, maxFrames });
  const n = mix.frames;
  if (n === 0) throw new NothingToMixError();
  if (mix.cut) opts.onCut?.(n / sr);

  const fx = new MasterFx(sr);
  fx.configure(system);
  const stream = new Pcm24Stream(sr);
  const L = new Float32Array(STEP);
  const R = new Float32Array(STEP);
  let body = new Blob([]);
  let parts: Uint8Array[] = [];
  let waiting = 0;
  let last = now();
  for (let at = 0; at < n; at += STEP) {
    const len = Math.min(STEP, n - at);
    mix.render(L, R, len);
    fx.process(L, R, len);
    const bytes = len === STEP ? stream.push(L, R) : stream.push(L.subarray(0, len), R.subarray(0, len));
    parts.push(bytes);
    waiting += bytes.length;
    if (waiting >= FOLD_BYTES) {
      body = new Blob([body, ...(parts as Uint8Array<ArrayBuffer>[])]);
      parts = [];
      waiting = 0;
    }
    if (now() - last >= YIELD_MS) {
      await macrotask();
      last = now();
    }
  }
  parts.push(stream.flush());

  const header = wavHeader(stream.frames * BYTES_PER_FRAME, EXPORT_RATE, 2, 'pcm24');
  // wavHeader and pcm24Bytes allocate plain ArrayBuffers; their declared types only say ArrayBufferLike.
  return new Blob([header as Uint8Array<ArrayBuffer>, body, ...(parts as Uint8Array<ArrayBuffer>[])], { type: 'audio/wav' });
}
