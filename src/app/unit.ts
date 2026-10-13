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
 * POWER off (a tap while on): the running take is completed (`recorder.stop()`) before anything is torn down, the
 *   system settings are saved and a clean shutdown is marked (`Controller.powerOff`, which also drops the recovery
 *   checkpoint, ruling R16), then the pod, controller and menu go and the engine stops.
 * Audio lost (the engine's `needsResume`): the running take is halted at once, and the shell shows TAP POWER TO
 *   RESUME; a tap on POWER then calls `resume({ retryMic: true })` instead of switching off.
 * Page hide: only after a POWER off is it a clean shutdown (`markCleanShutdown`). While on, the running flag stays set,
 *   so a crash or a closed app offers RECOVER next time; the controller checkpoints unsaved work on `pagehide` itself,
 *   and the unit has it do the same when the page goes hidden (iPadOS may end a hidden app without a pagehide).
 * Wake lock: asked for at power-on (inside the tap), again when the page is visible again and on panel presses while
 *   none is held, and let go at power off.
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
  dispose(): void;
}

export interface UnitDeps {
  /** The stores, opening (the app opens them at load, before any tap). */
  stores: Promise<ShellStores>;
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
  /** The stored system settings, read ahead of the tap so the engine opens the mic with the right MIC PROCESS. */
  private system: SystemSettings | undefined;
  /** The last power-off came from the POWER control (and the unit has not been switched on since). */
  private switchedOff = false;
  private transition: Promise<void> = Promise.resolve();
  private readonly preload: Promise<void>;
  private readonly listeners = new Set<() => void>();
  private readonly wake: WakeLockKeeper;
  private readonly bootMs: number;
  private readonly offState = darkPanel(new Uint8Array(LCD_W * LCD_H));
  private readonly bootState: PanelState;
  private disposed = false;

  constructor(private readonly deps: UnitDeps) {
    this.bootMs = deps.bootMs ?? BOOT_MS;
    const fb = new Framebuffer();
    drawBootScreen(fb);
    this.bootState = darkPanel(fb.data);
    this.wake = new WakeLockKeeper(deps.wakeLock, deps.doc ?? null);
    this.preload = deps.stores
      .then((s) => s.system.load())
      .then(
        (sys) => {
          this.system = sys;
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

  /** Tells `fn` whenever the state, the error or `needsResume` changes. Returns the unsubscribe. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** The POWER control. Off: power on. On: resume when audio is lost, else power off. Ignored while booting or stopping. */
  tap(): void {
    if (this.disposed) return;
    if (this._state === 'off') {
      this.powerOn();
      return;
    }
    const live = this.live;
    if (this._state !== 'on' || live === null) return;
    if (live.engine.needsResume) {
      this.wake.ensure();
      live.engine.resume({ retryMic: true }).catch((e: unknown) => console.error('resuming audio failed', e));
      return;
    }
    this.transition = this.powerOff(live);
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

  private powerOn(): void {
    this._error = null;
    this.switchedOff = false;
    this.bootState.contrast = this.system?.setup.contrast ?? 5;
    this.setState('booting');
    const t0 = performance.now();
    let starting: Promise<ShellEngine>;
    try {
      starting = this.deps.startEngine(this.system);
    } catch (e) {
      starting = Promise.reject(e);
    }
    this.wake.acquire(); // inside the tap too: Safari may want its activation
    this.transition = this.boot(starting, t0);
  }

  private async boot(starting: Promise<ShellEngine>, t0: number): Promise<void> {
    let engine: ShellEngine;
    try {
      engine = await starting;
    } catch (e) {
      console.error('the audio engine did not start', e);
      this.fail('AUDIO ERROR');
      return;
    }
    let stores: ShellStores;
    try {
      stores = await this.deps.stores;
    } catch (e) {
      console.error('storage did not open', e);
      await engine.stop().catch(() => undefined);
      this.fail('STORAGE ERROR');
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
      await controller.boot(1);
    } catch (e) {
      console.error('loading the settings or memory 01 failed', e);
      bootMessage = 'DATA READ ERR';
    }
    if (this.live !== live) return;
    menu.showStartScreen();
    await showBootPrompts(menu, controller, stores.recovery); // reads the running flag before it is set below
    if (this.live !== live) return;
    stores.recovery.markRunning().catch((e: unknown) => console.error('marking the session running failed', e));
    live.pod = this.deps.mountPod?.(recorder, controller) ?? null;

    const left = t0 + this.bootMs - performance.now();
    if (left > 0) await sleep(left);
    if (this.live !== live) return;
    this.setState('on');
    // A message raised while the boot screen was up has mostly expired under it: NO INPUT is shown again, in full.
    if (bootMessage !== null) controller.showMessage(bootMessage);
    else if (!engine.micAvailable) controller.showMessage('NO INPUT');
  }

  private async powerOff(live: Live): Promise<void> {
    this.switchedOff = true;
    this.setState('stopping');
    this.wake.release();
    // Marks POWER off at once (no checkpoint after this), then saves and marks the clean shutdown.
    const saved = live.controller.powerOff().catch((e: unknown) => console.error('saving at power off failed', e));
    if (live.recorder.state !== 'idle') {
      await live.recorder.stop().catch((e: unknown) => console.error('ending the take at power off failed', e));
    }
    await saved;
    this.teardown(live);
    await live.engine.stop().catch((e: unknown) => console.error('stopping the engine failed', e));
    if (this.live === live) this.live = null;
    this.setState('off');
  }

  private teardown(live: Live): void {
    live.offResume();
    live.pod?.dispose();
    live.pod = null;
    live.controller.dispose();
    live.menu.dispose();
  }

  private fail(error: string): void {
    this.wake.release();
    this.live = null;
    this._error = error;
    this.setState('off');
  }

  private onNeedsResume(live: Live, lost: boolean): void {
    if (this.live !== live) return;
    // The audio thread is gone: a stop() would wait for statuses that will not come. End the take with what it has.
    if (lost) live.recorder.halt().catch((e: unknown) => console.error('halting the take failed', e));
    this.emit();
  }

  private readonly onPageHide = (): void => {
    // Only a POWER off is a clean shutdown. Otherwise the running flag stays, so a crash offers RECOVER next time.
    if (!this.switchedOff) return;
    this.deps.stores
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
    for (const fn of [...this.listeners]) {
      try {
        fn();
      } catch (e) {
        console.error('power listener failed', e);
      }
    }
  }
}
