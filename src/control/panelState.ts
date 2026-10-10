/**
 * Engine status + session -> the LEDs, rings and LCD of the panel (`PanelState`).
 *
 * One PanelState, with one LedState / RingState object per light, is built once and mutated on every update, so the
 * 60 fps render loop allocates nothing. Consumers (the panel view diffs it each frame) must read it straight away and
 * never keep a reference to it or to anything inside it across frames.
 *
 * REC/DUB/PLAY: red = recording, yellow = overdubbing, green = playing, unlit = stopped or empty. An armed action
 * (pending rec/dub/play) blinks fast in the colour it will take; a FADE/LOOP stop under way blinks green fast; AUTO REC
 * waiting for input blinks red fast. In undo mode: green when undo is available, red when redo is, else unlit.
 */

import type { MemorySettings, SystemSettings } from '../schema/types';
import { TRACKS } from '../shared/ids';
import type { ButtonId } from '../shared/ids';
import type { Blink, LedColor, LedState, PanelState, RingState } from '../shared/panel';
import type { EngineStatus, TrackState, TrackStatus } from '../shared/protocol';

const newLed = (): LedState => ({ color: 'off', blink: 'none' });
const newRing = (): RingState => ({ color: 'off', blink: 'none', mode: 'status', amount: 0 });

function setLed(led: LedState, color: LedColor, blink: Blink): void {
  led.color = color;
  led.blink = color === 'off' ? 'none' : blink;
}

function stateColor(state: TrackState): LedColor {
  switch (state) {
    case 'recording':
      return 'red';
    case 'overdubbing':
      return 'yellow';
    case 'playing':
      return 'green';
    default:
      return 'off';
  }
}

/** The REC/DUB/PLAY colour of a track outside undo mode, written into `out`. */
// deferred: LOOP STATUS COLOR (ruling R27). SETUP LOOP STATUS COLOR (REC/PLAY/DUB/STOP/BLANK) recolours these states;
// its CYAN and WHITE have no LedColor, so the fixed manual colours (its defaults) are used.
function trackLed(out: LedState, ts: TrackStatus | undefined): void {
  if (!ts) return setLed(out, 'off', 'none');
  if (ts.autoRecWaiting) return setLed(out, 'red', 'fast');
  if (ts.stopping) return setLed(out, 'green', 'fast');
  switch (ts.pending) {
    case 'rec':
      return setLed(out, 'red', 'fast');
    case 'dub':
      return setLed(out, 'yellow', 'fast');
    case 'play':
      return setLed(out, 'green', 'fast');
    case 'stop': // INFERRED: an armed STOP blinks the current colour until it fires
      return setLed(out, stateColor(ts.state), 'fast');
    default:
      return setLed(out, stateColor(ts.state), 'none');
  }
}

/** recording, overdubbing and playing all count as running for ALL START/STOP (INFERRED: the brief says "plays"). */
const running = (state: TrackState): boolean => state === 'playing' || state === 'overdubbing' || state === 'recording';

export class PanelStateBuilder {
  /** The one PanelState, updated in place. */
  readonly state: PanelState;
  private readonly rec: LedState[];
  private readonly track: LedState[];
  private readonly fx: LedState[];
  private readonly all = newLed();
  private readonly undo = newLed();
  private readonly rhythm = newLed();
  /** The non-undo REC colour of the track being built; reused for its ring. */
  private readonly scratch = newLed();

  constructor(lcd: Uint8Array) {
    const leds: Partial<Record<ButtonId, LedState>> = {};
    this.rec = TRACKS.map((k) => (leds[`trk${k + 1}.rec` as ButtonId] = newLed()));
    this.track = TRACKS.map((k) => (leds[`trk${k + 1}.track` as ButtonId] = newLed()));
    this.fx = TRACKS.map((k) => (leds[`trk${k + 1}.fx` as ButtonId] = newLed()));
    leds.allStartStop = this.all;
    leds.undoRedo = this.undo;
    leds.rhythmStartStop = this.rhythm;
    this.state = { leds, rings: [newRing(), newRing(), newRing(), newRing(), newRing()], lcd, contrast: 5, beatPhase: 0 };
  }

  update(status: EngineStatus | null, memory: MemorySettings, system: SystemSettings, undoMode: boolean, lcd: Uint8Array): PanelState {
    const s = this.state;
    const indicator = system.setup.indicator;
    const scratch = this.scratch;
    let anyRunning = false;

    for (let k = 0; k < TRACKS.length; k++) {
      const ts = status?.tracks[k];
      trackLed(scratch, ts);
      const rec = this.rec[k]!;
      if (undoMode) setLed(rec, ts?.canUndo ? 'green' : ts?.canRedo ? 'red' : 'off', 'none');
      else setLed(rec, scratch.color, scratch.blink);
      // INFERRED: the manual says the TRACK button is lit while the track holds a phrase, not in which colour.
      setLed(this.track[k]!, ts !== undefined && ts.state !== 'empty' ? 'red' : 'off', 'none');
      setLed(this.fx[k]!, memory.track[k]?.fx ? 'red' : 'off', 'none');
      if (ts !== undefined && running(ts.state)) anyRunning = true;

      // Rings follow SETUP INDICATOR and always show the track's status colour, also in undo mode.
      const ring = s.rings[k]!;
      ring.color = scratch.color;
      switch (indicator) {
        case 'STATUS':
          ring.mode = 'status';
          ring.blink = scratch.color !== 'off' && scratch.blink === 'none' ? 'tempo' : scratch.blink;
          ring.amount = 1;
          break;
        case 'LOOP POSITION':
          ring.mode = 'position';
          ring.blink = scratch.blink;
          ring.amount = ts?.position ?? 0;
          break;
        case 'LEVEL':
          ring.mode = 'level';
          ring.blink = scratch.blink;
          ring.amount = ts?.peak ?? 0;
          break;
      }
    }

    setLed(this.all, anyRunning ? 'green' : 'off', 'none');
    setLed(this.undo, undoMode ? 'red' : 'off', 'none');
    const rhythm = status?.rhythm ?? 'off';
    setLed(this.rhythm, rhythm === 'off' ? 'off' : 'green', rhythm === 'standby' ? 'slow' : 'none');

    s.lcd = lcd;
    s.contrast = system.setup.contrast;
    s.beatPhase = status?.beatPhase ?? 0;
    return s;
  }
}
