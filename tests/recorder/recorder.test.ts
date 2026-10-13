import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Recorder } from '../../src/recorder/recorder';
import type { RecorderEvent } from '../../src/recorder/recorder';
import { QuotaError, openDb } from '../../src/storage/db';
import { Takes } from '../../src/storage/takes';
import { createDither, decodeWav, encodeWav, pcm24Bytes } from '../../src/storage/wav';
import { EXPORT_RATE } from '../../src/shared/constants';
import { BLOCK, RecEngine, bytesOf, resampleAll, sameBytes, sine } from './helpers';

const SR = 48000;
const FREQ = 1000;

let seq = 0;
let db: IDBDatabase;
let takes: Takes;
let engine: RecEngine;
let recorder: Recorder;

beforeEach(async () => {
  db = await openDb(`recorder-test-${seq++}`);
  takes = new Takes(db);
  engine = new RecEngine();
  recorder = new Recorder(engine, takes, SR, { settleMs: 30 });
});
afterEach(() => db.close());

/** Feeds `n` consecutive 4096-frame blocks of the test sine, continuing from absolute frame `from`. */
function feed(n: number, from = 0): void {
  for (let b = 0; b < n; b++) {
    const [L, R] = sine(BLOCK, FREQ, SR, from + b * BLOCK);
    engine.emitBlock(L, R);
  }
}

describe('Recorder: a take', () => {
  it('10 blocks of a 48 kHz sine become a valid 44.1 kHz 24-bit WAV of the right length', async () => {
    await recorder.start();
    feed(10);
    const id = await recorder.stop();

    const expected = (10 * BLOCK * EXPORT_RATE) / SR; // 37632, exactly
    const info = (await takes.list()).find((t) => t.id === id)!;
    expect(info.frames).toBe(expected);

    const bytes = await bytesOf(await takes.blob(id));
    const view = new DataView(bytes.buffer);
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...bytes.subarray(8, 12))).toBe('WAVE');
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(2); // stereo
    expect(view.getUint32(24, true)).toBe(EXPORT_RATE);
    expect(view.getUint16(34, true)).toBe(24);
    expect(view.getUint32(40, true)).toBe(expected * 6); // data bytes

    const wav = decodeWav(bytes);
    expect(wav.sr).toBe(EXPORT_RATE);
    expect(wav.chs[0]!.length).toBe(expected);
  });

  it('keeps the signal: same pitch, level and channel balance after the conversion', async () => {
    await recorder.start();
    feed(10);
    const id = await recorder.stop();
    const { chs } = decodeWav(await bytesOf(await takes.blob(id)));
    const [L, R] = chs as [Float32Array, Float32Array];

    // Away from the ends: peak 0.5 on the left, 0.25 on the right.
    const mid = L.subarray(2000, L.length - 2000);
    expect(Math.max(...mid)).toBeGreaterThan(0.49);
    expect(Math.max(...mid)).toBeLessThan(0.51);
    expect(Math.max(...R.subarray(2000, R.length - 2000))).toBeCloseTo(0.25, 2);

    // 1000 Hz at 44.1 kHz: 22.05 samples per cycle, so one upward zero crossing per 22.05 samples.
    let crossings = 0;
    for (let i = 2001; i < L.length - 2000; i++) if (L[i - 1]! < 0 && L[i]! >= 0) crossings++;
    const seconds = (L.length - 4000) / EXPORT_RATE;
    expect(crossings / seconds).toBeGreaterThan(FREQ - 10);
    expect(crossings / seconds).toBeLessThan(FREQ + 10);
  });

  it('turns the recorder bus on at start and off at stop, and tells the engine nothing else', async () => {
    await recorder.start();
    feed(2);
    await recorder.stop();
    expect(engine.commands('recorder')).toEqual([
      { t: 'recorder', on: true },
      { t: 'recorder', on: false },
    ]);
  });

  it('includes the last partial block the engine posts when the recorder goes off', async () => {
    engine.tail = 1000;
    await recorder.start();
    feed(3);
    const id = await recorder.stop();
    const total = 3 * BLOCK + 1000;
    const info = (await takes.list()).find((t) => t.id === id)!;
    expect(info.frames).toBe(Math.ceil((total * EXPORT_RATE) / SR));
  });

  it('finishes with the exact 44.1 kHz frame count of what was stored, even when the length is not a round ratio', async () => {
    engine.tail = 777;
    await recorder.start();
    feed(1);
    const id = await recorder.stop();
    const info = (await takes.list()).find((t) => t.id === id)!;
    const wav = decodeWav(await bytesOf(await takes.blob(id)));
    expect(wav.chs[0]!.length).toBe(info.frames);
  });

  it('stops after the settle time even if the engine never answers (a suspended audio context)', async () => {
    engine.answerOff = false;
    await recorder.start();
    feed(2);
    const id = await recorder.stop();
    const info = (await takes.list()).find((t) => t.id === id)!;
    expect(info.frames).toBe(Math.ceil((2 * BLOCK * EXPORT_RATE) / SR));
  });

  it('ignores blocks that arrive after stop, and does not listen between takes', async () => {
    await recorder.start();
    feed(2);
    const id = await recorder.stop();
    const before = (await takes.list()).find((t) => t.id === id)!.frames;
    feed(5);
    expect((await takes.list()).find((t) => t.id === id)!.frames).toBe(before);
    expect(recorder.recordingFrames).toBe(0);
  });

  it('each take gets its own record; a second take does not touch the first', async () => {
    await recorder.start();
    feed(2);
    const a = await recorder.stop();
    await recorder.start();
    feed(4);
    const b = await recorder.stop();
    expect(b).not.toBe(a);
    const list = await takes.list();
    expect(list.find((t) => t.id === a)!.frames).toBe(Math.ceil((2 * BLOCK * EXPORT_RATE) / SR));
    expect(list.find((t) => t.id === b)!.frames).toBe(Math.ceil((4 * BLOCK * EXPORT_RATE) / SR));
  });
});

describe('Recorder: state', () => {
  it('counts the 44.1 kHz frames recorded so far while recording, and is 0 otherwise', async () => {
    expect(recorder.recordingFrames).toBe(0);
    expect(recorder.recording).toBe(false);
    await recorder.start();
    expect(recorder.recording).toBe(true);
    expect(recorder.recordingFrames).toBe(0);
    feed(5);
    // A little under 5 blocks' worth: the resampler holds back the last few samples until it sees what follows.
    expect(recorder.recordingFrames).toBeGreaterThan((5 * BLOCK * EXPORT_RATE) / SR - 100);
    expect(recorder.recordingFrames).toBeLessThanOrEqual((5 * BLOCK * EXPORT_RATE) / SR);
    await recorder.stop();
    expect(recorder.recording).toBe(false);
    expect(recorder.recordingFrames).toBe(0);
  });

  it('start while recording does nothing; stop while idle rejects', async () => {
    await expect(recorder.stop()).rejects.toThrow(/not recording/i);
    await recorder.start();
    await recorder.start();
    expect(engine.commands('recorder').filter((c) => c.on)).toHaveLength(1);
    expect(await takes.list()).toHaveLength(1);
    await recorder.stop();
  });

  it('a stop right after start (before the take exists) still ends cleanly with one empty take', async () => {
    const started = recorder.start();
    const stopped = recorder.stop();
    await started;
    const id = await stopped;
    expect(recorder.recording).toBe(false);
    expect((await takes.list()).find((t) => t.id === id)!.frames).toBe(0);
  });

  it('tells listeners about start, stop (with the take id) in order, and unsubscribes', async () => {
    const seen: RecorderEvent[] = [];
    const off = recorder.onChange((e) => seen.push(e));
    await recorder.start();
    feed(1);
    const id = await recorder.stop();
    expect(seen).toEqual([{ kind: 'start' }, { kind: 'stop', takeId: id }]);
    expect(recorder.lastTakeId).toBe(id);
    off();
    await recorder.start();
    await recorder.stop();
    expect(seen).toHaveLength(2);
  });

  it('a failed take creation rejects start and leaves the recorder idle and the engine untouched', async () => {
    vi.spyOn(takes, 'create').mockRejectedValueOnce(new QuotaError());
    await expect(recorder.start()).rejects.toBeInstanceOf(QuotaError);
    expect(recorder.recording).toBe(false);
    expect(engine.commands('recorder')).toEqual([]);
    await recorder.start(); // and it can try again
    await recorder.stop();
  });
});

describe('Recorder: streaming', () => {
  it('appends every block as it arrives, as a small chunk; nothing is held back for the end', async () => {
    const append = vi.spyOn(takes, 'append');
    await recorder.start();
    const perBlock = Math.round((BLOCK * EXPORT_RATE) / SR); // 3763 output frames per block, give or take

    for (let b = 1; b <= 6; b++) {
      feed(1, (b - 1) * BLOCK);
      expect(append).toHaveBeenCalledTimes(b); // one append per block, before any stop
    }
    for (const call of append.mock.calls) {
      const bytes = call[1];
      expect(bytes.length).toBeLessThan((perBlock + 4) * 6);
      expect(bytes.length).toBeGreaterThan((perBlock - 40) * 6);
    }
    await recorder.stop();
    // The tail the resampler held back goes out as one more small chunk.
    expect(append.mock.calls.length).toBeLessThanOrEqual(8);
    const last = append.mock.calls.at(-1)![1];
    expect(last.length).toBeLessThan(100 * 6);
  });

  it('the stored bytes equal one-shot conversion of the whole signal (block splits are invisible)', async () => {
    await recorder.start();
    feed(7);
    const id = await recorder.stop();
    const [fullL, fullR] = sine(7 * BLOCK, FREQ, SR);
    const [rL, rR] = resampleAll(fullL, fullR, SR);
    const expected = encodeWav([rL, rR], EXPORT_RATE, 'pcm24'); // a fresh dither stream, like the take's
    const got = await bytesOf(await takes.blob(id));
    expect(got.length).toBe(expected.length);
    expect(sameBytes(got, expected)).toBe(true);
  });
});

describe('Recorder: dither', () => {
  it('uses one dither stream per take: two takes of the same audio are identical, whatever was encoded before', async () => {
    // Advance the module-shared dither, as other encoding in the app would.
    const [sL, sR] = sine(5000, 440, SR);
    pcm24Bytes(sL, sR, 5000);

    await recorder.start();
    feed(3);
    const a = await recorder.stop();
    await recorder.start();
    feed(3);
    const b = await recorder.stop();

    const bytesA = await bytesOf(await takes.blob(a));
    const bytesB = await bytesOf(await takes.blob(b));
    expect(sameBytes(bytesA, bytesB)).toBe(true);
  });

  it('the dither stream runs on across the blocks of a take (no restart at each block)', async () => {
    // Silence has no signal to hide the dither: each sample is the dither alone, so the stream is visible in the bytes.
    await recorder.start();
    for (let b = 0; b < 4; b++) engine.emitBlock(new Float32Array(BLOCK), new Float32Array(BLOCK));
    const id = await recorder.stop();
    const data = (await bytesOf(await takes.blob(id))).subarray(44);

    const n = data.length / 6;
    const dither = createDither();
    const z = new Float32Array(n);
    const expected = pcm24Bytes(z, z, n, dither);
    expect(sameBytes(data, expected)).toBe(true);
  });
});

describe('Recorder: storage failure', () => {
  it('a full disk ends the take at the last good frame, tells the listeners and turns the engine off', async () => {
    const real = takes.append.bind(takes);
    let calls = 0;
    vi.spyOn(takes, 'append').mockImplementation((id, bytes) => {
      calls++;
      return calls <= 3 ? real(id, bytes) : Promise.reject(new QuotaError());
    });
    const seen: RecorderEvent[] = [];
    recorder.onChange((e) => seen.push(e));

    await recorder.start();
    feed(3);
    feed(1, 3 * BLOCK); // the 4th append fails
    await vi.waitFor(() => expect(recorder.recording).toBe(false));

    expect(seen.map((e) => e.kind)).toEqual(['start', 'error', 'stop']);
    expect(seen[1]).toMatchObject({ kind: 'error', error: expect.any(QuotaError) });
    expect(engine.commands('recorder').at(-1)).toEqual({ t: 'recorder', on: false });

    const id = recorder.lastTakeId!;
    const info = (await takes.list()).find((t) => t.id === id)!;
    const wav = decodeWav(await bytesOf(await takes.blob(id)));
    expect(info.frames).toBe(wav.chs[0]!.length); // the record agrees with what was stored
    expect(info.frames).toBeGreaterThan(0);
    expect(info.frames).toBeLessThan((4 * BLOCK * EXPORT_RATE) / SR);
    expect(recorder.lastError).toBeInstanceOf(QuotaError);
  });
});
