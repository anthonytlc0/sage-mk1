import { describe, expect, it } from 'vitest';
import type { MixerScreen } from '../../src/lcd/screens/mixer';
import { expectScreen } from './fixtures';
import { frame, push, rig, status, turn, turnEv } from './rig';
import { blank, mixerColumn, mixerTitle } from './spec';
import type { Rig } from './rig';

const dB = (db: number): number => Math.pow(10, db / 20);
const mixer = (r: Rig): MixerScreen => r.menu.top as MixerScreen;

function open(r: Rig): void {
  push(r, 'enter');
  expect(r.menu.top.title).toBe('MIXER');
}

describe('MIXER (manual p. 8)', () => {
  it('page 1 holds MIC1 IN, MIC2 IN, INST1 IN and INST2 IN, with the live input level on MIC1', () => {
    const r = rig();
    status(r, { inputPeak: dB(-24) });
    open(r);
    expect(mixer(r).page).toBe(0);
    const want = blank();
    mixerTitle(want, false, true);
    mixerColumn(want, 0, 32, { value: '100', level: 100, lit: 5, hold: 5, labels: ['MIC1', 'IN'] });
    mixerColumn(want, 32, 32, { value: '100', level: 100, lit: 0, labels: ['MIC2', 'IN'] });
    mixerColumn(want, 64, 32, { value: '100', level: 100, lit: 0, labels: ['INST1', 'IN'] });
    mixerColumn(want, 96, 32, { value: '100', level: 100, lit: 0, labels: ['INST2', 'IN'] });
    expectScreen(frame(r.c), want.toAscii());
  });

  it('page 2 holds MAIN, SUB1, SUB2 and LOOP outs; page 3 holds RHYTHM, PHONES and MASTER (wider spacing)', () => {
    const r = rig();
    r.c.setParam('mixer.masterOut', 150);
    status(r, { outputPeak: 1 }, [{ peak: 1 }]);
    open(r);
    push(r, 'right');
    expect(mixer(r).page).toBe(1);
    let want = blank();
    mixerTitle(want, true, true);
    mixerColumn(want, 0, 32, { value: '100', level: 100, lit: 9, hold: 9, labels: ['MAIN', 'OUT'] });
    mixerColumn(want, 32, 32, { value: '100', level: 100, lit: 0, labels: ['SUB1', 'OUT'] });
    mixerColumn(want, 64, 32, { value: '100', level: 100, lit: 0, labels: ['SUB2', 'OUT'] });
    mixerColumn(want, 96, 32, { value: '100', level: 100, lit: 9, hold: 9, labels: ['LOOP', 'OUT'] });
    expectScreen(frame(r.c), want.toAscii());

    push(r, 'right');
    expect(mixer(r).page).toBe(2);
    want = blank();
    mixerTitle(want, true, false);
    mixerColumn(want, 0, 36, { value: '100', level: 100, lit: 0, labels: ['RHYTHM', 'OUT'] });
    mixerColumn(want, 36, 36, { value: '100', level: 100, lit: 9, hold: 9, labels: ['PHONES', 'OUT'] });
    mixerColumn(want, 72, 36, { value: '150', level: 150, lit: 9, hold: 9, labels: ['MASTER', 'OUT'] });
    expectScreen(frame(r.c), want.toAscii());
  });

  it('◀ ▶ switch pages and stop at the first and last', () => {
    const r = rig();
    open(r);
    expect(push(r, 'left')).toBe(true);
    expect(mixer(r).page).toBe(0);
    push(r, 'right');
    push(r, 'right');
    push(r, 'right');
    expect(mixer(r).page).toBe(2);
    expect(mixer(r).pageCount).toBe(3);
    push(r, 'left');
    expect(mixer(r).page).toBe(1);
  });

  it('turning a knob changes its level by the detents; a held knob turns x10; it stops at 0 and 200', () => {
    const r = rig();
    open(r);
    turn(r, 'knob2', 1);
    expect(r.c.session.system.mixer.mic2In).toBe(101);
    r.c.handle({ kind: 'press', id: 'knob2', t: 0 });
    r.menu.onEvent(turnEv('knob2', 1), r.c);
    expect(r.c.session.system.mixer.mic2In).toBe(111);
    r.menu.onEvent(turnEv('knob2', -50), r.c);
    expect(r.c.session.system.mixer.mic2In).toBe(0);
    r.c.handle({ kind: 'release', id: 'knob2', t: 0 });
    turn(r, 'knob2', 500);
    expect(r.c.session.system.mixer.mic2In).toBe(200);
  });

  it('a linked input (INST1 stereo link on) sets both its channels', () => {
    const r = rig();
    open(r);
    turn(r, 'knob3', -10);
    expect(r.c.session.system.mixer.inst1LIn).toBe(90);
    expect(r.c.session.system.mixer.inst1RIn).toBe(90);
    expect(r.c.session.system.mixer.inst2LIn).toBe(100);
  });

  it('pushing an input knob mutes it, and shows MUTE; pushing again unmutes', () => {
    const r = rig();
    open(r);
    push(r, 'knob2');
    expect(r.menu.muted.has('mic2In')).toBe(true);
    const want = blank();
    mixerTitle(want, false, true);
    mixerColumn(want, 0, 32, { value: '100', level: 100, lit: 0, labels: ['MIC1', 'IN'] });
    mixerColumn(want, 32, 32, { value: '100', level: 100, lit: 0, muted: true, labels: ['MIC2', 'IN'] });
    mixerColumn(want, 64, 32, { value: '100', level: 100, lit: 0, labels: ['INST1', 'IN'] });
    mixerColumn(want, 96, 32, { value: '100', level: 100, lit: 0, labels: ['INST2', 'IN'] });
    expectScreen(frame(r.c), want.toAscii());
    push(r, 'knob2');
    expect(r.menu.muted.has('mic2In')).toBe(false);
  });

  it('muting a linked input mutes both channels', () => {
    const r = rig();
    open(r);
    push(r, 'knob3');
    expect([...r.menu.muted].sort()).toEqual(['inst1LIn', 'inst1RIn']);
    push(r, 'knob3');
    expect(r.menu.muted.size).toBe(0);
  });

  it('pushing an output knob does nothing (only inputs mute)', () => {
    const r = rig();
    open(r);
    push(r, 'right');
    push(r, 'knob1');
    expect(r.menu.muted.size).toBe(0);
  });

  it('ENTER on the MIXER does nothing', () => {
    const r = rig();
    open(r);
    push(r, 'enter');
    expect(r.menu.top.title).toBe('MIXER');
    expect(r.menu.depth).toBe(2);
  });

  it('stereo link off splits the connectors into L and R columns', () => {
    const r = rig();
    r.c.setParam('input.stereoLink.INST1', false);
    open(r);
    const want = blank();
    mixerTitle(want, false, true);
    mixerColumn(want, 0, 32, { value: '100', level: 100, lit: 0, labels: ['MIC1', 'IN'] });
    mixerColumn(want, 32, 32, { value: '100', level: 100, lit: 0, labels: ['MIC2', 'IN'] });
    mixerColumn(want, 64, 32, { value: '100', level: 100, lit: 0, labels: ['INST1L', 'IN'] });
    mixerColumn(want, 96, 32, { value: '100', level: 100, lit: 0, labels: ['INST1R', 'IN'] });
    expectScreen(frame(r.c), want.toAscii());
    turn(r, 'knob4', 5);
    expect(r.c.session.system.mixer.inst1RIn).toBe(105);
    expect(r.c.session.system.mixer.inst1LIn).toBe(100);
    expect(mixer(r).pageCount).toBe(3); // 12 connectors: MIC1 MIC2 INST1L INST1R | INST2 MAIN SUB1 SUB2 | LOOP RHYTHM PHONES MASTER
  });

  it('stereo link on for MIC joins MIC 1 and 2 in one column', () => {
    const r = rig();
    r.c.setParam('input.stereoLink.MIC', true);
    open(r);
    turn(r, 'knob1', 2);
    expect(r.c.session.system.mixer.mic1In).toBe(102);
    expect(r.c.session.system.mixer.mic2In).toBe(102);
    const want = blank();
    mixerTitle(want, false, true);
    mixerColumn(want, 0, 32, { value: '102', level: 102, lit: 0, labels: ['MIC', 'IN'] });
    mixerColumn(want, 32, 32, { value: '100', level: 100, lit: 0, labels: ['INST1', 'IN'] });
    mixerColumn(want, 64, 32, { value: '100', level: 100, lit: 0, labels: ['INST2', 'IN'] });
    mixerColumn(want, 96, 32, { value: '100', level: 100, lit: 0, labels: ['MAIN', 'OUT'] });
    expectScreen(frame(r.c), want.toAscii());
  });

  it('the peak indicator holds and then falls (0.5 per second)', () => {
    const r = rig();
    status(r, { inputPeak: 1 });
    open(r);
    frame(r.c, 0);
    status(r, { inputPeak: 0 });
    const want = blank();
    mixerTitle(want, false, true);
    mixerColumn(want, 0, 32, { value: '100', level: 100, lit: 0, hold: 5, labels: ['MIC1', 'IN'] });
    mixerColumn(want, 32, 32, { value: '100', level: 100, lit: 0, labels: ['MIC2', 'IN'] });
    mixerColumn(want, 64, 32, { value: '100', level: 100, lit: 0, labels: ['INST1', 'IN'] });
    mixerColumn(want, 96, 32, { value: '100', level: 100, lit: 0, labels: ['INST2', 'IN'] });
    expectScreen(frame(r.c, 1000), want.toAscii());
  });

  it('draws without an engine status', () => {
    const r = rig();
    open(r);
    expect(() => frame(r.c)).not.toThrow();
    push(r, 'right');
    expect(() => frame(r.c)).not.toThrow();
  });

  it('opening the MIXER again starts on page 1', () => {
    const r = rig();
    open(r);
    push(r, 'right');
    push(r, 'exit');
    open(r);
    expect(mixer(r).page).toBe(0);
  });

  it('through the real controller: a push (no turn) mutes, a pushed knob turns x10', () => {
    const r = rig();
    open(r);
    r.c.handle({ kind: 'press', id: 'knob1', t: 0 });
    r.c.handle({ kind: 'release', id: 'knob1', t: 10 });
    expect(r.menu.muted.has('mic1In')).toBe(true);
    r.c.handle({ kind: 'press', id: 'knob1', t: 100 });
    r.c.handle({ kind: 'turn', id: 'knob1', steps: -1, t: 110 });
    r.c.handle({ kind: 'release', id: 'knob1', t: 120 });
    expect(r.c.session.system.mixer.mic1In).toBe(90);
    expect(r.menu.muted.has('mic1In')).toBe(true); // the press-and-turn was not a push
  });
});
