/**
 * The NAME screen (Parameter Guide p. 8): the memory's name, 12 characters, edited in place.
 *
 *   knob [4] turn: moves the cursor           knob [3] turn: selects the character at the cursor
 *   knob [1] turn: jumps to the beginning of uppercase / lowercase / numbers / symbols;  push: deletes the character
 *   knob [2] turn: toggles upper / lower case;                                           push: inserts a space
 *
 * The characters are printable ASCII in code order (INFERRED: the guide does not list them); the knob [3] turn wraps
 * at both ends. The name is written through the controller at every change, so the play screen and the engine settings
 * follow, and the memory counts as edited.
 */

import type { Controller } from '../../control/controller';
import type { ControlEvent } from '../../shared/ids';
import { NAME_LEN } from '../../shared/constants';
import { fillRect, hline, text } from '../draw';
import { FONT_SMALL } from '../fonts';
import type { Framebuffer } from '../framebuffer';
import type { Screen, ScreenResult } from '../menu';
import { drawLabelLines, drawTitleBar, turnSteps } from './common';

/** The characters knob [3] steps through: space to ~. */
export const NAME_CHARS: string = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join('');

/** Where knob [1] lands: uppercase, lowercase, numbers, symbols. // INFERRED: the class order and the symbol start ("!"). */
const CLASS_STARTS: readonly string[] = ['A', 'a', '0', '!'];

function classOf(ch: string): number {
  if (ch >= 'A' && ch <= 'Z') return 0;
  if (ch >= 'a' && ch <= 'z') return 1;
  if (ch >= '0' && ch <= '9') return 2;
  return 3;
}

/** The 12 cells of a name and the cursor: the editing rules, apart from the screen. */
export class NameBuffer {
  readonly cells: string[];
  cursor = 0;

  constructor(name: string) {
    this.cells = Array.from({ length: NAME_LEN }, (_, i) => name[i] ?? ' ');
  }

  /** The name: the cells without the blanks at the end. */
  get text(): string {
    return this.cells.join('').trimEnd();
  }

  moveCursor(steps: number): void {
    this.cursor = Math.min(NAME_LEN - 1, Math.max(0, this.cursor + steps));
  }

  /** Steps the character at the cursor along NAME_CHARS, wrapping at both ends. */
  turnChar(steps: number): void {
    const n = NAME_CHARS.length;
    const at = Math.max(0, NAME_CHARS.indexOf(this.cells[this.cursor]!));
    this.cells[this.cursor] = NAME_CHARS[(((at + steps) % n) + n) % n]!;
  }

  /** Jumps `steps` classes on (or back): the beginning of uppercase, lowercase, numbers or symbols. */
  jump(steps: number): void {
    const n = CLASS_STARTS.length;
    const cls = classOf(this.cells[this.cursor]!);
    this.cells[this.cursor] = CLASS_STARTS[(((cls + steps) % n) + n) % n]!;
  }

  toggleCase(): void {
    const ch = this.cells[this.cursor]!;
    const swapped = ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase();
    this.cells[this.cursor] = swapped;
  }

  /** Removes the cell at the cursor and closes the gap. Returns whether the name changed. */
  delete(): boolean {
    const before = this.text;
    this.cells.splice(this.cursor, 1);
    this.cells.push(' ');
    return this.text !== before;
  }

  /** Opens a blank at the cursor. A full name has no room for it: ignored (a 13th character never exists). */
  insertSpace(): boolean {
    if (this.cells[NAME_LEN - 1] !== ' ') return false;
    this.cells.splice(this.cursor, 0, ' ');
    this.cells.pop();
    return true;
  }
}

// ---- the screen -----------------------------------------------------------------------------------------------------

// The cells use the small font: the medium one has no lower case or symbols, which a name needs (it would show "a" as "A").
const CELL_X = 4;
const CELL_W = 10;
const BOX_Y = 24;
const BOX_H = 11;
const CELL_Y = 26;
const CELL = { align: 'center', width: CELL_W } as const;
const CURSOR = { align: 'center', width: CELL_W, invert: true } as const;

const LABELS: readonly (readonly string[])[] = [['JUMP', 'DELETE'], ['CASE', 'SPACE'], ['CHAR'], ['CURSOR']];

class NameScreen implements Screen {
  readonly title = 'NAME';
  private buf: NameBuffer | null = null;
  /** The name this editor last wrote (or read); a different one in the memory means it was replaced under us. */
  private known = '';

  /** The buffer, read from the memory name the first time and again when something else changed the name. */
  private sync(ctx: Controller): NameBuffer {
    const name = ctx.session.memory.name;
    if (this.buf === null || name !== this.known) {
      const cursor = this.buf?.cursor ?? 0;
      this.buf = new NameBuffer(name);
      this.buf.cursor = cursor;
      this.known = name;
    }
    return this.buf;
  }

  private store(ctx: Controller, buf: NameBuffer): void {
    ctx.setParam('name', buf.text);
    this.known = ctx.session.memory.name;
  }

  render(fb: Framebuffer, ctx: Controller): void {
    const buf = this.sync(ctx);
    drawTitleBar(fb, 'NAME');
    for (let i = 0; i < NAME_LEN; i++) {
      const x = CELL_X + CELL_W * i;
      if (i === buf.cursor) {
        fillRect(fb, x, BOX_Y, CELL_W, BOX_H); // a box taller than the glyph; the glyph is knocked out of it
        text(fb, x, CELL_Y, buf.cells[i]!, FONT_SMALL, CURSOR);
      } else {
        text(fb, x, CELL_Y, buf.cells[i]!, FONT_SMALL, CELL);
      }
      hline(fb, x + 1, BOX_Y + BOX_H + 1, CELL_W - 2);
    }
    for (let i = 0; i < 4; i++) drawLabelLines(fb, i, LABELS[i]!);
  }

  onEvent(e: ControlEvent, ctx: Controller): ScreenResult {
    const buf = this.sync(ctx);
    if (e.kind === 'turn') {
      switch (e.id) {
        case 'knob1': buf.jump(e.steps); break;
        case 'knob2': buf.toggleCase(); break;
        case 'knob3': buf.turnChar(turnSteps(e, ctx)); break;
        case 'knob4': buf.moveCursor(turnSteps(e, ctx)); break;
      }
      this.store(ctx, buf);
      return 'handled';
    }
    if (e.kind !== 'press') return 'unhandled';
    switch (e.id) {
      case 'exit':
        return 'pop';
      case 'knob1':
        buf.delete();
        this.store(ctx, buf);
        return 'handled';
      case 'knob2':
        buf.insertSpace();
        this.store(ctx, buf);
        return 'handled';
      case 'knob3': case 'knob4':
        return 'handled';
    }
    return 'unhandled';
  }
}

export function nameScreen(): Screen {
  return new NameScreen();
}
