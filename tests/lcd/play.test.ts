import { describe, expect, it } from 'vitest';
import { fillRect, text, textWidth } from '../../src/lcd/draw';
import { FONT_LARGE, FONT_MEDIUM, FONT_SMALL } from '../../src/lcd/fonts';
import type { Framebuffer } from '../../src/lcd/framebuffer';
import { icon } from '../../src/lcd/icons';
import type { IconName } from '../../src/lcd/icons';
import type { FxBankView } from '../../src/lcd/menu';
import type { TrackState } from '../../src/shared/protocol';
import { expectScreen } from './fixtures';
import { frame, push, rig, status } from './rig';
import { DEFAULT_FOOTER, bigNumber, blank, footer, header, pieCleared, rhythmPill, scaled, scaledWidth, statusRow } from './spec';
import type { Rig } from './rig';

const goto = (r: Rig, n: number): void => {
  for (let i = 0; i < n; i++) push(r, 'right');
};

/** The current-track dot: dark on a light icon, light on a dark one. */
function marker(fb: Framebuffer, x: number, y: number): void {
  icon(fb, x + 7, y + 7, 'current', { invert: fb.get(x + 9, y + 9) === 1 });
}

const BASE: Record<TrackState, IconName> = {
  empty: 'trkEmpty', stopped: 'trkStop', playing: 'trkPlay', recording: 'trkPlay', overdubbing: 'trkPlay',
};

describe('TRACK STATUS (2)', () => {
  it('shows an icon per track: recording/playing, stopped with a phrase, empty; the current track is marked', () => {
    const r = rig();
    r.c.setParam('name', 'BEATBOX 1');
    status(r, {}, [{ state: 'playing' }, { state: 'stopped' }, { state: 'empty' }, { state: 'recording' }, { state: 'empty' }]);
    goto(r, 1);
    const want = blank();
    statusRow(want);
    header(want, '01', 'BEATBOX 1');
    (['playing', 'stopped', 'empty', 'recording', 'empty'] as TrackState[]).forEach((s, i) => icon(want, 1 + 21 * i, 25, BASE[s]));
    marker(want, 1, 25); // track 1 is the current track
    rhythmPill(want, false);
    footer(want, DEFAULT_FOOTER);
    expectScreen(frame(r.c), want.toAscii());
  });

  it('the marker follows the current track and the rhythm indicator follows the rhythm', () => {
    const r = rig();
    r.c.setParam('play.currentTrack', 2);
    status(r, { rhythm: 'on' }, [{ state: 'stopped' }, { state: 'empty' }, { state: 'empty' }]);
    goto(r, 1);
    const want = blank();
    statusRow(want);
    header(want, '01', '');
    (['stopped', 'empty', 'empty', 'empty', 'empty'] as TrackState[]).forEach((s, i) => icon(want, 1 + 21 * i, 25, BASE[s]));
    marker(want, 1 + 21 * 2, 25);
    rhythmPill(want, true);
    footer(want, DEFAULT_FOOTER);
    expectScreen(frame(r.c), want.toAscii());
  });

  it('idle without an engine status: five empty tracks, current track marked', () => {
    const r = rig();
    goto(r, 1);
    const want = blank();
    statusRow(want);
    header(want, '01', '');
    for (let i = 0; i < 5; i++) icon(want, 1 + 21 * i, 25, 'trkEmpty');
    marker(want, 1, 25);
    rhythmPill(want, false);
    footer(want, DEFAULT_FOOTER);
    expectScreen(frame(r.c), want.toAscii());
  });

  it('a standby rhythm blinks the indicator', () => {
    const r = rig();
    status(r, { rhythm: 'standby' });
    goto(r, 1);
    const a = frame(r.c, 0);
    const b = frame(r.c, 300);
    let diff = 0;
    for (let i = 0; i < a.data.length; i++) diff += a.data[i]! ^ b.data[i]!;
    expect(diff).toBeGreaterThan(0);
  });
});

describe('LOOP TRACKS (3)', () => {
  it('fills each playing track icon like a pie as the phrase plays (status.tracks[i].position)', () => {
    const r = rig();
    r.c.setParam('name', 'BEATBOX 1');
    status(r, {}, [
      { state: 'playing', position: 0.5 },
      { state: 'stopped' },
      { state: 'empty' },
      { state: 'recording', position: 0.75 },
      { state: 'empty' },
    ]);
    goto(r, 2);
    const want = blank();
    statusRow(want);
    header(want, '01', 'BEATBOX 1');
    const pie = (i: number, p: number): void => {
      const x = 1 + 21 * i;
      icon(want, x, 25, 'trkStop');
      for (let j = 2; j < 18; j++) for (let k = 2; k < 18; k++) if (pieCleared(k, j, p)) want.set(x + k, 25 + j, 0);
    };
    pie(0, 0.5);
    icon(want, 1 + 21, 25, 'trkStop');
    icon(want, 1 + 42, 25, 'trkEmpty');
    pie(3, 0.75);
    icon(want, 1 + 84, 25, 'trkEmpty');
    marker(want, 1, 25);
    rhythmPill(want, false);
    footer(want, DEFAULT_FOOTER);
    expectScreen(frame(r.c), want.toAscii());
  });

  it('a track at the very start is an outlined empty frame, one nearly at the end is nearly solid', () => {
    const r = rig();
    status(r, {}, [{ state: 'playing', position: 0 }, { state: 'playing', position: 0.999 }]);
    goto(r, 2);
    const fb = frame(r.c);
    // the interior of track 1 is cleared (frame only), that of track 2 is filled but for a sliver
    expect(fb.get(1 + 10, 25 + 5)).toBe(0);
    expect(fb.get(1 + 21 + 10, 25 + 5)).toBe(1);
    expect(fb.get(1, 25 + 10)).toBe(1); // frame
  });
});

describe('LOOP STATUS (4)', () => {
  /** "TRKn: WORD" at 2x, centred, as in the manual's "TRK5: PLAY". */
  function bigStatus(want: Framebuffer, n: number, word: string): void {
    const trkW = textWidth('TRK', FONT_MEDIUM);
    const total = trkW + 2 + 14 + 2 + scaledWidth(':') + 4 + scaledWidth(word);
    let x = Math.floor((128 - total) / 2);
    text(want, x, 37, 'TRK', FONT_MEDIUM);
    x += trkW + 2;
    text(want, x, 24, String(n), FONT_LARGE);
    x += 14 + 2;
    scaled(want, x, 26, ':');
    x += scaledWidth(':') + 4;
    scaled(want, x, 26, word);
  }

  it('shows the current track and its status in big letters (TRK5: PLAY)', () => {
    const r = rig();
    r.c.setParam('name', 'BEATBOX 1');
    r.c.setParam('play.currentTrack', 4);
    status(r, {}, [{}, {}, {}, {}, { state: 'playing' }]);
    goto(r, 3);
    const want = blank();
    statusRow(want);
    header(want, '01', 'BEATBOX 1');
    bigStatus(want, 5, 'PLAY');
    footer(want, DEFAULT_FOOTER);
    expectScreen(frame(r.c), want.toAscii());
  });

  it.each<[TrackState, string]>([
    ['recording', 'REC'], ['overdubbing', 'DUB'], ['playing', 'PLAY'], ['stopped', 'STOP'], ['empty', 'EMPTY'],
  ])('names the %s state %s', (state, word) => {
    const r = rig();
    status(r, {}, [{ state }]);
    goto(r, 3);
    const want = blank();
    statusRow(want);
    header(want, '01', '');
    bigStatus(want, 1, word);
    footer(want, DEFAULT_FOOTER);
    expectScreen(frame(r.c), want.toAscii());
  });

  it('follows the track that was just operated, and the current track when it changes', () => {
    const r = rig();
    goto(r, 3);
    status(r);
    frame(r.c, 0);
    status(r, {}, [{}, {}, { state: 'recording' }]);
    let want = blank();
    statusRow(want);
    header(want, '01', '');
    bigStatus(want, 3, 'REC');
    footer(want, DEFAULT_FOOTER);
    expectScreen(frame(r.c, 16), want.toAscii());

    r.c.setParam('play.currentTrack', 4);
    want = blank();
    statusRow(want);
    header(want, '01', '');
    bigStatus(want, 5, 'EMPTY');
    footer(want, DEFAULT_FOOTER);
    expectScreen(frame(r.c, 32), want.toAscii());
  });

  it('idle without a status shows the current track as empty', () => {
    const r = rig();
    goto(r, 3);
    const want = blank();
    statusRow(want);
    header(want, '01', '');
    bigStatus(want, 1, 'EMPTY');
    footer(want, DEFAULT_FOOTER);
    expectScreen(frame(r.c), want.toAscii());
  });
});

describe('LOOP LEVEL (5)', () => {
  const dB = (db: number): number => Math.pow(10, db / 20);

  /** Two bars per track on a 24 px scale from y = 46 up; a peak-hold line sits two rows above the bar. */
  function bars(want: Framebuffer, heights: number[], holds: number[]): void {
    heights.forEach((h, i) => {
      const x = 4 + 25 * i;
      const hh = Math.max(1, h);
      fillRect(want, x, 46 - hh + 1, 8, hh);
      fillRect(want, x + 9, 46 - hh + 1, 8, hh);
      if (holds[i]! > 0) {
        fillRect(want, x, 46 - holds[i]! - 1, 8, 1);
        fillRect(want, x + 9, 46 - holds[i]! - 1, 8, 1);
      }
    });
  }

  it('draws a level meter per track from status.tracks[i].peak (0 dB = full scale, 48 dB range)', () => {
    const r = rig();
    r.c.setParam('name', 'BEATBOX 1');
    status(r, {}, [{ peak: 1 }, { peak: 0 }, { peak: dB(-24) }, { peak: dB(-12) }, { peak: dB(-60) }]);
    goto(r, 4);
    const want = blank();
    statusRow(want);
    header(want, '01', 'BEATBOX 1');
    bars(want, [24, 0, 12, 18, 0], [24, 0, 12, 18, 0]);
    footer(want, DEFAULT_FOOTER);
    expectScreen(frame(r.c), want.toAscii());
  });

  it('the peak-hold line falls slowly after the level drops', () => {
    const r = rig();
    status(r, {}, [{ peak: 1 }]);
    goto(r, 4);
    frame(r.c, 0);
    status(r, {}, [{ peak: 0 }]);
    const want = blank();
    statusRow(want);
    header(want, '01', '');
    bars(want, [0, 0, 0, 0, 0], [12, 0, 0, 0, 0]); // half a second later the hold has fallen from 24 to 12 px
    footer(want, DEFAULT_FOOTER);
    expectScreen(frame(r.c, 1000), want.toAscii());
  });

  it('idle without a status: flat bars', () => {
    const r = rig();
    goto(r, 4);
    const want = blank();
    statusRow(want);
    header(want, '01', '');
    bars(want, [0, 0, 0, 0, 0], [0, 0, 0, 0, 0]);
    footer(want, DEFAULT_FOOTER);
    expectScreen(frame(r.c), want.toAscii());
  });
});

describe('INPUT FX (6) and TRACK FX (7)', () => {
  function tiles(want: Framebuffer, label: string, names: string[][], on: boolean[]): void {
    text(want, 1, 23, label, FONT_SMALL);
    names.forEach((lines, i) => {
      const x = 32 * i + 1;
      if (on[i]) fillRect(want, x, 31, 30, 15);
      lines.forEach((s, k) => {
        const y = lines.length === 1 ? 35 : 31 + 8 * k;
        text(want, x, y, s, FONT_SMALL, { align: 'center', width: 30, invert: on[i] });
      });
    });
  }

  it('INPUT FX shows banks A-D with all slots off (phase 1: no effects yet)', () => {
    const r = rig();
    r.c.setParam('name', 'BEATBOX 1');
    goto(r, 5);
    const want = blank();
    statusRow(want);
    header(want, '01', 'BEATBOX 1');
    tiles(want, 'INPUT FX-A', [['---'], ['---'], ['---'], ['---']], [false, false, false, false]);
    footer(want, DEFAULT_FOOTER);
    expectScreen(frame(r.c), want.toAscii());
  });

  it('TRACK FX is the same with its own label', () => {
    const r = rig();
    goto(r, 6);
    const want = blank();
    statusRow(want);
    header(want, '01', '');
    tiles(want, 'TRACK FX-A', [['---'], ['---'], ['---'], ['---']], [false, false, false, false]);
    footer(want, DEFAULT_FOOTER);
    expectScreen(frame(r.c), want.toAscii());
  });

  it('an effect that is on is drawn in inverse video; long names wrap onto two lines', () => {
    const bank: FxBankView = {
      bank: 'B',
      slots: [{ name: 'LPF', on: true }, { name: 'G2B', on: false }, { name: 'PTN SL', on: true }, { name: 'DLY', on: false }],
    };
    const r = rig({ fx: () => bank });
    goto(r, 5);
    const want = blank();
    statusRow(want);
    header(want, '01', '');
    tiles(want, 'INPUT FX-B', [['LPF'], ['G2B'], ['PTN', 'SL'], ['DLY']], [true, false, true, false]);
    footer(want, DEFAULT_FOOTER);
    expectScreen(frame(r.c), want.toAscii());
  });
});
