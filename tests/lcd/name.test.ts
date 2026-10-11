import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { text } from '../../src/lcd/draw';
import { FONT_SMALL } from '../../src/lcd/fonts';
import { NAME_CHARS, NameBuffer } from '../../src/lcd/screens/name';
import { registerEditScreens } from '../../src/lcd/screens/register';
import { NAME_LEN } from '../../src/shared/constants';
import { frame, push, rig, sameRegion, turn, turnEv } from './rig';
import type { Rig } from './rig';
import { blank } from './spec';

let unregister: () => void;
beforeEach(() => {
  vi.useFakeTimers();
  unregister = registerEditScreens();
});
afterEach(() => {
  unregister();
  vi.useRealTimers();
});

/** LOOP > page 2 > NAME, as a player gets there. */
function openName(r: Rig): void {
  push(r, 'loop');
  push(r, 'right');
  push(r, 'knob4');
}

const A = NAME_CHARS.indexOf('A');

describe('the character set', () => {
  it('is printable ASCII in code order, and the small LCD font has a glyph of its own for every one', () => {
    expect(NAME_CHARS[0]).toBe(' ');
    expect(NAME_CHARS.length).toBe(95);
    for (let i = 0; i < NAME_CHARS.length; i++) expect(NAME_CHARS.charCodeAt(i)).toBe(32 + i);
    // the medium font has no lower case or symbols (it would draw "a" as "A"), so the editor cells use the small one
    for (const ch of NAME_CHARS) if (ch !== ' ') expect(FONT_SMALL.glyphs.get(ch), `glyph ${ch}`).toBeDefined();
  });
});

describe('NameBuffer', () => {
  it('starts from a name, padded to 12 cells, the cursor on the first', () => {
    const b = new NameBuffer('ABC');
    expect(b.cells.length).toBe(NAME_LEN);
    expect(b.text).toBe('ABC');
    expect(b.cursor).toBe(0);
    expect(new NameBuffer('').text).toBe('');
    expect(new NameBuffer('A'.repeat(20)).text).toBe('A'.repeat(NAME_LEN));
  });

  it('turnChar steps through the set at the cursor and wraps', () => {
    const b = new NameBuffer('');
    b.turnChar(A); // from a blank cell
    expect(b.text).toBe('A');
    b.turnChar(1);
    expect(b.text).toBe('B');
    b.turnChar(-2);
    expect(b.text).toBe('@');
    b.turnChar(-(NAME_CHARS.indexOf('@')));
    expect(b.cells[0]).toBe(' '); // all the way down to the space
    b.turnChar(-1);
    expect(b.cells[0]).toBe('~'); // wraps to the last character
    b.turnChar(1);
    expect(b.cells[0]).toBe(' ');
  });

  it('moveCursor stops at the first and the last cell', () => {
    const b = new NameBuffer('');
    b.moveCursor(-3);
    expect(b.cursor).toBe(0);
    b.moveCursor(5);
    expect(b.cursor).toBe(5);
    b.moveCursor(100);
    expect(b.cursor).toBe(NAME_LEN - 1);
  });

  it('jump goes to the start of the next class: uppercase, lowercase, numbers, symbols', () => {
    const b = new NameBuffer('Q');
    b.jump(1);
    expect(b.cells[0]).toBe('a');
    b.jump(1);
    expect(b.cells[0]).toBe('0');
    b.jump(1);
    expect(b.cells[0]).toBe('!');
    b.jump(1);
    expect(b.cells[0]).toBe('A');
    b.jump(-1);
    expect(b.cells[0]).toBe('!');
    b.jump(-1);
    expect(b.cells[0]).toBe('0');
    b.jump(2); // two classes on
    expect(b.cells[0]).toBe('A');
    b.jump(-5); // and five back
    expect(b.cells[0]).toBe('!');
  });

  it('jump from a blank cell lands on a class start too', () => {
    const b = new NameBuffer('');
    b.jump(1);
    expect(b.cells[0]).toBe('A');
  });

  it('toggleCase swaps the case of a letter and leaves anything else', () => {
    const b = new NameBuffer('aB1');
    b.toggleCase();
    expect(b.text).toBe('AB1');
    b.moveCursor(1);
    b.toggleCase();
    expect(b.text).toBe('Ab1');
    b.moveCursor(1);
    b.toggleCase();
    expect(b.text).toBe('Ab1');
  });

  it('delete removes the cell at the cursor and closes the gap', () => {
    const b = new NameBuffer('ABCD');
    b.moveCursor(1);
    expect(b.delete()).toBe(true);
    expect(b.text).toBe('ACD');
    expect(b.cursor).toBe(1);
    b.moveCursor(10);
    b.delete();
    expect(b.text).toBe('ACD'); // a blank cell: nothing to delete (still fine)
  });

  it('insertSpace opens a gap at the cursor', () => {
    const b = new NameBuffer('ABCD');
    b.moveCursor(2);
    expect(b.insertSpace()).toBe(true);
    expect(b.text).toBe('AB CD');
  });

  it('insertSpace into a full name is ignored: a 13th character never exists', () => {
    const b = new NameBuffer('ABCDEFGHIJKL');
    expect(b.insertSpace()).toBe(false);
    expect(b.text).toBe('ABCDEFGHIJKL');
    b.moveCursor(100);
    expect(b.cursor).toBe(NAME_LEN - 1);
    b.turnChar(1);
    expect(b.text).toBe('ABCDEFGHIJKM');
    expect(b.text.length).toBe(NAME_LEN);
  });

  it('text drops trailing blanks but keeps the ones inside', () => {
    const b = new NameBuffer('A');
    b.moveCursor(3);
    b.turnChar(A);
    expect(b.text).toBe('A  A');
    b.delete();
    expect(b.text).toBe('A');
  });
});

describe('the NAME screen', () => {
  it('is reached from LOOP (page 2, knob [4])', () => {
    const r = rig();
    openName(r);
    expect(r.menu.top.title).toBe('NAME');
    expect(r.menu.depth).toBe(3);
    push(r, 'exit');
    expect(r.menu.top.title).toBe('LOOP');
  });

  it('knob [3] turns the character, knob [4] moves the cursor; the memory name follows at once', () => {
    const r = rig();
    openName(r);
    turn(r, 'knob3', A); // blank -> A
    expect(r.c.session.memory.name).toBe('A');
    turn(r, 'knob4', 1);
    turn(r, 'knob3', A + 1);
    expect(r.c.session.memory.name).toBe('AB');
    turn(r, 'knob4', -1);
    turn(r, 'knob3', 1);
    expect(r.c.session.memory.name).toBe('BB');
    expect(r.engine.last('settings')!.memory.name).toBe('BB');
    expect(r.c.session.dirty).toBe(true);
  });

  it('starts from the memory name', () => {
    const r = rig();
    r.c.setParam('name', 'Memory01');
    openName(r);
    turn(r, 'knob4', 6);
    turn(r, 'knob3', 1); // the "0" of "01" -> "1"
    expect(r.c.session.memory.name).toBe('Memory11');
  });

  it('knob [1] push deletes the character at the cursor', () => {
    const r = rig();
    r.c.setParam('name', 'ABCD');
    openName(r);
    turn(r, 'knob4', 1);
    push(r, 'knob1');
    expect(r.c.session.memory.name).toBe('ACD');
    push(r, 'knob1');
    push(r, 'knob1');
    push(r, 'knob1');
    expect(r.c.session.memory.name).toBe('A');
  });

  it('knob [1] turn jumps between the character classes', () => {
    const r = rig();
    openName(r);
    turn(r, 'knob1', 1);
    expect(r.c.session.memory.name).toBe('A');
    turn(r, 'knob1', 1);
    expect(r.c.session.memory.name).toBe('a');
    turn(r, 'knob1', 1);
    expect(r.c.session.memory.name).toBe('0');
    turn(r, 'knob1', 3); // a class a detent: numbers -> symbols -> uppercase -> lowercase
    expect(r.c.session.memory.name).toBe('a');
    turn(r, 'knob1', -2);
    expect(r.c.session.memory.name).toBe('!');
  });

  it('knob [2] turn toggles the case, knob [2] push inserts a space', () => {
    const r = rig();
    r.c.setParam('name', 'ab');
    openName(r);
    turn(r, 'knob2', 1);
    expect(r.c.session.memory.name).toBe('Ab');
    turn(r, 'knob2', -1);
    expect(r.c.session.memory.name).toBe('ab');
    turn(r, 'knob4', 1);
    push(r, 'knob2');
    expect(r.c.session.memory.name).toBe('a b');
  });

  it('the 13th character is ignored', () => {
    const r = rig();
    openName(r);
    for (let i = 0; i < 12; i++) {
      turn(r, 'knob3', A + (i % 26));
      turn(r, 'knob4', 1);
    }
    expect(r.c.session.memory.name).toBe('ABCDEFGHIJKL');
    turn(r, 'knob4', 5); // there is no cell 13 to move to
    push(r, 'knob2'); // nor room to insert a space
    expect(r.c.session.memory.name).toBe('ABCDEFGHIJKL');
    expect(r.c.session.memory.name.length).toBe(12);
    turn(r, 'knob3', 1); // the cursor sits on the 12th
    expect(r.c.session.memory.name).toBe('ABCDEFGHIJKM');
  });

  it('a pushed knob [3] turns by tens', () => {
    const r = rig();
    openName(r);
    r.c.handle({ kind: 'press', id: 'knob3', t: 0 });
    r.menu.onEvent(turnEv('knob3', 3), r.c);
    r.c.handle({ kind: 'release', id: 'knob3', t: 5 });
    expect(r.c.session.memory.name).toBe(NAME_CHARS[30]); // 3 detents x 10 from the blank
  });

  it('picks up a changed memory name (a new memory was loaded) instead of overwriting it', () => {
    const r = rig();
    r.c.setParam('name', 'ONE');
    openName(r);
    frame(r.c); // drawn once, so the editor has read "ONE"
    r.c.setParam('name', 'TWO'); // something else changes the name
    turn(r, 'knob4', 1);
    turn(r, 'knob3', 1);
    expect(r.c.session.memory.name).toBe('TXO');
  });

  it('draws the 12 cells with the cursor cell in inverse video', () => {
    const r = rig();
    r.c.setParam('name', 'Hi');
    openName(r);
    const f = frame(r.c);
    const want = blank();
    // the title bar
    text(want, 1, 0, 'NAME', FONT_SMALL);
    for (let x = 0; x < 128; x++) want.set(x, 8);
    expect(sameRegion(f, want, 0, 0, 128, 9)).toBe(true);
    // cell 0 is the cursor: a dark box with the H knocked out; cell 1 plain, in its own case
    expect(f.get(4, 24)).toBe(1);
    expect(f.get(14, 24)).toBe(0);
    const cell1 = blank();
    text(cell1, 14, 26, 'i', FONT_SMALL, { align: 'center', width: 10 });
    expect(sameRegion(f, cell1, 14, 24, 10, 11)).toBe(true);
    turn(r, 'knob4', 1);
    const g = frame(r.c);
    expect(g.get(14, 24)).toBe(1);
    expect(g.get(4, 24)).toBe(0);
  });

  it('EXIT leaves it', () => {
    const r = rig();
    openName(r);
    push(r, 'exit');
    push(r, 'exit');
    expect(r.menu.depth).toBe(1);
  });
});
