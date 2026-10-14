/**
 * The unit's power cycle, without the DOM: what happens when POWER is tapped, which engine, controller, menu and
 * recorder exist while it is on, what the panel shows in each state, and what a hidden page or a lost audio context
 * leads to. `bootApp` (src/app.ts) gives it the browser pieces and draws what `frame` returns; the tests give it fakes.
 *
 * POWER on (the tap):
 *   EngineHost.start() (called inside the tap, so its AudioContext gets the tap's user activation) -> persistent
 *   storage asked for -> system settings and memory 01 loaded (`Controller.boot`) -> the DISPLAY MODE start screen ->
 *   the power-on prompts (RECOVER? when the last session crashed with unsaved work, CALIBRATE? on first run) -> the
 *   session marked running -> the recorder pod mounted. The LCD shows the boot screen ("Sage MK1", the version) from the
 *   tap until all that is done and for at least BOOT_MS, then whatever is on top of the menu.
 *   The small storage reads (opening the database, the system settings, the recovery flag) give up after
 *   STORAGE_TIMEOUT_MS (STORAGE ERROR: an IndexedDB that never answers would leave the unit booting with the mic
 *   open). Memory 01's audio has no time limit (hundreds of MB can take a while on an older iPad, and a timeout there
 *   would keep the unit from ever coming on); a POWER tap once the boot has run for ABORT_AFTER_MS abandons any boot.
 *   Either way the engine is stopped and the unit is off again, and a database that failed to open (or timed out) is
 *   opened afresh at the next power-on.
 * POWER off (a tap while on): the running take is completed (`recorder.stop()`) before anything is torn down, the
 *   system settings are saved and a clean shutdown is marked (`Controller.powerOff`, which also drops the recovery
 *   checkpoint, ruling R16), then the pod, controller and menu go and the engine stops. While RECOVER? is unanswered
 *   (ruling R68) no clean shutdown is marked, then or at a later pagehide, so the next power-on offers it again. The system settings as they
 *   are then are kept for the next power-on in this page (MIC PROCESS for the mic, CONTRAST for the boot screen).
 * Audio lost (the engine's `needsResume`, ruling R58): the running take is halted at once, and the shell shows TAP
 *   POWER TO RESUME. A POWER tap retries (`resume({ retryMic: true })`); once a retry has failed, or has run for
 *   RESUME_OFF_AFTER_MS without an answer (getUserMedia has no time limit), the prompt says the next POWER tap switches
 *   off, and it does (the normal POWER off). Taps on the prompt itself retry whenever no retry is running.
 * Page hide: only after a POWER off is it a clean shutdown (`markCleanShutdown`). While on, the running flag stays set,
 *   so a crash or a closed app offers RECOVER next time; the controller checkpoints unsaved work on `pagehide` itself,
 *   and the unit has it do the same when the page goes hidden (iPadOS may end a hidden app without a pagehide).
 * Wake lock: asked for at power-on (inside the tap), again when the page is visible again and on panel presses while
 *   none is held, and let go at power off.
 * Recorder pod: REC and LOOP MIX are enabled only while the unit is on with its audio running.
 */

import { Controller } from '../control/controller';
import type { EngineLike, Stores } from '../control/controller';
import { Framebuffer } from '../lcd/framebuffer';
import { MenuSystem } from '../lcd/menu';
import { BOOT_MS, drawBootScreen } from '../lcd/screens/boot';
import { showBootPrompts } from '../lcd/screens/recover';
import { Recorder } from '../recorder/recorder';
import type { SystemSettings } from '../schema/types';
import { LCD_H, LCD_W } from '../shared/constants';
import type { ControlEvent } from '../shared/ids';
import type { PanelState, RingState } from '../shared/panel';
import { openDb } from '../storage/db';
import { MemoryStore } from '../storage/memoryStore';
import { Recovery } from '../storage/recovery';
import { SystemStore } from '../storage/systemStore';
import { Takes } from '../storage/takes';
import { WakeLockKeeper } from './wakeLock';
import type { VisibilitySource, WakeLockApi } from './wakeLock';

export type PowerState = 'off' | 'booting' | 'on' | 'stopping';

/**
 * What the TAP POWER TO RESUME prompt shows: nothing; a resume is wanted; one is under way; one has run for
 * RESUME_OFF_AFTER_MS without an answer, or one failed: either way the next POWER tap switches off.
 */
export type ResumePrompt = 'none' | 'resume' | 'resuming' | 'slow' | 'off';

/** Each wait on storage during power-on gives up after this long. */
// INFERRED: IndexedDB answers in milliseconds; a wait this long means it is blocked or broken.
export const STORAGE_TIMEOUT_MS = 8000;
/** A POWER tap abandons a power-on that has been running this long (earlier taps are taken as impatience). */
export const ABORT_AFTER_MS = 3000;
/** A resume still unanswered after this long lets POWER switch off. */
// INFERRED: a resume takes well under a second when it works; RESUME_TIMEOUT_MS (2 s) bounds the context part.
export const RESUME_OFF_AFTER_MS = 5000;

/** The engine as the shell drives it: EngineHost in the app, a fake in tests. */
export interface ShellEngine extends EngineLike {
  readonly ctx: { readonly sampleRate: number };
  /** A mic is open. */
  readonly micAvailable: boolean;
  /** Audio was lost and could not be brought back (TAP POWER TO RESUME). */
  readonly needsResume: boolean;
  onNeedsResume(handler: (needsResume: boolean) => void): () => void;
  resume(opts?: { retryMic?: boolean }): Promise<boolean>;
  restartMic(): Promise<void>;
  stop(): Promise<void>;
}

/** The stores a powered-on unit uses. */
export interface ShellStores extends Stores {
  recovery: Stores['recovery'] & Pick<Recovery, 'markRunning' | 'needsRecovery' | 'take'>;
  takes: Takes;
}

/** The recorder pod as the unit holds it (`mountRecorderPod`'s handle). */
export interface PodHandle {
  toggleRecord(): Promise<void>;
  /** Whether REC and LOOP MIX may start (the unit is on and its audio runs). */
  setEnabled(on: boolean): void;
  dispose(): void;
}

export interface UnitDeps {
  /** Opens the stores (IndexedDB). Called when the unit is made (before any tap), and again at a power-on when that open failed. */
  openStores(): Promise<ShellStores>;
  /**
   * Starts the engine with the stored system settings (undefined if they are not read yet): `EngineHost.start`, which
   * creates its AudioContext before its first await. Called synchronously from the POWER tap.
   */
  startEngine(system: SystemSettings | undefined): Promise<ShellEngine>;
  /** `navigator.storage.persist()` (requestPersistence). */
  requestPersistence?: () => Promise<boolean>;
  /** Mounts the recorder pod for the powered-on unit. */
  mountPod?: (recorder: Recorder, controller: Controller) => PodHandle;
  /** Where `pagehide` is listened for (window); the controller listens there too. */
  win?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  /** Visibility (document): wake lock and the hidden-page checkpoint. */
  doc?: VisibilitySource | null;
  /** `navigator.wakeLock`, when there is one. */
  wakeLock?: WakeLockApi;
  /** The least time the boot screen shows (default BOOT_MS). */
  bootMs?: number;
  /** Default STORAGE_TIMEOUT_MS. */
  storageTimeoutMs?: number;
  /** Default ABORT_AFTER_MS. */
  abortAfterMs?: number;
  /** Default RESUME_OFF_AFTER_MS. */
  resumeOffAfterMs?: number;
}

/** One opening of the stores, and how it went. */
interface StoresOpen {
  readonly p: Promise<ShellStores>;
  state: 'pending' | 'ok' | 'failed';
  /** A power-on gave up waiting for it. */
  timedOut: boolean;
}

/** The MIXER input that is the app's mic: muting it there mutes the engine's one mic (ruling R34). */
export const MIXER_MIC_KEYS: readonly string[] = ['mic1In'];

/** Opens the IndexedDB stores the unit needs. */
export async function openStores(dbName?: string): Promise<ShellStores> {
  const db = await openDb(dbName);
  return { memories: new MemoryStore(db), system: new SystemStore(db), recovery: new Recovery(db), takes: new Takes(db) };
}

/** Everything that exists while the unit is on. */
interface Live {
  readonly engine: ShellEngine;
  readonly stores: ShellStores;
  readonly controller: Controller;
  readonly menu: MenuSystem;
  readonly recorder: Recorder;
  pod: PodHandle | null;
  offResume: () => void;
}

/** A power-on under way. */
interface Boot {
  readonly startedAt: number;
  /** Rejects with BootAborted when a POWER tap abandons the boot. */
  readonly aborted: Promise<never>;
  abort(): void;
}

class BootAborted extends Error {
  constructor() {
    super('power-on abandoned by a POWER tap');
    this.name = 'BootAborted';
  }
}

class StorageTimeout extends Error {
  constructor(ms: number) {
    super(`storage did not answer within ${ms} ms`);
    this.name = 'StorageTimeout';
  }
}

const offRing = (): RingState => ({ color: 'off', blink: 'none', mode: 'status', amount: 0 });
/** A panel with every LED dark and the given LCD. */
const darkPanel = (lcd: Uint8Array): PanelState => ({
  leds: {},
  rings: [offRing(), offRing(), offRing(), offRing(), offRing()],
  lcd,
  contrast: 5,
  beatPhase: 0,
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class SageUnit {
  private _state: PowerState = 'off';
  private _error: string | null = null;
  private live: Live | null = null;
  private boot: Boot | null = null;
  /** Where a resume asked for by TAP POWER TO RESUME stands ('slow': running past RESUME_OFF_AFTER_MS). */
  private resume: 'idle' | 'resuming' | 'slow' | 'failed' = 'idle';
  private resumeTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * The system settings for the next power-on: read from storage ahead of the first tap, then kept from the last
   * session, so the engine opens the mic with the right MIC PROCESS and the boot screen has the right CONTRAST.
   */
  private system: SystemSettings | undefined;
  /** The last power-off came from the POWER control (and the unit has not been switched on since). */
  private switchedOff = false;
  /**
   * That power-off kept the recovery checkpoint instead of marking a clean shutdown (RECOVER? unanswered, ruling R68;
   * the engine stopped, R67): a later pagehide must not mark one either.
   */
  private keptCheckpoint = false;
  private transition: Promise<void> = Promise.resolve();
  private readonly preload: Promise<void>;
  private stores: StoresOpen;
  private readonly listeners = new Set<() => void>();
  private readonly wake: WakeLockKeeper;
  private readonly bootMs: number;
  private readonly storageTimeoutMs: number;
  private readonly abortAfterMs: number;
  private readonly resumeOffAfterMs: number;
  private readonly offState = darkPanel(new Uint8Array(LCD_W * LCD_H));
  private readonly bootState: PanelState;
  private disposed = false;

  constructor(private readonly deps: UnitDeps) {
    this.bootMs = deps.bootMs ?? BOOT_MS;
    this.storageTimeoutMs = deps.storageTimeoutMs ?? STORAGE_TIMEOUT_MS;
    this.abortAfterMs = deps.abortAfterMs ?? ABORT_AFTER_MS;
    this.resumeOffAfterMs = deps.resumeOffAfterMs ?? RESUME_OFF_AFTER_MS;
    const fb = new Framebuffer();
    drawBootScreen(fb);
    this.bootState = darkPanel(fb.data);
    this.wake = new WakeLockKeeper(deps.wakeLock, deps.doc ?? null);
    this.stores = this.openStores();
    this.preload = this.stores.p
      .then((s) => s.system.load())
      .then(
        (sys) => {
          this.system ??= sys;
        },
        (e: unknown) => console.error('reading the system settings failed', e),
      );
    deps.win?.addEventListener('pagehide', this.onPageHide);
    deps.doc?.addEventListener('visibilitychange', this.onVisibility);
  }

  get state(): PowerState {
    return this._state;
  }

  /** Why the last power-on failed (AUDIO ERROR, STORAGE ERROR), or null. */
  get error(): string | null {
    return this._error;
  }

  /** Audio was lost while on: the shell shows TAP POWER TO RESUME. */
  get needsResume(): boolean {
    return this._state === 'on' && this.live !== null && this.live.engine.needsResume;
  }

  /** What the TAP POWER TO RESUME prompt shows. */
  get resumePrompt(): ResumePrompt {
    if (!this.needsResume) return 'none';
    switch (this.resume) {
      case 'idle': return 'resume';
      case 'resuming': return 'resuming';
      case 'slow': return 'slow';
      case 'failed': return 'off';
    }
  }

  get controller(): Controller | null {
    return this.live?.controller ?? null;
  }

  get menu(): MenuSystem | null {
    return this.live?.menu ?? null;
  }

  get recorder(): Recorder | null {
    return this.live?.recorder ?? null;
  }

  get engine(): ShellEngine | null {
    return this.live?.engine ?? null;
  }

  /** Resolves once the stored system settings have been read (or failed to be). */
  ready(): Promise<void> {
    return this.preload;
  }

  /** Resolves when the power-on or power-off under way has finished. */
  settled(): Promise<void> {
    return this.transition;
  }

  /** Tells `fn` whenever the state, the error or the resume prompt changes. Returns the unsubscribe. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /**
   * The POWER control. Off: power on. On: switch off, or, while audio is lost, retry the resume (and switch off once a
   * retry has failed). Booting: abandon a boot that has run for ABORT_AFTER_MS. Ignored while stopping.
   */
  tap(): void {
    if (this.disposed) return;
    if (this._state === 'off') {
      this.powerOn();
      return;
    }
    if (this._state === 'booting') {
      const boot = this.boot;
      if (boot && performance.now() - boot.startedAt >= this.abortAfterMs) boot.abort();
      return;
    }
    const live = this.live;
    if (this._state !== 'on' || live === null) return;
    if (live.engine.needsResume) {
      if (this.resume === 'failed' || this.resume === 'slow') this.transition = this.powerOff(live);
      else this.retryResume();
      return;
    }
    this.transition = this.powerOff(live);
  }

  /**
   * A tap on the TAP POWER TO RESUME prompt: a retry (`resume({ retryMic: true })`), never an off. Ignored while a
   * retry is still running (the engine runs them one after another).
   */
  retryResume(): void {
    const live = this.live;
    if (this._state !== 'on' || live === null || !live.engine.needsResume) return;
    if (this.resume === 'resuming' || this.resume === 'slow') return;
    this.resume = 'resuming';
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = undefined;
      if (this.live !== live || this.resume !== 'resuming') return;
      this.resume = 'slow'; // no answer yet: POWER may switch off now
      this.emit();
    }, this.resumeOffAfterMs);
    this.emit();
    this.wake.ensure();
    live.engine
      .resume({ retryMic: true })
      .catch((e: unknown) => {
        console.error('resuming audio failed', e);
        return false;
      })
      .then((ok) => {
        if (this.live !== live) return;
        this.clearResumeTimer();
        this.resume = ok || !live.engine.needsResume ? 'idle' : 'failed';
        this.emit();
      });
  }

  /** Panel input: to the controller while on, nowhere otherwise. */
  handle(e: ControlEvent): void {
    if (this._state !== 'on' || this.live === null) return;
    this.live.controller.handle(e);
    if (e.kind === 'press') this.wake.ensure();
  }

  /** The recorder pod's REC (Backquote). */
  toggleRecord(): void {
    if (this._state !== 'on') return;
    this.live?.pod?.toggleRecord().catch((e: unknown) => console.error('recorder toggle failed', e));
  }

  /** What the panel shows at rAF time `t`: dark when off, the boot screen while booting, else the controller's state. */
  frame(t: number): PanelState {
    if (this._state === 'on' && this.live !== null) return this.live.controller.panelState(t);
    return this._state === 'booting' ? this.bootState : this.offState;
  }

  /** Stops listening and powers down at once (no clean shutdown is marked). For tests and teardown. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.deps.win?.removeEventListener('pagehide', this.onPageHide);
    this.deps.doc?.removeEventListener('visibilitychange', this.onVisibility);
    this.boot?.abort();
    this.clearResumeTimer();
    this.wake.dispose();
    const live = this.live;
    this.live = null;
    if (live) {
      void live.recorder.halt().catch(() => undefined);
      this.teardown(live);
      void live.engine.stop().catch(() => undefined);
    }
    this.listeners.clear();
  }

  // -------------------------------------------------------------------------------------------------------------------

  /** Opens the stores, keeping track of how the open goes. */
  private openStores(): StoresOpen {
    let p: Promise<ShellStores>;
    try {
      p = this.deps.openStores();
    } catch (e) {
      p = Promise.reject(e);
    }
    const open: StoresOpen = { p, state: 'pending', timedOut: false };
    p.then(
      () => {
        open.state = 'ok';
      },
      () => {
        open.state = 'failed';
      },
    );
    return open;
  }

  private powerOn(): void {
    this._error = null;
    this.switchedOff = false;
    this.keptCheckpoint = false;
    this.resume = 'idle';
    // A database that failed to open, or that the last power-on gave up on, is opened afresh (there is no reload in a
    // Home Screen app).
    const open = this.stores;
    if (open.state === 'failed' || (open.state === 'pending' && open.timedOut)) this.stores = this.openStores();
    this.bootState.contrast = this.system?.setup.contrast ?? 5;
    let abort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      abort = () => reject(new BootAborted());
    });
    aborted.catch(() => undefined); // nobody may be waiting on it when it fires
    const boot: Boot = { startedAt: performance.now(), aborted, abort };
    this.boot = boot;
    this.setState('booting');
    let starting: Promise<ShellEngine>;
    try {
      starting = this.deps.startEngine(this.system);
    } catch (e) {
      starting = Promise.reject(e);
    }
    this.wake.acquire(); // inside the tap too: Safari may want its activation
    this.transition = this.runBoot(boot, starting);
  }

  /** Waits for a storage step of the boot: its result, or a StorageTimeout, or BootAborted. */
  private storage<T>(boot: Boot, step: Promise<T>): Promise<T> {
    const ms = this.storageTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new StorageTimeout(ms)), ms);
      step.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e: unknown) => {
          clearTimeout(timer);
          reject(e);
        },
      );
      boot.aborted.catch((e: unknown) => {
        clearTimeout(timer);
        reject(e);
      });
    });
  }

  private async runBoot(boot: Boot, starting: Promise<ShellEngine>): Promise<void> {
    let engine: ShellEngine;
    try {
      engine = await Promise.race([starting, boot.aborted]);
    } catch (e) {
      if (e instanceof BootAborted) {
        // The engine may still come (the mic prompt is open): stop it when it does.
        starting.then((late) => late.stop()).catch(() => undefined);
        this.endBoot(boot, null);
        return;
      }
      console.error('the audio engine did not start', e);
      this.endBoot(boot, 'AUDIO ERROR');
      return;
    }

    let stores: ShellStores;
    const open = this.stores;
    try {
      stores = await this.storage(boot, open.p);
      // The system settings: a small read, timed out like the open. (Controller.boot reads them again, quickly.)
      await this.storage(boot, stores.system.load());
    } catch (e) {
      if (e instanceof StorageTimeout) open.timedOut = true;
      await this.abandon(boot, null, engine, e);
      return;
    }
    if (this.disposed) {
      await engine.stop().catch(() => undefined);
      return;
    }
    this.deps.requestPersistence?.().catch(() => undefined);

    // The menu is made first (it is the controller's LCD host); its mute callback reaches the controller made next.
    let controller: Controller | null = null;
    const menu: MenuSystem = new MenuSystem({
      onMute: (key) => {
        if (!MIXER_MIC_KEYS.includes(key)) return;
        controller?.setMixerMicMute(MIXER_MIC_KEYS.some((k) => menu.muted.has(k)));
      },
    });
    controller = new Controller(engine, stores, menu, {
      ...(this.deps.win ? { events: this.deps.win } : {}),
      restartMic: () => engine.restartMic(),
    });
    const recorder = new Recorder(engine, stores.takes, engine.ctx.sampleRate);
    const live: Live = { engine, stores, controller, menu, recorder, pod: null, offResume: () => undefined };
    this.live = live;
    live.offResume = engine.onNeedsResume((lost) => this.onNeedsResume(live, lost));

    let bootMessage: string | null = null;
    try {
      // Memory 01 and all its audio: no time limit (see the header); only a POWER tap abandons it.
      await Promise.race([controller.boot(1), boot.aborted]);
    } catch (e) {
      if (e instanceof BootAborted) {
        await this.abandon(boot, live, engine, e);
        return;
      }
      console.error('loading the settings or memory 01 failed', e);
      bootMessage = 'DATA READ ERR';
    }
    if (this.live !== live) return;
    menu.showStartScreen();
    try {
      await this.storage(boot, showBootPrompts(menu, controller, stores.recovery)); // reads the running flag first
    } catch (e) {
      await this.abandon(boot, live, engine, e);
      return;
    }
    if (this.live !== live) return;
    stores.recovery.markRunning().catch((e: unknown) => console.error('marking the session running failed', e));
    live.pod = this.deps.mountPod?.(recorder, controller) ?? null;
    this.syncPod();

    const left = boot.startedAt + this.bootMs - performance.now();
    try {
      if (left > 0) await Promise.race([sleep(left), boot.aborted]);
    } catch (e) {
      await this.abandon(boot, live, engine, e);
      return;
    }
    if (this.live !== live) return;
    this.boot = null;
    this.setState('on');
    // A message raised while the boot screen was up has mostly expired under it: NO INPUT is shown again, in full.
    if (bootMessage !== null) controller.showMessage(bootMessage);
    else if (!engine.micAvailable) controller.showMessage('NO INPUT');
  }

  /** Gives up a power-on: everything made so far goes and the engine stops. STORAGE ERROR unless a tap asked for it. */
  private async abandon(boot: Boot, live: Live | null, engine: ShellEngine, reason: unknown): Promise<void> {
    const byTap = reason instanceof BootAborted;
    if (!byTap) console.error('power-on gave up: storage did not answer', reason);
    if (live) {
      if (this.live === live) this.live = null;
      this.teardown(live);
    }
    await engine.stop().catch(() => undefined);
    this.endBoot(boot, byTap ? null : 'STORAGE ERROR');
  }

  /** The boot is over without the unit coming on: off, with `error` (or none). */
  private endBoot(boot: Boot, error: string | null): void {
    if (this.boot !== boot) return;
    this.boot = null;
    this.wake.release();
    this.live = null;
    this._error = error;
    this.setState('off');
  }

  private async powerOff(live: Live): Promise<void> {
    this.switchedOff = true;
    // RECOVER? unanswered (R68): the crashed session's checkpoint stays for the next power-on.
    const keep = live.controller.recoveryPending;
    this.keptCheckpoint = keep;
    this.setState('stopping');
    this.wake.release();
    // Marks POWER off at once (no checkpoint after this), then saves and marks the clean shutdown (unless kept).
    const saved = live.controller
      .powerOff({ keepCheckpoint: keep })
      .catch((e: unknown) => console.error('saving at power off failed', e));
    if (live.recorder.state !== 'idle') {
      await live.recorder.stop().catch((e: unknown) => console.error('ending the take at power off failed', e));
    }
    await saved;
    this.system = structuredClone(live.controller.session.system); // for the next power-on in this page
    this.teardown(live);
    await live.engine.stop().catch((e: unknown) => console.error('stopping the engine failed', e));
    if (this.live === live) this.live = null;
    this.clearResumeTimer();
    this.resume = 'idle';
    this.setState('off');
  }

  private clearResumeTimer(): void {
    clearTimeout(this.resumeTimer);
    this.resumeTimer = undefined;
  }

  private teardown(live: Live): void {
    live.offResume();
    live.pod?.dispose();
    live.pod = null;
    live.controller.dispose();
    live.menu.dispose();
  }

  private onNeedsResume(live: Live, lost: boolean): void {
    if (this.live !== live) return;
    // The audio thread is gone: a stop() would wait for statuses that will not come. End the take with what it has.
    if (lost) live.recorder.halt().catch((e: unknown) => console.error('halting the take failed', e));
    else {
      this.clearResumeTimer();
      this.resume = 'idle';
    }
    this.emit();
  }

  /** REC and LOOP MIX only while the unit is on with its audio running. */
  private syncPod(): void {
    const live = this.live;
    live?.pod?.setEnabled(this._state === 'on' && !live.engine.needsResume);
  }

  private readonly onPageHide = (): void => {
    // Only a POWER off is a clean shutdown. Otherwise the running flag stays, so a crash offers RECOVER next time.
    if (!this.switchedOff || this.keptCheckpoint) return;
    this.stores.p
      .then((s) => s.recovery.markCleanShutdown())
      .catch((e: unknown) => console.error('marking the clean shutdown failed', e));
  };

  private readonly onVisibility = (): void => {
    if (this.deps.doc?.visibilityState === 'hidden' && this._state === 'on') this.live?.controller.onPageHide();
  };

  private setState(s: PowerState): void {
    this._state = s;
    this.emit();
  }

  private emit(): void {
    this.syncPod();
    for (const fn of [...this.listeners]) {
      try {
        fn();
      } catch (e) {
        console.error('power listener failed', e);
      }
    }
  }
}
