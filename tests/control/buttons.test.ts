import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PANEL_ACTIONS, EDIT_HOLD_MS, PANEL_HOLD_MS, TAP_REVERT_MS } from '../../src/control/buttons';
import { PANEL_FUNCTIONS, findParam } from '../../src/schema/params';
import { CLEAR_HOLD_MS, TEMPO_MIN } from '../../src/shared/constants';
import { faderGain } from '../../src/dsp/mixer';
import { click, press, release, set, setup, turn } from './helpers';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('track buttons', () => {
  it('trk1.rec press sends recPlay for track 0, timed to the event', () => {
    const { c, engine } = setup();
    press(c, 'trk1.rec', 1234);
    expect(engine.sent).toEqual([{ cmd: { t: 'recPlay', track: 0 }, eventTime: 1234 }]);
    release(c, 'trk1.rec', 1300);
    expect(engine.sent).toHaveLength(1);
  });

  it('holding trk1.stop for 2000 ms sends stop, then clear', () => {
    const { c, engine } = setup();
    press(c, 'trk1.stop', 0);
    expect(engine.types()).toEqual(['stop']);
    vi.advanceTimersByTime(CLEAR_HOLD_MS - 1);
    expect(engine.types()).toEqual(['stop']);
    vi.advanceTimersByTime(1);
    expect(engine.sent.map((s) => s.cmd)).toEqual([
      { t: 'stop', track: 0 },
      { t: 'clear', track: 0 },
    ]);
    release(c, 'trk1.stop', CLEAR_HOLD_MS + 100);
    expect(engine.types()).toEqual(['stop', 'clear']);
  });

  it('releasing STOP before the hold time cancels the clear', () => {
    const { c, engine } = setup();
    press(c, 'trk2.stop', 0);
    vi.advanceTimersByTime(1500);
    release(c, 'trk2.stop', 1500);
    vi.advanceTimersByTime(5000);
    expect(engine.sent.map((s) => s.cmd)).toEqual([{ t: 'stop', track: 1 }]);
  });

  it('in undo mode REC/DUB/PLAY is UNDO/REDO and STOP is MARK BACK (no hold-to-clear)', () => {
    const { c, engine } = setup();
    click(c, 'undoRedo');
    expect(c.undoMode).toBe(true);
    press(c, 'trk1.rec', 10);
    release(c, 'trk1.rec', 15);
    press(c, 'trk3.stop', 20);
    vi.advanceTimersByTime(CLEAR_HOLD_MS * 2);
    release(c, 'trk3.stop', 9000);
    expect(engine.sent).toEqual([
      { cmd: { t: 'undoRedo', track: 0 }, eventTime: 10 },
      { cmd: { t: 'markBack', track: 2 }, eventTime: 20 },
    ]);
    click(c, 'undoRedo');
    expect(c.undoMode).toBe(false);
    press(c, 'trk1.rec', 30);
    expect(engine.sent.at(-1)!.cmd).toEqual({ t: 'recPlay', track: 0 });
  });

  it('TRACK (PANEL PLAY default TRACK EDIT) selects the current track and opens the TRACK screen', () => {
    const { c, lcd } = setup();
    click(c, 'trk3.track');
    expect(c.session.memory.play.currentTrack).toBe(2);
    expect(lcd.shows).toEqual([{ screen: 'track', track: 2 }]);
  });

  it('FX (PANEL PLAY default TRACK FX) toggles track.N.fx and pushes settings', () => {
    const { c, engine } = setup();
    expect(c.session.memory.track[1]!.fx).toBe(true);
    click(c, 'trk2.fx');
    expect(c.session.memory.track[1]!.fx).toBe(false);
    const s = engine.last('settings')!;
    expect(s.memory.track[1]!.fx).toBe(false);
    click(c, 'trk2.fx');
    expect(c.session.memory.track[1]!.fx).toBe(true);
  });

  it('in undo mode TRACK and FX follow PANEL UNDO (defaults MARK SET / MARK CLEAR)', () => {
    const { c, engine } = setup();
    click(c, 'undoRedo');
    press(c, 'trk4.track', 5);
    press(c, 'trk5.fx', 6);
    expect(engine.sent).toEqual([
      { cmd: { t: 'markSet', track: 3 }, eventTime: 5 },
      { cmd: { t: 'markClear', track: 4 }, eventTime: 6 },
    ]);
  });

  it('ALL START/STOP and RHYTHM START/STOP send their commands', () => {
    const { c, engine } = setup();
    click(c, 'allStartStop', 1);
    click(c, 'rhythmStartStop', 2);
    expect(engine.types()).toEqual(['allStartStop', 'rhythmStartStop']);
  });

  it('a long ALL START/STOP press clears all tracks only when PREFERENCE ALL CLEAR is ON', () => {
    const { c, engine } = setup();
    press(c, 'allStartStop', 0);
    vi.advanceTimersByTime(CLEAR_HOLD_MS);
    release(c, 'allStartStop', CLEAR_HOLD_MS);
    expect(engine.types()).toEqual(['allStartStop']);
    c.setParam('ctl.preference.allClear', true);
    engine.reset();
    press(c, 'allStartStop', 0);
    vi.advanceTimersByTime(CLEAR_HOLD_MS);
    expect(engine.types()).toEqual(['allStartStop', 'clearAll']);
  });
});

describe('PANEL functions', () => {
  it('has a table entry for every PANEL_FUNCTIONS id', () => {
    for (const f of PANEL_FUNCTIONS) expect(PANEL_ACTIONS.has(f.id), f.id).toBe(true);
    expect(PANEL_ACTIONS.size).toBe(PANEL_FUNCTIONS.length);
  });

  it('reads the button function from ctl.panelPlay (REVERSE toggles track.N.reverse)', () => {
    const { c } = setup();
    c.setParam('ctl.panelPlay.track.0', 'TRK1 REVERSE');
    click(c, 'trk1.track');
    expect(c.session.memory.track[0]!.reverse).toBe(true);
    click(c, 'trk1.track');
    expect(c.session.memory.track[0]!.reverse).toBe(false);
  });

  it('a button may drive another track (TRK4 CLEAR on the track-1 FX button)', () => {
    const { c, engine } = setup();
    c.setParam('ctl.panelPlay.fx.0', 'TRK4 CLEAR');
    engine.reset();
    press(c, 'trk1.fx', 7);
    expect(engine.sent).toEqual([{ cmd: { t: 'clear', track: 3 }, eventTime: 7 }]);
  });

  it('UNDO/REDO, MARK BACK1, REC BACK, MARK SET1, MARK CLEAR map to their commands', () => {
    const { c, engine } = setup();
    const fns = ['TRK1 UNDO/REDO', 'TRK2 MARK BACK1', 'TRK3 REC BACK', 'TRK4 MARK SET1', 'TRK5 MARK CLEAR'];
    for (const [i, fn] of fns.entries()) c.setParam(`ctl.panelPlay.track.${i}`, fn);
    engine.reset();
    for (const n of [1, 2, 3, 4, 5] as const) click(c, `trk${n}.track`);
    expect(engine.sent.map((s) => s.cmd)).toEqual([
      { t: 'undoRedo', track: 0 },
      { t: 'markBack', track: 1 },
      { t: 'recBack', track: 2 },
      { t: 'markSet', track: 3 },
      { t: 'markClear', track: 4 },
    ]);
  });

  it('MARK SET2 marks on press; held, MARK CLEAR follows and supersedes it', () => {
    const { c, engine } = setup();
    c.setParam('ctl.panelPlay.track.1', 'TRK2 MARK SET2');
    engine.reset();
    press(c, 'trk2.track', 100);
    expect(engine.sent).toEqual([{ cmd: { t: 'markSet', track: 1 }, eventTime: 100 }]);
    vi.advanceTimersByTime(PANEL_HOLD_MS - 1);
    expect(engine.sent).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(engine.sent.at(-1)).toEqual({ cmd: { t: 'markClear', track: 1 }, eventTime: 100 + PANEL_HOLD_MS });
    release(c, 'trk2.track', 100 + PANEL_HOLD_MS + 200);
    expect(engine.sent).toHaveLength(2);
    // a short press marks at the press, not at the release
    engine.reset();
    press(c, 'trk2.track', 5000);
    release(c, 'trk2.track', 5300);
    vi.advanceTimersByTime(PANEL_HOLD_MS * 2);
    expect(engine.sent).toEqual([{ cmd: { t: 'markSet', track: 1 }, eventTime: 5000 }]);
  });

  it('MARK BACK2 marks back on press and holds to REC BACK; CUR.TRK DEC still waits (hold = INC, never both)', () => {
    const { c, engine } = setup();
    c.setParam('ctl.panelPlay.fx.2', 'TRK3 MARK BACK2');
    c.setParam('ctl.panelPlay.fx.3', 'CUR.TRK DEC');
    engine.reset();
    press(c, 'trk3.fx', 0);
    expect(engine.types()).toEqual(['markBack']);
    vi.advanceTimersByTime(PANEL_HOLD_MS);
    release(c, 'trk3.fx', PANEL_HOLD_MS);
    expect(engine.types()).toEqual(['markBack', 'recBack']);
    press(c, 'trk4.fx', 0);
    expect(c.session.memory.play.currentTrack).toBe(0); // DEC is deferred: nothing yet
    vi.advanceTimersByTime(PANEL_HOLD_MS);
    release(c, 'trk4.fx', PANEL_HOLD_MS);
    expect(c.session.memory.play.currentTrack).toBe(1);
    press(c, 'trk4.fx', 3000);
    expect(c.session.memory.play.currentTrack).toBe(1);
    release(c, 'trk4.fx', 3050);
    expect(c.session.memory.play.currentTrack).toBe(0);
  });

  it('HALF SPEED (MOMENT) plays at half speed while the button is down', () => {
    const { c, engine } = setup();
    c.setParam('ctl.panelPlay.track.0', 'TRK1 HALF SPEED (MOMENT)');
    c.setParam('ctl.panelPlay.track.1', 'TRK2 DOUBLE SPEED (MOMENT)');
    engine.reset();
    press(c, 'trk1.track', 10);
    release(c, 'trk1.track', 20);
    press(c, 'trk2.track', 30);
    release(c, 'trk2.track', 40);
    expect(engine.sent).toEqual([
      { cmd: { t: 'speedMoment', track: 0, speed: 'HALF' }, eventTime: 10 },
      { cmd: { t: 'speedMoment', track: 0, speed: null }, eventTime: 20 },
      { cmd: { t: 'speedMoment', track: 1, speed: 'DOUBLE' }, eventTime: 30 },
      { cmd: { t: 'speedMoment', track: 1, speed: null }, eventTime: 40 },
    ]);
  });

  it('the MOMENT release goes to the function bound at press, even if undo mode changed meanwhile', () => {
    const { c, engine } = setup();
    c.setParam('ctl.panelPlay.track.0', 'TRK1 HALF SPEED (MOMENT)');
    engine.reset();
    press(c, 'trk1.track', 0);
    click(c, 'undoRedo', 5);
    release(c, 'trk1.track', 10);
    expect(engine.sent.map((s) => s.cmd)).toEqual([
      { t: 'speedMoment', track: 0, speed: 'HALF' },
      { t: 'speedMoment', track: 0, speed: null },
    ]);
  });

  it('HALF SPEED / DOUBLE SPEED toggle the track speed setting', () => {
    const { c } = setup();
    c.setParam('ctl.panelPlay.track.0', 'TRK1 HALF SPEED');
    c.setParam('ctl.panelPlay.fx.0', 'TRK1 DOUBLE SPEED');
    click(c, 'trk1.track');
    expect(c.session.memory.track[0]!.tempoSyncSpeed).toBe('HALF');
    click(c, 'trk1.fx');
    expect(c.session.memory.track[0]!.tempoSyncSpeed).toBe('DOUBLE');
    click(c, 'trk1.fx');
    expect(c.session.memory.track[0]!.tempoSyncSpeed).toBe('NORMAL');
  });

  it('CUR.TRK functions act on the current track; INC/DEC move it with wrap-around', () => {
    const { c, engine, lcd } = setup();
    c.setParam('play.currentTrack', 3);
    c.setParam('ctl.panelPlay.track.0', 'CUR.TRK CLEAR');
    c.setParam('ctl.panelPlay.track.1', 'CUR.TRK INC');
    c.setParam('ctl.panelPlay.track.2', 'CUR.TRK DEC');
    c.setParam('ctl.panelPlay.track.3', 'CUR.TRK TRACK EDIT');
    c.setParam('ctl.panelPlay.track.4', 'CUR.TRK TRACK FX');
    engine.reset();
    click(c, 'trk1.track');
    expect(engine.sent.map((s) => s.cmd)).toEqual([{ t: 'clear', track: 3 }]);
    click(c, 'trk2.track');
    expect(c.session.memory.play.currentTrack).toBe(4);
    click(c, 'trk2.track');
    expect(c.session.memory.play.currentTrack).toBe(0);
    click(c, 'trk3.track');
    expect(c.session.memory.play.currentTrack).toBe(4);
    click(c, 'trk4.track');
    expect(lcd.shows.at(-1)).toEqual({ screen: 'track', track: 4 });
    click(c, 'trk5.track');
    expect(c.session.memory.track[4]!.fx).toBe(false);
  });

  it('TEMPO UP doubles and TEMPO DOWN halves the tempo, clamped, keeping memory.tempo in step', () => {
    const { c, engine } = setup();
    c.setParam('ctl.panelPlay.track.0', 'TEMPO UP');
    c.setParam('ctl.panelPlay.track.1', 'TEMPO DOWN');
    engine.reset();
    click(c, 'trk1.track');
    expect(c.session.memory.tempo).toBe(240);
    expect(engine.last('tempo')).toEqual({ t: 'tempo', bpm: 240 });
    expect(engine.last('settings')!.memory.tempo).toBe(240);
    click(c, 'trk2.track');
    click(c, 'trk2.track');
    click(c, 'trk2.track');
    expect(c.session.memory.tempo).toBe(TEMPO_MIN); // 240 -> 120 -> 60 -> 30, clamped to 40
    expect(engine.last('tempo')).toEqual({ t: 'tempo', bpm: TEMPO_MIN });
  });

  it('MIC IN MUTE toggles the mic mute on press; MIC1 and MIC2 IN MUTE switch the same single mic (ruling R34)', () => {
    const { c, engine, lcd } = setup();
    c.setParam('ctl.panelPlay.track.0', 'MIC IN MUTE');
    c.setParam('ctl.panelPlay.track.1', 'MIC1 IN MUTE');
    c.setParam('ctl.panelPlay.fx.0', 'MIC2 IN MUTE');
    engine.reset();
    expect(c.micMuted).toBe(false);
    press(c, 'trk1.track', 100);
    expect(engine.sent).toEqual([{ cmd: { t: 'micMute', on: true }, eventTime: 100 }]);
    expect(c.micMuted).toBe(true);
    vi.advanceTimersByTime(PANEL_HOLD_MS * 3);
    release(c, 'trk1.track', 100 + PANEL_HOLD_MS * 3);
    click(c, 'trk2.track', 5000);
    expect(c.micMuted).toBe(false);
    click(c, 'trk1.fx', 6000);
    expect(c.micMuted).toBe(true);
    expect(engine.sent.map((s) => s.cmd)).toEqual([
      { t: 'micMute', on: true },
      { t: 'micMute', on: false },
      { t: 'micMute', on: true },
    ]);
    expect(lcd.shows).toEqual([]);
  });

  it('OFF, LED and the phase-2 FX switches do nothing yet', () => {
    const { c, engine, lcd } = setup();
    const fns = ['OFF', 'LED', 'INPUT FX ON/OFF', 'TRACK FX ON/OFF', 'OFF'];
    for (const [i, fn] of fns.entries()) c.setParam(`ctl.panelPlay.track.${i}`, fn);
    engine.reset();
    const before = JSON.stringify(c.session.memory);
    for (const n of [1, 2, 3, 4, 5] as const) click(c, `trk${n}.track`);
    vi.advanceTimersByTime(PANEL_HOLD_MS * 3);
    expect(engine.sent).toEqual([]);
    expect(lcd.shows).toEqual([]);
    expect(JSON.stringify(c.session.memory)).toBe(before);
  });
});

describe('TAP TEMPO', () => {
  it('taps set the tempo (memory.tempo and the tempo command) and show the TAP TEMPO screen', () => {
    const { c, engine, lcd } = setup();
    for (const t of [0, 400, 800, 1200]) click(c, 'tapTempo', t);
    expect(c.session.memory.tempo).toBe(150);
    expect(engine.last('tempo')).toEqual({ t: 'tempo', bpm: 150 });
    expect(engine.last('settings')!.memory.tempo).toBe(150);
    expect(lcd.shows.at(-1)).toEqual({ screen: 'tapTempo' });
  });

  it('a 1500 ms long-press reverts to the tempo saved in the memory', () => {
    const { c, engine } = setup();
    c.setParam('tempo', 97.3);
    expect(c.session.savedTempo).toBe(120);
    press(c, 'tapTempo', 0);
    vi.advanceTimersByTime(TAP_REVERT_MS - 1);
    expect(c.session.memory.tempo).toBe(97.3);
    vi.advanceTimersByTime(1);
    expect(c.session.memory.tempo).toBe(120);
    expect(engine.last('tempo')).toEqual({ t: 'tempo', bpm: 120 });
    release(c, 'tapTempo', TAP_REVERT_MS + 10);
  });
});

describe('EXIT / ENTER / EDIT act on release; chords', () => {
  it('ENTER pressed while EXIT is held fires the WRITE chord and neither single action', () => {
    const { c, lcd } = setup();
    press(c, 'exit', 0);
    press(c, 'enter', 30);
    expect(lcd.shows).toEqual([{ screen: 'write' }]);
    release(c, 'enter', 100);
    release(c, 'exit', 120);
    expect(lcd.events).toEqual([]);
  });

  it('EXIT pressed while ENTER is held is the same chord', () => {
    const { c, lcd } = setup();
    press(c, 'enter', 0);
    press(c, 'exit', 10);
    release(c, 'exit', 20);
    release(c, 'enter', 30);
    expect(lcd.shows).toEqual([{ screen: 'write' }]);
    expect(lcd.events).toEqual([]);
  });

  it('a lone ENTER reaches the LCD host as press + release, on release', () => {
    const { c, lcd } = setup();
    press(c, 'enter', 0);
    expect(lcd.events).toEqual([]);
    release(c, 'enter', 80);
    expect(lcd.log()).toEqual(['press:enter', 'release:enter']);
    expect(lcd.events[0]!.t).toBe(0);
    expect(lcd.events[1]!.t).toBe(80);
  });

  it('EDIT + A-D opens that effect; EDIT held 1000 ms is bank select; a lone EDIT reaches the host', () => {
    const { c, lcd } = setup();
    press(c, 'in.edit', 0);
    press(c, 'in.B', 10);
    release(c, 'in.B', 20);
    release(c, 'in.edit', 30);
    expect(lcd.shows).toEqual([{ screen: 'fxEdit', side: 'in', slot: 'B' }]);
    expect(lcd.events).toEqual([]);

    press(c, 'tr.edit', 100);
    vi.advanceTimersByTime(EDIT_HOLD_MS);
    expect(lcd.shows.at(-1)).toEqual({ screen: 'bankSelect', side: 'tr' });
    release(c, 'tr.edit', 100 + EDIT_HOLD_MS + 50);
    expect(lcd.events).toEqual([]);

    click(c, 'tr.edit', 5000);
    vi.advanceTimersByTime(EDIT_HOLD_MS * 2);
    expect(lcd.log()).toEqual(['press:tr.edit', 'release:tr.edit']);
    expect(lcd.shows).toHaveLength(2);
  });

  it('A-D on their own, and A-D after bank select, go to the LCD host', () => {
    const { c, lcd } = setup();
    click(c, 'tr.C', 0);
    press(c, 'in.edit', 100);
    vi.advanceTimersByTime(EDIT_HOLD_MS);
    click(c, 'in.A', 2000);
    expect(lcd.log()).toEqual(['press:tr.C', 'release:tr.C', 'press:in.A', 'release:in.A']);
  });

  it('EDIT of one side does not chord with A-D of the other side', () => {
    const { c, lcd } = setup();
    press(c, 'in.edit', 0);
    click(c, 'tr.A', 10);
    release(c, 'in.edit', 100);
    expect(lcd.shows).toEqual([]);
    expect(lcd.log()).toEqual(['press:tr.A', 'release:tr.A', 'press:in.edit', 'release:in.edit']);
  });
});

describe('knobs, faders and the rest', () => {
  it('turns reach the host with raw steps, held or not (each screen applies its own press-and-turn rule)', () => {
    const { c, lcd } = setup();
    const heldDuringTurn: boolean[] = [];
    lcd.onEvent = (e) => {
      lcd.events.push(e);
      if (e.kind === 'turn') heldDuringTurn.push(c.isHeld(e.id));
      return true;
    };
    turn(c, 'knob1', 2, 0);
    press(c, 'knob2', 10);
    turn(c, 'knob2', -1, 20);
    release(c, 'knob2', 30);
    expect(lcd.log()).toEqual(['turn:knob1:2', 'turn:knob2:-1']);
    expect(heldDuringTurn).toEqual([false, true]);
  });

  it('a knob push with no turn reaches the host on release; one turned while held is not a push', () => {
    const { c, lcd } = setup();
    click(c, 'knob3', 40);
    press(c, 'knob4', 100);
    turn(c, 'knob4', 3, 110);
    release(c, 'knob4', 120);
    expect(lcd.log()).toEqual(['press:knob3', 'release:knob3', 'turn:knob4:3']);
    expect(c.isHeld('knob3')).toBe(false);
  });

  it('a fader move sends its gain from faderGain()', () => {
    const { c, engine } = setup();
    set(c, 'trk2.fader', 0.5, 77);
    expect(engine.sent).toEqual([{ cmd: { t: 'fader', track: 1, gain: faderGain(0.5) }, eventTime: 77 }]);
    expect(c.faderGain(1)).toBe(faderGain(0.5));
    expect(c.faderGain(0)).toBe(1);
  });

  it('OUTPUT LEVEL sets MASTER OUT per OUTPUT KNOB (ALL/MASTER), PHONES OUT for PHONES, nothing for OFF', () => {
    const { c } = setup();
    const range = findParam('mixer.masterOut')!.def;
    set(c, 'outputLevel', 1);
    expect(c.session.system.mixer.masterOut).toBe(range.max);
    set(c, 'outputLevel', 0.5);
    expect(c.session.system.mixer.masterOut).toBe((range.min! + range.max!) / 2);
    c.setParam('output.knob', 'PHONES');
    set(c, 'outputLevel', 0);
    expect(c.session.system.mixer.phonesOut).toBe(range.min);
    expect(c.session.system.mixer.masterOut).toBe((range.min! + range.max!) / 2);
    c.setParam('output.knob', 'OFF');
    set(c, 'outputLevel', 1);
    expect(c.session.system.mixer.phonesOut).toBe(range.min);
  });

  it('MENU, LOOP, ◀ ▶, RHYTHM EDIT and the FX knobs go to the LCD host', () => {
    const { c, lcd, engine } = setup();
    click(c, 'menu');
    click(c, 'left');
    click(c, 'rhythmEdit');
    set(c, 'in.knob', 0.3);
    expect(lcd.log()).toEqual(['press:menu', 'release:menu', 'press:left', 'release:left', 'press:rhythmEdit', 'release:rhythmEdit', 'set:in.knob:0.3']);
    expect(engine.sent).toEqual([]);
  });

  it('isHeld tracks buttons that are down', () => {
    const { c } = setup();
    press(c, 'trk1.rec');
    expect(c.isHeld('trk1.rec')).toBe(true);
    release(c, 'trk1.rec');
    expect(c.isHeld('trk1.rec')).toBe(false);
  });
});
