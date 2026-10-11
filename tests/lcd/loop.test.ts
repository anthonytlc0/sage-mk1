import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { text } from '../../src/lcd/draw';
import { FONT_SMALL } from '../../src/lcd/fonts';
import { registerEditScreens } from '../../src/lcd/screens/register';
import { MSG_BEAT_LOCKED } from '../../src/lcd/screens/rhythm';
import { frame, push, rig, sameRegion, status, turn } from './rig';
import type { Rig } from './rig';
import { ARROW_L, ARROW_R, blank, footer } from './spec';

let unregister: () => void;
beforeEach(() => {
  vi.useFakeTimers();
  unregister = registerEditScreens();
});
afterEach(() => {
  unregister();
  vi.useRealTimers();
});

const mem = (r: Rig) => r.c.session.memory;

/** Presses ▶ n times. */
function pages(r: Rig, n: number): void {
  for (let i = 0; i < n; i++) push(r, 'right');
}

/** Title bar and page arrows as every edit screen draws them. */
function header(title: string, prev: boolean, next: boolean) {
  const want = blank();
  text(want, 1, 0, title, FONT_SMALL);
  for (let x = 0; x < 128; x++) want.set(x, 8);
  if (prev) want.blit(ARROW_L, 116, 2);
  if (next) want.blit(ARROW_R, 122, 2);
  return want;
}
const headerMatches = (r: Rig, title: string, prev: boolean, next: boolean): boolean =>
  sameRegion(frame(r.c), header(title, prev, next), 0, 0, 128, 9);

describe('the LOOP screen', () => {
  it('opens from the LOOP button: page 1 has TRACK, REC and PLAY, with TRK1 over the track icon', () => {
    const r = rig();
    expect(push(r, 'loop')).toBe(true);
    expect(r.menu.depth).toBe(2);
    expect(r.menu.top.title).toBe('LOOP');
    expect(headerMatches(r, 'LOOP', false, true)).toBe(true);
    const want = blank();
    footer(want, [['TRACK'], ['REC'], ['PLAY'], null]);
    text(want, 0, 12, 'TRK1', FONT_SMALL, { align: 'center', width: 32 });
    const f = frame(r.c);
    expect(sameRegion(f, want, 0, 56, 128, 8)).toBe(true);
    expect(sameRegion(f, want, 0, 11, 32, 8)).toBe(true);
  });

  it('page 2 (▶) has INPUT FX, TRACK FX, RHYTHM and NAME', () => {
    const r = rig();
    push(r, 'loop');
    push(r, 'right');
    expect(headerMatches(r, 'LOOP', true, false)).toBe(true);
    const want = blank();
    footer(want, [['INPUT'], ['TRACK'], ['RHYTHM'], ['NAME']]);
    expect(sameRegion(frame(r.c), want, 0, 56, 128, 8)).toBe(true);
    push(r, 'left');
    expect(headerMatches(r, 'LOOP', false, true)).toBe(true);
  });

  it('starts on the current track, and knob [1] turned picks another (TRK3 shows over the icon)', () => {
    const r = rig();
    r.c.setParam('play.currentTrack', 1);
    push(r, 'loop');
    const want = (label: string) => {
      const w = blank();
      text(w, 0, 12, label, FONT_SMALL, { align: 'center', width: 32 });
      return w;
    };
    expect(sameRegion(frame(r.c), want('TRK2'), 0, 11, 32, 8)).toBe(true);
    turn(r, 'knob1', 1);
    expect(sameRegion(frame(r.c), want('TRK3'), 0, 11, 32, 8)).toBe(true);
    turn(r, 'knob1', 10); // stops at TRK5
    expect(sameRegion(frame(r.c), want('TRK5'), 0, 11, 32, 8)).toBe(true);
    turn(r, 'knob1', -10);
    expect(sameRegion(frame(r.c), want('TRK1'), 0, 11, 32, 8)).toBe(true);
    expect(mem(r).play.currentTrack).toBe(1); // only the edit screen follows; the current track is untouched
  });

  it('LOOP > TRACK > PLAY LEVEL change sends settings with the new value', () => {
    const r = rig();
    push(r, 'loop');
    push(r, 'knob1'); // TRACK
    expect(r.menu.top.title).toBe('TRACK1');
    r.engine.reset();
    turn(r, 'knob4', 5); // PLAY LEVEL is knob [4] of page 1
    expect(mem(r).track[0]!.playLevel).toBe(105);
    expect(r.engine.last('settings')!.memory.track[0]!.playLevel).toBe(105);
  });

  it('LOOP > TRACK edits the track chosen with knob [1]', () => {
    const r = rig();
    push(r, 'loop');
    turn(r, 'knob1', 2);
    push(r, 'knob1');
    expect(r.menu.top.title).toBe('TRACK3');
    turn(r, 'knob4', -20);
    expect(mem(r).track[2]!.playLevel).toBe(80);
    expect(mem(r).track[0]!.playLevel).toBe(100);
    push(r, 'exit');
    expect(r.menu.top.title).toBe('LOOP');
    push(r, 'exit');
    expect(r.menu.depth).toBe(1);
  });

  it('page 1: knob [2] opens REC, knob [3] opens PLAY; knob [4] does nothing', () => {
    const r = rig();
    push(r, 'loop');
    push(r, 'knob4');
    expect(r.menu.depth).toBe(2);
    push(r, 'knob2');
    expect(r.menu.top.title).toBe('REC');
    push(r, 'exit');
    push(r, 'knob3');
    expect(r.menu.top.title).toBe('PLAY');
  });

  it('INPUT FX and TRACK FX open an "FX: PHASE 2" message until the effects land', () => {
    const r = rig();
    push(r, 'loop');
    push(r, 'right');
    push(r, 'knob1');
    expect(r.c.message).toBe('FX: PHASE 2');
    expect(r.menu.depth).toBe(2);
    r.c.clearMessage();
    push(r, 'knob2');
    expect(r.c.message).toBe('FX: PHASE 2');
    expect(r.menu.depth).toBe(2);
  });

  it('page 2: knob [3] opens RHYTHM, knob [4] opens NAME', () => {
    const r = rig();
    push(r, 'loop');
    push(r, 'right');
    push(r, 'knob3');
    expect(r.menu.top.title).toBe('RHYTHM');
    push(r, 'exit');
    push(r, 'knob4');
    expect(r.menu.top.title).toBe('NAME');
  });

  it('knob turns on the other pages do nothing, and the LOOP button on LOOP does nothing', () => {
    const r = rig();
    push(r, 'loop');
    r.engine.reset();
    turn(r, 'knob2', 3);
    push(r, 'loop');
    expect(r.engine.sent).toEqual([]);
    expect(r.menu.depth).toBe(2);
  });

  it('registerEditScreens() hands back a function that takes the screens out again', () => {
    unregister();
    const r = rig();
    push(r, 'loop');
    push(r, 'knob1'); // the placeholder has no items
    expect(r.menu.depth).toBe(2);
    unregister = registerEditScreens();
    push(r, 'exit');
    push(r, 'loop');
    push(r, 'knob1');
    expect(r.menu.depth).toBe(3);
  });
});

describe('the TRACK screen', () => {
  it('opens from the TRACK button (PANEL PLAY default TRACK EDIT) on that track', () => {
    const r = rig();
    r.c.handle({ kind: 'press', id: 'trk3.track', t: 0 });
    r.c.handle({ kind: 'release', id: 'trk3.track', t: 50 });
    expect(r.menu.top.title).toBe('TRACK3');
    expect(mem(r).play.currentTrack).toBe(2);
    turn(r, 'knob3', 10);
    expect(mem(r).track[2]!.pan).toBe(10);
  });

  it('pressing another track\'s TRACK button replaces it instead of stacking', () => {
    const r = rig();
    r.c.handle({ kind: 'press', id: 'trk1.track', t: 0 });
    r.c.handle({ kind: 'release', id: 'trk1.track', t: 50 });
    r.c.handle({ kind: 'press', id: 'trk4.track', t: 100 });
    r.c.handle({ kind: 'release', id: 'trk4.track', t: 150 });
    expect(r.menu.depth).toBe(2);
    expect(r.menu.top.title).toBe('TRACK4');
  });

  it('page 1 REVERSE, 1SHOT, PAN, PLAY LEVEL: ▶ for the next page (manual p. 14)', () => {
    const r = rig();
    r.menu.show({ screen: 'track', track: 0 }, r.c);
    expect(headerMatches(r, 'TRACK1', false, true)).toBe(true);
    turn(r, 'knob1', 1);
    turn(r, 'knob2', 1);
    turn(r, 'knob3', -3);
    turn(r, 'knob4', 1);
    expect(mem(r).track[0]).toMatchObject({ reverse: true, oneShot: true, pan: -3, playLevel: 101 });
  });

  it('walks through every parameter of the guide on five pages', () => {
    const r = rig();
    r.menu.show({ screen: 'track', track: 1 }, r.c);
    pages(r, 1);
    expect(headerMatches(r, 'TRACK2', true, true)).toBe(true);
    turn(r, 'knob1', 1); // START MODE
    turn(r, 'knob2', 1); // STOP MODE
    turn(r, 'knob3', 1); // DUB MODE
    push(r, 'knob4'); // FX (on by default)
    expect(mem(r).track[1]).toMatchObject({ startMode: 'FADE', stopMode: 'FADE', dubMode: 'REPLACE1', fx: false });

    pages(r, 1); // PLAY MODE, MEASURE, LOOP SYNC SW, LOOP SYNC MODE
    turn(r, 'knob1', 1);
    turn(r, 'knob2', -1); // FREE -> AUTO
    push(r, 'knob3');
    turn(r, 'knob4', 1);
    expect(mem(r).track[1]).toMatchObject({ playMode: 'SINGLE', measure: 'AUTO', loopSyncSw: false, loopSyncMode: 'MEASURE' });

    pages(r, 1); // TEMPO SYNC SW, MODE, SPEED, BOUNCE IN
    push(r, 'knob1');
    turn(r, 'knob2', -1);
    turn(r, 'knob3', 1);
    push(r, 'knob4');
    expect(mem(r).track[1]).toMatchObject({ tempoSyncSw: false, tempoSyncMode: 'PITCH', tempoSyncSpeed: 'DOUBLE', bounceIn: true });

    pages(r, 1); // INPUT
    expect(headerMatches(r, 'TRACK2', true, false)).toBe(true);
    pages(r, 1);
    expect(headerMatches(r, 'TRACK2', true, false)).toBe(true); // stays on the last page
    expect(mem(r).track[0]).toMatchObject({ reverse: false, startMode: 'IMMEDIATE' }); // other tracks are untouched
  });

  it('LOOP switches to the next track, on the same page (manual p. 14 memo); after TRACK5 comes TRACK1', () => {
    const r = rig();
    r.menu.show({ screen: 'track', track: 3 }, r.c);
    pages(r, 1);
    push(r, 'loop');
    expect(r.menu.top.title).toBe('TRACK5');
    expect(r.menu.depth).toBe(2);
    expect(headerMatches(r, 'TRACK5', true, true)).toBe(true); // still page 2
    turn(r, 'knob2', 1); // STOP MODE of track 5
    expect(mem(r).track[4]!.stopMode).toBe('FADE');
    expect(mem(r).track[3]!.stopMode).toBe('IMMEDIATE');
    push(r, 'loop');
    expect(r.menu.top.title).toBe('TRACK1');
    expect(headerMatches(r, 'TRACK1', true, true)).toBe(true);
  });

  describe('INPUT (page 5)', () => {
    function toInput(r: Rig, track = 0): void {
      r.menu.show({ screen: 'track', track: track as 0 }, r.c);
      pages(r, 4);
    }

    it('turn selects the connector, push switches it ON/OFF (one connector per stereo-linked pair)', () => {
      const r = rig(); // default links: MIC 1 and 2 apart, INST1 and INST2 stereo
      toInput(r);
      push(r, 'knob1'); // MIC1
      expect(mem(r).track[0]!.input).toMatchObject({ MIC1: false, MIC2: true });
      turn(r, 'knob1', 1);
      push(r, 'knob1'); // MIC2
      expect(mem(r).track[0]!.input.MIC2).toBe(false);
      turn(r, 'knob1', 1);
      push(r, 'knob1'); // INST1: L and R together
      expect(mem(r).track[0]!.input).toMatchObject({ INST1L: false, INST1R: false, INST2L: true, INST2R: true });
      turn(r, 'knob1', 2);
      push(r, 'knob1'); // RHYTHM
      expect(mem(r).track[0]!.input.RHYTHM).toBe(false);
      push(r, 'knob1');
      expect(mem(r).track[0]!.input.RHYTHM).toBe(true);
      turn(r, 'knob1', 50); // stops at the last connector
      push(r, 'knob1');
      expect(mem(r).track[0]!.input.RHYTHM).toBe(false);
    });

    it('any knob turns and pushes (the group spans the screen)', () => {
      const r = rig();
      toInput(r);
      turn(r, 'knob3', 1);
      push(r, 'knob4');
      expect(mem(r).track[0]!.input.MIC2).toBe(false);
    });

    it('unlinked pairs are separate connectors, a linked MIC is one', () => {
      const r = rig();
      r.c.setParam('input.stereoLink.INST1', false);
      toInput(r, 2);
      turn(r, 'knob1', 3); // MIC1, MIC2, INST1L, INST1R
      push(r, 'knob1');
      expect(mem(r).track[2]!.input).toMatchObject({ INST1L: true, INST1R: false, INST2L: true });
      r.c.setParam('input.stereoLink.MIC', true);
      turn(r, 'knob1', -9); // MIC (1 + 2)
      push(r, 'knob1');
      expect(mem(r).track[2]!.input).toMatchObject({ MIC1: false, MIC2: false });
    });

    it('draws a switch per connector that follows its value, and marks the selected one', () => {
      const r = rig();
      toInput(r);
      const before = frame(r.c);
      push(r, 'knob1');
      const after = frame(r.c);
      expect(sameRegion(before, after, 0, 19, 18, 12)).toBe(false); // the first switch flipped
      expect(sameRegion(before, after, 18, 19, 110, 12)).toBe(true); // the others did not
      turn(r, 'knob1', 1);
      const moved = frame(r.c);
      expect(sameRegion(after, moved, 0, 53, 36, 3)).toBe(false); // the marker under the captions moved on
    });
  });
});

describe('the REC screen', () => {
  function toRec(r: Rig): void {
    push(r, 'loop');
    push(r, 'knob2');
  }

  it('page 1: REC ACTION, QUANTIZE, AUTO REC SW, AUTO REC SENS', () => {
    const r = rig();
    toRec(r);
    expect(headerMatches(r, 'REC', false, true)).toBe(true);
    turn(r, 'knob1', -1);
    turn(r, 'knob2', -1);
    push(r, 'knob3');
    turn(r, 'knob4', 10);
    expect(mem(r).rec).toMatchObject({ recAction: 'REC->DUB', quantize: 'OFF', autoRecSw: true, autoRecSens: 60 });
  });

  it('page 2: BOUNCE SW and BOUNCE TRACK (turn selects the track, push switches it)', () => {
    const r = rig();
    toRec(r);
    pages(r, 1);
    expect(headerMatches(r, 'REC', true, false)).toBe(true);
    push(r, 'knob1');
    expect(mem(r).rec.bounceSw).toBe(true);
    push(r, 'knob2'); // track 1
    expect(mem(r).rec.bounceTrack).toEqual([false, true, true, true, true]);
    turn(r, 'knob3', 2);
    push(r, 'knob4'); // track 3
    expect(mem(r).rec.bounceTrack).toEqual([false, true, false, true, true]);
    turn(r, 'knob2', 9);
    push(r, 'knob2'); // track 5
    expect(mem(r).rec.bounceTrack).toEqual([false, true, false, true, false]);
  });
});

describe('the PLAY screen', () => {
  function toPlay(r: Rig): void {
    push(r, 'loop');
    push(r, 'knob3');
  }

  it('page 1: S.TRK CHANGE, CURRENT TRACK, FADE TIME IN and OUT', () => {
    const r = rig();
    toPlay(r);
    expect(headerMatches(r, 'PLAY', false, true)).toBe(true);
    turn(r, 'knob1', 1);
    turn(r, 'knob2', 2);
    turn(r, 'knob3', -1);
    turn(r, 'knob4', 1);
    expect(mem(r).play).toMatchObject({ sTrkChange: 'LOOP END', currentTrack: 2, fadeIn: { measures: 1 }, fadeOut: { measures: 3 } });
  });

  it('page 2: ALL START TRK on knobs [1][2], ALL STOP TRK on knobs [3][4]', () => {
    const r = rig();
    toPlay(r);
    pages(r, 1);
    push(r, 'knob1');
    expect(mem(r).play.allStartTrk).toEqual([false, true, true, true, true]);
    turn(r, 'knob2', 1);
    push(r, 'knob1');
    expect(mem(r).play.allStartTrk).toEqual([false, false, true, true, true]);
    expect(mem(r).play.allStopTrk).toEqual([true, true, true, true, true]);
    turn(r, 'knob4', 3);
    push(r, 'knob3');
    expect(mem(r).play.allStopTrk).toEqual([true, true, true, false, true]);
    expect(mem(r).play.allStartTrk).toEqual([false, false, true, true, true]); // the groups keep their own selection
  });

  it('page 3: LOOP LENGTH, SPEED CHANGE, SYNC ADJUST', () => {
    const r = rig();
    toPlay(r);
    pages(r, 2);
    expect(headerMatches(r, 'PLAY', true, false)).toBe(true);
    turn(r, 'knob1', 1); // AUTO -> 1
    turn(r, 'knob2', 1);
    turn(r, 'knob3', 1);
    expect(mem(r).play).toMatchObject({ loopLength: 1, speedChange: 'LOOP END', syncAdjust: 'BEAT' });
  });
});

describe('the RHYTHM screen', () => {
  it('opens from the RHYTHM [EDIT] button (and from LOOP)', () => {
    const r = rig();
    expect(push(r, 'rhythmEdit')).toBe(true);
    expect(r.menu.top.title).toBe('RHYTHM');
    expect(headerMatches(r, 'RHYTHM', false, true)).toBe(true);
  });

  it('page 1: GENRE offers only GUIDE; PATTERN, VARIATION and KIT are stored', () => {
    const r = rig();
    push(r, 'rhythmEdit');
    turn(r, 'knob1', 1);
    turn(r, 'knob1', -1);
    expect(mem(r).rhythm.genre).toBe('GUIDE');
    turn(r, 'knob2', 1);
    turn(r, 'knob3', 1);
    turn(r, 'knob4', 1);
    expect(mem(r).rhythm).toMatchObject({ genre: 'GUIDE', pattern: '4/4 TRIPLE', variation: 'B', kit: 'LIVE' });
  });

  it('page 2: BEAT changes while no track has audio; START TRIG, STOP TRIG and INTRO REC are stored', () => {
    const r = rig();
    push(r, 'rhythmEdit');
    pages(r, 1);
    expect(headerMatches(r, 'RHYTHM', true, true)).toBe(true);
    turn(r, 'knob1', 1);
    expect(mem(r).rhythm.beat).toEqual({ num: 5, den: 4 });
    turn(r, 'knob1', -3);
    expect(mem(r).rhythm.beat).toEqual({ num: 2, den: 4 });
    turn(r, 'knob2', 1);
    turn(r, 'knob3', 1);
    push(r, 'knob4');
    expect(mem(r).rhythm).toMatchObject({ startTrig: 'REC END', stopTrig: 'REC END', introRec: true });
    expect(r.c.message).toBeNull();
  });

  it('page 3: INTRO PLAY, ENDING, FILL and VAR.CHANGE', () => {
    const r = rig();
    push(r, 'rhythmEdit');
    pages(r, 2);
    expect(headerMatches(r, 'RHYTHM', true, false)).toBe(true);
    push(r, 'knob1');
    push(r, 'knob2');
    push(r, 'knob3'); // FILL starts on
    turn(r, 'knob4', 1);
    expect(mem(r).rhythm).toMatchObject({ introPlay: true, ending: true, fill: false, varChange: 'LOOP END' });
  });

  // INFERRED: the guide says the beat cannot be changed after a track is recorded; the refusal wording is ours.
  it.each([['stopped'], ['playing'], ['recording'], ['overdubbing']] as const)('BEAT is locked once a track has audio (%s): the change is refused with a message', (state) => {
    const r = rig();
    push(r, 'rhythmEdit');
    pages(r, 1);
    status(r, {}, [{}, {}, { state }]);
    r.engine.reset();
    turn(r, 'knob1', 1);
    expect(mem(r).rhythm.beat).toEqual({ num: 4, den: 4 });
    expect(r.c.message).toBe(MSG_BEAT_LOCKED);
    expect(r.engine.sent).toEqual([]);
  });

  it('the lock leaves the other parameters alone, and lifts when the tracks are cleared', () => {
    const r = rig();
    push(r, 'rhythmEdit');
    pages(r, 1);
    status(r, {}, [{ state: 'stopped' }]);
    turn(r, 'knob2', 1);
    expect(mem(r).rhythm.startTrig).toBe('REC END');
    expect(r.c.message).toBeNull();
    turn(r, 'knob1', 1);
    expect(mem(r).rhythm.beat).toEqual({ num: 4, den: 4 });
    status(r, {}, [{ state: 'empty' }]);
    turn(r, 'knob1', 1);
    expect(mem(r).rhythm.beat).toEqual({ num: 5, den: 4 });
  });

  it('RHYTHM > page 2 > knob [3] reaches the same screen', () => {
    const r = rig();
    push(r, 'loop');
    pages(r, 1);
    push(r, 'knob3');
    pages(r, 1);
    status(r, {}, [{ state: 'playing' }]);
    turn(r, 'knob1', 1);
    expect(r.c.message).toBe(MSG_BEAT_LOCKED);
  });
});

describe('every edit screen draws on every page without trouble', () => {
  it.each([
    ['LOOP', (r: Rig) => push(r, 'loop'), 2],
    ['TRACK1', (r: Rig) => r.menu.show({ screen: 'track', track: 0 }, r.c), 5],
    ['REC', (r: Rig) => { push(r, 'loop'); push(r, 'knob2'); }, 2],
    ['PLAY', (r: Rig) => { push(r, 'loop'); push(r, 'knob3'); }, 3],
    ['RHYTHM', (r: Rig) => push(r, 'rhythmEdit'), 3],
    ['WRITE', (r: Rig) => r.menu.show({ screen: 'write' }, r.c), 1],
  ] as const)('%s', (title, open, n) => {
    const r = rig();
    open(r);
    expect(r.menu.top.title).toBe(title);
    status(r, {}, [{ state: 'playing' }]);
    for (let i = 0; i < n; i++) {
      const f = frame(r.c, 1000 * i);
      expect(f.toAscii()).toContain('#');
      push(r, 'right');
    }
  });
});
