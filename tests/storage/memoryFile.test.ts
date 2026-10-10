import { describe, it, expect } from 'vitest';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { defaultMemory, defaultSystem } from '../../src/schema/params';
import type { MemorySettings } from '../../src/schema/types';
import type { TrackAudio } from '../../src/shared/protocol';
import {
  UnsupportedFile,
  packBackup,
  packMemory,
  unpackBackup,
  unpackMemory,
} from '../../src/storage/memoryFile';
import { decodeWav } from '../../src/storage/wav';

/** Deterministic non-trivial samples (not a clean tone, so any bit change shows). */
function noise(n: number, seed: number): Float32Array {
  const out = new Float32Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = (s / 0x100000000) * 2 - 1;
  }
  return out;
}

function track(n: number, seed: number, over: Partial<TrackAudio> = {}): TrackAudio {
  return { L: noise(n, seed), R: noise(n, seed + 1000), sampleRate: 48000, recordedTempo: 97.5, measures: 4, ...over };
}

function sameBits(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false;
  const x = new Uint32Array(a.buffer, a.byteOffset, a.length);
  const y = new Uint32Array(b.buffer, b.byteOffset, b.length);
  return x.every((v, i) => v === y[i]);
}

function customSettings(): MemorySettings {
  const m = defaultMemory();
  m.name = 'MY LOOP';
  m.tempo = 133.3;
  m.track[1]!.measure = { measures: 4 };
  m.track[2]!.pan = -20;
  m.track[3]!.measure = { note: '1/4' };
  m.play.fadeIn = { note: '1/8' };
  m.play.loopLength = 77;
  m.rhythm.beat = { num: 7, den: 8 };
  return m;
}

describe('packMemory / unpackMemory', () => {
  it('round-trips settings (deep equal) and samples (bit exact) at the same rate', () => {
    const settings = customSettings();
    settings.prefs = { master: { ...defaultSystem().master, comp: 30 } };
    const t0 = track(5000, 1, { measures: 4, recordedTempo: 120 });
    const t3 = track(3333, 2, { measures: null, recordedTempo: 88.8 });
    const bytes = packMemory(settings, [t0, null, null, t3, null]);
    const out = unpackMemory(bytes, 48000);

    expect(out.settings).toEqual(settings);
    expect(out.tracks).toHaveLength(5);
    expect(out.tracks[1]).toBeNull();
    expect(out.tracks[2]).toBeNull();
    expect(out.tracks[4]).toBeNull();
    for (const [i, src] of [[0, t0], [3, t3]] as const) {
      const got = out.tracks[i]!;
      expect(sameBits(got.L, src.L)).toBe(true);
      expect(sameBits(got.R, src.R)).toBe(true);
      expect(got.sampleRate).toBe(48000);
      expect(got.recordedTempo).toBe(src.recordedTempo);
      expect(got.measures).toBe(src.measures);
    }
  });

  it('round-trips a memory with no audio at all', () => {
    const out = unpackMemory(packMemory(defaultMemory(), []), 44100);
    expect(out.settings).toEqual(defaultMemory());
    expect(out.tracks).toEqual([null, null, null, null, null]);
  });

  it('treats a missing or empty (zero-frame) track as absent', () => {
    const empty: TrackAudio = { L: new Float32Array(0), R: new Float32Array(0), sampleRate: 48000, recordedTempo: 120, measures: null };
    const out = unpackMemory(packMemory(defaultMemory(), [empty, track(10, 3)]), 48000);
    expect(out.tracks[0]).toBeNull();
    expect(out.tracks[1]).not.toBeNull();
  });

  it('writes the documented layout: memory.json plus a float32 trackN.wav per track with audio', () => {
    const bytes = packMemory(customSettings(), [null, track(100, 1), null, null, track(50, 2, { sampleRate: 44100 })]);
    const files = unzipSync(bytes);
    expect(Object.keys(files).sort()).toEqual(['memory.json', 'track2.wav', 'track5.wav']);
    const doc = JSON.parse(strFromU8(files['memory.json']!));
    expect(doc.format).toBe('sage-mk1-memory');
    expect(doc.version).toBe(1);
    expect(doc.settings.name).toBe('MY LOOP');
    expect(doc.tracks).toEqual([
      null,
      { recordedTempo: 97.5, measures: 4, sampleRate: 48000 },
      null,
      null,
      { recordedTempo: 97.5, measures: 4, sampleRate: 44100 },
    ]);
    const wav = files['track2.wav']!;
    expect(new DataView(wav.buffer, wav.byteOffset).getUint16(20, true)).toBe(3); // IEEE float
    expect(decodeWav(files['track5.wav']!).sr).toBe(44100);
  });

  it('refuses to pack more than 5 tracks or a track whose channels differ in length', () => {
    expect(() => packMemory(defaultMemory(), Array(6).fill(null))).toThrow(RangeError);
    const bad: TrackAudio = { L: new Float32Array(4), R: new Float32Array(5), sampleRate: 48000, recordedTempo: 120, measures: null };
    expect(() => packMemory(defaultMemory(), [bad])).toThrow(RangeError);
  });

  it('rejects garbage bytes with UnsupportedFile (message is the LCD text)', () => {
    const random = Uint8Array.from({ length: 500 }, (_, i) => (Math.imul(i + 1, 2654435761) >>> 24) & 0xff);
    for (const garbage of [new Uint8Array(0), new Uint8Array([1, 2, 3, 4, 5]), random, strToU8('hello, not a zip')]) {
      let caught: unknown;
      try {
        unpackMemory(garbage, 48000);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(UnsupportedFile);
      expect((caught as Error).message).toBe('UNSUPPORTED FILE');
      expect((caught as Error).name).toBe('UnsupportedFile');
    }
  });

  it('rejects a truncated memory file', () => {
    const bytes = packMemory(defaultMemory(), [track(2000, 1)]);
    expect(() => unpackMemory(bytes.slice(0, Math.floor(bytes.length / 2)), 48000)).toThrow(UnsupportedFile);
  });

  it('defaults a settings key that a file from an older build lacks', () => {
    const settings = customSettings() as unknown as Record<string, unknown>;
    const old = structuredClone(settings);
    delete old.rhythm;                                    // a whole group added by a newer build
    delete (old.track as Record<string, unknown>[])[2]!.pan; // a leaf added to each track
    delete old.prefs;
    const doc = { format: 'sage-mk1-memory', version: 1, settings: old, tracks: [null, null, null, null, null] };
    const bytes = zipSync({ 'memory.json': strToU8(JSON.stringify(doc)) });
    const out = unpackMemory(bytes, 48000);
    expect(out.settings.rhythm).toEqual(defaultMemory().rhythm);
    expect(out.settings.track[2]!.pan).toBe(defaultMemory().track[2]!.pan);
    expect(out.settings.prefs).toEqual({});
    expect(out.settings.name).toBe('MY LOOP');
    expect(out.settings.tempo).toBe(133.3);
  });

  it('corrects out-of-range or unknown stored settings instead of loading them raw', () => {
    const bad = customSettings() as unknown as Record<string, unknown>;
    (bad.track as Record<string, unknown>[])[0]!.pan = 99999;
    (bad.track as Record<string, unknown>[])[1]!.measure = { measures: 5000, evil: true };
    bad.tempo = -5;
    const doc = { format: 'sage-mk1-memory', version: 1, settings: bad, tracks: [] };
    const out = unpackMemory(zipSync({ 'memory.json': strToU8(JSON.stringify(doc)) }), 48000);
    expect(out.settings.track[0]!.pan).toBe(50);
    expect(out.settings.track[1]!.measure).toEqual({ measures: 64 });
    expect(out.settings.tempo).toBe(40);
  });
});

describe('packBackup / unpackBackup', () => {
  it('round-trips the system settings and a sparse set of memories', () => {
    const system = defaultSystem();
    system.master.comp = 25;
    system.setup.contrast = 8;
    const s1 = customSettings();
    const s99 = defaultMemory();
    s99.name = 'LAST';
    const memories: ({ settings: MemorySettings; tracks: (TrackAudio | null)[] } | null)[] = Array(99).fill(null);
    memories[0] = { settings: s1, tracks: [track(800, 1), null, track(900, 2, { measures: null }), null, null] };
    memories[98] = { settings: s99, tracks: [] };
    const out = unpackBackup(packBackup(memories, system), 48000);

    expect(out.system).toEqual(system);
    expect(out.memories).toHaveLength(99);
    expect(out.memories[0]!.settings).toEqual(s1);
    expect(sameBits(out.memories[0]!.tracks[0]!.L, memories[0]!.tracks[0]!.L)).toBe(true);
    expect(sameBits(out.memories[0]!.tracks[2]!.R, memories[0]!.tracks[2]!.R)).toBe(true);
    expect(out.memories[0]!.tracks[2]!.measures).toBeNull();
    expect(out.memories[0]!.tracks[1]).toBeNull();
    expect(out.memories[98]!.settings.name).toBe('LAST');
    expect(out.memories[98]!.tracks).toEqual([null, null, null, null, null]);
    for (let i = 1; i < 98; i++) expect(out.memories[i]).toBeNull();
  });

  it('writes backup.json and mNN/ folders only for present slots', () => {
    const memories = [{ settings: defaultMemory(), tracks: [track(10, 1)] }, null, { settings: defaultMemory(), tracks: [null, track(10, 2)] }];
    const files = unzipSync(packBackup(memories, defaultSystem()));
    expect(Object.keys(files).sort()).toEqual(['backup.json', 'm01/memory.json', 'm01/track1.wav', 'm03/memory.json', 'm03/track2.wav']);
    const doc = JSON.parse(strFromU8(files['backup.json']!));
    expect(doc.format).toBe('sage-mk1-backup');
    expect(doc.version).toBe(1);
    expect(doc.memories).toEqual([{ slot: 1, present: true }, { slot: 2, present: false }, { slot: 3, present: true }]);
    expect(doc.system).toEqual(defaultSystem());
    expect(JSON.parse(strFromU8(files['m01/memory.json']!)).format).toBe('sage-mk1-memory');
  });

  it('resamples every memory on restore', () => {
    const t = track(4800, 5);
    const out = unpackBackup(packBackup([{ settings: defaultMemory(), tracks: [t] }], defaultSystem()), 44100);
    const got = out.memories[0]!.tracks[0]!;
    expect(got.sampleRate).toBe(44100);
    expect(Math.abs(got.L.length - 4410)).toBeLessThanOrEqual(2);
    expect(got.R.length).toBe(got.L.length);
  });

  it('refuses more than 99 memories', () => {
    expect(() => packBackup(Array(100).fill(null), defaultSystem())).toThrow(RangeError);
  });

  it('rejects garbage, and a memory file handed to unpackBackup (and the reverse)', () => {
    expect(() => unpackBackup(new Uint8Array([9, 9, 9]), 48000)).toThrow(UnsupportedFile);
    expect(() => unpackBackup(packMemory(defaultMemory(), []), 48000)).toThrow(UnsupportedFile);
    expect(() => unpackMemory(packBackup([], defaultSystem()), 48000)).toThrow(UnsupportedFile);
  });
});
