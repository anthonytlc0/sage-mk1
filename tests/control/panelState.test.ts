import { describe, expect, it } from 'vitest';
import { makeStatus } from '../../src/control/fakeEngine';
import type { TrackStatus } from '../../src/shared/protocol';
import { click, setup } from './helpers';

/** Emits a status where track 0 has `t0` and the others are empty. */
function withTrack0(t0: Partial<TrackStatus>, rest: Partial<Parameters<typeof makeStatus>[0]> = {}) {
  const s = setup();
  s.engine.emit({ t: 'status', status: makeStatus({ ...rest }, [t0]) });
  return s;
}

describe('PanelState: REC/DUB/PLAY LEDs', () => {
  it('recording is red', () => {
    const { c } = withTrack0({ state: 'recording' });
    expect(c.panelState(0).leds['trk1.rec']).toEqual({ color: 'red', blink: 'none' });
  });

  it('pending play is green blinking fast', () => {
    const { c } = withTrack0({ state: 'stopped', pending: 'play' });
    expect(c.panelState(0).leds['trk1.rec']).toEqual({ color: 'green', blink: 'fast' });
  });

  it.each([
    [{ state: 'overdubbing' }, 'yellow', 'none'],
    [{ state: 'playing' }, 'green', 'none'],
    [{ state: 'stopped' }, 'off', 'none'],
    [{ state: 'empty' }, 'off', 'none'],
    [{ state: 'empty', pending: 'rec' }, 'red', 'fast'],
    [{ state: 'playing', pending: 'dub' }, 'yellow', 'fast'],
    [{ state: 'playing', stopping: true }, 'green', 'fast'],
    [{ state: 'empty', autoRecWaiting: true }, 'red', 'fast'],
  ] as [Partial<TrackStatus>, string, string][])('%o -> %s %s', (ts, color, blink) => {
    const { c } = withTrack0(ts);
    expect(c.panelState(0).leds['trk1.rec']).toEqual({ color, blink });
  });

  it('in undo mode: green when undo is available, red when redo is, else off', () => {
    const s = setup();
    click(s.c, 'undoRedo');
    s.engine.emit({
      t: 'status',
      status: makeStatus({}, [
        { state: 'playing', canUndo: true },
        { state: 'playing', canRedo: true },
        { state: 'playing' },
      ]),
    });
    const p = s.c.panelState(0);
    expect(p.leds['trk1.rec']).toEqual({ color: 'green', blink: 'none' });
    expect(p.leds['trk2.rec']).toEqual({ color: 'red', blink: 'none' });
    expect(p.leds['trk3.rec']).toEqual({ color: 'off', blink: 'none' });
    expect(p.leds.undoRedo).toEqual({ color: 'red', blink: 'none' });
  });
});

describe('PanelState: other LEDs', () => {
  it('TRACK is red when the track has audio; FX is red while track.N.fx is on', () => {
    const s = withTrack0({ state: 'stopped' });
    s.c.setParam('track.*.fx', false, 1);
    const p = s.c.panelState(0);
    expect(p.leds['trk1.track']).toEqual({ color: 'red', blink: 'none' });
    expect(p.leds['trk2.track']).toEqual({ color: 'off', blink: 'none' });
    expect(p.leds['trk1.fx']).toEqual({ color: 'red', blink: 'none' });
    expect(p.leds['trk2.fx']).toEqual({ color: 'off', blink: 'none' });
  });

  it('ALL START/STOP is green while any track runs; UNDO/REDO off outside undo mode', () => {
    const idle = withTrack0({ state: 'stopped' });
    expect(idle.c.panelState(0).leds.allStartStop!.color).toBe('off');
    expect(idle.c.panelState(0).leds.undoRedo!.color).toBe('off');
    const running = withTrack0({ state: 'playing' });
    expect(running.c.panelState(0).leds.allStartStop).toEqual({ color: 'green', blink: 'none' });
  });

  it('RHYTHM START/STOP: on = green, standby = green slow, off = off', () => {
    expect(withTrack0({}, { rhythm: 'on' }).c.panelState(0).leds.rhythmStartStop).toEqual({ color: 'green', blink: 'none' });
    expect(withTrack0({}, { rhythm: 'standby' }).c.panelState(0).leds.rhythmStartStop).toEqual({ color: 'green', blink: 'slow' });
    expect(withTrack0({}, { rhythm: 'off' }).c.panelState(0).leds.rhythmStartStop!.color).toBe('off');
  });

  it('with no engine status yet everything is off', () => {
    const { c } = setup();
    const p = c.panelState(0);
    expect(p.leds['trk1.rec']!.color).toBe('off');
    expect(p.leds['trk1.track']!.color).toBe('off');
    expect(p.rings.every((r) => r.color === 'off')).toBe(true);
    expect(p.beatPhase).toBe(0);
  });
});

describe('PanelState: rings', () => {
  it('STATUS (default): the REC colour, blinking with the tempo while the track runs', () => {
    const { c } = withTrack0({ state: 'playing', position: 0.25 });
    const r = c.panelState(0).rings[0];
    expect(r).toMatchObject({ mode: 'status', color: 'green', blink: 'tempo' });
    expect(c.panelState(0).rings[1]).toMatchObject({ mode: 'status', color: 'off' });
  });

  it('STATUS keeps the fast blink of a pending action, and ignores undo mode', () => {
    const s = withTrack0({ state: 'playing', pending: 'dub', canUndo: true });
    click(s.c, 'undoRedo');
    expect(s.c.panelState(0).rings[0]).toMatchObject({ color: 'yellow', blink: 'fast' });
  });

  it('LOOP POSITION: amount is the play position', () => {
    const s = withTrack0({ state: 'playing', position: 0.4 });
    s.c.setParam('setup.indicator', 'LOOP POSITION');
    expect(s.c.panelState(0).rings[0]).toMatchObject({ mode: 'position', color: 'green', blink: 'none', amount: 0.4 });
  });

  it('LEVEL: amount is the peak', () => {
    const s = withTrack0({ state: 'overdubbing', peak: 0.7 });
    s.c.setParam('setup.indicator', 'LEVEL');
    expect(s.c.panelState(0).rings[0]).toMatchObject({ mode: 'level', color: 'yellow', amount: 0.7 });
  });
});

describe('PanelState: object reuse, LCD and globals', () => {
  it('returns the same PanelState and LED objects every call (consumers must not retain them)', () => {
    const s = withTrack0({ state: 'recording' });
    const a = s.c.panelState(0);
    const led = a.leds['trk1.rec'];
    const ring = a.rings[0];
    s.engine.emit({ t: 'status', status: makeStatus({}, [{ state: 'playing' }]) });
    const b = s.c.panelState(16);
    expect(b).toBe(a);
    expect(b.leds['trk1.rec']).toBe(led);
    expect(b.rings[0]).toBe(ring);
    expect(led).toEqual({ color: 'green', blink: 'none' });
  });

  it('the LCD is the framebuffer the LCD host rendered into; contrast and beat phase come through', () => {
    const s = withTrack0({ state: 'playing' }, { beatPhase: 0.3 });
    s.c.setParam('setup.contrast', 8);
    const p = s.c.panelState(123);
    expect(s.lcd.renders).toBe(1);
    expect(p.lcd).toHaveLength(128 * 64);
    expect(p.lcd[2 * 128 + 3]).toBe(1);
    expect(p.lcd.reduce((a, v) => a + v, 0)).toBe(1);
    expect(p.contrast).toBe(8);
    expect(p.beatPhase).toBe(0.3);
    expect(s.c.now).toBe(123);
    // the framebuffer is cleared before each render
    s.c.panelState(140);
    expect(p.lcd.reduce((a, v) => a + v, 0)).toBe(1);
  });
});
