import { describe, expect, it } from 'vitest';
import {
  AbsoluteDrag,
  DETENT_PX,
  EncoderGesture,
  HOLD_MS,
  KNOB_DRAG_PX,
  TAP_MAX_MOVE_PX,
  createPressGate,
} from '../../src/ui/input/gestures';
import type { ControlEvent, EncoderId } from '../../src/shared/ids';

function rig() {
  const out: ControlEvent[] = [];
  return { out, emit: (e: ControlEvent): void => void out.push(e) };
}

const encoder = (id: EncoderId, t0: number, x0: number, y0: number) => {
  const r = rig();
  return { ...r, g: new EncoderGesture(id, r.emit, t0, x0, y0) };
};

const turned = (out: ControlEvent[]): number => out.reduce((n, e) => (e.kind === 'turn' ? n + e.steps : n), 0);

describe('constants', () => {
  it('match the brief', () => {
    expect(DETENT_PX).toBe(12);
    expect(TAP_MAX_MOVE_PX).toBe(10);
    expect(HOLD_MS).toBe(300);
    expect(KNOB_DRAG_PX).toBe(200);
  });
});

describe('EncoderGesture: tap', () => {
  it('a short, still touch is a press and a release of the knob', () => {
    const { g, out } = encoder('knob1', 1000, 50, 100);
    g.up(1120, 50, 101);
    expect(out).toEqual([
      { kind: 'press', id: 'knob1', t: 1000 },
      { kind: 'release', id: 'knob1', t: 1120 },
    ]);
  });

  it('nothing is emitted while the finger is still down', () => {
    const { g, out } = encoder('knob1', 0, 0, 0);
    g.move(50, 2, 2);
    g.move(100, 3, -4);
    expect(out).toEqual([]);
  });

  it('9 px of travel is still a tap; 10 px is a drag', () => {
    const tap = encoder('knob2', 0, 0, 100);
    tap.g.move(50, 0, 91);
    tap.g.up(100, 0, 91);
    expect(tap.out.map((e) => e.kind)).toEqual(['press', 'release']);

    const drag = encoder('knob2', 0, 0, 100);
    drag.g.move(50, 0, 90);
    drag.g.up(100, 0, 90);
    expect(drag.out).toEqual([]); // moved, but under one detent: no turn, and not a tap either
  });

  it('sideways travel counts toward the tap limit too', () => {
    const { g, out } = encoder('knob2', 0, 0, 100);
    g.move(50, 12, 100);
    g.up(100, 12, 100);
    expect(out).toEqual([]);
  });

  it('a still hold lifted after 300 ms (no timer fired) is still a press and a release', () => {
    const { g, out } = encoder('knob3', 0, 0, 0);
    g.up(900, 0, 0);
    expect(out).toEqual([
      { kind: 'press', id: 'knob3', t: 0 },
      { kind: 'release', id: 'knob3', t: 900 },
    ]);
  });
});

describe('EncoderGesture: turns', () => {
  it('a 36 px upward drag is turn +3 (one detent per 12 px, up is +)', () => {
    const { g, out } = encoder('knob2', 0, 10, 200);
    g.move(80, 10, 164);
    g.up(100, 10, 164);
    expect(out).toEqual([{ kind: 'turn', id: 'knob2', steps: 3, t: 80 }]);
  });

  it('a downward drag turns the other way', () => {
    const { g, out } = encoder('knob4', 0, 0, 100);
    g.move(60, 0, 124);
    expect(out).toEqual([{ kind: 'turn', id: 'knob4', steps: -2, t: 60 }]);
  });

  it('emits one detent at a time as a slow drag crosses them', () => {
    const { g, out } = encoder('knob1', 0, 0, 200);
    for (let i = 1; i <= 36; i++) g.move(i * 5, 0, 200 - i);
    expect(out.map((e) => (e.kind === 'turn' ? e.steps : 0))).toEqual([1, 1, 1]);
    expect(out.map((e) => e.t)).toEqual([60, 120, 180]);
  });

  it('keeps the sub-detent remainder and can reverse', () => {
    const { g, out } = encoder('knob1', 0, 0, 200);
    g.move(10, 0, 191); // 9 px: nothing
    g.move(20, 0, 185); // 15 px: +1, 3 px left over
    g.move(30, 0, 176); // 24 px: +1 more (12 + 12)
    g.move(40, 0, 188); // back 12 px: -1
    expect(out.map((e) => (e.kind === 'turn' ? e.steps : 0))).toEqual([1, 1, -1]);
  });

  it('a drag that starts inside 300 ms never presses, however long it goes on', () => {
    const { g, out } = encoder('knob1', 0, 0, 500);
    g.move(100, 0, 470);
    g.move(900, 0, 440);
    g.up(1000, 0, 440);
    expect(out.every((e) => e.kind === 'turn')).toBe(true);
    expect(turned(out)).toBe(5);
  });
});

describe('EncoderGesture: hold then drag', () => {
  it('hold 350 ms then drag = press, the turns, then release on lift', () => {
    const { g, out } = encoder('knob3', 100, 0, 300);
    g.move(450, 0, 264);
    g.up(700, 0, 264);
    expect(out).toEqual([
      { kind: 'press', id: 'knob3', t: 100 },
      { kind: 'turn', id: 'knob3', steps: 3, t: 450 },
      { kind: 'release', id: 'knob3', t: 700 },
    ]);
  });

  it('keeps turning while held and releases once', () => {
    const { g, out } = encoder('knob3', 0, 0, 300);
    g.move(320, 0, 288);
    g.move(400, 0, 252);
    g.up(500, 0, 252);
    expect(out.map((e) => e.kind)).toEqual(['press', 'turn', 'turn', 'release']);
    expect(turned(out)).toBe(4);
  });

  it('the hold timer presses while the finger is still, without waiting for a lift', () => {
    const { g, out } = encoder('knob2', 40, 0, 0);
    g.holdElapsed();
    expect(out).toEqual([{ kind: 'press', id: 'knob2', t: 40 }]);
    g.up(900, 0, 0);
    expect(out[1]).toEqual({ kind: 'release', id: 'knob2', t: 900 });
    expect(out).toHaveLength(2);
  });

  it('the hold timer does nothing once a drag has started', () => {
    const { g, out } = encoder('knob2', 0, 0, 100);
    g.move(100, 0, 60);
    g.holdElapsed();
    expect(out.map((e) => e.kind)).toEqual(['turn']);
  });

  it('presses only once however the hold is reported', () => {
    const { g, out } = encoder('knob2', 0, 0, 100);
    g.holdElapsed();
    g.holdElapsed();
    g.move(400, 0, 70);
    expect(out.filter((e) => e.kind === 'press')).toHaveLength(1);
  });
});

describe('EncoderGesture: cancel', () => {
  it('releases the knob if it was being pushed', () => {
    const { g, out } = encoder('knob1', 0, 0, 0);
    g.holdElapsed();
    g.cancel(600);
    expect(out).toEqual([
      { kind: 'press', id: 'knob1', t: 0 },
      { kind: 'release', id: 'knob1', t: 600 },
    ]);
  });

  it('emits nothing for a touch that was never a press', () => {
    const a = encoder('knob1', 0, 0, 0);
    a.g.cancel(50);
    expect(a.out).toEqual([]);
    const b = encoder('knob1', 0, 0, 100);
    b.g.move(50, 0, 60);
    b.g.cancel(80);
    expect(b.out.map((e) => e.kind)).toEqual(['turn']);
  });

  it('is final: later samples and a second cancel add nothing', () => {
    const { g, out } = encoder('knob1', 0, 0, 0);
    g.holdElapsed();
    g.cancel(400);
    g.move(500, 0, -60);
    g.up(600, 0, -60);
    g.cancel(700);
    expect(out.map((e) => e.kind)).toEqual(['press', 'release']);
  });

  it('a lift after the gesture ended adds nothing', () => {
    const { g, out } = encoder('knob1', 0, 0, 0);
    g.up(100, 0, 0);
    g.up(200, 0, 0);
    expect(out).toHaveLength(2);
  });
});

describe('AbsoluteDrag', () => {
  const drag = (start: number, y0: number, px: number) => {
    const r = rig();
    return { ...r, d: new AbsoluteDrag('in.knob', start, y0, px, r.emit) };
  };
  const values = (out: ControlEvent[]): number[] => out.map((e) => (e.kind === 'set' ? e.value : NaN));

  it('moves the value relative to where the drag started (up = more), 200 px per full range', () => {
    const { d, out } = drag(0.3, 500, KNOB_DRAG_PX);
    d.move(10, 400);
    d.move(20, 450);
    expect(values(out)).toEqual([0.8, 0.55]);
    expect(out[0]).toEqual({ kind: 'set', id: 'in.knob', value: 0.8, t: 10 });
  });

  it('does not jump on touch-down', () => {
    const { out } = drag(0.7, 500, KNOB_DRAG_PX);
    expect(out).toEqual([]);
  });

  it('clamps to 0..1 and stays quiet while pinned', () => {
    const { d, out } = drag(0.9, 500, 100);
    d.move(1, 450); // 1.4 -> 1
    d.move(2, 300); // still 1: no new event
    d.move(3, 700); // -1.1 -> 0
    d.move(4, 800); // still 0
    expect(values(out)).toEqual([1, 0]);
  });

  it('ignores a move that lands on the value already set', () => {
    const { d, out } = drag(0.5, 500, 200);
    d.move(1, 500);
    d.move(2, 500);
    expect(out).toEqual([]);
  });

  it('uses the given travel for faders', () => {
    const r = rig();
    const d = new AbsoluteDrag('trk2.fader', 0.2, 600, 160, r.emit);
    d.move(5, 520); // 80 px of 160 = +0.5
    expect(values(r.out)).toEqual([0.7]);
  });

  it('survives a bad start value or travel', () => {
    const a = rig();
    new AbsoluteDrag('outputLevel', Number.NaN, 0, 200, a.emit).move(1, -100);
    expect(values(a.out)).toEqual([0.5]);
    const b = rig();
    new AbsoluteDrag('outputLevel', 0.5, 0, 0, b.emit).move(1, -100);
    expect(values(b.out)).toEqual([1]);
  });
});

describe('createPressGate', () => {
  const press = (id: 'trk1.rec' | 'trk2.rec', t: number): ControlEvent => ({ kind: 'press', id, t });
  const release = (id: 'trk1.rec' | 'trk2.rec', t: number): ControlEvent => ({ kind: 'release', id, t });

  it('passes a single press and release straight through', () => {
    const { out, emit } = rig();
    const gate = createPressGate(emit);
    gate(press('trk1.rec', 1));
    gate(release('trk1.rec', 2));
    expect(out).toEqual([press('trk1.rec', 1), release('trk1.rec', 2)]);
  });

  it('holds a button down until every source has let go', () => {
    const { out, emit } = rig();
    const gate = createPressGate(emit);
    gate(press('trk1.rec', 1)); // finger A
    gate(press('trk1.rec', 2)); // finger B on the same pad: not a second press
    gate(release('trk1.rec', 3));
    expect(out).toEqual([press('trk1.rec', 1)]);
    gate(release('trk1.rec', 4));
    expect(out).toEqual([press('trk1.rec', 1), release('trk1.rec', 4)]);
  });

  it('tracks each button on its own', () => {
    const { out, emit } = rig();
    const gate = createPressGate(emit);
    gate(press('trk1.rec', 1));
    gate(press('trk2.rec', 2));
    gate(release('trk1.rec', 3));
    expect(out.map((e) => e.kind)).toEqual(['press', 'press', 'release']);
  });

  it('drops a release that has no press, and passes turns and sets through', () => {
    const { out, emit } = rig();
    const gate = createPressGate(emit);
    gate(release('trk1.rec', 1));
    gate({ kind: 'turn', id: 'knob1', steps: 2, t: 2 });
    gate({ kind: 'set', id: 'outputLevel', value: 0.4, t: 3 });
    expect(out).toEqual([
      { kind: 'turn', id: 'knob1', steps: 2, t: 2 },
      { kind: 'set', id: 'outputLevel', value: 0.4, t: 3 },
    ]);
  });
});
