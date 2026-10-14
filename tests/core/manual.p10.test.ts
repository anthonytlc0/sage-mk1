/**
 * Owner's Manual p.10, "Recording on Multiple Tracks" (ruling R3: this walkthrough needs ALL START/STOP, so it lives
 * with Task 8). Each track in ascending order is recorded, played back, overdubbed (repeat as needed) and played back;
 * then [ALL START/STOP] stops everything: "The [ALL START/STOP] button and the [REC/DUB/PLAY] buttons for each track go
 * dark." The page's Undo/Redo box follows: the REC/DUB/PLAY button is green while undo is available, red while redo
 * is. The button also "makes all tracks start (play back) at the same time" (p. 4).
 *
 * LED colours are the controller's job; here the states behind them are checked (dark = stopped, with the phrase kept;
 * green = canUndo, red = canRedo).
 */
import { describe, expect, it } from 'vitest';
import { at, makeCore, recPlay, run, trk, XF } from './harness';
import type { TrackIndex } from '../../src/shared/ids';

const TRACKS = [0, 1, 2, 3, 4] as const;
/** Each track's recorded phrase and its overdub layer. */
const REC = [0.5, 0.25, 0.125, 0.0625, 0.03125];
const DUB = REC.map((r) => r / 2);
/** Track k's turn starts at frame 3100 k: record 1000 frames, play one pass, overdub one pass, then play. */
const start = (k: number): number => 3100 * k;

/** The performance: each track's phrase while it records (and over its seam), its layer while it overdubs. */
function performance(f: number): number {
  const k = Math.floor(f / 3100);
  const t = f - start(k);
  if (k > 4) return 0;
  if (t < 1000 + XF) return REC[k];
  if (t >= 2000 && t < 3000 + XF) return DUB[k];
  return 0;
}

describe("Owner's Manual p.10: recording on multiple tracks, then ALL START/STOP", () => {
  it('tracks 1-5 in ascending order: record -> playback -> overdub -> playback; ALL START/STOP stops them all', () => {
    const core = makeCore(); // guide defaults: REC ACTION = REC->PLAY, PLAY MODE = MULTI, ALL START TRK all on

    for (const k of TRACKS) {
      const s = start(k);
      // Recording: press REC/DUB/PLAY.
      at(core, s, recPlay(k), performance);
      run(core, 1, performance);
      expect(trk(core, k).state).toBe('recording');
      // Playback: press again. The recorded phrase plays as a loop.
      at(core, s + 1000, recPlay(k), performance);
      expect(trk(core, k).state).toBe('playing');
      expect(trk(core, k).lengthFrames).toBe(1000);
      // Overdubbing (repeat as many times as necessary), then playback.
      at(core, s + 2000, recPlay(k), performance);
      expect(trk(core, k).state).toBe('overdubbing');
      at(core, s + 3000, recPlay(k), performance);
      expect(trk(core, k).state).toBe('playing');
      // The tracks recorded before it are still playing their loops.
      for (let j = 0; j <= k; j++) expect(trk(core, j as TrackIndex).state).toBe('playing');
    }
    const out = run(core, 1000, performance);
    for (const k of TRACKS) expect(out.tracks[k][500]).toBe(REC[k] + DUB[k]);

    // Stopping: press ALL START/STOP. Every track goes dark; the phrases are kept.
    core.command({ t: 'allStartStop' });
    for (const k of TRACKS) {
      const s = trk(core, k);
      expect(s.state).toBe('stopped');
      expect(s.lengthFrames).toBe(1000);
    }
    const quiet = run(core, 500);
    for (const k of TRACKS) expect(quiet.tracks[k].subarray(XF).every((v) => v === 0)).toBe(true);

    // Undo/Redo: every track's last overdub can be undone (green). Undoing track 2 makes redo available (red).
    for (const k of TRACKS) expect(trk(core, k).canUndo).toBe(true);
    core.command({ t: 'undoRedo', track: 1 });
    expect(trk(core, 1).canUndo).toBe(false);
    expect(trk(core, 1).canRedo).toBe(true);

    // ALL START/STOP again: all five start at the same frame, track 2 without its overdub.
    core.command({ t: 'allStartStop' });
    for (const k of TRACKS) expect(trk(core, k).state).toBe('playing');
    const again = run(core, 1000);
    for (const k of TRACKS) {
      expect(again.tracks[k][0]).toBe(0); // every ramp-in starts on the same frame
      expect(again.tracks[k][500]).toBe(k === 1 ? REC[k] : REC[k] + DUB[k]);
    }
    // Press UNDO/REDO on track 2 once more to return to the previous state.
    core.command({ t: 'undoRedo', track: 1 });
    expect(run(core, 1000).tracks[1][500]).toBe(REC[1] + DUB[1]);
  });
});
