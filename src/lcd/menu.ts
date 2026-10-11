/**
 * The menu engine: a stack of screens drawn on the 128x64 LCD, the `LcdHost` the controller talks to.
 *
 *  - The bottom of the stack is the play screen (seven variants, ◀ ▶ cycle them). ENTER opens the MIXER, TAP TEMPO opens
 *    the tempo screen, and the controller's chords and long-presses reach `show`.
 *  - A screen gets every event first; `unhandled` falls through to the global rules (EXIT goes back, MENU / LOOP /
 *    RHYTHM EDIT open their screens from the play screen). Screens act on `press` (the controller delivers a push of
 *    EXIT, ENTER or a knob as a press and a release together) and on `turn`, which carries the raw detents: a screen
 *    asks `ctx.isHeld(knob)` for press-and-turn (see `turnSteps`).
 *  - Screens that later tasks build (WRITE and TRACK: Task 20; MENU, LOOP, RHYTHM and the FX screens: Tasks 20/21 and
 *    phase 2) register themselves with `registerScreen`; until then a placeholder (the title and "--") is pushed.
 *  - The timed message overlay is drawn over whatever is on top. Its timing belongs to `Controller.showMessage`.
 */

import type { Controller, LcdHost, ScreenRequest } from '../control/controller';
import type { ControlEvent } from '../shared/ids';
import { hline, text } from './draw';
import { FONT_MEDIUM, FONT_SMALL } from './fonts';
import type { Framebuffer } from './framebuffer';
import type { KnobTarget } from './knobFunc';
import { PLAIN } from './screens/common';
import { drawMessage } from './screens/message';
import { MixerScreen } from './screens/mixer';
import { PlayScreen } from './screens/play';
import { TapTempoScreen } from './screens/tap';

export { turnSteps } from './screens/common';
export { MEMORY_DEBOUNCE_MS } from './screens/play';

export type ScreenResult = 'handled' | 'pop' | { push: Screen } | 'unhandled';

export interface Screen {
  readonly title: string;
  render(fb: Framebuffer, ctx: Controller): void;
  onEvent(e: ControlEvent, ctx: Controller): ScreenResult;
  /** Called when the screen leaves the stack (cancel timers here). */
  dispose?(): void;
}

// ---- effects (phase 2 plugs the real banks in) ----------------------------------------------------------------------

export interface FxSlotView {
  readonly name: string;
  readonly on: boolean;
}
/** One effect bank as the INPUT FX / TRACK FX play screens show it: its letter and the four slots A-D. */
export interface FxBankView {
  readonly bank: 'A' | 'B' | 'C' | 'D';
  readonly slots: readonly FxSlotView[];
}
export type FxSource = (side: 'in' | 'tr', ctx: Controller) => FxBankView;

export interface MenuOptions {
  /** The effect banks to show (phase 2). Default: bank A with four empty, off slots. */
  fx?: FxSource;
  /** Called when a mixer input is muted or unmuted (the engine's `InputChain.setMute` can be wired here). */
  onMute?: (key: string, muted: boolean) => void;
}

// ---- the registry of screens other tasks build ----------------------------------------------------------------------

export type ScreenKind = 'write' | 'track' | 'loop' | 'menu' | 'rhythmEdit' | 'fxEdit' | 'bankSelect';
type PlainKind = 'loop' | 'menu' | 'rhythmEdit';
/** What a factory is given: the controller's request, or `{ screen }` for the screens a button opens. */
export type ScreenArgs<K extends ScreenKind> = K extends PlainKind ? { screen: K } : Extract<ScreenRequest, { screen: K }>;
export type ScreenFactory<K extends ScreenKind> = (req: ScreenArgs<K>, ctx: Controller, menu: MenuSystem) => Screen;

const registry = new Map<ScreenKind, ScreenFactory<never>>();

/**
 * Plugs in the real screen for `kind`. Returns a function that takes it out again (tests use it to clean up). A later
 * registration for the same kind replaces the earlier one.
 */
export function registerScreen<K extends ScreenKind>(kind: K, factory: ScreenFactory<K>): () => void {
  const f = factory as unknown as ScreenFactory<never>;
  registry.set(kind, f);
  return () => {
    if (registry.get(kind) === f) registry.delete(kind);
  };
}

const FX_NAMES = { in: 'INPUT FX', tr: 'TRACK FX' } as const;

function placeholderTitle(req: ScreenRequest | { screen: PlainKind }): string {
  switch (req.screen) {
    case 'write': return 'WRITE';
    case 'track': return `TRACK${req.track + 1}`;
    case 'fxEdit': return `${FX_NAMES[req.side]} ${req.slot}`;
    case 'bankSelect': return `${FX_NAMES[req.side]} BANK`;
    case 'menu': return 'MENU';
    case 'loop': return 'LOOP';
    case 'rhythmEdit': return 'RHYTHM';
    case 'tapTempo': return 'TAP TEMPO';
  }
}

/** The stand-in for a screen a later task has not built yet: the title, an underline and "--". EXIT goes back. */
class Placeholder implements Screen {
  constructor(readonly title: string) {}
  render(fb: Framebuffer): void {
    text(fb, 1, 0, this.title, FONT_SMALL, PLAIN);
    hline(fb, 0, 8, 128);
    text(fb, 0, 26, '--', FONT_MEDIUM, DASH_OPTS);
  }
  onEvent(e: ControlEvent): ScreenResult {
    return e.kind === 'press' && e.id === 'exit' ? 'pop' : 'unhandled';
  }
}
const DASH_OPTS = { align: 'center', width: 128 } as const;

// ---- the menu system ------------------------------------------------------------------------------------------------

export class MenuSystem implements LcdHost, KnobTarget {
  /** The knob lock (manual p. 8): its icon shows and the knobs do nothing on a play screen. Nothing sets it yet. */
  knobLock = false;
  readonly fx: FxSource;

  private readonly stack: Screen[];
  private readonly kinds = new WeakMap<Screen, ScreenKind>();
  private readonly muteSet = new Set<string>();
  private readonly play: PlayScreen;
  private readonly tap: TapTempoScreen;

  constructor(private readonly opts: MenuOptions = {}) {
    this.fx = opts.fx ?? DEFAULT_FX;
    this.play = new PlayScreen(this);
    this.tap = new TapTempoScreen(this);
    this.stack = [this.play];
  }

  get top(): Screen {
    return this.stack[this.stack.length - 1]!;
  }
  get depth(): number {
    return this.stack.length;
  }
  /** The mixer inputs that are muted, by MIXER parameter key (`mic1In`). */
  get muted(): ReadonlySet<string> {
    return this.muteSet;
  }

  push(screen: Screen): void {
    this.stack.push(screen);
  }

  /** Leaves the top screen. The play screen at the bottom stays. */
  pop(): void {
    if (this.stack.length > 1) this.stack.pop()!.dispose?.();
  }

  /** Takes `screen` out of the stack wherever it is (a timed screen closing under another one). */
  remove(screen: Screen): void {
    const i = this.stack.indexOf(screen);
    if (i > 0) {
      this.stack.splice(i, 1);
      screen.dispose?.();
    }
  }

  /** Back to the play screen the SETUP DISPLAY MODE names (power-on, after the settings are loaded). */
  showStartScreen(): void {
    while (this.stack.length > 1) this.pop();
    this.play.reset();
  }

  /** Cancels every timer (the app is shutting down). */
  dispose(): void {
    for (const s of this.stack) s.dispose?.();
  }

  // ---- mute ---------------------------------------------------------------------------------------------------------

  isMuted(keys: readonly string[]): boolean {
    for (const k of keys) if (!this.muteSet.has(k)) return false;
    return keys.length > 0;
  }

  setMuted(keys: readonly string[], on: boolean): void {
    for (const k of keys) {
      if (this.muteSet.has(k) === on) continue;
      if (on) this.muteSet.add(k);
      else this.muteSet.delete(k);
      this.opts.onMute?.(k, on);
    }
  }

  toggleMute(keys: readonly string[]): void {
    this.setMuted(keys, !this.isMuted(keys));
  }

  /** KNOB FUNC DISPLAY MODE: the next / previous play screen. Returns its name. */
  cyclePlay(steps: number): string {
    return this.play.cycle(steps);
  }

  /** A fresh MIXER, on page 1. */
  newMixer(): Screen {
    return new MixerScreen(this);
  }

  // ---- LcdHost ------------------------------------------------------------------------------------------------------

  onEvent(e: ControlEvent, ctx: Controller): boolean {
    this.play.sync(ctx);
    const result = this.top.onEvent(e, ctx);
    if (result === 'unhandled') return this.fallback(e, ctx);
    this.apply(result);
    return true;
  }

  render(fb: Framebuffer, ctx: Controller): void {
    this.play.sync(ctx);
    this.top.render(fb, ctx);
    if (ctx.message !== null) drawMessage(fb, ctx.message);
  }

  show(req: ScreenRequest, ctx: Controller): void {
    this.play.sync(ctx);
    if (req.screen === 'tapTempo') {
      if (this.top !== this.tap) {
        this.remove(this.tap);
        this.push(this.tap);
      }
      this.tap.open();
      return;
    }
    this.open(req.screen, req, ctx);
  }

  // ---- internals ----------------------------------------------------------------------------------------------------

  private apply(result: Exclude<ScreenResult, 'unhandled'>): void {
    if (result === 'pop') this.pop();
    else if (result !== 'handled') this.push(result.push);
  }

  /** What no screen wanted: EXIT goes back; MENU, LOOP and RHYTHM EDIT open their screens from the play screen. */
  private fallback(e: ControlEvent, ctx: Controller): boolean {
    if (e.kind !== 'press') return false;
    if (e.id === 'exit') {
      if (this.stack.length === 1) return false;
      this.pop();
      return true;
    }
    if (this.stack.length === 1 && (e.id === 'menu' || e.id === 'loop' || e.id === 'rhythmEdit')) {
      this.open(e.id, { screen: e.id }, ctx);
      return true;
    }
    return false;
  }

  /** Opens the screen for `kind`: the registered one or a placeholder. One of the same kind on top is replaced. */
  private open<K extends ScreenKind>(kind: K, req: ScreenArgs<K>, ctx: Controller): void {
    const factory = registry.get(kind) as ScreenFactory<K> | undefined;
    const screen = factory ? factory(req, ctx, this) : new Placeholder(placeholderTitle(req as ScreenRequest));
    this.kinds.set(screen, kind);
    if (this.stack.length > 1 && this.kinds.get(this.top) === kind) {
      this.stack.pop()!.dispose?.();
    }
    this.push(screen);
  }
}

const EMPTY_SLOT: FxSlotView = { name: '---', on: false };
const EMPTY_BANK: FxBankView = { bank: 'A', slots: [EMPTY_SLOT, EMPTY_SLOT, EMPTY_SLOT, EMPTY_SLOT] };
const DEFAULT_FX: FxSource = () => EMPTY_BANK;
