/**
 * The controller: the main-thread brain of Sage MK1.
 *
 *  - `handle` is the single entry for panel input (touch, mouse and keyboard all arrive as ControlEvents); buttons.ts
 *    turns them into timed engine commands, settings changes and LCD requests.
 *  - It owns the session: the current memory and the system settings. Every change goes through `setParam`, which
 *    validates through the schema and pushes `settings` to the engine; system settings are also saved to their store.
 *  - It loads, writes and clears memories, checkpoints unsaved work for crash recovery, and turns the latest engine
 *    status into `PanelState` (LEDs, rings, the LCD framebuffer drawn by the menu system).
 */

import { faderGain } from '../dsp/mixer';
import { Framebuffer } from '../lcd/framebuffer';
import { defaultMemory, defaultSystem } from '../schema/params';
import type { FACTORY_RESET_TARGETS } from '../schema/params';
import type { MemorySettings, SystemSettings } from '../schema/types';
import { TRACKS } from '../shared/ids';
import type { ButtonId, ControlEvent } from '../shared/ids';
import { STATUS_HZ } from '../shared/constants';
import type { PanelState } from '../shared/panel';
import type { EngineCommand, EngineEvent, EngineStatus, TrackAudio } from '../shared/protocol';
import { QuotaError } from '../storage/db';
import { FileTooLarge, defaultMaxDecodedBytes } from '../storage/memoryFile';
import type { BackupContents, MemoryContents } from '../storage/memoryFile';
import { SLOT_COUNT } from '../storage/memoryStore';
import type { MemoryStore } from '../storage/memoryStore';
import type { Recovery } from '../storage/recovery';
import type { SystemStore } from '../storage/systemStore';
import { ButtonRouter } from './buttons';
import type { ButtonHost, ScreenRequest } from './buttons';
import { PanelStateBuilder } from './panelState';
import { Session } from './session';

export type { ScreenRequest, FxSide, FxSlot } from './buttons';

/** The engine as the controller sees it (EngineHost in the app, FakeEngine in tests). */
export interface EngineLike {
  send(cmd: EngineCommand, eventTime?: number): void;
  on(h: (e: EngineEvent) => void): () => void;
}

/**
 * The menu system (Task 19). The controller offers it every event it does not handle itself (`onEvent`; return true
 * when used), asks it to open screens for chords, long-presses and panel functions (`show`), and has it draw the LCD
 * once per frame (`render`, into a cleared framebuffer). `ctx.message` holds the current popup text for it to overlay.
 */
export interface LcdHost {
  onEvent(e: ControlEvent, ctx: Controller): boolean;
  render(fb: Framebuffer, ctx: Controller): void;
  show(req: ScreenRequest, ctx: Controller): void;
}

/** The storage the controller uses: the parts of the Task 12 stores it calls (the real stores satisfy this). */
export interface Stores {
  memories: Pick<MemoryStore, 'load' | 'save' | 'clear' | 'hasAudio' | 'list'>;
  system: Pick<SystemStore, 'load' | 'save'>;
  recovery: Pick<Recovery, 'checkpoint' | 'discard' | 'markCleanShutdown'>;
}

export interface ControllerOptions {
  /** Where `pagehide` is listened for; defaults to `window` when there is one. */
  events?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  /**
   * Reopens the mic with the current SETUP MIC PROCESS (the app passes `() => host.restartMic()`). Called after the
   * new settings have gone to the engine whenever MIC PROCESS changes.
   */
  restartMic?: () => Promise<void>;
}

/** What FACTORY RESET returns to the factory state (Owner's Manual p. 24). */
export type FactoryResetTarget = (typeof FACTORY_RESET_TARGETS)[number];

/** How long a popup message stays up by default. */
// INFERRED: the manual gives no time; the plan's NO INPUT case uses 2 s.
export const MESSAGE_MS = 2000;
/** The recovery checkpoint is written this long after the last change to the audio. */
export const CHECKPOINT_DEBOUNCE_MS = 2000;
/** System settings are saved this long after the last change (knob turns come in bursts). */
export const SYSTEM_SAVE_DEBOUNCE_MS = 500;
/** `exportTracks` gives up when the engine has not answered by then. */
export const EXPORT_TIMEOUT_MS = 20000;
/** `calibrate` gives up when the engine has not answered by then (the measurement itself takes 4.5 s). */
export const CALIBRATE_TIMEOUT_MS = 10000;
/**
 * Statuses (about half a second) after which tempos sent but never echoed are taken as overtaken by the engine (it
 * changed the tempo right after applying them), so its own tempo can be adopted. Real echoes take a few statuses.
 */
export const TEMPO_SETTLE_STATUSES = Math.round(STATUS_HZ / 2);

const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;

/**
 * Tells tempo changes the engine made by itself (a first free recording defines the tempo) from echoes of tempos the
 * controller sent, which reach the status late and in order. Every sent tempo is queued until a status shows it; a
 * status still showing the value from before the next queued send is stale and ignored. Only a status that matches no
 * outstanding send, seen while nothing is outstanding, is an engine change.
 */
class TempoEcho {
  /** Tempos sent and not yet seen in a status, oldest first; no two neighbours equal. */
  private readonly queue: number[] = [];
  /** The tempo the engine is known to hold (the last one seen or acknowledged); null before the first status. */
  private known: number | null = null;
  /** Statuses since the queue last moved. */
  private waited = 0;

  /** A tempo went to the engine (in `settings` or a `tempo` command). */
  sent(bpm: number): void {
    const last = this.queue.length > 0 ? this.queue[this.queue.length - 1]! : this.known;
    if (last !== null && near(last, bpm)) return; // nothing changes for the engine's tempo
    if (this.queue.length === 0) this.waited = 0;
    this.queue.push(bpm);
  }

  /** A status showed `bpm`. Returns the tempo to adopt when the engine changed it by itself, else null. */
  seen(bpm: number): number | null {
    if (this.queue.length === 0) {
      const changed = this.known !== null && !near(this.known, bpm);
      this.known = bpm;
      return changed ? bpm : null;
    }
    if (this.known !== null && near(this.known, bpm)) return this.wait(bpm); // stale: from before our next send
    const i = this.queue.findIndex((v) => near(v, bpm));
    if (i >= 0) {
      this.queue.splice(0, i + 1); // the engine has applied our sends up to this one
      this.known = bpm;
      this.waited = 0;
      return null;
    }
    if (this.known === null) {
      this.known = bpm; // the first status: the engine's tempo before our sends
      return null;
    }
    return this.wait(bpm);
  }

  private wait(bpm: number): number | null {
    if (++this.waited < TEMPO_SETTLE_STATUSES) return null;
    // Our sends never showed up: the engine overtook them. Trust what it reports.
    this.queue.length = 0;
    this.known = bpm;
    return bpm;
  }
}

const EMPTY_TRACKS = (): (TrackAudio | null)[] => TRACKS.map(() => null);

/**
 * What a LATENCY calibration recorded: the mic capture, and the frames at which the clicks were played, as indices
 * into `capture` (capture-relative, not status or context frames; see engine/calibration.ts).
 */
export interface Calibration {
  capture: Float32Array;
  clickFrames: number[];
}

export class Controller {
  readonly session = new Session();
  private _status: EngineStatus | null = null;
  private _message: string | null = null;
  private _now = 0;
  /** MIC IN MUTE is on (a PANEL function toggled it). */
  private _micMuted = false;
  /** The MIXER has the mic muted (`setMixerMicMute`). */
  private _mixerMicMuted = false;

  private readonly buttons: ButtonRouter;
  private readonly fb = new Framebuffer();
  private readonly panel: PanelStateBuilder;
  private readonly unsubscribe: () => void;
  private readonly events: ControllerOptions['events'];
  private readonly onPageHideListener = (): void => this.onPageHide();

  private messageTimer: ReturnType<typeof setTimeout> | undefined;
  private checkpointTimer: ReturnType<typeof setTimeout> | undefined;
  private systemSaveTimer: ReturnType<typeof setTimeout> | undefined;
  private nextReqId = 1;
  private readonly exports = new Map<number, { resolve: (tracks: (TrackAudio | null)[]) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly calibrations = new Map<number, { resolve: (r: Calibration) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly restartMic: ControllerOptions['restartMic'];
  private readonly tempoEcho = new TempoEcho();
  /** Counts the engine's audioDirty pulses, so WRITE can tell whether the audio changed while it was saving. */
  private audioSeq = 0;
  /** POWER is off: no checkpoint may be written after the clean-shutdown mark. Cleared by `boot`. */
  private poweredOff = false;
  /** Bumped by every memory load, so a slower earlier load cannot overwrite a later one. */
  private loadSeq = 0;
  /** Bumped whenever the checkpoint goes stale (memory saved or reloaded): a checkpoint in flight then gives up. */
  private checkpointGen = 0;
  /** Bumped by every change to the work a checkpoint holds (a parameter, the audio, a tempo the engine set, a restore). */
  private workSeq = 0;
  /** The `workSeq` the checkpoint in storage holds; -1 when there is none for this work. */
  private checkpointedSeq = -1;
  /** The checkpoint being written: a second request joins it rather than exporting all the audio again. */
  private checkpointing: Promise<void> | null = null;

  constructor(
    private readonly engine: EngineLike,
    private readonly stores: Stores,
    private readonly lcd: LcdHost,
    opts: ControllerOptions = {},
  ) {
    const host: ButtonHost = {
      session: this.session,
      send: (cmd, eventTime) => this.engine.send(cmd, eventTime),
      setParam: (id, value, track) => this.setParam(id, value, track),
      lcdEvent: (e) => this.lcd.onEvent(e, this),
      lcdShow: (req) => this.lcd.show(req, this),
      toggleMicMute: (t) => {
        this._micMuted = !this._micMuted;
        this.sendMicMute(t);
      },
    };
    this.buttons = new ButtonRouter(host);
    this.panel = new PanelStateBuilder(this.fb.data);
    this.unsubscribe = engine.on((e) => this.onEngineEvent(e));
    this.events = opts.events ?? (typeof window !== 'undefined' ? window : undefined);
    this.events?.addEventListener('pagehide', this.onPageHideListener);
    this.restartMic = opts.restartMic;
  }

  /** The latest engine status, or null before the first one. */
  get status(): EngineStatus | null {
    return this._status;
  }

  /** The popup message to overlay on the LCD, or null. */
  get message(): string | null {
    return this._message;
  }

  /** The `t` of the latest `panelState` call (rAF time, ms), for screens that animate. */
  get now(): number {
    return this._now;
  }

  get undoMode(): boolean {
    return this.buttons.undoMode;
  }

  /** The mic is muted by a MIC IN MUTE function. */
  get micMuted(): boolean {
    return this._micMuted;
  }

  /**
   * The MIXER's mute of the mic input (the app shell wires `MenuOptions.onMute` here, ruling R34). The engine's one mic
   * is muted while this or MIC IN MUTE is on, so neither undoes the other.
   */
  setMixerMicMute(on: boolean): void {
    if (on === this._mixerMicMuted) return;
    this._mixerMicMuted = on;
    this.sendMicMute();
  }

  isHeld(id: ButtonId): boolean {
    return this.buttons.isHeld(id);
  }

  /** Track `track`'s fader as a linear gain (what the engine was last sent). */
  faderGain(track: number): number {
    return faderGain(this.buttons.faderPosition(track));
  }

  /**
   * Power-on: loads the system settings, then memory `slot` (sending settings and tracks to the engine). Unlike
   * `selectMemory` it keeps the recovery checkpoint, which the app checks next (RECOVER?).
   */
  async boot(slot = 1): Promise<void> {
    this.poweredOff = false;
    this.session.system = await this.stores.system.load();
    await this.loadSlot(slot, false);
  }

  /** The single entry for all panel input. */
  handle(e: ControlEvent): void {
    this.buttons.handle(e);
  }

  /**
   * LEDs, rings and LCD for this frame. The LCD host draws into the controller's framebuffer, which becomes
   * `PanelState.lcd` as is. The returned object is the same one every call, updated in place: read it now and do not
   * keep it or anything in it.
   */
  panelState(t: number): PanelState {
    this._now = t;
    this.fb.clear();
    this.lcd.render(this.fb, this);
    return this.panel.update(this._status, this.session.memory, this.session.effectiveSystem, this.buttons.undoMode, this.fb.data);
  }

  /**
   * Validates and stores a parameter (memory or system, by its schema scope) and pushes `settings` to the engine.
   * `track` is the index of a `*` id (a track, or a key such as 'MIC1'). A tempo change also sends `tempo`, so the
   * transport and `memory.tempo` never disagree. A system change is saved to the system store shortly after; a system
   * parameter whose PREFERENCE is MEMORY goes into the memory instead (`memory.prefs`, unsaved until WRITE). A MIC
   * PROCESS change also reopens the mic (the `restartMic` option). A value that does not change sends nothing. Throws
   * for an unknown id or a bad value or index.
   */
  setParam(id: string, value: unknown, track?: number | string): void {
    const { scope, changed } = this.session.set(id, value, track);
    if (!changed) return;
    this.workSeq++;
    if (scope === 'system') this.scheduleSystemSave();
    this.pushSettings();
    if (id === 'tempo') {
      const bpm = this.session.memory.tempo;
      this.tempoEcho.sent(bpm);
      this.engine.send({ t: 'tempo', bpm });
    }
    if (id === 'setup.micProcess') this.reopenMic();
  }

  /**
   * Makes `slot` the current memory: unsaved changes are discarded (as on the hardware), the slot's settings (or the
   * defaults for an empty slot) are loaded, and the engine gets `settings` and `loadTrack` for all five tracks.
   */
  async selectMemory(slot: number): Promise<void> {
    await this.loadSlot(slot, true);
  }

  /**
   * WRITE: saves the current memory's settings and audio (fetched from the engine) to `slot`, which then becomes the
   * current memory. Re-saving the current slot is always allowed; a different slot that holds a phrase is refused
   * with NOT EMPTY (manual p. 23: clear it first; checked from the slot's metadata, its audio is never loaded). MEMORY
   * FULL when storage refuses the write. The settings saved are those of the moment WRITE starts; edits made while it
   * waits for the engine stay unsaved. Rejects if the memory is reloaded or cleared during that wait (nothing is
   * saved), if the engine does not return the tracks within EXPORT_TIMEOUT_MS, or on any other storage error.
   */
  async write(slot: number): Promise<'ok' | 'NOT EMPTY' | 'MEMORY FULL'> {
    if (slot !== this.session.slot && (await this.stores.memories.hasAudio(slot))) return 'NOT EMPTY';
    const seq = this.loadSeq;
    this.session.snapshotPrefs(); // the PREFERENCE = MEMORY groups are saved with the memory
    const settings = structuredClone(this.session.memory);
    const audioSeq = this.audioSeq;
    const tracks = await this.requestTracks();
    if (seq !== this.loadSeq) throw new Error('WRITE aborted: the memory changed while it was being saved');
    try {
      await this.stores.memories.save(slot, settings, tracks);
    } catch (e) {
      if (e instanceof QuotaError) return 'MEMORY FULL';
      throw e;
    }
    if (seq !== this.loadSeq) return 'ok'; // written, but the session has moved on to another memory since
    this.session.markSaved(slot, settings, this.audioSeq !== audioSeq);
    this.dropCheckpoint();
    return 'ok';
  }

  /**
   * The names of all 99 memories for the WRITE / CLEAR screen: index 0 is memory 1, blank for an empty slot (and for a
   * memory saved without a name). Reads the slot list only; no memory or audio is loaded and the session is untouched.
   */
  async memoryNames(): Promise<string[]> {
    const names: string[] = Array.from({ length: SLOT_COUNT }, () => '');
    for (const e of await this.stores.memories.list()) {
      if (!e.empty && e.slot >= 1 && e.slot <= SLOT_COUNT) names[e.slot - 1] = e.name;
    }
    return names;
  }

  /** CLEAR: empties memory `slot`. Clearing the current memory also empties the session (INFERRED). */
  async clear(slot: number): Promise<void> {
    await this.stores.memories.clear(slot);
    if (slot === this.session.slot) {
      ++this.loadSeq;
      this.loadSession(slot, defaultMemory(), EMPTY_TRACKS(), true);
    }
  }

  /** Shows an LCD popup (EXECUTING..., STOP LOOPER, ...) for `ms`; Infinity keeps it until replaced or cleared. */
  showMessage(text: string, ms: number = MESSAGE_MS): void {
    clearTimeout(this.messageTimer);
    this.messageTimer = undefined;
    this._message = text;
    if (Number.isFinite(ms)) {
      this.messageTimer = setTimeout(() => {
        this.messageTimer = undefined;
        this._message = null;
      }, ms);
    }
  }

  clearMessage(): void {
    clearTimeout(this.messageTimer);
    this.messageTimer = undefined;
    this._message = null;
  }

  /** The five tracks' audio, from the engine (`exportTracks`). Also used by WRITE, the checkpoint and LOOP MIX. */
  requestTracks(): Promise<(TrackAudio | null)[]> {
    const reqId = this.nextReqId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.exports.delete(reqId);
        reject(new Error(`engine did not return tracks for request ${reqId}`));
      }, EXPORT_TIMEOUT_MS);
      this.exports.set(reqId, { resolve, timer });
      this.engine.send({ t: 'exportTracks', reqId });
    });
  }

  /**
   * LATENCY calibration: has the engine play its clicks and record the mic (`calibrate`), and resolves with what it
   * recorded. Rejects if the engine has not answered within CALIBRATE_TIMEOUT_MS.
   */
  requestCalibration(): Promise<Calibration> {
    const reqId = this.nextReqId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.calibrations.delete(reqId);
        reject(new Error(`engine did not return a calibration for request ${reqId}`));
      }, CALIBRATE_TIMEOUT_MS);
      this.calibrations.set(reqId, { resolve, timer });
      this.engine.send({ t: 'calibrate', reqId });
    });
  }

  /**
   * RECOVER? ENTER: the crash checkpoint becomes the current memory again, in the slot it was made in, as unsaved
   * work (WRITE saves it). The checkpoint is kept until the memory is saved or replaced, so a second crash still has it.
   */
  restoreRecovery(rec: { slot: number; settings: MemorySettings; tracks: (TrackAudio | null)[] }): void {
    ++this.loadSeq;
    this.loadSession(rec.slot, rec.settings, rec.tracks, false);
    this.workSeq++;
    this.session.paramsDirty = true;
    if (rec.tracks.some((t) => t !== null)) this.session.audioDirty = true;
  }

  /**
   * Replaces the system settings (FACTORY RESET SYSTEM, RESTORE ALL): pushed to the engine and saved at once. A
   * different MIC PROCESS reopens the mic.
   */
  async replaceSystem(system: SystemSettings): Promise<void> {
    const micBefore = this.session.system.setup.micProcess;
    this.session.system = system;
    this.workSeq++;
    this.pushSettings();
    if (system.setup.micProcess !== micBefore) this.reopenMic();
    clearTimeout(this.systemSaveTimer);
    this.systemSaveTimer = undefined;
    await this.saveSystem();
  }

  /**
   * FACTORY RESET (Owner's Manual p. 24): MEMORY clears memories 01-99 (and so the current memory, unsaved work
   * included); SYSTEM restores `defaultSystem()`; MEMORY+SYSTEM does both. When clearing fails partway the error is
   * passed on, but the current memory is reloaded from what storage holds first, so the session never claims a
   * cleared slot still holds its old, saved memory.
   */
  async factoryReset(target: FactoryResetTarget): Promise<void> {
    if (target !== 'SYSTEM') {
      try {
        for (let slot = 1; slot <= SLOT_COUNT; slot++) await this.stores.memories.clear(slot);
      } finally {
        await this.selectMemory(this.session.slot);
      }
    }
    if (target !== 'MEMORY') await this.replaceSystem(defaultSystem());
  }

  /**
   * IMPORT MEMORY: stores an imported memory in `slot`. A slot holding a phrase is refused with NOT EMPTY (as WRITE
   * does), and so is the current memory while it holds unsaved work. Importing into the current memory loads it.
   * MEMORY FULL when storage refuses the write.
   */
  async importMemory(slot: number, contents: MemoryContents): Promise<'ok' | 'NOT EMPTY' | 'MEMORY FULL'> {
    if ((slot === this.session.slot && this.session.dirty) || (await this.stores.memories.hasAudio(slot))) return 'NOT EMPTY';
    try {
      await this.stores.memories.save(slot, contents.settings, contents.tracks);
    } catch (e) {
      if (e instanceof QuotaError) return 'MEMORY FULL';
      throw e;
    }
    if (slot === this.session.slot) await this.selectMemory(slot);
    return 'ok';
  }

  /** EXPORT MEMORY: the current memory as it is now (unsaved edits and PREFERENCE = MEMORY groups included) and its audio. */
  async exportCurrent(): Promise<MemoryContents> {
    const settings = this.session.memoryForSave();
    const tracks = await this.requestTracks();
    return { settings, tracks };
  }

  /**
   * BACKUP ALL: the 99 stored memories (null for an empty slot) and the system settings. The memories are loaded one
   * by one with a running total of their audio (frames x 8 bytes, as `packBackup` counts it): once it passes
   * `maxDecodedBytes` this throws `FileTooLarge` at once, before the rest are loaded, and what was loaded is dropped.
   */
  async backupAll(maxDecodedBytes: number = defaultMaxDecodedBytes()): Promise<BackupContents> {
    const memories: (MemoryContents | null)[] = [];
    let bytes = 0;
    for (let slot = 1; slot <= SLOT_COUNT; slot++) {
      const rec = await this.stores.memories.load(slot);
      if (rec) {
        for (const t of rec.tracks) if (t) bytes += t.L.length * 8;
        if (bytes > maxDecodedBytes) {
          memories.length = 0; // let the loaded audio go before the error travels up
          throw new FileTooLarge(bytes, maxDecodedBytes);
        }
      }
      memories.push(rec ? { settings: rec.settings, tracks: rec.tracks } : null);
    }
    return { system: structuredClone(this.session.system), memories };
  }

  /**
   * RESTORE ALL: every slot becomes the backup's (an empty one is cleared), the system settings are replaced, and the
   * current memory is loaded again. MEMORY FULL when storage refuses a write (the slots before it are restored). Any
   * other failure is passed on, after the current memory has been reloaded from what storage now holds.
   */
  async restoreAll(backup: BackupContents): Promise<'ok' | 'MEMORY FULL'> {
    let result: 'ok' | 'MEMORY FULL' = 'ok';
    try {
      try {
        for (let slot = 1; slot <= SLOT_COUNT; slot++) {
          const m = backup.memories[slot - 1];
          if (m) await this.stores.memories.save(slot, m.settings, m.tracks);
          else await this.stores.memories.clear(slot);
        }
      } catch (e) {
        if (!(e instanceof QuotaError)) throw e;
        result = 'MEMORY FULL';
      }
      await this.replaceSystem(backup.system);
    } finally {
      await this.selectMemory(this.session.slot);
    }
    return result;
  }

  /**
   * Writes the recovery checkpoint now (unsaved work only). Nothing is written when the checkpoint already holds the
   * work as it is. A request while one is being written joins it (the page going hidden and then `pagehide` export the
   * audio once), and writes again after it if the work changed meanwhile.
   */
  async checkpointNow(): Promise<void> {
    clearTimeout(this.checkpointTimer);
    this.checkpointTimer = undefined;
    if (this.poweredOff || !this.session.dirty) return;
    const running = this.checkpointing;
    if (running) {
      await running;
      if (this.workSeq !== this.checkpointedSeq) await this.checkpointNow();
      return;
    }
    if (this.workSeq === this.checkpointedSeq) return; // the checkpoint in storage is current
    const run = this.writeCheckpoint();
    this.checkpointing = run;
    try {
      await run;
    } finally {
      if (this.checkpointing === run) this.checkpointing = null;
    }
  }

  private async writeCheckpoint(): Promise<void> {
    const gen = this.checkpointGen;
    const seq = this.workSeq;
    const slot = this.session.slot;
    const settings = this.session.memoryForSave();
    try {
      const tracks = await this.requestTracks();
      if (gen !== this.checkpointGen) return; // saved or reloaded meanwhile: this work is no longer unsaved
      await this.stores.recovery.checkpoint(slot, settings, tracks);
      if (gen === this.checkpointGen) this.checkpointedSeq = seq;
    } catch (e) {
      if (e instanceof QuotaError) this.showMessage('MEMORY FULL');
      else console.error('recovery checkpoint failed', e);
    }
  }

  /** The page is being hidden (maybe for good): save pending system settings and checkpoint unsaved work. */
  onPageHide(): void {
    if (this.poweredOff) return; // already saved and marked clean
    void this.flushSystemSave();
    void this.checkpointNow();
  }

  /**
   * The deliberate POWER off (wired by the app shell): saves pending system settings, then marks a clean shutdown,
   * which also discards the recovery checkpoint (ruling R16). Never called for a mere page hide.
   */
  async powerOff(): Promise<void> {
    this.poweredOff = true;
    this.checkpointGen++; // a checkpoint waiting for the engine gives up
    clearTimeout(this.checkpointTimer);
    this.checkpointTimer = undefined;
    await this.flushSystemSave();
    await this.stores.recovery.markCleanShutdown();
  }

  /**
   * Stops listening to the engine and the page and cancels every timer. A pending system save is written at once.
   * Pending `requestTracks` promises are dropped: they never settle (no late rejection).
   */
  dispose(): void {
    this.unsubscribe();
    this.events?.removeEventListener('pagehide', this.onPageHideListener);
    this.buttons.dispose();
    void this.flushSystemSave();
    for (const { timer } of this.exports.values()) clearTimeout(timer);
    this.exports.clear();
    for (const { timer } of this.calibrations.values()) clearTimeout(timer);
    this.calibrations.clear();
    this.checkpointGen++;
    clearTimeout(this.messageTimer);
    clearTimeout(this.checkpointTimer);
    this.messageTimer = this.checkpointTimer = undefined;
  }

  // -------------------------------------------------------------------------------------------------------------------

  private pushSettings(): void {
    this.tempoEcho.sent(this.session.memory.tempo);
    // The engine copies these (EngineHost posts them through a MessagePort), so passing the live objects is safe. The
    // system settings sent are those in effect (PREFERENCE = MEMORY groups from the memory).
    this.engine.send({ t: 'settings', memory: this.session.memory, system: this.session.effectiveSystem });
  }

  private sendMicMute(eventTime?: number): void {
    this.engine.send({ t: 'micMute', on: this._micMuted || this._mixerMicMuted }, eventTime);
  }

  private reopenMic(): void {
    this.restartMic?.().catch((e: unknown) => console.error('reopening the mic failed', e));
  }

  private async loadSlot(slot: number, discardCheckpoint: boolean): Promise<void> {
    const seq = ++this.loadSeq;
    const rec = await this.stores.memories.load(slot);
    if (seq !== this.loadSeq) return; // a later load won
    this.loadSession(slot, rec?.settings ?? defaultMemory(), rec?.tracks ?? EMPTY_TRACKS(), discardCheckpoint);
  }

  /** Loads a memory into the session and the engine. `discardCheckpoint`: the unsaved work it held is now gone. */
  private loadSession(slot: number, memory: MemorySettings, tracks: (TrackAudio | null)[], discardCheckpoint: boolean): void {
    this.session.load(slot, memory);
    this.workSeq++;
    this.buttons.resetTap();
    if (discardCheckpoint) this.dropCheckpoint();
    this.pushSettings();
    for (const track of TRACKS) this.engine.send({ t: 'loadTrack', track, audio: tracks[track] ?? null });
  }

  /** The checkpoint holds unsaved work; once the memory is saved or reloaded it is stale. */
  private dropCheckpoint(): void {
    this.checkpointGen++;
    this.checkpointedSeq = -1;
    clearTimeout(this.checkpointTimer);
    this.checkpointTimer = undefined;
    this.stores.recovery.discard().catch((e: unknown) => console.error('recovery discard failed', e));
  }

  private onEngineEvent(e: EngineEvent): void {
    switch (e.t) {
      case 'status':
        this.onStatus(e.status);
        return;
      case 'tracks': {
        const pending = this.exports.get(e.reqId);
        if (pending) {
          this.exports.delete(e.reqId);
          clearTimeout(pending.timer);
          pending.resolve(e.tracks);
        }
        return;
      }
      case 'calibration': {
        const pending = this.calibrations.get(e.reqId);
        if (pending) {
          this.calibrations.delete(e.reqId);
          clearTimeout(pending.timer);
          pending.resolve({ capture: e.capture, clickFrames: e.clickFrames });
        }
        return;
      }
      case 'message':
        this.showMessage(e.text);
        return;
      default:
        return; // recorderBlock belongs to the recorder
    }
  }

  private onStatus(s: EngineStatus): void {
    this._status = s;
    // audioDirty is a pulse (raised once per change: a recording kept, a pass ended, a track cleared); latch it.
    if (s.audioDirty) {
      this.audioSeq++;
      this.workSeq++;
      this.session.audioDirty = true;
      this.scheduleCheckpoint();
    }
    // The engine sets the tempo itself when a first recording defines it. Take that tempo into the memory, or the next
    // settings push would put the old one back. Echoes of our own sends are told apart by TempoEcho. No settings push:
    // the engine already has it; session.set leaves the memory clean when the (snapped) value is the one it had.
    const adopt = this.tempoEcho.seen(s.tempo);
    if (adopt !== null) {
      this.session.set('tempo', adopt);
      this.workSeq++;
    }
  }

  private scheduleCheckpoint(): void {
    if (this.poweredOff) return;
    clearTimeout(this.checkpointTimer);
    this.checkpointTimer = setTimeout(() => {
      this.checkpointTimer = undefined;
      void this.checkpointNow();
    }, CHECKPOINT_DEBOUNCE_MS);
  }

  private scheduleSystemSave(): void {
    clearTimeout(this.systemSaveTimer);
    this.systemSaveTimer = setTimeout(() => {
      this.systemSaveTimer = undefined;
      void this.saveSystem();
    }, SYSTEM_SAVE_DEBOUNCE_MS);
  }

  /** Saves the system settings now if a save is pending. */
  private flushSystemSave(): Promise<void> {
    if (this.systemSaveTimer === undefined) return Promise.resolve();
    clearTimeout(this.systemSaveTimer);
    this.systemSaveTimer = undefined;
    return this.saveSystem();
  }

  private async saveSystem(): Promise<void> {
    try {
      await this.stores.system.save(structuredClone(this.session.system));
    } catch (e) {
      if (e instanceof QuotaError) this.showMessage('MEMORY FULL');
      else console.error('saving system settings failed', e);
    }
  }
}
