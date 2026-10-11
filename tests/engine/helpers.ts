/** Shared helpers for the engine tests. Not a test file (vitest only picks up *.test.ts). */
import { expect } from 'vitest';
import { SageProcessor } from '../../src/engine/processor';
import type { SageProcessorOptions } from '../../src/engine/processor';
import { FakePort } from '../../src/engine/fakePort';
import { defaultMemory } from '../../src/schema/memory';
import { defaultSystem } from '../../src/schema/system';
import type { MemorySettings, SystemSettings } from '../../src/schema/types';
import type { EngineCommand, TrackAudio } from '../../src/shared/protocol';

export const SR = 48000;
export const BLOCK = 128;

/** A processor at `sr` on a FakePort. */
export function makeProcessor(opts: SageProcessorOptions = {}, sr = SR): { p: SageProcessor; port: FakePort } {
  const port = new FakePort();
  const p = new SageProcessor(sr, port, opts);
  return { p, port };
}

/** Posts `cmd` to the processor as the host would (a TimedCommand; `at` null = now). */
export function send(port: FakePort, cmd: EngineCommand, at: number | null = null): void {
  port.receive({ cmd, at });
}

/** The guide defaults with LOOP SYNC OFF on every track (free loops), edited by `edit`. */
export function freeSettings(edit?: (m: MemorySettings, s: SystemSettings) => void): Extract<EngineCommand, { t: 'settings' }> {
  const memory = defaultMemory();
  for (const t of memory.track) t.loopSyncSw = false;
  const system = defaultSystem();
  edit?.(memory, system);
  return { t: 'settings', memory, system };
}

export type Input = number | ((frame: number) => number) | null;

/**
 * Runs `frames` frames through the processor in 128-frame blocks, as an AudioWorklet would. `input` is the mono mic: a
 * constant, a function of the frame within this run, or null for no input channel at all (no mic connected).
 * `contextFrame`, when given, is the AudioContext frame of the first block (the worklet's `currentFrame`); the blocks
 * after it follow on. Returns the stereo output.
 */
export function run(
  p: SageProcessor,
  frames: number,
  input: Input = 0,
  block = BLOCK,
  contextFrame?: number,
): { L: Float32Array; R: Float32Array } {
  const L = new Float32Array(frames);
  const R = new Float32Array(frames);
  let done = 0;
  while (done < frames) {
    const n = Math.min(block, frames - done);
    const outL = new Float32Array(n);
    const outR = new Float32Array(n);
    let inputs: Float32Array[][];
    if (input === null) {
      inputs = [[]];
    } else {
      const mic = new Float32Array(n);
      for (let k = 0; k < n; k++) mic[k] = typeof input === 'number' ? input : input(done + k);
      inputs = [[mic]];
    }
    expect(p.process(inputs, [[outL, outR]], contextFrame === undefined ? undefined : contextFrame + done)).toBe(true);
    L.set(outL, done);
    R.set(outR, done);
    done += n;
  }
  return { L, R };
}

/** Runs blocks of silence until the processor answers `reqId` (the export copies a bounded amount per block). */
export function awaitTracks(p: SageProcessor, port: FakePort, reqId: number, maxBlocks = 10000): (TrackAudio | null)[] {
  for (let i = 0; i < maxBlocks; i++) {
    const reply = port.events('tracks').find((e) => e.reqId === reqId);
    if (reply) return reply.tracks;
    run(p, BLOCK);
  }
  throw new Error(`no tracks reply for request ${reqId}`);
}

/** Asks the processor for its tracks and returns the reply. */
export function exportTracks(p: SageProcessor, port: FakePort, reqId = 1): (TrackAudio | null)[] {
  send(port, { t: 'exportTracks', reqId });
  return awaitTracks(p, port, reqId);
}

export function maxAbs(buf: Float32Array, from = 0, to = buf.length): number {
  let m = 0;
  for (let i = from; i < to; i++) m = Math.max(m, Math.abs(buf[i]!));
  return m;
}

export function minOf(buf: Float32Array, from = 0, to = buf.length): number {
  let m = Infinity;
  for (let i = from; i < to; i++) m = Math.min(m, buf[i]!);
  return m;
}
