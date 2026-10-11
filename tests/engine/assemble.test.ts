import { describe, expect, it } from 'vitest';
import { ExportAssembler } from '../../src/engine/assemble';
import type { ExportEvent } from '../../src/engine/assemble';
import type { TrackExportMeta } from '../../src/shared/protocol';
import type { TrackIndex } from '../../src/shared/ids';

const meta = (frames: number): TrackExportMeta => ({ frames, sampleRate: 48000, recordedTempo: 120, measures: null });

const start = (reqId: number, tracks: (TrackExportMeta | null)[]): ExportEvent => ({ t: 'tracksStart', reqId, tracks });
const end = (reqId: number): ExportEvent => ({ t: 'tracksEnd', reqId });
const abort = (reqId: number): ExportEvent => ({ t: 'tracksAbort', reqId });
function part(reqId: number, track: TrackIndex, offset: number, values: number[]): ExportEvent {
  return { t: 'tracksPart', reqId, track, offset, L: Float32Array.from(values), R: Float32Array.from(values, (v) => -v) };
}

function make(): { asm: ExportAssembler; logs: string[] } {
  const logs: string[] = [];
  return { asm: new ExportAssembler((m) => logs.push(m)), logs };
}

describe('ExportAssembler', () => {
  it('delivers a complete export, with each part placed by its offset even when parts arrive out of order', () => {
    const { asm, logs } = make();
    expect(asm.take(start(1, [meta(6), null, meta(2), null, null]))).toBeNull();
    expect(asm.take(part(1, 0, 3, [4, 5, 6]))).toBeNull(); // the second half first
    expect(asm.take(part(1, 2, 0, [9, 8]))).toBeNull();
    expect(asm.take(part(1, 0, 0, [1, 2, 3]))).toBeNull();
    const done = asm.take(end(1))!;
    expect(done.t).toBe('tracks');
    expect(done.reqId).toBe(1);
    expect(Array.from(done.tracks[0]!.L)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(Array.from(done.tracks[0]!.R)).toEqual([-1, -2, -3, -4, -5, -6]);
    expect(Array.from(done.tracks[2]!.L)).toEqual([9, 8]);
    expect(done.tracks[1]).toBeNull();
    expect(done.tracks[0]!.sampleRate).toBe(48000);
    expect(asm.inProgress).toBe(0);
    expect(logs).toEqual([]);
  });

  it('a missing part: nothing is delivered (no silent hole), the arrays are let go and the reason logged', () => {
    const { asm, logs } = make();
    asm.take(start(1, [meta(6), null, null, null, null]));
    asm.take(part(1, 0, 0, [1, 2, 3])); // frames 3-5 never come
    expect(asm.take(end(1))).toBeNull();
    expect(asm.inProgress).toBe(0);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/incomplete/);
  });

  it('an abort frees the state and delivers nothing; parts and an end arriving after it are ignored', () => {
    const { asm } = make();
    asm.take(start(2, [meta(4), null, null, null, null]));
    asm.take(part(2, 0, 0, [1, 2]));
    expect(asm.take(abort(2))).toBeNull();
    expect(asm.inProgress).toBe(0);
    expect(asm.take(part(2, 0, 2, [3, 4]))).toBeNull();
    expect(asm.take(end(2))).toBeNull();
    expect(asm.inProgress).toBe(0);
  });

  it('an end that comes before its parts delivers nothing, and the late parts are ignored', () => {
    const { asm, logs } = make();
    asm.take(start(3, [meta(2), null, null, null, null]));
    expect(asm.take(end(3))).toBeNull();
    expect(asm.take(part(3, 0, 0, [1, 2]))).toBeNull();
    expect(asm.inProgress).toBe(0);
    expect(logs).toHaveLength(1);
  });

  it('ignores parts and ends for a request it never saw start', () => {
    const { asm } = make();
    expect(asm.take(part(9, 0, 0, [1]))).toBeNull();
    expect(asm.take(end(9))).toBeNull();
    expect(asm.inProgress).toBe(0);
  });

  it('a part that does not fit its track, or covers frames twice, makes the export incomplete', () => {
    const { asm } = make();
    asm.take(start(4, [meta(4), null, null, null, null]));
    asm.take(part(4, 0, 2, [1, 2, 3])); // runs past the end: dropped
    asm.take(part(4, 0, 0, [1, 2]));
    expect(asm.take(end(4))).toBeNull();
    asm.take(start(5, [meta(4), null, null, null, null]));
    asm.take(part(5, 0, 0, [1, 2]));
    asm.take(part(5, 0, 0, [1, 2])); // the same frames again: still frames 2-3 missing
    expect(asm.take(end(5))).toBeNull();
    asm.take(start(6, [null, meta(2), null, null, null]));
    asm.take(part(6, 0, 0, [1, 2])); // a track that has no loop in this export
    expect(asm.take(end(6))).toBeNull();
    expect(asm.inProgress).toBe(0);
  });

  it('an export with no loops at all is complete at once', () => {
    const { asm } = make();
    asm.take(start(7, [null, null, null, null, null]));
    expect(asm.take(end(7))!.tracks).toEqual([null, null, null, null, null]);
  });

  it('clear() drops every export in progress', () => {
    const { asm } = make();
    asm.take(start(1, [meta(4), null, null, null, null]));
    asm.take(start(2, [meta(4), null, null, null, null]));
    expect(asm.inProgress).toBe(2);
    asm.clear();
    expect(asm.inProgress).toBe(0);
    expect(asm.take(end(1))).toBeNull();
  });
});
