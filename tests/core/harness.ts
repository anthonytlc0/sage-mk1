/**
 * Test harness for the looper core. Everything runs at sr 1000, so one frame is one millisecond, a 1 s chunk is 1000
 * frames, the 5 ms seam crossfade is 5 frames, and a 4/4 measure at tempo 120 is 2000 frames.
 */
import { LooperCore } from '../../src/core/looper';
import type { CoreConfig, CoreOutput } from '../../src/core/looper';
import { defaultMemory } from '../../src/schema/memory';
import { defaultSystem } from '../../src/schema/system';
import type { MemorySettings, SystemSettings } from '../../src/schema/types';
import type { EngineCommand } from '../../src/shared/protocol';
import type { TrackIndex } from '../../src/shared/ids';

export const SR = 1000;
export const BLOCK = 128;
export const XF = 5;
const BUDGET = 64 * 1024 * 1024;

export type DeepPartial<T> = T extends readonly (infer U)[]
  ? DeepPartial<U>[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

const settingsOf = new WeakMap<LooperCore, { memory: MemorySettings; system: SystemSettings }>();

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Merge `src` into `dst` in place: arrays merge by index, plain objects merge key by key. A FADE TIME or MEASURE value
 * (an object with `note` or `measures`) is replaced whole, since mixing its two forms makes no sense.
 */
function deepMerge(dst: Record<string, unknown> | unknown[], src: unknown): void {
  if (Array.isArray(src) && Array.isArray(dst)) {
    src.forEach((v, i) => {
      if (v === undefined) return;
      const cur = dst[i];
      if ((isPlainObject(cur) || Array.isArray(cur)) && (isPlainObject(v) || Array.isArray(v)) && !isValueObject(v)) {
        deepMerge(cur, v);
      } else {
        dst[i] = v;
      }
    });
    return;
  }
  if (!isPlainObject(src) || Array.isArray(dst)) return;
  for (const [k, v] of Object.entries(src)) {
    if (v === undefined) continue;
    const cur = dst[k];
    if ((isPlainObject(cur) || Array.isArray(cur)) && (isPlainObject(v) || Array.isArray(v)) && !isValueObject(v)) {
      deepMerge(cur, v);
    } else {
      dst[k] = v;
    }
  }
}

function isValueObject(v: unknown): boolean {
  return isPlainObject(v) && ('note' in v || 'measures' in v);
}

/**
 * A core at sr 1000 with a 64 MB budget, latency 0 and LOOP SYNC OFF on every track (free loops). `over` is merged
 * over the guide defaults after LOOP SYNC is switched off, so a test can switch it back on.
 */
export function makeCore(over: DeepPartial<MemorySettings> = {}, cfg: Partial<CoreConfig> = {}): LooperCore {
  const core = new LooperCore({ sampleRate: SR, memoryBudgetBytes: BUDGET, ...cfg });
  const memory = defaultMemory();
  for (const t of memory.track) t.loopSyncSw = false;
  deepMerge(memory as unknown as Record<string, unknown>, over);
  const system = defaultSystem();
  core.setSettings(memory, system);
  core.setLatency(0, 0);
  settingsOf.set(core, { memory, system });
  return core;
}

/** Change settings mid-test: merges `over` into the core's memory and hands the result to `setSettings`. */
export function configure(core: LooperCore, over: DeepPartial<MemorySettings>): void {
  const s = settingsOf.get(core);
  if (!s) throw new Error('configure() needs a core from makeCore()');
  const memory = structuredClone(s.memory);
  deepMerge(memory as unknown as Record<string, unknown>, over);
  s.memory = memory;
  core.setSettings(memory, s.system);
}

export interface RunResult {
  /** Per track, the left channel of every frame run. */
  tracks: Float32Array[];
  /** Per track, the right channel. */
  tracksR: Float32Array[];
  /** The left channels of all five tracks summed. */
  sum: Float32Array;
}

/** A CoreOutput of `n`-frame buffers. */
export function makeOutput(n: number): CoreOutput {
  const tracks: [Float32Array, Float32Array][] = [];
  for (let i = 0; i < 5; i++) tracks.push([new Float32Array(n), new Float32Array(n)]);
  return { tracks, click: [new Float32Array(n), new Float32Array(n)] };
}

/**
 * Run `n` frames in blocks of `block` (128, as an AudioWorklet does). `input(frame)` gives both input channels at each
 * absolute frame (default silence); the rhythm inputs are silent.
 */
export function run(core: LooperCore, n: number, input?: (frame: number) => number, block = BLOCK): RunResult {
  const tracks = Array.from({ length: 5 }, () => new Float32Array(n));
  const tracksR = Array.from({ length: 5 }, () => new Float32Array(n));
  const sum = new Float32Array(n);
  const inL = new Float32Array(block);
  const inR = new Float32Array(block);
  const rhythmL = new Float32Array(block);
  const rhythmR = new Float32Array(block);
  const out = makeOutput(block);
  let done = 0;
  while (done < n) {
    const m = Math.min(block, n - done);
    const f0 = core.frame;
    for (let i = 0; i < m; i++) {
      const v = input ? input(f0 + i) : 0;
      inL[i] = v;
      inR[i] = v;
    }
    core.process(inL, inR, rhythmL, rhythmR, out, m);
    for (let t = 0; t < 5; t++) {
      tracks[t].set(out.tracks[t][0].subarray(0, m), done);
      tracksR[t].set(out.tracks[t][1].subarray(0, m), done);
      for (let i = 0; i < m; i++) sum[done + i] += out.tracks[t][0][i];
    }
    done += m;
  }
  return { tracks, tracksR, sum };
}

/** Run up to `frame` (feeding `input`), then issue `cmd` at that frame. Returns what was run. */
export function at(
  core: LooperCore,
  frame: number,
  cmd: EngineCommand,
  input?: (frame: number) => number,
): RunResult {
  if (frame < core.frame) throw new Error(`at(${frame}): the core is already at frame ${core.frame}`);
  const r = run(core, frame - core.frame, input);
  core.command(cmd, frame);
  return r;
}

export const recPlay = (track: TrackIndex = 0): EngineCommand => ({ t: 'recPlay', track });
export const stop = (track: TrackIndex = 0): EngineCommand => ({ t: 'stop', track });
export const clear = (track: TrackIndex = 0): EngineCommand => ({ t: 'clear', track });

/** Track `i`'s status. */
export function trk(core: LooperCore, i: TrackIndex = 0) {
  return core.status().tracks[i];
}

/** Input that is `x` for every frame. */
export const dc = (x: number) => (): number => x;
/** Input equal to its frame number: a recorded sample's value tells which frame it came from. */
export const ramp = (f: number): number => f;
