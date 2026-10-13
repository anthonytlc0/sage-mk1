/**
 * LOOP MIX: the loops that are playing right now, mixed down to one cycle and written as a 44.1 kHz 24-bit stereo WAV.
 *
 *   exportTracks (the engine) -> render one cycle (fader gains applied) -> MASTER FX -> 44.1 kHz -> pcm24 WAV
 *
 * The mixing itself is `renderMix` (src/core/render.ts, Task 9). It is handed in as `render`, so this module does not
 * depend on the core and a test can use a stand-in.
 */

import type { Controller } from '../control/controller';
import { MasterFx } from '../dsp/master';
import type { MemorySettings, SystemSettings } from '../schema/types';
import { EXPORT_RATE } from '../shared/constants';
import type { TrackAudio } from '../shared/protocol';
import { wavHeader } from '../storage/wav';
import { Pcm24Stream } from './encode';

/** The shape of `renderMix`: one full cycle of the playing tracks, at the context's sample rate `sr`. */
export type RenderMixFn = (
  memory: MemorySettings,
  system: SystemSettings,
  tracks: (TrackAudio | null)[],
  playing: boolean[],
  faderGains: number[],
  sr: number,
) => { L: Float32Array; R: Float32Array };

/** The part of the controller a loop mix reads. */
export type LoopMixSource = Pick<Controller, 'requestTracks' | 'status' | 'faderGain' | 'session'>;

/** No loop is playing (or the render came back empty): there is nothing to mix. */
export class NothingToMixError extends Error {
  constructor() {
    super('nothing is playing');
    this.name = 'NothingToMixError';
  }
}

/** Frames per step through MASTER FX and the converter: small enough for the DSP, big enough to be cheap. */
const STEP = 4096;

/**
 * Renders the playing loops to a WAV Blob. Rejects with `NothingToMixError` when no track with audio is playing.
 * The tracks come from the engine (`exportTracks`); which of them sound is read from the engine status (playing or
 * overdubbing), and the fader positions and the settings from the controller. MASTER FX runs on the rendered mix with a
 * fresh instance configured from the system settings, so a mix does not depend on what was exported before.
 * `render`'s output is processed in place.
 */
export async function exportLoopMix(controller: LoopMixSource, render: RenderMixFn): Promise<Blob> {
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
  const { L, R } = render(memory, system, tracks, playing, gains, sr);
  const n = Math.min(L.length, R.length);
  if (n === 0) throw new NothingToMixError();

  const fx = new MasterFx(sr);
  fx.configure(system);
  const stream = new Pcm24Stream(sr);
  const parts: Uint8Array[] = [];
  for (let at = 0; at < n; at += STEP) {
    const len = Math.min(STEP, n - at);
    const l = L.subarray(at, at + len);
    const r = R.subarray(at, at + len);
    fx.process(l, r, len);
    parts.push(stream.push(l, r));
  }
  parts.push(stream.flush());

  const header = wavHeader(stream.frames * 6, EXPORT_RATE, 2, 'pcm24');
  // wavHeader and pcm24Bytes allocate plain ArrayBuffers; their declared types only say ArrayBufferLike.
  return new Blob([header, ...parts] as Uint8Array<ArrayBuffer>[], { type: 'audio/wav' });
}
