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
import { defaultMemory } from '../schema/params';
import type { MemorySettings } from '../schema/types';
import { TRACKS } from '../shared/ids';
import type { ButtonId, ControlEvent } from '../shared/ids';
import type { PanelState } from '../shared/panel';
import type { EngineCommand, EngineEvent, EngineStatus, TrackAudio } from '../shared/protocol';
import { QuotaError } from '../storage/db';
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
  memories: Pick<MemoryStore, 'load' | 'save' | 'clear' | 'isEmpty'>;
  system: Pick<SystemStore, 'load' | 'save'>;
  recovery: Pick<Recovery, 'checkpoint' | 'discard' | 'markCleanShutdown'>;
}

export interface ControllerOptions {
  /** Where `pagehide` is listened for; defaults to `window` when there is one. */
  events?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
}

/** How long a popup message stays up by default. */
// INFERRED: the manual gives no time; the plan's NO INPUT case uses 2 s.
export const MESSAGE_MS = 2000;
/** The recovery checkpoint is written this long after the last change to the audio. */
export const CHECKPOINT_DEBOUNCE_MS = 2000;
/** System settings are saved this long after the last change (knob turns come in bursts). */
export const SYSTEM_SAVE_DEBOUNCE_MS = 500;
/** `exportTracks` gives up when the engine has not answered by then. */
export const EXPORT_TIMEOUT_MS = 20000;

const EMPTY_TRACKS = (): (TrackAudio | null)[] => TRACKS.map(() => null);

export class Controller {
  readonly session = new Session();
  private _status: EngineStatus | null = null;
  private _message: string | null = null;
  private _now = 0;

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
  private readonly exports = new Map<number, (tracks: (TrackAudio | null)[]) => void>();
  /** Bumped by every memory load, so a slower earlier load cannot overwrite a later one. */
  private loadSeq = 0;
  /** Bumped whenever the checkpoint goes stale (memory saved or reloaded): a checkpoint in flight then gives up. */
  private checkpointGen = 0;
  /** The tempo of the previous status: a change there that the session did not ask for came from the engine. */
  private lastStatusTempo: number | null = null;

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
    };
    this.buttons = new ButtonRouter(host);
    this.panel = new PanelStateBuilder(this.fb.data);
    this.unsubscribe = engine.on((e) => this.onEngineEvent(e));
    this.events = opts.events ?? (typeof window !== 'undefined' ? window : undefined);
    this.events?.addEventListener('pagehide', this.onPageHideListener);
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
    return this.panel.update(this._status, this.session.memory, this.session.system, this.buttons.undoMode, this.fb.data);
  }

  /**
   * Validates and stores a parameter (memory or system, by its schema scope) and pushes `settings` to the engine.
   * `track` is the index of a `*` id. A tempo change also sends `tempo`, so the transport and `memory.tempo` never
   * disagree. A system change is saved to the system store shortly after. A value that does not change sends nothing.
   * Throws for an unknown id or a bad value or index.
   */
  setParam(id: string, value: unknown, track?: number): void {
    const { scope, changed } = this.session.set(id, value, track);
    if (!changed) return;
    if (scope === 'system') this.scheduleSystemSave();
    this.pushSettings();
    if (id === 'tempo') this.engine.send({ t: 'tempo', bpm: this.session.memory.tempo });
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
   * with NOT EMPTY (manual p. 23: clear it first). MEMORY FULL when storage refuses the write. Rejects if the engine
   * does not return the tracks within EXPORT_TIMEOUT_MS, or on any other storage error.
   */
  async write(slot: number): Promise<'ok' | 'NOT EMPTY' | 'MEMORY FULL'> {
    if (slot !== this.session.slot && !(await this.stores.memories.isEmpty(slot))) {
      // Loads the slot's audio just to look at it. A rare operation, but a metadata-only check would be lighter.
      const existing = await this.stores.memories.load(slot);
      if (existing && existing.tracks.some((t) => t !== null)) return 'NOT EMPTY';
    }
    const tracks = await this.requestTracks();
    try {
      await this.stores.memories.save(slot, structuredClone(this.session.memory), tracks);
    } catch (e) {
      if (e instanceof QuotaError) return 'MEMORY FULL';
      throw e;
    }
    this.session.markSaved(slot);
    this.dropCheckpoint();
    return 'ok';
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
      this.exports.set(reqId, (tracks) => {
        clearTimeout(timer);
        resolve(tracks);
      });
      this.engine.send({ t: 'exportTracks', reqId });
    });
  }

  /** Writes the recovery checkpoint now (unsaved work only). */
  async checkpointNow(): Promise<void> {
    clearTimeout(this.checkpointTimer);
    this.checkpointTimer = undefined;
    if (!this.session.dirty) return;
    const gen = this.checkpointGen;
    const slot = this.session.slot;
    const settings = structuredClone(this.session.memory);
    try {
      const tracks = await this.requestTracks();
      if (gen !== this.checkpointGen) return; // saved or reloaded meanwhile: this work is no longer unsaved
      await this.stores.recovery.checkpoint(slot, settings, tracks);
    } catch (e) {
      if (e instanceof QuotaError) this.showMessage('MEMORY FULL');
      else console.error('recovery checkpoint failed', e);
    }
  }

  /** The page is being hidden (maybe for good): save pending system settings and checkpoint unsaved work. */
  onPageHide(): void {
    void this.flushSystemSave();
    void this.checkpointNow();
  }

  /**
   * The deliberate POWER off (wired by the app shell): saves pending system settings, then marks a clean shutdown,
   * which also discards the recovery checkpoint (ruling R16). Never called for a mere page hide.
   */
  async powerOff(): Promise<void> {
    clearTimeout(this.checkpointTimer);
    this.checkpointTimer = undefined;
    await this.flushSystemSave();
    await this.stores.recovery.markCleanShutdown();
  }

  /** Stops listening to the engine and the page, and cancels every timer. */
  dispose(): void {
    this.unsubscribe();
    this.events?.removeEventListener('pagehide', this.onPageHideListener);
    this.buttons.dispose();
    clearTimeout(this.messageTimer);
    clearTimeout(this.checkpointTimer);
    clearTimeout(this.systemSaveTimer);
    this.messageTimer = this.checkpointTimer = this.systemSaveTimer = undefined;
  }

  // -------------------------------------------------------------------------------------------------------------------

  private pushSettings(): void {
    // The engine copies these (EngineHost posts them through a MessagePort), so passing the live objects is safe.
    this.engine.send({ t: 'settings', memory: this.session.memory, system: this.session.system });
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
    this.buttons.resetTap();
    if (discardCheckpoint) this.dropCheckpoint();
    this.pushSettings();
    for (const track of TRACKS) this.engine.send({ t: 'loadTrack', track, audio: tracks[track] ?? null });
  }

  /** The checkpoint holds unsaved work; once the memory is saved or reloaded it is stale. */
  private dropCheckpoint(): void {
    this.checkpointGen++;
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
        const resolve = this.exports.get(e.reqId);
        if (resolve) {
          this.exports.delete(e.reqId);
          resolve(e.tracks);
        }
        return;
      }
      case 'message':
        this.showMessage(e.text);
        return;
      default:
        return; // recorderBlock and calibration belong to the recorder and the latency screen
    }
  }

  private onStatus(s: EngineStatus): void {
    this._status = s;
    // audioDirty is a pulse (raised once per change: a recording kept, a pass ended, a track cleared); latch it.
    if (s.audioDirty) {
      this.session.audioDirty = true;
      this.scheduleCheckpoint();
    }
    // The engine sets the tempo itself when a first recording defines it. Take that tempo into the memory, or the next
    // settings push would put the old one back. Only a change between two statuses counts, so a status still in
    // flight from before one of our own tempo changes is not mistaken for it.
    const prev = this.lastStatusTempo;
    this.lastStatusTempo = s.tempo;
    if (prev !== null && s.tempo !== prev && Math.abs(s.tempo - this.session.memory.tempo) > 1e-6) {
      this.session.set('tempo', s.tempo);
    }
  }

  private scheduleCheckpoint(): void {
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
