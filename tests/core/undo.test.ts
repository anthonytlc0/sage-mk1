/**
 * Undo/redo, MARK SET/CLEAR/BACK and REC BACK (Owner's Manual pp. 5, 9-10; Parameter Guide pp. 14-16 PANEL UNDO).
 *
 * Each track keeps copy-on-write snapshots of its loop: REC BACK (the loop right after its recording), the MARK, and
 * one level of undo/redo. A rec or dub pass sets undo to the loop as it was before the pass and drops redo.
 *
 * sr 1000 (the harness): one frame is 1 ms, a chunk is 1000 frames, the 5 ms crossfades are XF = 5 frames.
 */
import { describe, expect, it } from 'vitest';
import { at, configure, dc, makeCore, recPlay, run, SR, stop, trk, XF } from './harness';
import type { LooperCore } from '../../src/core/looper';
import type { EngineCommand } from '../../src/shared/protocol';
import type { TrackIndex } from '../../src/shared/ids';

const CHUNK_BYTES = SR * 2 * 4;
const undoRedo = (track: TrackIndex = 0): EngineCommand => ({ t: 'undoRedo', track });
const markSet = (track: TrackIndex = 0): EngineCommand => ({ t: 'markSet', track });
const markClear = (track: TrackIndex = 0): EngineCommand => ({ t: 'markClear', track });
const markBack = (track: TrackIndex = 0): EngineCommand => ({ t: 'markBack', track });
const recBack = (track: TrackIndex = 0): EngineCommand => ({ t: 'recBack', track });

/** What track 1 plays once any crossfade has passed: the value 500 frames into the next 1000. */
function level(core: LooperCore, track: TrackIndex = 0): number {
  return run(core, 1000).tracks[track][500];
}

/**
 * A 1000-frame loop of 0.5 recorded from frame 0 (REC->PLAY), then whole-pass overdubs of each value in `dubs`, one
 * per pass: punch in at a pass start, punch out one pass later (the punch-in ramp and the punch-out tail sum to 1, so
 * each layer is flat). Ends at a pass start with the track playing.
 */
function layered(dubs: number[], over: Parameters<typeof makeCore>[0] = {}): LooperCore {
  const core = makeCore(over);
  at(core, 0, recPlay(), dc(0.5));
  at(core, 1000, recPlay(), dc(0.5));
  run(core, 1000, dc(0.5)); // the seam tail takes 0.5: the loop is flat
  for (const d of dubs) {
    const f = core.frame;
    at(core, f, recPlay(), dc(d));
    at(core, f + 1000, recPlay(), dc(d));
    run(core, 1000, dc(d)); // the punch-out tail
  }
  return core;
}

describe('undo/redo (the brief)', () => {
  it('record 0.5, overdub +0.25 -> 0.75; undoRedo -> 0.5 with canRedo; undoRedo -> 0.75', () => {
    const core = layered([0.25]);
    expect(trk(core).canUndo).toBe(true);
    expect(trk(core).canRedo).toBe(false);
    expect(level(core)).toBe(0.75);

    core.command(undoRedo());
    expect(trk(core).canUndo).toBe(false);
    expect(trk(core).canRedo).toBe(true);
    expect(trk(core).state).toBe('playing');
    expect(level(core)).toBe(0.5);

    core.command(undoRedo());
    expect(trk(core).canUndo).toBe(true);
    expect(trk(core).canRedo).toBe(false);
    expect(level(core)).toBe(0.75);
    expect(core.getTrackAudio(0)!.L.every((v) => v === 0.75)).toBe(true);
  });

  it('a new pass sets undo to the loop before it and drops redo', () => {
    const core = layered([0.25]);
    core.command(undoRedo()); // back to 0.5, redo holds 0.75
    expect(trk(core).canRedo).toBe(true);
    const f = core.frame;
    at(core, f, recPlay(), dc(0.125));
    expect(trk(core).canUndo).toBe(true);
    expect(trk(core).canRedo).toBe(false);
    at(core, f + 1000, recPlay(), dc(0.125));
    run(core, 1000, dc(0.125));
    expect(level(core)).toBe(0.625);
    core.command(undoRedo());
    expect(level(core)).toBe(0.5); // the pass is undone, not the one before it
  });

  it('undoing the first recording empties the track; redo brings the audio back (stopped)', () => {
    const core = makeCore();
    at(core, 0, recPlay(), dc(0.5));
    at(core, 1000, recPlay(), dc(0.5));
    run(core, 300, dc(0.5));
    expect(trk(core).canUndo).toBe(true);

    core.command(undoRedo());
    let s = trk(core);
    expect(s.state).toBe('empty');
    expect(s.lengthFrames).toBe(0);
    expect(s.canUndo).toBe(false);
    expect(s.canRedo).toBe(true);
    expect(core.getTrackAudio(0)).toBeNull();
    expect(run(core, 500).tracks[0].subarray(XF).every((v) => v === 0)).toBe(true); // a 5 ms ramp-out, then silence

    core.command(undoRedo());
    s = trk(core);
    expect(s.state).toBe('stopped');
    expect(s.lengthFrames).toBe(1000);
    expect(s.canUndo).toBe(true);
    expect(s.canRedo).toBe(false);
    expect(core.getTrackAudio(0)!.L.every((v) => v === 0.5)).toBe(true);
    core.command(recPlay());
    expect(level(core)).toBe(0.5);
  });

  it('undo during an overdub ends the pass and undoes it; redo gives back the pass with its punch-out fade', () => {
    const core = layered([]);
    const f = core.frame; // a pass start
    at(core, f, recPlay(), dc(0.25));
    at(core, f + 600, undoRedo(), dc(0.25)); // 600 frames into the pass
    expect(trk(core).state).toBe('playing');
    expect(trk(core).canRedo).toBe(true);
    run(core, 400, dc(0.25)); // the punch-out tail lands in the redo loop, not in the one playing
    expect(core.getTrackAudio(0)!.L.every((v) => v === 0.5)).toBe(true);

    // A reference core that punched out at the same frame.
    const ref = layered([]);
    at(ref, f, recPlay(), dc(0.25));
    at(ref, f + 600, recPlay(), dc(0.25));
    run(ref, 400, dc(0.25));

    core.command(undoRedo());
    expect(core.getTrackAudio(0)!.L).toEqual(ref.getTrackAudio(0)!.L);
  });

  it('a swap while playing crossfades over 5 ms instead of stepping', () => {
    const core = layered([0.25]);
    run(core, 300); // mid-loop
    core.command(undoRedo());
    const out = run(core, 20).tracks[0];
    for (let i = 1; i < 20; i++) expect(Math.abs(out[i] - out[i - 1])).toBeLessThanOrEqual(0.25 / XF + 1e-6);
    expect(out[0]).toBeGreaterThan(0.5);
    expect(out[XF + 2]).toBe(0.5);
  });

  it('a stopped track swaps silently and stays stopped', () => {
    const core = layered([0.25]);
    core.command(stop());
    run(core, 100);
    core.command(undoRedo());
    expect(trk(core).state).toBe('stopped');
    expect(run(core, 100).tracks[0].every((v) => v === 0)).toBe(true);
    core.command(recPlay());
    expect(level(core)).toBe(0.5);
  });

  it('nothing to undo or redo: a fresh track, a first recording still running', () => {
    const core = makeCore();
    core.command(undoRedo());
    expect(trk(core).state).toBe('empty');
    at(core, 0, recPlay(), dc(0.5));
    run(core, 500, dc(0.5));
    expect(trk(core).canUndo).toBe(false);
    core.command(undoRedo()); // ignored while recording
    expect(trk(core).state).toBe('recording');
    at(core, 1000, recPlay(), dc(0.5));
    expect(trk(core).lengthFrames).toBe(1000);
  });

  it('clear drops undo, redo, the mark and REC BACK', () => {
    const core = layered([0.25]);
    core.command(markSet());
    core.command(undoRedo());
    core.command({ t: 'clear', track: 0 });
    run(core, 100);
    const s = trk(core);
    expect([s.canUndo, s.canRedo, s.hasMark]).toEqual([false, false, false]);
    core.command(recBack());
    core.command(markBack());
    core.command(undoRedo());
    expect(trk(core).state).toBe('empty');
    expect(core.status().memoryBytes).toBe(0);
  });

  it('loading audio drops the history of the loop it replaces', () => {
    const core = layered([0.25]);
    core.command(markSet());
    const L = new Float32Array(800).fill(0.1);
    core.setTrackAudio(0, { L, R: L.slice(), sampleRate: SR, recordedTempo: 120, measures: null });
    const s = trk(core);
    expect([s.canUndo, s.canRedo, s.hasMark]).toEqual([false, false, false]);
    core.command(recBack()); // a loaded loop was not recorded here: nothing to go back to
    expect(core.getTrackAudio(0)!.L.every((v) => Math.abs(v - 0.1) < 1e-7)).toBe(true);
  });
});

describe('MARK and REC BACK (the brief)', () => {
  it('markSet after the 1st dub, then 2 more dubs, markBack -> the value after the 1st dub', () => {
    const core = layered([0.25]);
    core.command(markSet());
    expect(trk(core).hasMark).toBe(true);
    const f = core.frame;
    for (const [k, d] of [0.125, 0.0625].entries()) {
      at(core, f + 2000 * k, recPlay(), dc(d));
      at(core, f + 2000 * k + 1000, recPlay(), dc(d));
      run(core, 1000, dc(d));
    }
    expect(level(core)).toBe(0.9375);
    core.command(markBack());
    expect(trk(core).hasMark).toBe(true); // the mark stays
    expect(trk(core).canUndo).toBe(true);
    expect(trk(core).canRedo).toBe(false);
    expect(level(core)).toBe(0.75);
    core.command(undoRedo()); // MARK BACK itself can be undone
    expect(level(core)).toBe(0.9375);
  });

  it('markBack with no mark -> the post-record value', () => {
    const core = layered([0.25, 0.125]);
    expect(trk(core).hasMark).toBe(false);
    core.command(markBack());
    expect(level(core)).toBe(0.5);
  });

  it('markClear drops the mark, so MARK BACK goes back to the recording', () => {
    const core = layered([0.25]);
    core.command(markSet());
    core.command(markClear());
    expect(trk(core).hasMark).toBe(false);
    core.command(markBack());
    expect(level(core)).toBe(0.5);
  });

  it('recBack -> the post-record value even with a mark set; undo returns', () => {
    const core = layered([0.25, 0.125]);
    core.command(markSet());
    core.command(recBack());
    expect(level(core)).toBe(0.5);
    expect(trk(core).canUndo).toBe(true);
    core.command(undoRedo());
    expect(level(core)).toBe(0.875);
  });

  it('MARK BACK during an overdub ends the pass first', () => {
    const core = layered([0.25]);
    const f = core.frame;
    at(core, f, recPlay(), dc(0.125));
    at(core, f + 500, markBack(), dc(0.125));
    expect(trk(core).state).toBe('playing');
    run(core, 500, dc(0.125));
    expect(level(core)).toBe(0.5);
  });

  it('a mark set while the loop plays keeps that loop through later passes and an undo', () => {
    const core = layered([0.25]);
    core.command(markSet());
    core.command(undoRedo()); // 0.5 playing, the mark still holds 0.75
    core.command(markBack());
    expect(level(core)).toBe(0.75);
  });
});

describe('snapshots include the writes still landing when they are taken', () => {
  /**
   * Binding note 1: the seam is not final for 5 ms after a recording ends, and with REC->DUB the pass starts at once.
   * REC BACK (and the pass's undo) must hold the seam crossfade but none of the overdub.
   */
  const seamInput = (f: number): number => (f < 1000 ? 0.5 : 0.1); // the seam crossfades 0.1 into 0.5

  function recordedRef(): Float32Array {
    const ref = makeCore();
    at(ref, 0, recPlay(), seamInput);
    at(ref, 1000, recPlay(), seamInput);
    run(ref, 100, seamInput);
    const a = ref.getTrackAudio(0)!.L;
    expect(a[0]).toBeCloseTo(0.1, 6); // the crossfade is there
    expect(a[XF]).toBe(0.5);
    return a;
  }

  it('REC BACK after a REC->DUB pass is the loop with its seam crossfade and none of the overdub', () => {
    const want = recordedRef();
    const core = makeCore({ rec: { recAction: 'REC->DUB' } });
    at(core, 0, recPlay(), seamInput);
    at(core, 1000, recPlay(), seamInput); // REC->DUB: the overdub starts at once
    expect(trk(core).state).toBe('overdubbing');
    at(core, 1500, recPlay(), seamInput);
    run(core, 1500, seamInput);
    core.command(recBack());
    expect(core.getTrackAudio(0)!.L).toEqual(want);
  });

  it('undo of the REC->DUB pass is the same loop, even when pressed inside the seam crossfade', () => {
    const want = recordedRef();
    const core = makeCore({ rec: { recAction: 'REC->DUB' } });
    at(core, 0, recPlay(), seamInput);
    at(core, 1000, recPlay(), seamInput);
    at(core, 1002, undoRedo(), seamInput); // 2 frames into the 5 ms seam crossfade
    expect(trk(core).state).toBe('playing');
    run(core, 500, seamInput);
    expect(core.getTrackAudio(0)!.L).toEqual(want);
    core.command(recBack()); // REC BACK holds the whole crossfade too
    expect(core.getTrackAudio(0)!.L).toEqual(want);
  });

  it('REC BACK pressed inside the seam crossfade of a REC->PLAY recording gets the whole crossfade', () => {
    const want = recordedRef();
    const core = makeCore();
    at(core, 0, recPlay(), seamInput);
    at(core, 1000, recPlay(), seamInput);
    at(core, 1002, recBack(), seamInput);
    run(core, 500, seamInput);
    expect(core.getTrackAudio(0)!.L).toEqual(want);
    core.command(undoRedo()); // the loop it replaced also got the crossfade
    expect(core.getTrackAudio(0)!.L).toEqual(want);
  });

  /**
   * Binding note 2: at a rate other than 1 an overdub's writes are gathered and land up to `writeDelay` (6175 frames
   * at 48 kHz) after the punch-out. A snapshot taken at the punch-out must still hold the whole pass.
   */
  const SR48 = 48000;
  const tone = (hz: number, amp: number) => (f: number): number => amp * Math.sin((2 * Math.PI * hz * f) / SR48);

  /**
   * A 2 s loop of 440 Hz at tempo 120, then played at 1.5x (XFADE) and overdubbed with 660 Hz from frame 100000; at
   * 148000 (a 1 s pass) `end` is issued: a punch-out by default.
   */
  function xfadeDub(end: EngineCommand = recPlay()): LooperCore {
    const core = makeCore({ track: [{ tempoSyncMode: 'XFADE' }] }, { sampleRate: SR48 });
    at(core, 0, recPlay(), tone(440, 0.4));
    at(core, 96000, recPlay(), tone(440, 0.4));
    configure(core, { tempo: 180 }); // rate 1.5
    at(core, 100000, recPlay(), tone(660, 0.4));
    at(core, 148000, end, tone(660, 0.4));
    return core;
  }

  it('a mark set at the punch-out of an XFADE overdub at 1.5x holds the whole pass', () => {
    const core = xfadeDub();
    core.command(markSet()); // at the punch-out frame: the tail and ~6000 gathered frames are still to land
    run(core, 48000, tone(660, 0.4));
    core.command(markBack());
    const got = core.getTrackAudio(0)!.L;

    const ref = xfadeDub();
    run(ref, 48000, tone(660, 0.4));
    ref.command(markSet());
    ref.command(markBack());
    const want = ref.getTrackAudio(0)!.L;
    let differ = 0;
    for (let i = 0; i < want.length; i++) if (got[i] !== want[i]) differ++;
    expect(differ).toBe(0);
  });

  it('undo during an XFADE overdub at 1.5x, then redo: the redo loop holds the whole pass', () => {
    const core = xfadeDub(undoRedo()); // ends the pass at 148000 and undoes it
    expect(trk(core).state).toBe('playing');
    run(core, 48000, tone(660, 0.4));
    core.command(undoRedo());
    const got = core.getTrackAudio(0)!.L;

    const ref = xfadeDub(); // the same pass, punched out at the same frame and never undone
    run(ref, 48000, tone(660, 0.4));
    const want = ref.getTrackAudio(0)!.L;
    let differ = 0;
    for (let i = 0; i < want.length; i++) if (got[i] !== want[i]) differ++;
    expect(differ).toBe(0);
  });
});

describe('memory accounting (snapshots share chunks)', () => {
  const chunks = (core: LooperCore): number => core.status().memoryBytes / CHUNK_BYTES;

  /** A 2000-frame (2-chunk) loop of 0.5, playing from a pass start at frame 4000, the seam tail done. */
  function twoChunkLoop(): LooperCore {
    const core = makeCore();
    at(core, 0, recPlay(), dc(0.5));
    at(core, 2000, recPlay(), dc(0.5));
    run(core, 2000, dc(0.5));
    return core;
  }

  function wholePass(core: LooperCore, d: number): void {
    const f = core.frame;
    at(core, f, recPlay(), dc(d));
    at(core, f + 2000, recPlay(), dc(d));
    run(core, 2000, dc(d));
  }

  it('REC BACK and the undo of the first recording cost nothing: the loop is counted once', () => {
    const core = twoChunkLoop();
    expect(chunks(core)).toBe(2);
    core.command(markSet()); // a mark of the same loop shares it too
    expect(chunks(core)).toBe(2);
  });

  it('an overdub copies only what it changes; undo and redo move between the copies without adding any', () => {
    const core = twoChunkLoop();
    wholePass(core, 0.25);
    expect(chunks(core)).toBe(4); // the old loop (undo, REC BACK) and the new one
    core.command(undoRedo());
    expect(chunks(core)).toBe(4);
    core.command(undoRedo());
    expect(chunks(core)).toBe(4);
    core.command({ t: 'clear', track: 0 });
    run(core, 100);
    expect(chunks(core)).toBe(0);
  });

  it('releasing undo, redo or the mark frees the chunks only it held', () => {
    const core = twoChunkLoop();
    wholePass(core, 0.25); // A: undo and REC BACK hold the original O
    core.command(markSet()); // the mark holds A
    wholePass(core, 0.125); // A': undo holds A (with the mark)
    expect(chunks(core)).toBe(6);
    core.command(recBack()); // undo = A', current = O; the old undo let go of A, but the mark keeps it
    expect(chunks(core)).toBe(6);
    core.command(markClear()); // A was the mark's alone
    expect(chunks(core)).toBe(4);
    core.command(undoRedo()); // back to A': redo holds O, which REC BACK shares
    expect(chunks(core)).toBe(4);
    expect(level(core)).toBe(0.875);
  });

  it('a partial overdub copies only the chunks it touched', () => {
    const core = twoChunkLoop();
    const f = core.frame;
    at(core, f + 100, recPlay(), dc(0.25));
    at(core, f + 600, recPlay(), dc(0.25)); // positions 100..605: chunk 0 only
    run(core, 100, dc(0.25));
    expect(chunks(core)).toBe(3);
  });
});
