import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getLoopMixRenderer } from '../../src/app/renderAdapter';
import { SageUnit, openStores } from '../../src/app/unit';
import type { PodHandle, ShellEngine, ShellStores, UnitDeps } from '../../src/app/unit';
import type { WakeLockApi, WakeLockSentinelLike } from '../../src/app/wakeLock';
import { FakeEngine, makeStatus } from '../../src/control/fakeEngine';
import { Framebuffer } from '../../src/lcd/framebuffer';
import { drawBootScreen } from '../../src/lcd/screens/boot';
import { RECOVER_PROMPT } from '../../src/lcd/screens/recover';
import { defaultMemory, defaultSystem } from '../../src/schema/params';
import type { SystemSettings } from '../../src/schema/types';
import type { ControlEvent, ButtonId } from '../../src/shared/ids';
import type { EngineCommand } from '../../src/shared/protocol';

// ---------------------------------------------------------------------------------------------------------- fakes

/** EngineHost as the shell sees it: FakeEngine plus needsResume, resume, restartMic and stop. */
class ShellFake extends FakeEngine implements ShellEngine {
  readonly ctx = { sampleRate: 48000 };
  micAvailable = true;
  needsResume = false;
  readonly resumes: { retryMic?: boolean }[] = [];
  /** What `resume` brings back. */
  resumeWorks = true;
  restarts = 0;
  stopped = false;
  private frame = 0;
  private readonly resumeHandlers = new Set<(v: boolean) => void>();

  constructor(private readonly log: string[] = []) {
    super();
  }

  override send(cmd: EngineCommand, eventTime?: number): void {
    super.send(cmd, eventTime);
    if (cmd.t === 'recorder') {
      // Answer like the worklet: a status showing the recorder running, or off.
      const on = cmd.on;
      queueMicrotask(() => {
        this.frame += 4096;
        this.emit({ t: 'status', status: makeStatus({ frame: this.frame, recorderFrames: on ? this.frame : null }) });
      });
    }
  }

  onNeedsResume(h: (v: boolean) => void): () => void {
    this.resumeHandlers.add(h);
    return () => {
      this.resumeHandlers.delete(h);
    };
  }

  setNeedsResume(v: boolean): void {
    this.needsResume = v;
    for (const h of [...this.resumeHandlers]) h(v);
  }

  async resume(opts: { retryMic?: boolean } = {}): Promise<boolean> {
    this.resumes.push(opts);
    if (this.resumeWorks) this.setNeedsResume(false);
    return this.resumeWorks;
  }

  async restartMic(): Promise<void> {
    this.restarts++;
  }

  async stop(): Promise<void> {
    this.log.push('engine.stop');
    this.stopped = true;
  }
}

class FakeSentinel implements WakeLockSentinelLike {
  released = false;
  async release(): Promise<void> {
    this.released = true;
  }
}

class FakeWakeLock implements WakeLockApi {
  requests = 0;
  readonly sentinels: FakeSentinel[] = [];
  async request(): Promise<WakeLockSentinelLike> {
    this.requests++;
    const s = new FakeSentinel();
    this.sentinels.push(s);
    return s;
  }
}

class FakeDoc extends EventTarget {
  visibilityState: 'visible' | 'hidden' = 'visible';
  set(v: 'visible' | 'hidden'): void {
    this.visibilityState = v;
    this.dispatchEvent(new Event('visibilitychange'));
  }
}

class FakePod implements PodHandle {
  toggles = 0;
  disposed = false;
  constructor(private readonly log: string[]) {}
  async toggleRecord(): Promise<void> {
    this.toggles++;
  }
  dispose(): void {
    this.log.push('pod.dispose');
    this.disposed = true;
  }
}

let dbSeq = 0;
const units: SageUnit[] = [];
afterEach(() => {
  for (const u of units.splice(0)) u.dispose();
});

interface RigOptions {
  /** Prepares the database before the unit opens it. */
  seed?: (stores: ShellStores) => Promise<void>;
  engine?: (log: string[]) => ShellFake;
  startEngine?: UnitDeps['startEngine'];
  bootMs?: number;
}

async function rig(opts: RigOptions = {}) {
  const log: string[] = [];
  const stores = await openStores(`unit-test-${dbSeq++}`);
  await opts.seed?.(stores);
  const engine = opts.engine?.(log) ?? new ShellFake(log);
  const win = new EventTarget();
  const doc = new FakeDoc();
  const wakeLock = new FakeWakeLock();
  const pods: FakePod[] = [];
  const started: (SystemSettings | undefined)[] = [];
  const startEngine = vi.fn(
    opts.startEngine ??
      ((system: SystemSettings | undefined) => {
        started.push(system);
        return Promise.resolve(engine);
      }),
  );
  const requestPersistence = vi.fn(async () => true);
  const unit = new SageUnit({
    stores: Promise.resolve(stores),
    startEngine,
    requestPersistence,
    mountPod: () => {
      const p = new FakePod(log);
      pods.push(p);
      return p;
    },
    win,
    doc,
    wakeLock,
    bootMs: opts.bootMs ?? 20,
  });
  units.push(unit);
  await unit.ready(); // the stored system settings are read ahead of the POWER tap
  return { unit, stores, engine, win, doc, wakeLock, pods, started, startEngine, requestPersistence, log };
}

type Rig = Awaited<ReturnType<typeof rig>>;

async function powerOn(r: Rig): Promise<void> {
  r.unit.tap();
  await r.unit.settled();
}

const press = (r: Rig, id: ButtonId, t = 0): void => {
  r.unit.handle({ kind: 'press', id, t } satisfies ControlEvent);
  r.unit.handle({ kind: 'release', id, t: t + 30 } satisfies ControlEvent);
};

const calibrated = (): SystemSettings => {
  const s = defaultSystem();
  s.setup.latency = 480;
  return s;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------------------- power-on

describe('SageUnit: POWER on', () => {
  it('starts off: a dark panel, and panel input goes nowhere', async () => {
    const r = await rig();
    expect(r.unit.state).toBe('off');
    const s = r.unit.frame(0);
    expect(s.lcd.every((p) => p === 0)).toBe(true);
    expect(Object.values(s.leds).filter((l) => l && l.color !== 'off')).toEqual([]);
    expect(s.rings.every((ring) => ring.color === 'off')).toBe(true);
    press(r, 'trk1.rec');
    expect(r.engine.sent).toEqual([]);
  });

  it('the tap starts the engine at once (its AudioContext needs the tap), with the stored system settings', async () => {
    const r = await rig({
      seed: async (s) => {
        const sys = calibrated();
        sys.setup.micProcess = true;
        await s.system.save(sys);
      },
    });
    r.unit.tap();
    expect(r.startEngine).toHaveBeenCalledTimes(1); // synchronously, inside the tap
    expect(r.started[0]?.setup.micProcess).toBe(true);
    expect(r.unit.state).toBe('booting');
    await r.unit.settled();
  });

  it('shows the boot screen until it has been up for the boot time, then the play screen', async () => {
    const r = await rig({ seed: (s) => s.system.save(calibrated()), bootMs: 120 });
    const t0 = performance.now();
    r.unit.tap();
    const boot = new Framebuffer();
    drawBootScreen(boot);
    expect(Array.from(r.unit.frame(0).lcd)).toEqual(Array.from(boot.data));
    press(r, 'trk1.rec'); // ignored while booting
    await r.unit.settled();
    expect(performance.now() - t0).toBeGreaterThanOrEqual(110);
    expect(r.unit.state).toBe('on');
    expect(r.engine.commands('micMute')).toEqual([]);
    expect(r.unit.menu!.depth).toBe(1); // the play screen: calibrated, so no prompt
    expect(Array.from(r.unit.frame(1).lcd)).not.toEqual(Array.from(boot.data));
  });

  it('loads the system settings and memory 01 into the engine, and asks for persistent storage', async () => {
    const r = await rig({
      seed: async (s) => {
        await s.system.save(calibrated());
        const m = defaultMemory();
        m.tempo = 97;
        await s.memories.save(1, m, [null, null, null, null, null]);
      },
    });
    await powerOn(r);
    expect(r.unit.controller!.session.slot).toBe(1);
    expect(r.engine.last('settings')!.memory.tempo).toBe(97);
    expect(r.engine.last('settings')!.system.setup.latency).toBe(480);
    expect(r.engine.commands('loadTrack')).toHaveLength(5);
    expect(r.requestPersistence).toHaveBeenCalled();
  });

  it('first run: the CALIBRATE? prompt is up once powered on', async () => {
    const r = await rig();
    await powerOn(r);
    expect(r.unit.menu!.top.title).toBe('LATENCY');
    press(r, 'exit');
    expect(r.unit.menu!.depth).toBe(1);
  });

  it('after a crash with unsaved work: RECOVER? on top (CALIBRATE? under it); the session is marked running after the check', async () => {
    const r = await rig({
      seed: async (s) => {
        await s.recovery.markRunning();
        await s.recovery.checkpoint(1, defaultMemory(), [null, null, null, null, null]);
      },
    });
    await powerOn(r);
    const top = r.unit.menu!.top as { title: string; text?: string };
    expect(top.title).toBe('RECOVER');
    expect(top.text).toBe(RECOVER_PROMPT);
    press(r, 'exit'); // discard
    expect(r.unit.menu!.top.title).toBe('LATENCY');
  });

  it('a clean start sets the running flag, so a crash from now on is noticed', async () => {
    const r = await rig({ seed: (s) => s.system.save(calibrated()) });
    expect(await r.stores.recovery.needsRecovery()).toBe(false);
    await powerOn(r);
    await sleep(10);
    await r.stores.recovery.checkpoint(1, defaultMemory(), [null, null, null, null, null]);
    expect(await r.stores.recovery.needsRecovery()).toBe(true); // running flag set
  });

  it('no mic: NO INPUT is on the LCD once the boot screen has gone, and the menus still work', async () => {
    const r = await rig({
      seed: (s) => s.system.save(calibrated()),
      engine: (log) => {
        const e = new ShellFake(log);
        e.micAvailable = false;
        return e;
      },
    });
    await powerOn(r);
    expect(r.unit.controller!.message).toBe('NO INPUT');
    expect(r.unit.needsResume).toBe(false); // no mic at power-on is not lost audio
    press(r, 'menu');
    expect(r.unit.menu!.top.title).toBe('MENU');
  });

  it('a failed engine start goes back to off and says why', async () => {
    const r = await rig({ startEngine: () => Promise.reject(new Error('no worklet')) });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await powerOn(r);
    expect(r.unit.state).toBe('off');
    expect(r.unit.error).toBe('AUDIO ERROR');
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('a tap while booting does nothing', async () => {
    const r = await rig();
    r.unit.tap();
    r.unit.tap();
    expect(r.startEngine).toHaveBeenCalledTimes(1);
    await r.unit.settled();
    expect(r.unit.state).toBe('on');
  });
});

// ---------------------------------------------------------------------------------------------------------- wiring

describe('SageUnit: wiring', () => {
  it('panel input reaches the controller once on', async () => {
    const r = await rig({ seed: (s) => s.system.save(calibrated()) });
    await powerOn(r);
    r.engine.reset();
    r.unit.handle({ kind: 'press', id: 'trk1.rec', t: 5 });
    expect(r.engine.types()).toContain('recPlay');
  });

  it('the MIXER mute of MIC 1 really mutes the mic (MenuOptions.onMute -> micMute, ruling R34)', async () => {
    const r = await rig({ seed: (s) => s.system.save(calibrated()) });
    await powerOn(r);
    r.engine.reset();
    press(r, 'enter'); // the play screen's ENTER opens the MIXER
    expect(r.unit.menu!.top.title).toBe('MIXER');
    press(r, 'knob1'); // pushing MIC 1's knob mutes it
    expect(r.unit.menu!.muted.has('mic1In')).toBe(true);
    expect(r.engine.last('micMute')).toEqual({ t: 'micMute', on: true });
    press(r, 'knob1');
    expect(r.engine.last('micMute')).toEqual({ t: 'micMute', on: false });
    r.unit.menu!.setMuted(['inst1LIn'], true); // other inputs have no signal in the app: the mic is untouched
    expect(r.engine.commands('micMute')).toHaveLength(2);
  });

  it('the controller reopens the mic through the engine when MIC PROCESS changes (restartMic hook)', async () => {
    const r = await rig({ seed: (s) => s.system.save(calibrated()) });
    await powerOn(r);
    r.unit.controller!.setParam('setup.micProcess', true);
    expect(r.engine.restarts).toBe(1);
  });

  it('Backquote (toggleRecord) goes to the recorder pod, mounted at power-on', async () => {
    const r = await rig({ seed: (s) => s.system.save(calibrated()) });
    r.unit.toggleRecord(); // off: nothing to toggle
    await powerOn(r);
    expect(r.pods).toHaveLength(1);
    r.unit.toggleRecord();
    expect(r.pods[0]!.toggles).toBe(1);
  });

  it('LOOP MIX has no mixer until Task 9 (ruling R56)', () => {
    expect(getLoopMixRenderer()).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------- resume

describe('SageUnit: TAP POWER TO RESUME', () => {
  it('when audio is lost: the prompt is asked for and the running take is halted', async () => {
    const r = await rig({ seed: (s) => s.system.save(calibrated()) });
    await powerOn(r);
    const halt = vi.spyOn(r.unit.recorder!, 'halt');
    let changes = 0;
    r.unit.onChange(() => changes++);
    expect(r.unit.needsResume).toBe(false);
    r.engine.setNeedsResume(true);
    expect(r.unit.needsResume).toBe(true);
    expect(changes).toBeGreaterThan(0);
    expect(halt).toHaveBeenCalled();
  });

  it('POWER then resumes (mic and context again) instead of switching off; the prompt goes when audio is back', async () => {
    const r = await rig({ seed: (s) => s.system.save(calibrated()) });
    await powerOn(r);
    r.engine.setNeedsResume(true);
    r.engine.resumeWorks = false;
    r.unit.tap();
    await sleep(0);
    expect(r.engine.resumes).toEqual([{ retryMic: true }]);
    expect(r.unit.state).toBe('on');
    expect(r.unit.needsResume).toBe(true); // still lost: the prompt stays
    r.engine.resumeWorks = true;
    r.unit.tap();
    await sleep(0);
    expect(r.engine.resumes).toHaveLength(2);
    expect(r.unit.needsResume).toBe(false);
    expect(r.engine.stopped).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------- power-off

describe('SageUnit: POWER off and page hide', () => {
  it('a page hidden while on keeps the running flag (a crash shows RECOVER) and checkpoints unsaved work', async () => {
    const r = await rig({ seed: (s) => s.system.save(calibrated()) });
    await powerOn(r);
    const clean = vi.spyOn(r.stores.recovery, 'markCleanShutdown');
    r.unit.controller!.setParam('track.*.pan', 25, 0); // unsaved work
    r.win.dispatchEvent(new Event('pagehide'));
    await sleep(20);
    expect(clean).not.toHaveBeenCalled();
    expect(await r.stores.recovery.needsRecovery()).toBe(true);
    expect((await r.stores.recovery.take())!.settings.track[0]!.pan).toBe(25);
  });

  it('going hidden checkpoints too (iPadOS may end a hidden app without a pagehide)', async () => {
    const r = await rig({ seed: (s) => s.system.save(calibrated()) });
    await powerOn(r);
    r.unit.controller!.setParam('track.*.pan', 30, 0);
    r.doc.set('hidden');
    await sleep(20);
    expect((await r.stores.recovery.take())!.settings.track[0]!.pan).toBe(30);
  });

  it('POWER off is a clean shutdown: the take is completed before the engine stops, and a later pagehide marks clean again', async () => {
    const r = await rig({ seed: (s) => s.system.save(calibrated()) });
    await powerOn(r);
    r.unit.controller!.setParam('track.*.pan', 25, 0);
    const recorder = r.unit.recorder!;
    await recorder.start();
    const realStop = recorder.stop.bind(recorder);
    const stop = vi.spyOn(recorder, 'stop').mockImplementation(() => {
      r.log.push('recorder.stop');
      return realStop();
    });
    const clean = vi.spyOn(r.stores.recovery, 'markCleanShutdown');

    r.unit.tap();
    expect(r.unit.state).toBe('stopping');
    expect(r.unit.frame(0).lcd.every((p) => p === 0)).toBe(true); // dark at once
    await r.unit.settled();
    expect(r.unit.state).toBe('off');
    expect(stop).toHaveBeenCalled();
    expect(r.log).toEqual(['recorder.stop', 'pod.dispose', 'engine.stop']);
    expect(recorder.state).toBe('idle');
    expect(recorder.lastTakeId).not.toBeNull();
    expect(clean).toHaveBeenCalledTimes(1);
    expect(await r.stores.recovery.needsRecovery()).toBe(false);

    r.win.dispatchEvent(new Event('pagehide'));
    await sleep(10);
    expect(clean).toHaveBeenCalledTimes(2);
  });

  it('after POWER off the unit is off: input goes nowhere, and POWER boots it again (RECOVER is not offered)', async () => {
    const engines: ShellFake[] = [];
    const r = await rig({
      seed: (s) => s.system.save(calibrated()),
      startEngine: () => {
        const e = new ShellFake();
        engines.push(e);
        return Promise.resolve(e);
      },
    });
    await powerOn(r);
    r.unit.controller!.setParam('track.*.pan', 25, 0);
    r.unit.tap();
    await r.unit.settled();
    press(r, 'trk1.rec');
    expect(engines[0]!.commands('recPlay')).toEqual([]);
    await powerOn(r);
    expect(r.unit.state).toBe('on');
    expect(engines).toHaveLength(2);
    expect(r.unit.menu!.depth).toBe(1);
    // a pagehide while on again is not a clean shutdown any more
    const clean = vi.spyOn(r.stores.recovery, 'markCleanShutdown');
    r.win.dispatchEvent(new Event('pagehide'));
    await sleep(10);
    expect(clean).not.toHaveBeenCalled();
  });

  it('wake lock: asked for at power-on, again when visible after a hide, and let go at power off', async () => {
    const r = await rig({ seed: (s) => s.system.save(calibrated()) });
    await powerOn(r);
    expect(r.wakeLock.requests).toBe(1);
    r.doc.set('hidden');
    r.wakeLock.sentinels[0]!.released = true; // the browser drops it while hidden
    r.doc.set('visible');
    await sleep(0);
    expect(r.wakeLock.requests).toBe(2);
    r.unit.tap();
    await r.unit.settled();
    expect(r.wakeLock.sentinels[1]!.released).toBe(true);
    r.doc.set('hidden');
    r.doc.set('visible');
    expect(r.wakeLock.requests).toBe(2);
  });
});
