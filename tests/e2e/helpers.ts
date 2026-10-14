/**
 * User flows the end-to-end scenario specs share (manual.walkthroughs, memory.roundtrip, keyboard), built on app.ts.
 *
 * Every action goes in the way that user would make it:
 *  - `Panel` drives the panel by touch on the iPad (WebKit) and by mouse on the desktop (Chromium). Taps are real
 *    taps / clicks. A knob turn is a drag on the encoder: the real mouse in Chromium; in WebKit synthetic touch
 *    PointerEvents (Playwright has no touch drag there), as input.spec.ts does. EXIT + ENTER together is two fingers on
 *    the iPad and Esc + Enter on the desktop (a mouse cannot hold two buttons).
 *  - What the unit is doing is read where the existing specs read it, through the dev-only `window.__sage` hook: the
 *    engine status the controller holds (track state and length), the session, the menu stack, the panel state's LEDs.
 * Waits are on the engine's own clock (`waitAudio`) or on a state, never a bare timeout.
 */
import { expect, type Download, type Page } from '@playwright/test';
import type { Blink, LedColor } from '../../src/shared/panel';
import type { ButtonId, EncoderId } from '../../src/shared/ids';
import type { TrackState } from '../../src/shared/protocol';
import { DETENT_PX } from '../../src/ui/input/gestures';
import { ledColor, menuDepth, powerState, powerSwitch, pressControl, tap, topScreen } from './app';
import { fingers } from './touch';

/** Node's Buffer (the specs run in Node; the project has no Node typings). */
declare const Buffer: {
  from(data: string, encoding: 'base64'): Uint8Array;
  concat(list: readonly Uint8Array[]): Uint8Array;
};


// ------------------------------------------------------------------------------------------------ reading the unit

/** One track as the engine status reports it. */
export interface TrackView {
  state: TrackState;
  pending: 'rec' | 'dub' | 'play' | 'stop' | null;
  /** Loop length in frames (grows while recording). */
  length: number;
  measures: number | null;
  canUndo: boolean;
  canRedo: boolean;
}

/** The five tracks from the latest engine status (empty tracks before the first status). */
export const tracks = (page: Page): Promise<TrackView[]> =>
  page.evaluate(() => {
    const st = window.__sage!.unit.controller?.status;
    if (!st) return [0, 1, 2, 3, 4].map(() => ({ state: 'empty' as const, pending: null, length: 0, measures: null, canUndo: false, canRedo: false }));
    return st.tracks.map((t) => ({ state: t.state, pending: t.pending, length: t.lengthFrames, measures: t.measures, canUndo: t.canUndo, canRedo: t.canRedo }));
  });

export const trackState = async (page: Page, k: number): Promise<TrackState> => (await tracks(page))[k]!.state;
export const trackLength = async (page: Page, k: number): Promise<number> => (await tracks(page))[k]!.length;

/** The engine's sample rate and the timeline frame of its latest status. */
const clock = (page: Page): Promise<{ sr: number; frame: number }> =>
  page.evaluate(() => {
    const st = window.__sage!.unit.controller!.status!;
    return { sr: st.sampleRate, frame: st.frame };
  });

/** Waits until the engine has rendered `seconds` more audio: its own clock, not a stopwatch. */
export async function waitAudio(page: Page, seconds: number): Promise<void> {
  const { sr, frame } = await clock(page);
  const until = frame + seconds * sr;
  await expect.poll(async () => (await clock(page)).frame >= until, { timeout: seconds * 1000 + 10_000, intervals: [20] }).toBe(true);
}

/** Waits until track `k`'s recording has `seconds` of audio in it. */
export async function waitRecorded(page: Page, k: number, seconds: number): Promise<void> {
  const { sr } = await clock(page);
  await expect.poll(() => trackLength(page, k), { timeout: seconds * 1000 + 10_000, intervals: [20] }).toBeGreaterThanOrEqual(seconds * sr);
}

export async function expectTrack(page: Page, k: number, state: TrackState, timeout = 10_000): Promise<void> {
  await expect.poll(() => trackState(page, k), { timeout, intervals: [20] }).toBe(state);
}

/** The LED as the controller's panel state has it now: colour and blink. */
export const ledState = (page: Page, id: ButtonId): Promise<{ color: LedColor; blink: Blink }> =>
  page.evaluate((id) => {
    const led = window.__sage!.unit.frame(performance.now()).leds[id];
    return { color: led?.color ?? 'off', blink: led?.blink ?? 'none' };
  }, id);

/**
 * Waits until the LED is steadily `color` (not blinking: an armed action blinks in the colour it will take), as the
 * panel state has it and as the panel shows it.
 */
export async function expectSteady(page: Page, id: ButtonId, color: LedColor, timeout = 10_000): Promise<void> {
  await expect.poll(() => ledState(page, id), { timeout, intervals: [20] }).toEqual({ color, blink: 'none' });
  await expect.poll(() => ledColor(page, id), { timeout, intervals: [20] }).toBe(color);
}

export const session = (page: Page): Promise<{ slot: number; dirty: boolean; pan: number[] }> =>
  page.evaluate(() => {
    const s = window.__sage!.unit.controller!.session;
    return { slot: s.slot, dirty: s.dirty, pan: s.memory.track.map((t) => t.pan) };
  });

/** A property of the screen on top of the menu stack (the STORAGE screen's `prompt` and `importSlot`). */
export const topProp = <T>(page: Page, key: string): Promise<T | undefined> =>
  page.evaluate((key) => (window.__sage!.unit.menu?.top as unknown as Record<string, unknown> | undefined)?.[key], key) as Promise<T | undefined>;

// ------------------------------------------------------------------------------------------------ touch and mouse

/** The centre of a panel control, in CSS px. */
async function centre(page: Page, id: ButtonId | EncoderId): Promise<{ x: number; y: number }> {
  const box = await page.locator(`[data-id="${id}"]`).boundingBox();
  if (!box) throw new Error(`${id} is not on screen`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

let nextFinger = 100;

/** The panel as a hand works it: touch on the iPad (WebKit), the mouse on the desktop (Chromium). */
export class Panel {
  constructor(
    private readonly page: Page,
    private readonly browserName: string,
  ) {}

  get touch(): boolean {
    return this.browserName === 'webkit';
  }

  /** A tap (iPad) or a click (desktop). */
  press(id: ButtonId): Promise<void> {
    return pressControl(this.page, id, this.browserName);
  }

  /** Turns an encoder `steps` detents (+ is clockwise): a quick vertical drag on it, up is +. */
  async turn(id: EncoderId, steps: number): Promise<void> {
    if (steps === 0) return;
    const p = await centre(this.page, id);
    const dy = -Math.sign(steps) * (Math.abs(steps) * DETENT_PX + DETENT_PX / 2);
    if (!this.touch) {
      const m = this.page.mouse;
      await m.move(p.x, p.y);
      await m.down();
      await m.move(p.x, p.y + dy); // one move, well inside the hold time: a turn, not a push
      await m.up();
      return;
    }
    // Down, move and up in one page round trip: a stall between them could pass HOLD_MS and make a push-and-turn.
    const f = nextFinger++;
    await fingers(this.page, [
      { type: 'pointerdown', id: f, x: p.x, y: p.y, primary: true },
      { type: 'pointermove', id: f, x: p.x, y: p.y + dy, primary: true },
      { type: 'pointerup', id: f, x: p.x, y: p.y + dy, primary: true },
    ]);
  }

  /** EXIT and ENTER pressed together (Owner's Manual p. 12): two fingers on the iPad, Esc + Enter on the desktop. */
  async exitEnter(): Promise<void> {
    if (!this.touch) {
      const k = this.page.keyboard;
      await k.down('Escape');
      await k.down('Enter');
      await k.up('Enter');
      await k.up('Escape');
      return;
    }
    const a = await centre(this.page, 'exit');
    const b = await centre(this.page, 'enter');
    const fa = nextFinger++, fb = nextFinger++;
    await fingers(this.page, [
      { type: 'pointerdown', id: fa, x: a.x, y: a.y, primary: true },
      { type: 'pointerdown', id: fb, x: b.x, y: b.y, primary: false },
      { type: 'pointerup', id: fb, x: b.x, y: b.y, primary: false },
      { type: 'pointerup', id: fa, x: a.x, y: a.y, primary: true },
    ]);
  }
}

// ------------------------------------------------------------------------------------------------ flows

/**
 * POWER on (a returning page has no CALIBRATE? offer; a fresh one does, and it is dismissed with EXIT). The wait is
 * generous: the 3 s product bound is power.spec's to check, under its own measurement; here a loaded machine only
 * has to get there.
 */
export async function powerOn(page: Page, browserName: string, dismiss: () => Promise<void>): Promise<void> {
  await tap(page, powerSwitch(page), browserName);
  await expect.poll(() => powerState(page), { timeout: 20_000, intervals: [20] }).toBe('on');
  if ((await topScreen(page)) === 'LATENCY') {
    await dismiss(); // the first-run CALIBRATE? offer: EXIT
    await expect.poll(() => menuDepth(page)).toBe(1);
  }
  await expect.poll(async () => (await page.evaluate(() => window.__sage!.unit.controller?.status != null))).toBe(true);
}

/**
 * Track `k` from empty: REC (red), `seconds` of audio, REC again: green once the loop is closed (a recording that
 * waits for a measure line blinks first). Returns the loop's length in frames.
 */
export async function recordLoop(page: Page, k: number, seconds: number, press: () => Promise<void>): Promise<number> {
  const rec = `trk${k + 1}.rec` as ButtonId;
  await press();
  await expectTrack(page, k, 'recording');
  await expectSteady(page, rec, 'red');
  await waitRecorded(page, k, seconds);
  await press();
  await expectTrack(page, k, 'playing');
  await expectSteady(page, rec, 'green');
  const length = await trackLength(page, k);
  expect(length).toBeGreaterThan(0);
  return length;
}

/** A playing track: REC/DUB/PLAY overdubs (yellow) for `seconds`, then back to playing (green). The length stays. */
export async function overdub(page: Page, k: number, seconds: number, press: () => Promise<void>): Promise<void> {
  const rec = `trk${k + 1}.rec` as ButtonId;
  const length = await trackLength(page, k);
  await press();
  await expectTrack(page, k, 'overdubbing');
  await expectSteady(page, rec, 'yellow');
  await waitAudio(page, seconds);
  await press();
  await expectTrack(page, k, 'playing');
  await expectSteady(page, rec, 'green');
  expect(await trackLength(page, k)).toBe(length);
}

/** STOP on a playing track: stopped, REC/DUB/PLAY dark, the loop kept. */
export async function stopTrack(page: Page, k: number, press: () => Promise<void>): Promise<void> {
  const length = await trackLength(page, k);
  await press();
  await expectTrack(page, k, 'stopped');
  await expectSteady(page, `trk${k + 1}.rec` as ButtonId, 'off');
  expect(await trackLength(page, k)).toBe(length);
}

// ------------------------------------------------------------------------------------------------ files

/**
 * The iPad's share sheet, for `page.addInitScript`: a touch device (maxTouchPoints 5, as an iPad reports) whose
 * `navigator.share` takes the files and keeps their bytes (base64) in `window.__shared`, as if saved to Files. With it
 * `saveFile` takes the same path as on the iPad. Serialised into the page: it must not use anything outside its body.
 *
 * Like the real one, it refuses (NotAllowedError, kept in `window.__shareRefused`) a call made without a user
 * activation, so a `saveFile` moved out of the tap fails the spec. `navigator.userActivation.isActive` alone cannot
 * show that under Playwright: its own page.evaluate calls grant an activation (about 5 s, in WebKit and Chromium
 * alike), and the specs poll all the time. So the call must also come from inside the dispatch of a trusted input
 * event: `window.event` is set only while an event listener runs, never after an await.
 */
export function fakeShareSheet(): void {
  const shared: { name: string; type: string; b64: string; via: string }[] = [];
  const refused: string[] = [];
  const w = window as unknown as { __shared: typeof shared; __shareRefused: string[] };
  w.__shared = shared;
  w.__shareRefused = refused;
  const GESTURES = ['pointerdown', 'pointerup', 'touchend', 'mousedown', 'mouseup', 'click', 'keydown', 'keyup'];
  Object.defineProperty(Navigator.prototype, 'maxTouchPoints', { get: () => 5, configurable: true });
  Object.defineProperty(Navigator.prototype, 'canShare', {
    value: (data?: { files?: File[] }) => Array.isArray(data?.files) && data.files.length > 0,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(Navigator.prototype, 'share', {
    value: (data: { files: File[] }): Promise<void> => {
      const ev = (window as unknown as { event?: Event }).event;
      const active = navigator.userActivation?.isActive === true;
      if (!active || ev === undefined || !ev.isTrusted || !GESTURES.includes(ev.type)) {
        refused.push(`activation ${active}, event ${ev ? `${ev.type} trusted ${ev.isTrusted}` : 'none'}`);
        return Promise.reject(new DOMException('The request is not allowed by the user agent', 'NotAllowedError'));
      }
      const via = ev.type;
      return (async () => {
        for (const f of data.files) {
          const bytes = new Uint8Array(await f.arrayBuffer());
          let s = '';
          for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          shared.push({ name: f.name, type: f.type, b64: btoa(s), via });
        }
      })();
    },
    configurable: true,
    writable: true,
  });
}

/** A file the app saved: its name and bytes. */
export interface SavedFile {
  name: string;
  /** The input event `navigator.share` was called in (the iPad path), or null for a download. */
  via: string | null;
  /** A Node Buffer (what `setInputFiles` takes). */
  bytes: Uint8Array;
}

async function downloadBytes(download: Download): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const c of await download.createReadStream()) chunks.push(c as Uint8Array);
  return Buffer.concat(chunks);
}

/**
 * Runs `save` (the tap that saves a file) and returns the file: from the share sheet on the iPad (`fakeShareSheet`),
 * from the download on the desktop.
 */
export async function captureSave(page: Page, browserName: string, save: () => Promise<void>): Promise<SavedFile> {
  if (browserName === 'webkit') {
    type Sheet = { __shared: { name: string; b64: string; via: string }[]; __shareRefused: string[] };
    const count = () => page.evaluate(() => {
      const w = window as unknown as Sheet;
      return { shared: w.__shared.length, refused: [...w.__shareRefused] };
    });
    const before = await count();
    await save();
    await expect.poll(async () => { const c = await count(); return c.shared + c.refused.length; }).toBe(before.shared + before.refused.length + 1);
    expect((await count()).refused, 'navigator.share was called without the tap\'s user activation').toEqual(before.refused);
    const f = await page.evaluate((i) => (window as unknown as Sheet).__shared[i]!, before.shared);
    return { name: f.name, via: f.via, bytes: Buffer.from(f.b64, 'base64') };
  }
  const [download] = await Promise.all([page.waitForEvent('download'), save()]);
  return { name: download.suggestedFilename(), via: null, bytes: await downloadBytes(download) };
}
