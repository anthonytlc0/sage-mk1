/**
 * MENU > SETUP > LATENCY (non-hardware addition): measures the round-trip audio latency of this device.
 *
 *   REMOVE HEADPHONES / ENTER: START / NOW <frames>   ENTER: the engine plays 8 clicks through the speaker and records
 *   MEASURING...                                        them with the mic (4.5 s; the normal output is muted meanwhile)
 *   LATENCY SET / <frames> FRAMES / <ms> MS             the median delay is stored in SETUP LATENCY
 *
 * ENTER is refused with STOP ALL while a track records, plays or overdubs or the rhythm plays (the clicks replace
 * what is heard, and the loops would be taken for clicks). EXIT is ignored while it measures, so the menu is never
 * left while the engine still has the output muted; a measurement that never answers ends with CALIB FAILED after
 * CALIBRATE_TIMEOUT_MS. A result that cannot be trusted (computeLatency null) shows CALIB FAILED and goes back to the
 * start. Storing SETUP LATENCY sends the engine new settings, which EngineHost turns into the `latency` command (with
 * the output latency it measures itself).
 *
 * `showCalibratePrompt` is the first-run offer: at power-on, while the device is uncalibrated and the offer has never
 * been made, CALIBRATE? ENTER/EXIT is shown once.
 */

import type { Controller } from '../../control/controller';
import { computeLatency } from '../../control/calibrate';
import type { ControlEvent } from '../../shared/ids';
import { text } from '../draw';
import { FONT_SMALL } from '../fonts';
import type { Framebuffer } from '../framebuffer';
import type { MenuSystem, Screen, ScreenResult } from '../menu';
import { drawTitleBar } from './common';
import { PromptScreen, looperBusy } from './prompt';

export const MSG_REMOVE_HEADPHONES = 'REMOVE HEADPHONES';
export const MSG_CALIB_FAILED = 'CALIB FAILED';
export const MSG_MEASURING = 'MEASURING...';
export const CALIBRATE_PROMPT = 'CALIBRATE? ENTER/EXIT';

/** The sample rate assumed before the engine has reported one. */
const DEFAULT_RATE = 48000;
const CENTERED = { align: 'center', width: 128 } as const;
const LINE_Y: readonly number[] = [16, 28, 40, 52];

/** SETUP LATENCY as the LCD shows it: AUTO while uncalibrated (the browser's estimate is used), else the frames. */
export function formatLatency(v: unknown): string {
  return v === -1 ? 'AUTO' : String(v);
}

class LatencyScreen implements Screen {
  readonly title = 'LATENCY';
  private state: 'ready' | 'running' | 'done' = 'ready';
  private resultLines: string[] = [];
  private disposed = false;
  private readyLines: string[] = [MSG_REMOVE_HEADPHONES, 'ENTER: START'];
  private readyFor: unknown = undefined;

  /** The lines shown now (for the tests and the render). */
  get lines(): readonly string[] {
    if (this.state === 'running') return RUNNING;
    if (this.state === 'done') return this.resultLines;
    return this.readyLines;
  }

  render(fb: Framebuffer, ctx: Controller): void {
    this.syncReady(ctx);
    drawTitleBar(fb, this.title);
    const lines = this.lines;
    for (let i = 0; i < lines.length && i < LINE_Y.length; i++) text(fb, 0, LINE_Y[i]!, lines[i]!, FONT_SMALL, CENTERED);
  }

  onEvent(e: ControlEvent, ctx: Controller): ScreenResult {
    if (e.kind === 'turn') return 'handled';
    if (e.kind !== 'press') return 'unhandled';
    if (this.state === 'running') return 'handled'; // EXIT too: the output is muted until the measurement ends
    if (e.id === 'exit') return 'pop';
    if (e.id !== 'enter') return 'handled';
    if (this.state === 'done') return 'pop';
    if (looperBusy(ctx)) ctx.showMessage('STOP ALL');
    else this.start(ctx);
    return 'handled';
  }

  dispose(): void {
    this.disposed = true;
  }

  private syncReady(ctx: Controller): void {
    const v = ctx.session.system.setup.latency;
    if (v === this.readyFor) return;
    this.readyFor = v;
    this.readyLines = [MSG_REMOVE_HEADPHONES, 'ENTER: START', `NOW ${formatLatency(v)}`];
  }

  private start(ctx: Controller): void {
    this.state = 'running';
    const sr = ctx.status?.sampleRate ?? DEFAULT_RATE;
    ctx.requestCalibration().then(
      ({ capture, clickFrames }) => {
        if (this.disposed) return;
        const frames = computeLatency(capture, clickFrames, sr);
        if (frames === null) return this.fail(ctx);
        ctx.setParam('setup.latency', frames);
        this.resultLines = ['LATENCY SET', `${frames} FRAMES`, `${((frames / sr) * 1000).toFixed(1)} MS`];
        this.state = 'done';
      },
      (e: unknown) => {
        if (this.disposed) return;
        console.error('latency calibration failed', e);
        this.fail(ctx);
      },
    );
  }

  private fail(ctx: Controller): void {
    this.state = 'ready';
    ctx.showMessage(MSG_CALIB_FAILED);
  }
}

const RUNNING: readonly string[] = [MSG_MEASURING];

/** The LATENCY calibration screen (MENU > SETUP > LATENCY, or ENTER at the first-run prompt). */
export function latencyScreen(): Screen & { readonly lines: readonly string[] } {
  return new LatencyScreen();
}

/**
 * The first-run offer, for the app shell to call once after power-on (after `boot()` and `showStartScreen()`): when
 * SETUP LATENCY is uncalibrated (-1) and the offer was never made, shows CALIBRATE? ENTER/EXIT and records that it
 * was (`setup.calibPrompted`, saved with the system settings). ENTER opens the LATENCY screen in its place; EXIT
 * closes it. Returns true when it was shown.
 */
export function showCalibratePrompt(menu: MenuSystem, ctx: Controller): boolean {
  const setup = ctx.session.system.setup;
  if (setup.latency !== -1 || setup.calibPrompted) return false;
  ctx.setParam('setup.calibPrompted', true);
  const prompt: PromptScreen = new PromptScreen('LATENCY', CALIBRATE_PROMPT, {
    enter: () => {
      menu.remove(prompt);
      return { push: latencyScreen() };
    },
    exit: () => 'pop',
  });
  menu.push(prompt);
  return true;
}
