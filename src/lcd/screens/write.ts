/**
 * The WRITE / CLEAR screen (Owner's Manual p. 12), opened by EXIT + ENTER.
 *
 *   1. The choice: knobs [1] or [2] = WRITE, knobs [3] or [4] = CLEAR.
 *   2. Any of the knobs [1]-[4] turns the memory number (it starts on the current one) inside SETUP MEMORY EXT MIN..MAX,
 *      wrapping at the ends as the memory knob does; its name shows beside it. EXIT cancels.
 *   3. ENTER runs it: "EXECUTING..." stays up until the controller is done.
 *
 * STOP ALL (manual p. 23) when a track is recording, playing or overdubbing: for WRITE, and for CLEAR of the current
 * memory, which also empties the engine's tracks. (A rhythm that plays or waits does not block WRITE: it saves a
 * "rhythm: on" memory, Parameter Guide p. 6.) The controller decides the rest: over the current memory is always allowed,
 * over another one that holds audio it answers NOT EMPTY (clear it first), and MEMORY FULL when storage refuses; all
 * three are shown as a message and the screen stays for another try. A save the controller aborts because the memory
 * changed meanwhile shows WRITE ABORTED, any other failure DATA WRITE ERR (manual p. 23).
 *
 * The names of the memories are asked of the controller once, when the screen opens. The current memory shows the name
 * it has now (what WRITE would save), any other the name it was saved under, blank when empty or not yet known.
 *
 * The controller's promises are never awaited by the screen: the result is picked up with `then`, and a screen that
 * has left the stack by then (`dispose` ran) is not touched. Its message still shows, the popup is still taken down.
 */

import type { Controller } from '../../control/controller';
import type { ControlEvent } from '../../shared/ids';
import { hline, rect, text, vline } from '../draw';
import { FONT_MEDIUM, FONT_SMALL } from '../fonts';
import type { Framebuffer } from '../framebuffer';
import type { MenuSystem, Screen, ScreenResult } from '../menu';
import { PLAIN, drawTitleBar, knobIndex, turnSteps } from './common';
import { looperRunning } from './looperState';

export const MSG_EXECUTING = 'EXECUTING...';
export const MSG_STOP_ALL = 'STOP ALL';
export const MSG_ABORTED = 'WRITE ABORTED';
export const MSG_WRITE_ERR = 'DATA WRITE ERR';

const SLOTS: readonly string[] = Array.from({ length: 100 }, (_, i) => String(i).padStart(2, '0'));
/** The names before they have arrived (and when they cannot be read). */
const NO_NAMES: readonly string[] = [];

/**
 * Controllers with a write or clear in flight. Only one runs at a time, even when its screen was torn down and a new one
 * opened while it waited (the result of the old one still arrives).
 */
const running = new WeakSet<Controller>();

type Mode = 'choose' | 'write' | 'clear';
type Outcome = 'ok' | 'NOT EMPTY' | 'MEMORY FULL';

const HALF = { align: 'center', width: 64 } as const;
const ENTER_HINT = { align: 'right', width: 127 } as const;
const NUMBER_TAG = { invert: true, width: 17, align: 'center' } as const;

const HINTS = { write: 'WRITE: ENTER', clear: 'CLEAR: ENTER' } as const;
const NAMES = { write: 'WRITE', clear: 'CLEAR' } as const;

// ---- pictures: a page with a pencil, and an eraser ------------------------------------------------------------------

function writeIcon(fb: Framebuffer, x: number, y: number): void {
  rect(fb, x, y + 1, 11, 14);
  hline(fb, x + 2, y + 5, 6);
  hline(fb, x + 2, y + 8, 6);
  hline(fb, x + 2, y + 11, 4);
  for (let k = 0; k < 8; k++) {
    fb.set(x + 15 - k, y + k);
    fb.set(x + 14 - k, y + k);
  }
  fb.set(x + 7, y + 8);
  fb.set(x + 6, y + 9);
}

function clearIcon(fb: Framebuffer, x: number, y: number): void {
  // a slanted block: two parallel edges, joined at the ends, the lower part solid
  for (let k = 0; k < 8; k++) {
    fb.set(x + 2 + k, y + 10 - k);
    fb.set(x + 6 + k, y + 14 - k);
  }
  vline(fb, x + 2, y + 10, 5);
  hline(fb, x + 2, y + 14, 5);
  for (let k = 0; k < 4; k++) hline(fb, x + 3 + k, y + 10 + k, 4 - k);
  hline(fb, x, y + 15, 16);
}

// ---- the screen -----------------------------------------------------------------------------------------------------

class WriteScreen implements Screen {
  readonly title = 'WRITE';
  private mode: Mode = 'choose';
  private slot = 0;
  /** A write or clear is running: the screen takes no input. */
  private busy = false;
  /** Cleared by `dispose`: the screen has left the stack. */
  private alive = true;
  /** The names of the 99 memories (index = slot - 1), once they have arrived. */
  private names: readonly string[] = NO_NAMES;

  constructor(private readonly menu: Pick<MenuSystem, 'remove'>, ctx: Controller) {
    ctx.memoryNames().then(
      (names) => {
        if (this.alive) this.names = names;
      },
      (err: unknown) => console.error('reading the memory names failed', err),
    );
  }

  dispose(): void {
    this.alive = false;
  }

  render(fb: Framebuffer, ctx: Controller): void {
    drawTitleBar(fb, 'WRITE');
    if (this.mode === 'choose') {
      writeIcon(fb, 24, 20);
      clearIcon(fb, 88, 20);
      text(fb, 0, 57, 'WRITE', FONT_SMALL, HALF);
      text(fb, 64, 57, 'CLEAR', FONT_SMALL, HALF);
      return;
    }
    const mode = this.mode;
    text(fb, 0, 11, HINTS[mode], FONT_SMALL, ENTER_HINT);
    if (mode === 'write') writeIcon(fb, 2, 11);
    else clearIcon(fb, 2, 11);
    text(fb, 1, 28, NAMES[mode], FONT_SMALL, PLAIN);
    // the memory: its number in a box, then its name (the current memory's is the one it has now)
    text(fb, 1, 44, SLOTS[this.slot] ?? '--', FONT_MEDIUM, NUMBER_TAG);
    text(fb, 20, 44, this.slot === ctx.session.slot ? ctx.session.memory.name : (this.names[this.slot - 1] ?? ''), FONT_MEDIUM, PLAIN);
  }

  onEvent(e: ControlEvent, ctx: Controller): ScreenResult {
    if (e.kind === 'turn') {
      if (!this.busy && this.mode !== 'choose') {
        // inside SETUP MEMORY EXT MIN..MAX, wrapping at the ends (the same rule as the play screen's memory knob)
        const { min, max } = ctx.session.system.setup.memoryExt;
        const lo = Math.min(min, max), hi = Math.max(min, max);
        const n = hi - lo + 1;
        this.slot = lo + ((((this.slot - lo + turnSteps(e, ctx)) % n) + n) % n);
      }
      return 'handled';
    }
    if (e.kind !== 'press') return 'unhandled';
    if (this.busy) return 'handled'; // EXIT does not abandon a save in progress
    switch (e.id) {
      case 'exit':
        return 'pop';
      case 'knob1': case 'knob2': case 'knob3': case 'knob4':
        if (this.mode === 'choose') {
          this.mode = knobIndex(e.id) < 2 ? 'write' : 'clear';
          this.slot = ctx.session.slot;
        }
        return 'handled';
      case 'enter':
        if (this.mode !== 'choose') this.run(ctx, this.mode);
        return 'handled';
      case 'left': case 'right':
        return 'handled';
    }
    return 'unhandled';
  }

  private run(ctx: Controller, mode: 'write' | 'clear'): void {
    // Controller.clear of the current memory empties the engine's tracks, so it waits for the tracks to stop, like WRITE
    if (looperRunning(ctx) && (mode === 'write' || this.slot === ctx.session.slot)) {
      ctx.showMessage(MSG_STOP_ALL);
      return;
    }
    if (running.has(ctx)) return; // the popup of the one in flight is still up
    running.add(ctx);
    const slot = this.slot;
    this.busy = true;
    ctx.showMessage(MSG_EXECUTING, Infinity);
    const job: Promise<Outcome> = mode === 'write' ? ctx.write(slot) : ctx.clear(slot).then(() => 'ok');
    job.then(
      (outcome) => this.finish(ctx, outcome === 'ok' ? null : outcome, outcome === 'ok'),
      (err: unknown) => {
        if (err instanceof Error && err.message.startsWith('WRITE aborted')) this.finish(ctx, MSG_ABORTED, false);
        else {
          console.error(`${mode} failed`, err);
          this.finish(ctx, MSG_WRITE_ERR, false);
        }
      },
    ).catch((err: unknown) => console.error('finishing the write screen failed', err)); // a throw in `finish` must not go unhandled
  }

  /** The job is over: take the popup down, say what went wrong, and leave the screen when it went right. */
  private finish(ctx: Controller, message: string | null, close: boolean): void {
    running.delete(ctx);
    if (ctx.message === MSG_EXECUTING) ctx.clearMessage(); // unless something else has replaced it meanwhile
    if (message !== null) ctx.showMessage(message);
    if (!this.alive) return; // the screen left the stack while the controller worked: nothing to update
    this.busy = false;
    if (close) this.menu.remove(this);
  }
}

/** The WRITE / CLEAR screen. `menu` closes it when the job is done; `ctx` is asked for the memory names at once. */
export function writeScreen(menu: Pick<MenuSystem, 'remove'>, ctx: Controller): Screen {
  return new WriteScreen(menu, ctx);
}
