/**
 * Button semantics: turns panel `ControlEvent`s (touch, mouse and keyboard alike) into engine commands, settings changes
 * and LCD requests. Holds, long-presses and chords live here, with timers started on press and cancelled on release.
 *
 *  - trkN.rec: REC/DUB/PLAY (`recPlay`); in undo mode UNDO/REDO.
 *  - trkN.stop: `stop`, and `clear` once held CLEAR_HOLD_MS; in undo mode MARK BACK.
 *  - trkN.track / trkN.fx: the PANEL PLAY function of that button (MENU > CTL FUNC), in undo mode the PANEL UNDO one.
 *  - allStartStop, rhythmStartStop: their commands. undoRedo toggles undo mode.
 *  - tapTempo: tap tempo, and TEMPO REVERT (the memory's saved tempo) once held TAP_REVERT_MS.
 *  - exit / enter / in.edit / tr.edit act on release, so they can form chords: EXIT + ENTER = WRITE screen, EDIT + A-D =
 *    edit that effect. When the partner goes down while one is held the chord fires and neither single action runs.
 *    EDIT held EDIT_HOLD_MS = bank select.
 *  - Encoder pushes (knob1-4) also act on release, and only when the knob was not turned while held: turning a pushed
 *    knob is a press-and-turn, not a push. Turns reach the LCD host with their raw steps either way; each screen reads
 *    `ctx.isHeld(knob)` and applies its own press-and-turn rule (larger steps in general, 0.1 BPM decimals on the TAP
 *    TEMPO screen's knob [4], Owner's Manual p. 11; ruling R30).
 *  - trkN.fader: `fader` with `faderGain`. outputLevel: MASTER OUT (or PHONES OUT) per the OUTPUT KNOB setting.
 *  - Everything else (MENU, LOOP, ◀ ▶, RHYTHM EDIT, A-D, knob turns, the FX knobs) goes to the LCD host.
 *
 * What the LCD host receives for the release-acting buttons: a `press` (with the original press time) immediately
 * followed by the `release`, both at release time, and only when the press was a single action. A chord or long-press
 * reaches it as a `ScreenRequest` instead.
 */

import { faderGain } from '../dsp/mixer';
import { PANEL_FUNCTIONS, findParam } from '../schema/params';
import type { PanelFunction } from '../schema/params';
import { CLEAR_HOLD_MS } from '../shared/constants';
import { TRACKS } from '../shared/ids';
import type { AbsoluteId, ButtonId, ControlEvent, TrackIndex } from '../shared/ids';
import type { EngineCommand } from '../shared/protocol';
import type { Session } from './session';
import { TapTempo } from './tapTempo';

/** EDIT held this long enters FX bank-select mode. */
export const EDIT_HOLD_MS = 1000;
/** TAP TEMPO held this long returns to the memory's saved tempo (spec reading of manual pp. 5 and 11). */
export const TAP_REVERT_MS = 1500;
/** Hold time of the PANEL functions that have a HOLD action (MARK SET2, MARK BACK2, CUR.TRK INC/DEC). */
// INFERRED: the guide gives no time for HOLD; one second, like EDIT's long-press.
export const PANEL_HOLD_MS = 1000;

export type FxSide = 'in' | 'tr';
export type FxSlot = 'A' | 'B' | 'C' | 'D';

/** A screen the controller asks the LCD host to open. */
export type ScreenRequest =
  | { screen: 'write' }                                   // EXIT + ENTER: the WRITE/CLEAR screen
  | { screen: 'track'; track: TrackIndex }                // TRACK EDIT: the TRACK screen of that track
  | { screen: 'tapTempo' }                                // TAP TEMPO, TEMPO REVERT, TEMPO UP/DOWN: the tempo popup
  | { screen: 'fxEdit'; side: FxSide; slot: FxSlot }      // EDIT + A-D: the edit screen of that effect
  | { screen: 'bankSelect'; side: FxSide };               // EDIT held: FX bank select

/** What the button logic needs from the controller. */
export interface ButtonHost {
  readonly session: Session;
  send(cmd: EngineCommand, eventTime?: number): void;
  /** Validated settings change (memory or system), pushed to the engine. */
  setParam(id: string, value: unknown, track?: number): void;
  /** Offers an event to the LCD host; true when it used it. */
  lcdEvent(e: ControlEvent): boolean;
  lcdShow(req: ScreenRequest): void;
  /** MIC (MIC1 / MIC2) IN MUTE: flips the mic mute and sends `micMute`. */
  toggleMicMute(t: number): void;
}

// ---------------------------------------------------------------------------------------------------------------------
// PANEL PLAY / PANEL UNDO functions (Parameter Guide pp. 14-16)
// ---------------------------------------------------------------------------------------------------------------------

type Act = (h: ButtonHost, track: TrackIndex, t: number) => void;

/**
 * What one PANEL function does. `push` runs on press; `hold` runs once the button has been held PANEL_HOLD_MS, after
 * the push, and supersedes it (MARK SET2: the mark is set at the press, a hold then clears it; MARK BACK2: a hold then
 * restores the post-recording state). With `deferPush` the push waits instead: released before PANEL_HOLD_MS it runs
 * on release, held that long only `hold` runs. That is for CUR.TRK DEC, whose hold is INC, so a long press must not
 * run both. `release` runs on every release (the MOMENT speeds).
 */
export interface PanelAction {
  readonly fn: PanelFunction;
  readonly push?: Act;
  readonly hold?: Act;
  readonly deferPush?: true;
  readonly release?: Act;
}
type Template = Omit<PanelAction, 'fn'>;

const send = (make: (track: TrackIndex) => EngineCommand): Act => (h, k, t) => h.send(make(k), t);
const markBack = send((track) => ({ t: 'markBack', track }));
const recBack = send((track) => ({ t: 'recBack', track }));
const markSet = send((track) => ({ t: 'markSet', track }));
const markClear = send((track) => ({ t: 'markClear', track }));

const toggleTrack = (key: 'reverse' | 'fx'): Act => (h, k) => h.setParam(`track.*.${key}`, !h.session.memory.track[k]![key], k);

/** HALF / DOUBLE SPEED switch the track's speed to that value, or back to NORMAL when it already has it. */
// INFERRED: the guide says "sets the playback speed to 1/2"; pressing again returning to NORMAL is assumed.
const toggleSpeed = (speed: 'HALF' | 'DOUBLE'): Act => (h, k) =>
  h.setParam('track.*.tempoSyncSpeed', h.session.memory.track[k]!.tempoSyncSpeed === speed ? 'NORMAL' : speed, k);

const momentSpeed = (speed: 'HALF' | 'DOUBLE'): Template => ({
  push: (h, track, t) => h.send({ t: 'speedMoment', track, speed }, t),
  release: (h, track, t) => h.send({ t: 'speedMoment', track, speed: null }, t),
});

const trackEdit: Act = (h, track) => {
  h.setParam('play.currentTrack', track);
  h.lcdShow({ screen: 'track', track });
};

/** CUR.TRK INC / DEC: the current track moves 1 -> 2 -> ... -> 5 and wraps (wrap INFERRED). */
const stepCurrent = (d: 1 | -1): Act => (h) => {
  const n = TRACKS.length;
  h.setParam('play.currentTrack', (h.session.memory.play.currentTrack + d + n) % n);
};

const micMute: Act = (h, _track, t) => h.toggleMicMute(t);

/** TEMPO UP / DOWN double / halve the tempo; setParam clamps it to the range. Shows the tempo popup (INFERRED). */
const scaleTempo = (factor: number): Act => (h) => {
  h.setParam('tempo', h.session.memory.tempo * factor);
  h.lcdShow({ screen: 'tapTempo' });
};

/**
 * Behaviour per function name, without its 'TRKn ' / 'CUR.TRK ' prefix. Every PANEL_FUNCTIONS entry must resolve to a
 * key here (checked when the module loads). An empty template does nothing.
 */
const TEMPLATES: Readonly<Record<string, Template>> = {
  OFF: {},
  CLEAR: { push: send((track) => ({ t: 'clear', track })) },
  REVERSE: { push: toggleTrack('reverse') },
  'UNDO/REDO': { push: send((track) => ({ t: 'undoRedo', track })) },
  'MARK BACK1': { push: markBack },
  'MARK BACK2': { push: markBack, hold: recBack },
  'REC BACK': { push: recBack },
  'MARK SET1': { push: markSet },
  'MARK SET2': { push: markSet, hold: markClear },
  'MARK CLEAR': { push: markClear },
  'HALF SPEED': { push: toggleSpeed('HALF') },
  'HALF SPEED (MOMENT)': momentSpeed('HALF'),
  'DOUBLE SPEED': { push: toggleSpeed('DOUBLE') },
  'DOUBLE SPEED (MOMENT)': momentSpeed('DOUBLE'),
  'TRACK EDIT': { push: trackEdit },
  'TRACK FX': { push: toggleTrack('fx') },
  INC: { push: stepCurrent(1), hold: stepCurrent(1) },
  DEC: { push: stepCurrent(-1), hold: stepCurrent(1), deferPush: true },   // the guide: DEC holds to INC
  'TEMPO UP': { push: scaleTempo(2) },
  'TEMPO DOWN': { push: scaleTempo(0.5) },
  // TODO(phase 2): INPUT FX / TRACK FX section on/off arrive with the effects framework.
  'INPUT FX ON/OFF': {},
  'TRACK FX ON/OFF': {},
  // The app has one mic, MIC1; MIC2 maps to it too, so all three switch the same mute (ruling R34).
  'MIC IN MUTE': { push: micMute },
  'MIC1 IN MUTE': { push: micMute },
  'MIC2 IN MUTE': { push: micMute },
  // LED (TOGGLE COLOR) changes only the button's lit colour; nothing to do.
  LED: {},
};

function templateName(fn: PanelFunction): string {
  if (fn.track !== undefined) return fn.id.slice(`TRK${fn.track + 1} `.length);
  if (fn.current) return fn.id.slice('CUR.TRK '.length);
  return fn.id;
}

/** Every PANEL PLAY / PANEL UNDO function by its id (the stored LCD label, e.g. 'TRK2 MARK SET1'). */
export const PANEL_ACTIONS: ReadonlyMap<string, PanelAction> = new Map(
  PANEL_FUNCTIONS.map((fn) => {
    const template = TEMPLATES[templateName(fn)];
    if (!template) throw new Error(`no behaviour defined for PANEL function ${fn.id}`);
    return [fn.id, { fn, ...template }];
  }),
);
const OFF_ACTION = PANEL_ACTIONS.get('OFF')!;

// ---------------------------------------------------------------------------------------------------------------------
// Button ids
// ---------------------------------------------------------------------------------------------------------------------

type TrackPart = 'rec' | 'stop' | 'track' | 'fx';
const TRACK_BUTTONS = new Map<ButtonId, { track: TrackIndex; part: TrackPart }>();
const FADERS = new Map<AbsoluteId, TrackIndex>();
for (const track of TRACKS) {
  for (const part of ['rec', 'stop', 'track', 'fx'] as const) TRACK_BUTTONS.set(`trk${track + 1}.${part}` as ButtonId, { track, part });
  FADERS.set(`trk${track + 1}.fader` as AbsoluteId, track);
}
const FX_BUTTONS = new Map<ButtonId, { side: FxSide; slot: FxSlot }>();
for (const side of ['in', 'tr'] as const) {
  for (const slot of ['A', 'B', 'C', 'D'] as const) FX_BUTTONS.set(`${side}.${slot}`, { side, slot });
}
const KNOBS: ReadonlySet<ButtonId> = new Set(['knob1', 'knob2', 'knob3', 'knob4']);

const clamp01 = (v: number): number => (v > 0 ? (v < 1 ? v : 1) : 0);

/** A button that is down. */
interface Held {
  readonly t: number;
  /** A chord or long-press used this press: its release does nothing. */
  consumed: boolean;
  /** An encoder turned while pushed: not a push. */
  turned: boolean;
  timer?: ReturnType<typeof setTimeout>;
  /** TRACK / FX: the PANEL function bound at press time, and the track it acts on. */
  action?: PanelAction;
  track?: TrackIndex;
}

// ---------------------------------------------------------------------------------------------------------------------

export class ButtonRouter {
  private readonly held = new Map<ButtonId, Held>();
  private undo = false;
  private readonly tapTempo = new TapTempo();
  /** Fader positions 0..1; the panel draws them at the top (unity) until moved. */
  private readonly faders: number[] = TRACKS.map(() => 1);

  constructor(private readonly host: ButtonHost) {}

  /** UNDO/REDO is lit: REC/DUB/PLAY, STOP, TRACK and FX have their undo functions. */
  get undoMode(): boolean {
    return this.undo;
  }

  isHeld(id: ButtonId): boolean {
    return this.held.has(id);
  }

  faderPosition(track: number): number {
    return this.faders[track] ?? 1;
  }

  /** Starts a fresh tap series (a new memory was loaded). */
  resetTap(): void {
    this.tapTempo.reset();
  }

  handle(e: ControlEvent): void {
    switch (e.kind) {
      case 'press':
        this.press(e.id, e.t, e);
        return;
      case 'release':
        this.release(e.id, e.t, e);
        return;
      case 'turn': {
        const h = this.held.get(e.id);
        if (!h) {
          this.host.lcdEvent(e);
          return;
        }
        h.turned = true; // press-and-turn: the push will not fire on release
        this.host.lcdEvent(e);
        return;
      }
      case 'set':
        this.set(e.id, e.value, e.t, e);
        return;
    }
  }

  /** Cancels every pending hold. */
  dispose(): void {
    for (const h of this.held.values()) if (h.timer !== undefined) clearTimeout(h.timer);
    this.held.clear();
  }

  // -------------------------------------------------------------------------------------------------------------------

  private press(id: ButtonId, t: number, e: ControlEvent): void {
    if (this.held.has(id)) return; // a second press without a release in between
    const h: Held = { t, consumed: false, turned: false };
    this.held.set(id, h);
    const host = this.host;

    const tb = TRACK_BUTTONS.get(id);
    if (tb) {
      this.trackPress(id, h, tb.track, tb.part, t);
      return;
    }
    switch (id) {
      case 'allStartStop':
        host.send({ t: 'allStartStop' }, t);
        // PREFERENCE ALL CLEAR: a long-press clears all tracks. INFERRED: "long-press" taken as CLEAR_HOLD_MS.
        if (host.session.system.ctl.preference.allClear) this.hold(id, h, CLEAR_HOLD_MS, () => host.send({ t: 'clearAll' }, t + CLEAR_HOLD_MS));
        return;
      case 'undoRedo':
        this.undo = !this.undo;
        return;
      case 'tapTempo': {
        const bpm = this.tapTempo.tap(t);
        if (bpm !== null) host.setParam('tempo', bpm);
        host.lcdShow({ screen: 'tapTempo' });
        this.hold(id, h, TAP_REVERT_MS, () => {
          this.tapTempo.reset();
          host.setParam('tempo', host.session.savedTempo);
          host.lcdShow({ screen: 'tapTempo' });
        });
        return;
      }
      case 'rhythmStartStop':
        host.send({ t: 'rhythmStartStop' }, t);
        return;
      case 'exit':
      case 'enter': {
        const partner = this.held.get(id === 'exit' ? 'enter' : 'exit');
        if (partner && !partner.consumed) {
          partner.consumed = h.consumed = true;
          host.lcdShow({ screen: 'write' });
        }
        return; // otherwise it acts on release
      }
      case 'in.edit':
      case 'tr.edit': {
        const side: FxSide = id === 'in.edit' ? 'in' : 'tr';
        this.hold(id, h, EDIT_HOLD_MS, () => host.lcdShow({ screen: 'bankSelect', side }));
        return; // otherwise it acts on release
      }
    }
    if (KNOBS.has(id)) return; // a push acts on release

    const fx = FX_BUTTONS.get(id);
    if (fx) {
      const edit = this.held.get(fx.side === 'in' ? 'in.edit' : 'tr.edit');
      if (edit && !edit.consumed) {
        if (edit.timer !== undefined) clearTimeout(edit.timer);
        edit.timer = undefined;
        edit.consumed = h.consumed = true;
        host.lcdShow({ screen: 'fxEdit', side: fx.side, slot: fx.slot });
        return;
      }
    }
    host.lcdEvent(e);
  }

  private trackPress(id: ButtonId, h: Held, track: TrackIndex, part: TrackPart, t: number): void {
    const host = this.host;
    switch (part) {
      case 'rec':
        host.send(this.undo ? { t: 'undoRedo', track } : { t: 'recPlay', track }, t);
        return;
      case 'stop':
        if (this.undo) {
          host.send({ t: 'markBack', track }, t);
          return;
        }
        host.send({ t: 'stop', track }, t);
        this.hold(id, h, CLEAR_HOLD_MS, () => host.send({ t: 'clear', track }, t + CLEAR_HOLD_MS));
        return;
      case 'track':
      case 'fx': {
        // TODO(T21: PREFERENCE=MEMORY, ruling R26): with CTL FUNC PREFERENCE MODE PLAY / MODE UNDO = MEMORY the
        // functions come from the memory (memory.prefs.ctl); nothing writes those copies yet, so the system ones are used.
        const table = this.undo ? 'panelUndo' : 'panelPlay';
        const fnId = this.host.session.get(`ctl.${table}.${part}.${track}`) as string;
        const action = PANEL_ACTIONS.get(fnId) ?? OFF_ACTION;
        const target = (action.fn.track ?? host.session.memory.play.currentTrack) as TrackIndex;
        h.action = action;
        h.track = target;
        if (!action.deferPush) action.push?.(host, target, t);
        if (action.hold) {
          const hold = action.hold;
          this.hold(id, h, PANEL_HOLD_MS, () => hold(host, target, t + PANEL_HOLD_MS));
        }
        return;
      }
    }
  }

  private release(id: ButtonId, t: number, e: ControlEvent): void {
    const h = this.held.get(id);
    if (!h) return; // no press seen (e.g. the key went down before the page had focus)
    this.held.delete(id);
    if (h.timer !== undefined) clearTimeout(h.timer);
    const host = this.host;

    const action = h.action;
    if (action) {
      if (action.deferPush && !h.consumed) action.push?.(host, h.track!, t);
      action.release?.(host, h.track!, t);
      return;
    }
    if (TRACK_BUTTONS.has(id)) return;
    switch (id) {
      case 'allStartStop':
      case 'undoRedo':
      case 'tapTempo':
      case 'rhythmStartStop':
        return;
    }
    if (h.consumed) return;
    if (id === 'exit' || id === 'enter' || id === 'in.edit' || id === 'tr.edit' || (KNOBS.has(id) && !h.turned)) {
      host.lcdEvent({ kind: 'press', id, t: h.t });
      host.lcdEvent(e);
      return;
    }
    if (KNOBS.has(id)) return; // turned while held: a press-and-turn, not a push
    host.lcdEvent(e);
  }

  private set(id: AbsoluteId, value: number, t: number, e: ControlEvent): void {
    const track = FADERS.get(id);
    if (track !== undefined) {
      const pos = clamp01(value);
      this.faders[track] = pos;
      this.host.send({ t: 'fader', track, gain: faderGain(pos) }, t);
      return;
    }
    if (id === 'outputLevel') {
      // OUTPUT KNOB: ALL and MASTER drive MASTER OUT (the app has one output pair, INFERRED for ALL), PHONES the
      // PHONES OUT level, OFF nothing. The knob's travel spans the level's range, so 12 o'clock is the default 100.
      const knob = this.host.session.system.output.knob;
      if (knob === 'OFF') return;
      const param = knob === 'PHONES' ? 'mixer.phonesOut' : 'mixer.masterOut';
      const def = findParam(param)!.def;
      this.host.setParam(param, def.min! + clamp01(value) * (def.max! - def.min!));
      return;
    }
    this.host.lcdEvent(e);
  }

  /** Runs `fn` if `id` is still held after `ms`. Cancelled by the release. */
  private hold(id: ButtonId, h: Held, ms: number, fn: () => void): void {
    h.timer = setTimeout(() => {
      h.timer = undefined;
      if (this.held.get(id) !== h) return;
      h.consumed = true;
      fn();
    }, ms);
  }
}
