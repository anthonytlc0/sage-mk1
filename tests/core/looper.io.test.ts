import { describe, expect, it } from 'vitest';
import { at, clear, configure, dc, makeCore, makeOutput, ramp, recPlay, run, SR, trk } from './harness';
import { LooperCore } from '../../src/core/looper';

describe('LooperCore status', () => {
  it('reports every track, the transport and memory use', () => {
    const core = makeCore({ tempo: 100, rhythm: { beat: { num: 3, den: 4 } } });
    const s = core.status();
    expect(s.tracks).toHaveLength(5);
    expect(s.tempo).toBe(100);
    expect(s.beat).toEqual({ num: 3, den: 4 });
    expect(s.rhythm).toBe('off');
    expect(s.memoryBytes).toBe(0);
    expect(s.memoryBudget).toBe(64 * 1024 * 1024);
    for (const t of s.tracks) {
      expect(t).toEqual({
        state: 'empty', pending: null, stopping: false, autoRecWaiting: false, position: 0, lengthFrames: 0,
        measures: null, peak: 0, canUndo: false, canRedo: false, hasMark: false, speed: 'NORMAL',
      });
    }
  });

  it('tracks the beat and measure phase of the current frame', () => {
    const core = makeCore({ tempo: 120 }); // 4/4: a beat is 500 frames, a measure 2000
    run(core, 750);
    const s = core.status();
    expect(s.beatPhase).toBeCloseTo(0.5, 9);
    expect(s.measurePhase).toBeCloseTo(0.375, 9);
  });

  it('reports position, length, peak and memory while a loop plays', () => {
    const core = makeCore();
    at(core, 0, recPlay(), dc(0.5));
    run(core, 400, dc(0.5));
    expect(trk(core).lengthFrames).toBe(400); // grows while recording
    at(core, 1000, recPlay(), dc(0.5));
    run(core, 250, dc(0.5));
    const s = core.status();
    expect(s.tracks[0].position).toBeCloseTo(0.25, 9);
    expect(s.tracks[0].peak).toBe(0.5);
    expect(s.memoryBytes).toBe(SR * 2 * 4);
    expect(core.status().tracks[0].peak).toBe(0); // peak is since the last status()
  });

  it('audioDirty is raised when a pass ends or a track is cleared, and reads once', () => {
    const core = makeCore();
    expect(core.status().audioDirty).toBe(false);
    at(core, 0, recPlay(), dc(0.5));
    run(core, 500, dc(0.5));
    expect(core.status().audioDirty).toBe(false); // nothing finished yet
    at(core, 1000, recPlay(), dc(0.5));
    run(core, 1);
    expect(core.status().audioDirty).toBe(true);
    expect(core.status().audioDirty).toBe(false);
    at(core, 1500, clear());
    run(core, 1);
    expect(core.status().audioDirty).toBe(true);
    // Clearing a first recording before it ends changes nothing that was there before.
    at(core, 2000, recPlay(), dc(0.5));
    at(core, 2500, clear(), dc(0.5));
    expect(core.status().audioDirty).toBe(false);
  });

  it('frame advances by the frames processed', () => {
    const core = makeCore();
    expect(core.frame).toBe(0);
    run(core, 300);
    expect(core.frame).toBe(300);
  });

  it('process writes zeros for silent tracks and the click', () => {
    const core = new LooperCore({ sampleRate: SR, memoryBudgetBytes: 1 << 20 }); // works before setSettings
    const out = makeOutput(64);
    for (const [L, R] of out.tracks) { L.fill(9); R.fill(9); }
    out.click[0].fill(9);
    out.click[1].fill(9);
    const z = new Float32Array(64);
    core.process(z, z, z, z, out, 64);
    for (const [L, R] of out.tracks) expect(L.every((v) => v === 0) && R.every((v) => v === 0)).toBe(true);
    expect(out.click[0].every((v) => v === 0) && out.click[1].every((v) => v === 0)).toBe(true);
  });
});

describe('track audio in and out', () => {
  it('getTrackAudio returns the loop; null for an empty track', () => {
    const core = makeCore({ tempo: 95 });
    expect(core.getTrackAudio(0)).toBeNull();
    at(core, 0, recPlay(), ramp);
    at(core, 1000, recPlay(), ramp);
    run(core, 20, ramp);
    const a = core.getTrackAudio(0)!;
    expect(a.L).toHaveLength(1000);
    expect(a.R).toHaveLength(1000);
    expect(a.L[500]).toBe(500);
    expect(a.R[999]).toBe(999);
    expect(a.sampleRate).toBe(SR);
    expect(a.recordedTempo).toBe(95);
    expect(a.measures).toBeNull();
  });

  it('getTrackAudio is null while the first recording is still running', () => {
    const core = makeCore();
    at(core, 0, recPlay(), dc(0.5));
    run(core, 300, dc(0.5));
    expect(core.getTrackAudio(0)).toBeNull();
  });

  it('setTrackAudio loads a stopped track that plays from the start', () => {
    const core = makeCore();
    const L = new Float32Array(800).map((_, i) => i);
    const R = L.map((v) => -v);
    core.setTrackAudio(2, { L, R, sampleRate: SR, recordedTempo: 120, measures: null });
    expect(trk(core, 2).state).toBe('stopped');
    expect(trk(core, 2).lengthFrames).toBe(800);
    at(core, 100, recPlay(2));
    const out = run(core, 1000);
    expect(out.tracks[2][300]).toBe(300);
    expect(out.tracksR[2][300]).toBe(-300);
    expect(out.tracks[2][850]).toBe(50); // looped
    expect(core.getTrackAudio(2)!.L).toEqual(L);
  });

  it('setTrackAudio(null) empties the track; loadTrack does the same through the command queue', () => {
    const core = makeCore();
    const L = new Float32Array(500).fill(0.5);
    core.setTrackAudio(0, { L, R: L, sampleRate: SR, recordedTempo: 120, measures: null });
    core.setTrackAudio(0, null);
    expect(trk(core).state).toBe('empty');
    expect(core.status().memoryBytes).toBe(0);
    core.command({ t: 'loadTrack', track: 1, audio: { L, R: L, sampleRate: SR, recordedTempo: 120, measures: null } }, 50);
    run(core, 100);
    expect(trk(core, 1).state).toBe('stopped');
    expect(trk(core, 1).lengthFrames).toBe(500);
  });

  it('a track can record again after it was cleared (the released take is replaced)', () => {
    const core = makeCore();
    for (let k = 0; k < 3; k++) {
      const f0 = core.frame;
      at(core, f0, recPlay(), dc(0.5));
      at(core, f0 + 1000, recPlay(), dc(0.5));
      at(core, f0 + 1500, clear(), dc(0.5));
      run(core, 1);
    }
    expect(core.takeMessages()).toEqual([]);
    expect(trk(core).state).toBe('empty');
  });

  it('settings changes apply live: PLAY LEVEL while playing', () => {
    const core = makeCore();
    at(core, 0, recPlay(), dc(0.5));
    at(core, 1000, recPlay(), dc(0.5));
    configure(core, { track: [{ playLevel: 50 }] });
    expect(run(core, 600).tracks[0][500]).toBe(0.25);
  });
});
