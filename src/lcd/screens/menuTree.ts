/**
 * The MENU (Owner's Manual pp. 17-18, Parameter Guide pp. 9-33): the system settings as a tree of screens.
 *
 *   MENU   [INPUT] [OUTPUT] [MIXER] [CTL FUNC] / [ASSIGN] [USB] [MIDI] [SETUP] / [FACTORY RESET on knob 4]
 *
 * A list of items shows one per knob [1]-[4]: push the knob to open it, ◀ ▶ for the next four, EXIT to go back
 * (manual p. 17). A leaf is a set of parameter pages (Task 19's `paramPage`, four parameters on the knobs, ◀ ▶ between
 * pages), the MIXER screen, or FACTORY RESET. Two leaves are entry points rather than values:
 *   - USB > STORAGE (knob [1]): turned or pushed it opens the memory-file screen (storage.ts), the app's stand-in for
 *     the hardware's USB drive mode; the stored value stays OFF.
 *   - SETUP > LATENCY (knob [1] of the last page): pushed, or ENTER on that page, it runs the calibration (latency.ts);
 *     turned it edits the stored value (AUTO = uncalibrated) by hand.
 *
 * `menuTree()` is the tree as data, so a test can walk it: every SYSTEM_PARAMS id but the hidden ones is reached
 * exactly once. Every page is built from concrete ids, so a value is written through `Controller.setParam` with its
 * full id, and the PREFERENCE = MEMORY groups land in the memory (prefs.ts).
 *
 * STEREO LINK does nothing in the app (spec: hardware-only), so the EQ and MIXER channels are always listed singly.
 */

import type { Controller, FactoryResetTarget } from '../../control/controller';
import { findParam } from '../../schema/params';
import type { ParamDef } from '../../schema/types';
import type { ControlEvent } from '../../shared/ids';
import type { Framebuffer } from '../framebuffer';
import { registerScreen } from '../menu';
import type { MenuSystem, Screen, ScreenResult } from '../menu';
import { MIXER_KEYS } from './mixer';
import { drawPageArrows, drawTitleBar, knobIndex } from './common';
import { formatLatency, latencyScreen } from './latency';
import { paramPage } from './paramPage';
import { drawRows, looperBusy } from './prompt';
import { storageScreen } from './storage';
import type { StorageDeps } from './storage';

// ---- the tree as data -----------------------------------------------------------------------------------------------

/** One parameter on a page: its concrete id, and the label / display to use instead of the schema's. */
export interface Cell {
  readonly id: string;
  readonly label?: string;
  readonly display?: (v: unknown) => string;
  /** The knob opens this screen instead of editing (see the file comment). */
  readonly opens?: 'storage' | 'latency';
}
/** One page of up to four cells. */
export interface PageSpec {
  readonly title?: string;
  readonly cells: readonly Cell[];
}
export type MenuNode =
  /** A list of items on the knobs; null leaves a knob empty. `label` is the name in the parent's list. */
  | { readonly kind: 'items'; readonly title: string; readonly label?: string; readonly items: readonly (MenuNode | null)[] }
  | { readonly kind: 'pages'; readonly title: string; readonly label?: string; readonly pages: readonly PageSpec[] }
  /** A screen of its own, with the parameters it edits. */
  | { readonly kind: 'screen'; readonly title: string; readonly label?: string; readonly screen: 'mixer' | 'factoryReset'; readonly params: readonly string[] };

const items = (title: string, list: readonly (MenuNode | null)[], label?: string): MenuNode => ({ kind: 'items', title, items: list, ...(label ? { label } : {}) });

const cell = (id: string, label?: string, extra: Omit<Cell, 'id' | 'label'> = {}): Cell => ({ id, ...(label ? { label } : {}), ...extra });

/** Pages of up to four cells; every group starts on a page of its own. */
function pages(title: string, groups: readonly (readonly Cell[])[], label?: string): MenuNode {
  const out: PageSpec[] = [];
  for (const group of groups) for (let i = 0; i < group.length; i += 4) out.push({ cells: group.slice(i, i + 4) });
  return { kind: 'pages', title, pages: out, ...(label ? { label } : {}) };
}

const TRACK_LABELS = ['TRK1', 'TRK2', 'TRK3', 'TRK4', 'TRK5'];
const IN_CHANNELS: readonly [string, string][] = [['MIC1', 'MIC1'], ['MIC2', 'MIC2'], ['INST1L', 'INST1 L'], ['INST1R', 'INST1 R'], ['INST2L', 'INST2 L'], ['INST2R', 'INST2 R']];
const OUT_CHANNELS: readonly [string, string][] = [['MAINL', 'MAIN L'], ['MAINR', 'MAIN R'], ['SUB1L', 'SUB1 L'], ['SUB1R', 'SUB1 R'], ['SUB2L', 'SUB2 L'], ['SUB2R', 'SUB2 R']];
const JACKS: readonly [string, string][] = [['MAINL', 'MAIN-L'], ['MAINR', 'MAIN-R'], ['SUB1L', 'SUB1-L'], ['SUB1R', 'SUB1-R'], ['SUB2L', 'SUB2-L'], ['SUB2R', 'SUB2-R'], ['PHONES', 'PHONES']];
const SOURCES: readonly [string, string][] = [...IN_CHANNELS, ['RHYTHM', 'RHYTHM']];
const DESTS = ['MAIN', 'SUB1', 'SUB2', 'PHONES'] as const;

/** The 12 EQ parameters of one channel, grouped LO/HI, LO MID, HI MID, LEVEL and the cuts. */
function eqPages(title: string, root: string, label: string): MenuNode {
  const c = (key: string): Cell => cell(`${root}.${key}`);
  return pages(title, [[c('sw'), c('loGain'), c('hiGain')], [c('loMidFreq'), c('loMidQ'), c('loMidGain')], [c('hiMidFreq'), c('hiMidQ'), c('hiMidGain')], [c('level'), c('loCut'), c('hiCut')]], label);
}

const input = (): MenuNode => items('INPUT', [
  pages('INPUT SETUP', [
    [cell('input.phantom.MIC1', 'PHANTOM MIC1'), cell('input.phantom.MIC2', 'PHANTOM MIC2'), cell('input.instGain.INST1'), cell('input.instGain.INST2')],
    [cell('input.stereoLink.MIC'), cell('input.stereoLink.INST1'), cell('input.stereoLink.INST2')],
    [cell('input.preference.MIC', 'PREF MIC'), cell('input.preference.INST1', 'PREF INST1'), cell('input.preference.INST2', 'PREF INST2')],
  ], 'SETUP'),
  items('INPUT EQ', IN_CHANNELS.map(([ch, name]) => eqPages(`INPUT EQ ${name}`, `input.eq.${ch}`, name)), 'EQ'),
  pages('DYNAMICS', [
    [cell('input.dynamics.mic1Comp'), cell('input.dynamics.mic1Ns'), cell('input.dynamics.mic2Comp'), cell('input.dynamics.mic2Ns')],
    [cell('input.dynamics.inst1Ns'), cell('input.dynamics.inst2Ns')],
  ]),
]);

const output = (): MenuNode => items('OUTPUT', [
  pages('OUTPUT SETUP', [
    [cell('output.knob'), cell('output.stereoLink.MAIN', 'STEREO LINK MAIN'), cell('output.stereoLink.SUB1', 'STEREO LINK SUB1'), cell('output.stereoLink.SUB2', 'STEREO LINK SUB2')],
    ['MAIN', 'SUB1', 'SUB2', 'PHONES', 'RHYTHM', 'MFX'].map((k) => cell(`output.preference.${k}`, `PREF ${k}`)),
  ], 'SETUP'),
  items('ROUTING', [
    items('ROUTING TRACK', JACKS.map(([jack, name]) => pages(`ROUTING ${name}`, [TRACK_LABELS.map((t, i) => cell(`output.routing.track.${jack}.${i}`, t))], name)), 'TRACK'),
    {
      kind: 'pages', title: 'ROUTING INPUT', label: 'INPUT/RHYTHM',
      pages: [
        ...DESTS.flatMap((dest) => {
          const cells = SOURCES.map(([src, name]) => cell(`output.routing.inputRhythm.${dest}.${src}`, name));
          return [{ title: `ROUTING ${dest}`, cells: cells.slice(0, 4) }, { title: `ROUTING ${dest}`, cells: cells.slice(4) }];
        }),
        { cells: [cell('output.routing.phonesRhythm'), cell('output.routing.rhythmOut'), cell('output.routing.inputThru')] },
      ],
    },
    pages('PHONES OUT', [[cell('output.routing.phonesOut', 'SW')]]),
    pages('PHONES MONITOR', [[cell('output.routing.phonesMonitor')]]),
  ]),
  items('OUTPUT EQ', OUT_CHANNELS.map(([ch, name]) => eqPages(`OUTPUT EQ ${name}`, `output.eq.${ch}`, name)), 'EQ'),
  pages('MASTER FX', [[cell('master.comp'), cell('master.reverb'), cell('master.insert')]]),
]);

function panelPages(title: string, table: 'panelPlay' | 'panelUndo'): MenuNode {
  return pages(title, [
    TRACK_LABELS.map((_t, i) => cell(`ctl.${table}.track.${i}`)),
    TRACK_LABELS.map((_t, i) => cell(`ctl.${table}.fx.${i}`)),
  ]);
}

const ctlFunc = (): MenuNode => items('CTL FUNC', [
  panelPages('PANEL PLAY', 'panelPlay'),
  panelPages('PANEL UNDO', 'panelUndo'),
  pages('CTL/EXP', [
    ['CTL1', 'CTL2', 'CTL3', 'CTL4'].map((k) => cell(`ctl.footswitch.${k}`, k)),
    [cell('ctl.exp.EXP1.func'), cell('ctl.exp.EXP1.min'), cell('ctl.exp.EXP1.max')],
    [cell('ctl.exp.EXP2.func'), cell('ctl.exp.EXP2.min'), cell('ctl.exp.EXP2.max')],
  ]),
  pages('PREFERENCE', [
    [cell('ctl.preference.modePlay'), cell('ctl.preference.modeUndo'), cell('ctl.preference.quickClear'), cell('ctl.preference.allClear')],
    [cell('ctl.preference.footswitch'), cell('ctl.preference.exp')],
  ]),
]);

const ASSIGN_KEYS = ['sw', 'source', 'sourceMode', 'sourceActLo', 'sourceActHi', 'target', 'targetMin', 'targetMax'];
const assign = (): MenuNode => items('ASSIGN', Array.from({ length: 16 }, (_, n) =>
  pages(`ASSIGN${n + 1}`, [ASSIGN_KEYS.slice(0, 5).map((k) => cell(`assign.${n}.${k}`)), ASSIGN_KEYS.slice(5).map((k) => cell(`assign.${n}.${k}`))])));

const usb = (): MenuNode => pages('USB', [[
  cell('usb.storage', undefined, { opens: 'storage' }), cell('usb.audioMode'), cell('usb.audioRouting'), cell('usb.inputLevel'), cell('usb.outputLevel'),
]]);

const midi = (): MenuNode => pages('MIDI', [[
  cell('midi.rxCh.ctl'), cell('midi.rxCh.rhythm'), cell('midi.rxCh.voice'), cell('midi.txCh'),
  cell('midi.sync.clock'), cell('midi.sync.out'), cell('midi.sync.start'), cell('midi.pcOut'), cell('midi.thru'),
]]);

const setup = (): MenuNode => pages('SETUP', [
  [
    cell('setup.contrast'), cell('setup.displayMode'), cell('setup.indicator'), cell('setup.fxKnobMode'),
    cell('setup.autoOff'), cell('setup.memoryExt.min'), cell('setup.memoryExt.max'),
    ...[0, 1, 2, 3].map((n) => cell(`setup.knobFunc.${n}`)),
    ...['rec', 'play', 'dub', 'stop', 'blank'].map((k) => cell(`setup.loopStatusColor.${k}`)),
  ],
  [cell('setup.latency', undefined, { opens: 'latency', display: formatLatency }), cell('setup.micProcess')],
]);

/** The MENU tree. A fresh object each call. */
export function menuTree(): MenuNode {
  return items('MENU', [
    input(), output(),
    { kind: 'screen', title: 'MIXER', screen: 'mixer', params: MIXER_KEYS.map((k) => `mixer.${k}`) },
    ctlFunc(), assign(), usb(), midi(), setup(),
    null, null, null,
    { kind: 'screen', title: 'FACTORY RESET', screen: 'factoryReset', params: [] },
  ]);
}

// ---- screens --------------------------------------------------------------------------------------------------------

export interface MenuDeps {
  /** File functions for USB > STORAGE (default: the browser's). */
  storage?: Partial<StorageDeps>;
}

interface Env {
  readonly menu: MenuSystem;
  readonly deps: MenuDeps;
}

function build(node: MenuNode, env: Env): Screen {
  switch (node.kind) {
    case 'items': return new ItemsScreen(node.title, node.items, env);
    case 'pages': return new PagesScreen(node.title, node.pages, env);
    case 'screen': return node.screen === 'mixer' ? env.menu.newMixer() : new FactoryResetScreen(env.menu);
  }
}

function open(kind: NonNullable<Cell['opens']>, env: Env): Screen {
  return kind === 'storage' ? storageScreen(env.deps.storage) : latencyScreen();
}

/** A list of items, four to a page on the knobs. */
class ItemsScreen implements Screen {
  private page = 0;
  /** The labels of each page, built once so drawing allocates nothing. */
  private readonly pageLabels: (string | null)[][] = [];

  constructor(readonly title: string, private readonly list: readonly (MenuNode | null)[], private readonly env: Env) {
    const labels = list.map((n) => (n ? n.label ?? n.title : null));
    for (let i = 0; i < labels.length; i += 4) this.pageLabels.push(labels.slice(i, i + 4));
  }

  private get pageCount(): number {
    return Math.max(1, Math.ceil(this.list.length / 4));
  }

  render(fb: Framebuffer): void {
    drawTitleBar(fb, this.title);
    drawPageArrows(fb, this.page > 0, this.page < this.pageCount - 1);
    drawRows(fb, this.pageLabels[this.page] ?? []);
  }

  onEvent(e: ControlEvent): ScreenResult {
    if (e.kind === 'turn') return 'handled';
    if (e.kind !== 'press') return 'unhandled';
    switch (e.id) {
      case 'exit':
        return 'pop';
      case 'left':
        this.page = Math.max(0, this.page - 1);
        return 'handled';
      case 'right':
        this.page = Math.min(this.pageCount - 1, this.page + 1);
        return 'handled';
    }
    const k = knobIndex(e.id);
    if (k < 0) return 'unhandled';
    const node = this.list[this.page * 4 + k];
    return node ? { push: build(node, this.env) } : 'handled';
  }
}

/** The schema definition of a cell: its concrete id, with the cell's label and display. */
function defOf(c: Cell): ParamDef {
  const hit = findParam(c.id);
  if (!hit) throw new Error(`menu: unknown parameter ${c.id}`);
  return { ...hit.def, id: c.id, label: c.label ?? hit.def.label, display: c.display ?? hit.def.display };
}

/** Parameter pages: one `paramPage` per page, ◀ ▶ between them. */
class PagesScreen implements Screen {
  private index = 0;
  private readonly screens: Screen[];

  constructor(readonly title: string, private readonly specs: readonly PageSpec[], private readonly env: Env) {
    this.screens = specs.map((p) => paramPage(p.title ?? title, p.cells.map(defOf)));
  }

  render(fb: Framebuffer, ctx: Controller): void {
    this.screens[this.index]!.render(fb, ctx);
    drawPageArrows(fb, this.index > 0, this.index < this.screens.length - 1);
  }

  onEvent(e: ControlEvent, ctx: Controller): ScreenResult {
    const cells = this.specs[this.index]!.cells;
    if (e.kind === 'press') {
      if (e.id === 'left' || e.id === 'right') {
        this.index = Math.min(this.screens.length - 1, Math.max(0, this.index + (e.id === 'left' ? -1 : 1)));
        return 'handled';
      }
      const opens = knobIndex(e.id) >= 0 ? cells[knobIndex(e.id)]?.opens : undefined;
      if (opens) return { push: open(opens, this.env) };
      if (e.id === 'enter' && cells.some((c) => c.opens === 'latency')) return { push: open('latency', this.env) };
    } else if (e.kind === 'turn') {
      if (cells[knobIndex(e.id)]?.opens === 'storage') return { push: open('storage', this.env) };
    }
    return this.screens[this.index]!.onEvent(e, ctx);
  }
}

const RESET_TARGETS: readonly FactoryResetTarget[] = ['MEMORY', 'SYSTEM', 'MEMORY+SYSTEM'];

/**
 * FACTORY RESET (Owner's Manual p. 24): turn a knob (or push [1]-[3]) to choose MEMORY, SYSTEM or MEMORY+SYSTEM,
 * ENTER to execute (EXECUTING...), then back to the play screen. EXIT cancels. Clearing the memories is refused with
 * STOP ALL while the looper runs (INFERRED: it would empty the tracks playing).
 */
class FactoryResetScreen implements Screen {
  readonly title = 'FACTORY RESET';
  selected = 0;
  private running = false;

  constructor(private readonly menu: MenuSystem) {}

  render(fb: Framebuffer): void {
    drawTitleBar(fb, this.title);
    drawRows(fb, RESET_TARGETS, this.selected);
  }

  onEvent(e: ControlEvent, ctx: Controller): ScreenResult {
    if (this.running) return e.kind === 'press' || e.kind === 'turn' ? 'handled' : 'unhandled';
    if (e.kind === 'turn') {
      this.selected = Math.min(RESET_TARGETS.length - 1, Math.max(0, this.selected + e.steps));
      return 'handled';
    }
    if (e.kind !== 'press') return 'unhandled';
    const k = knobIndex(e.id);
    if (k >= 0) {
      if (k < RESET_TARGETS.length) this.selected = k;
      return 'handled';
    }
    if (e.id === 'exit') return 'pop';
    if (e.id !== 'enter') return 'unhandled';
    const target = RESET_TARGETS[this.selected]!;
    if (target !== 'SYSTEM' && looperBusy(ctx)) {
      ctx.showMessage('STOP ALL');
      return 'handled';
    }
    this.running = true;
    ctx.showMessage('EXECUTING...', Infinity);
    ctx.factoryReset(target).then(
      () => {
        ctx.clearMessage();
        this.menu.showStartScreen();
      },
      (err: unknown) => {
        console.error('factory reset failed', err);
        this.running = false;
        ctx.clearMessage();
        ctx.showMessage('DATA WRITE ERR');
      },
    );
    return 'handled';
  }
}

/** The MENU screen (what the MENU button opens). */
export function menuScreen(menu: MenuSystem, deps: MenuDeps = {}): Screen {
  return build(menuTree(), { menu, deps });
}

/**
 * Plugs the MENU into the menu system (Task 21). The app calls this once at start-up; the returned function takes it
 * out again (tests use it to clean up).
 */
export function registerMenuScreens(deps: MenuDeps = {}): () => void {
  return registerScreen('menu', (_req, _ctx, menu) => menuScreen(menu, deps));
}
