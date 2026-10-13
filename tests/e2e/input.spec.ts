import { expect, test, type CDPSession, type Page } from '@playwright/test';
import type { AbsoluteId, ButtonId, ControlEvent } from '../../src/shared/ids';

const PANEL_URL = '/tests/e2e/pages/panel.html';

// WebKit (the iPad device) has touch already; Chromium needs it for page.touchscreen.
test.use({ hasTouch: true });

async function openPanel(page: Page): Promise<void> {
  await page.goto(PANEL_URL);
  await page.waitForFunction(() => window.__panel !== undefined && window.__events !== undefined);
}

test.beforeEach(async ({ page }) => {
  await openPanel(page);
});

// ------------------------------------------------------------------------------------------------ helpers

/** The control's LAYOUT-rect centre (plus dx, dy viewBox units) in CSS px, the px per viewBox unit, and the rect height. */
async function pointOf(page: Page, id: ButtonId | AbsoluteId, dx = 0, dy = 0) {
  return page.evaluate(
    ({ id, dx, dy }) => {
      const p = window.__panel;
      const sr = p.view.rootSvg.getBoundingClientRect();
      const k = Math.min(sr.width / p.PANEL_VIEWBOX.w, sr.height / p.PANEL_VIEWBOX.h);
      const ox = sr.left + (sr.width - p.PANEL_VIEWBOX.w * k) / 2;
      const oy = sr.top + (sr.height - p.PANEL_VIEWBOX.h * k) / 2;
      const r = p.LAYOUT[id];
      return { x: ox + (r.x + r.w / 2 + dx) * k, y: oy + (r.y + r.h / 2 + dy) * k, k, h: r.h };
    },
    { id, dx, dy },
  );
}

const events = (page: Page): Promise<ControlEvent[]> => page.evaluate(() => window.__events.slice());
const special = (page: Page): Promise<string[]> => page.evaluate(() => window.__special.slice());
const clear = (page: Page): Promise<void> =>
  page.evaluate(() => {
    window.__events.length = 0;
    window.__special.length = 0;
  });

/** 'press:trk1.rec', 'turn:knob1:3', 'set:trk1.fader': the event without its timestamp or value. */
const shape = (evs: readonly ControlEvent[]): string[] =>
  evs.map((e) => (e.kind === 'turn' ? `turn:${e.id}:${e.steps}` : `${e.kind}:${e.id}`));

const sets = (evs: readonly ControlEvent[]): number[] =>
  evs.flatMap((e) => (e.kind === 'set' ? [e.value] : []));
const turns = (evs: readonly ControlEvent[]): number =>
  evs.reduce((n, e) => (e.kind === 'turn' ? n + e.steps : n), 0);

/**
 * One wheel notch over (x, y), negative deltaY = wheel up, then a pause so the next notch is past the input layer's
 * 50 ms per-control step cap (as an ordinary mouse-wheel spin is). Chromium gets a real mouse wheel. Playwright has
 * none for mobile WebKit (the iPad device), so there it is a synthetic WheelEvent on the element under the point.
 */
async function wheel(page: Page, browserName: string, at: { x: number; y: number }, deltaY: number): Promise<void> {
  if (browserName === 'chromium') {
    await page.mouse.move(at.x, at.y);
    await page.mouse.wheel(0, deltaY);
  } else {
    await page.evaluate(
      ({ x, y, deltaY }) => {
        const target = document.elementFromPoint(x, y) ?? document.body;
        target.dispatchEvent(
          new WheelEvent('wheel', { deltaY, clientX: x, clientY: y, bubbles: true, cancelable: true, composed: true }),
        );
      },
      { ...at, deltaY },
    );
  }
  await page.waitForTimeout(70);
}

interface Finger {
  id: number;
  x: number;
  y: number;
}

/**
 * Multi-touch, per engine.
 *  - Chromium: real touch through CDP `Input.dispatchTouchEvent`. The browser turns each finger into a genuine touch
 *    PointerEvent with its own pointerId, and implicit capture works as on a device.
 *  - WebKit: Playwright has no multi-touch API there (page.touchscreen only taps one finger, and there is no CDP). So
 *    each finger is a synthetic `PointerEvent` (pointerType 'touch', its own pointerId, isPrimary on the first
 *    finger) dispatched on the element under the finger when it went down, which stands in for the capture a real
 *    finger gets. setPointerCapture throws for a synthetic pointerId, which the input layer tolerates.
 * Either way the page sees two or more concurrently active touch pointers on different controls.
 */
class Touch {
  private cdp: CDPSession | undefined;
  private readonly active = new Map<number, Finger>();

  constructor(
    private readonly page: Page,
    private readonly browserName: string,
  ) {}

  get real(): boolean {
    return this.browserName === 'chromium';
  }

  /** touchStart and touchMove list every finger that is down; touchEnd lists the finger(s) that lift. */
  private async cdpSend(type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel', lifting: Finger[] = []): Promise<void> {
    this.cdp ??= await this.page.context().newCDPSession(this.page);
    const points = type === 'touchCancel' ? [] : type === 'touchEnd' ? lifting : [...this.active.values()];
    await this.cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(({ id, x, y }) => ({ id, x, y })) });
  }

  private synthetic(type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel', f: Finger, primary: boolean) {
    return this.page.evaluate(
      ({ type, f, primary }) => {
        const w = window as unknown as { __fingerTarget?: Map<number, Element> };
        const targets = (w.__fingerTarget ??= new Map());
        const fresh = document.elementFromPoint(f.x, f.y) ?? document.body;
        const target = type === 'pointerdown' ? fresh : (targets.get(f.id) ?? fresh);
        if (type === 'pointerdown') targets.set(f.id, target);
        if (type === 'pointerup' || type === 'pointercancel') targets.delete(f.id);
        target.dispatchEvent(
          new PointerEvent(type, {
            pointerId: f.id,
            pointerType: 'touch',
            isPrimary: primary,
            clientX: f.x,
            clientY: f.y,
            button: type === 'pointermove' ? -1 : 0,
            buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1,
            width: 20,
            height: 20,
            bubbles: true,
            cancelable: true,
            composed: true,
          }),
        );
      },
      { type, f, primary },
    );
  }

  async down(f: Finger): Promise<void> {
    const primary = this.active.size === 0;
    this.active.set(f.id, f);
    if (this.real) await this.cdpSend('touchStart');
    else await this.synthetic('pointerdown', f, primary);
  }

  async move(f: Finger): Promise<void> {
    if (!this.active.has(f.id)) throw new Error(`finger ${f.id} is not down`);
    this.active.set(f.id, f);
    if (this.real) await this.cdpSend('touchMove');
    else await this.synthetic('pointermove', f, f.id === [...this.active.keys()][0]);
  }

  async up(id: number): Promise<void> {
    const f = this.active.get(id);
    if (!f) throw new Error(`finger ${id} is not down`);
    const primary = id === [...this.active.keys()][0];
    this.active.delete(id);
    if (this.real) await this.cdpSend('touchEnd', [f]);
    else await this.synthetic('pointerup', f, primary);
  }

  /** The OS takes the touches away (iPadOS does this for 4-5 finger gestures): every finger gets a pointercancel. */
  async cancelAll(): Promise<void> {
    const fingers = [...this.active.values()];
    this.active.clear();
    if (this.real) await this.cdpSend('touchCancel');
    else for (const f of fingers) await this.synthetic('pointercancel', f, false);
  }
}

/** Logs every pointer event at the document, in the capture phase, so a spec can prove what the browser delivered. */
async function logPointers(page: Page): Promise<void> {
  await page.evaluate(() => {
    const log: { type: string; id: number; pt: string }[] = [];
    (window as unknown as { __ptrLog: typeof log }).__ptrLog = log;
    for (const type of ['pointerdown', 'pointerup', 'pointercancel']) {
      document.addEventListener(
        type,
        (e) => log.push({ type: e.type, id: (e as PointerEvent).pointerId, pt: (e as PointerEvent).pointerType }),
        true,
      );
    }
  });
}
const pointerLog = (page: Page) =>
  page.evaluate(() => (window as unknown as { __ptrLog: { type: string; id: number; pt: string }[] }).__ptrLog.slice());

/** Records every keydown at the window (bubble phase, after the input layer) with the flags a spec wants to check. */
async function logKeys(page: Page): Promise<void> {
  await page.evaluate(() => {
    const log: { code: string; repeat: boolean; prevented: boolean }[] = [];
    (window as unknown as { __keyLog: typeof log }).__keyLog = log;
    window.addEventListener('keydown', (e) => log.push({ code: e.code, repeat: e.repeat, prevented: e.defaultPrevented }));
  });
}
const keyLog = (page: Page) =>
  page.evaluate(() => (window as unknown as { __keyLog: { code: string; repeat: boolean; prevented: boolean }[] }).__keyLog.slice());

// ------------------------------------------------------------------------------------------------ touch

test.describe('touch', () => {
  test('two simultaneous touches on trk1.rec and trk3.rec press both, independently', async ({ page, browserName }) => {
    await logPointers(page);
    const touch = new Touch(page, browserName);
    const a = await pointOf(page, 'trk1.rec');
    const b = await pointOf(page, 'trk3.rec');

    await touch.down({ id: 1, x: a.x, y: a.y });
    await touch.down({ id: 2, x: b.x, y: b.y });
    expect(shape(await events(page))).toEqual(['press:trk1.rec', 'press:trk3.rec']);

    // The browser really had two touch pointers down at once, with different ids.
    const log = await pointerLog(page);
    expect(log.map((e) => e.type)).toEqual(['pointerdown', 'pointerdown']);
    expect(log.every((e) => e.pt === 'touch')).toBe(true);
    expect(new Set(log.map((e) => e.id)).size).toBe(2);

    // Each real finger is captured by the control it landed on (a synthetic pointerId cannot be captured).
    if (touch.real) {
      const captured = await page.evaluate((ids) => {
        const v = window.__panel.view;
        return [v.elementFor('trk1.rec').hasPointerCapture(ids[0]), v.elementFor('trk3.rec').hasPointerCapture(ids[1])];
      }, log.map((e) => e.id));
      expect(captured).toEqual([true, true]);
    }

    // Lifting one finger releases only its button.
    await touch.up(1);
    expect(shape(await events(page))).toEqual(['press:trk1.rec', 'press:trk3.rec', 'release:trk1.rec']);
    await touch.up(2);
    expect(shape(await events(page))).toEqual([
      'press:trk1.rec',
      'press:trk3.rec',
      'release:trk1.rec',
      'release:trk3.rec',
    ]);
  });

  test('a real single tap (page.touchscreen) is a press and a release', async ({ page }) => {
    const p = await pointOf(page, 'trk2.stop');
    await page.touchscreen.tap(p.x, p.y);
    expect(shape(await events(page))).toEqual(['press:trk2.stop', 'release:trk2.stop']);
  });

  test('pointercancel releases every held button, and the late lift adds nothing', async ({ page, browserName }) => {
    const touch = new Touch(page, browserName);
    const a = await pointOf(page, 'trk1.rec');
    const b = await pointOf(page, 'trk3.rec');
    const c = await pointOf(page, 'allStartStop');
    await touch.down({ id: 1, x: a.x, y: a.y });
    await touch.down({ id: 2, x: b.x, y: b.y });
    await touch.down({ id: 3, x: c.x, y: c.y });
    await touch.cancelAll();
    const evs = shape(await events(page));
    expect(evs.slice(0, 3)).toEqual(['press:trk1.rec', 'press:trk3.rec', 'press:allStartStop']);
    expect(evs.slice(3).sort()).toEqual(['release:allStartStop', 'release:trk1.rec', 'release:trk3.rec']);
    expect(evs).toHaveLength(6);
  });

  test('two fingers on one button are one press, released when the last lifts', async ({ page, browserName }) => {
    const touch = new Touch(page, browserName);
    const a = await pointOf(page, 'trk4.rec', -20, 0);
    const b = await pointOf(page, 'trk4.rec', 20, 0);
    await touch.down({ id: 1, x: a.x, y: a.y });
    await touch.down({ id: 2, x: b.x, y: b.y });
    await touch.up(1);
    expect(shape(await events(page))).toEqual(['press:trk4.rec']);
    await touch.up(2);
    expect(shape(await events(page))).toEqual(['press:trk4.rec', 'release:trk4.rec']);
  });

  test('a finger dragged off its button still releases that button, and only on lift', async ({ page, browserName }) => {
    const touch = new Touch(page, browserName);
    const a = await pointOf(page, 'trk1.rec');
    await touch.down({ id: 1, x: a.x, y: a.y });
    await touch.move({ id: 1, x: a.x + 400, y: a.y - 300 });
    expect(shape(await events(page))).toEqual(['press:trk1.rec']);
    await touch.up(1);
    expect(shape(await events(page))).toEqual(['press:trk1.rec', 'release:trk1.rec']);
  });

  test('two fingers drag two faders at once', async ({ page, browserName }) => {
    await page.evaluate(() => {
      window.__panel.view.setPhysical('trk1.fader', 0.2);
      window.__panel.view.setPhysical('trk2.fader', 0.8);
    });
    const touch = new Touch(page, browserName);
    const a = await pointOf(page, 'trk1.fader');
    const b = await pointOf(page, 'trk2.fader');
    const run = a.h * a.k * 0.25;
    await touch.down({ id: 1, x: a.x, y: a.y });
    await touch.down({ id: 2, x: b.x, y: b.y });
    for (let i = 1; i <= 5; i++) {
      await touch.move({ id: 1, x: a.x, y: a.y - (run * i) / 5 }); // up: more
      await touch.move({ id: 2, x: b.x, y: b.y + (run * i) / 5 }); // down: less
    }
    await touch.up(1);
    await touch.up(2);
    const evs = await events(page);
    const one = evs.filter((e) => e.kind === 'set' && e.id === 'trk1.fader');
    const two = evs.filter((e) => e.kind === 'set' && e.id === 'trk2.fader');
    expect(sets(one).at(-1)).toBeCloseTo(0.45, 2);
    expect(sets(two).at(-1)).toBeCloseTo(0.55, 2);
    expect(sets(one)).toEqual([...sets(one)].sort((x, y) => x - y));
    expect(sets(two)).toEqual([...sets(two)].sort((x, y) => y - x));
  });

  test('a touch drag on an encoder turns it', async ({ page, browserName }) => {
    const touch = new Touch(page, browserName);
    const p = await pointOf(page, 'knob2');
    await touch.down({ id: 1, x: p.x, y: p.y });
    for (let i = 1; i <= 6; i++) await touch.move({ id: 1, x: p.x, y: p.y - i * 6 });
    await touch.up(1);
    const evs = await events(page);
    expect(turns(evs)).toBe(3);
    expect(evs.every((e) => e.kind === 'turn')).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------ mouse

test.describe('mouse', () => {
  test('click is a press and a release, with the mouse captured; right click does nothing', async ({ page }) => {
    await logPointers(page);
    const p = await pointOf(page, 'menu');
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    expect(shape(await events(page))).toEqual(['press:menu']);
    const [down] = await pointerLog(page);
    expect(
      await page.evaluate((id) => window.__panel.view.elementFor('menu').hasPointerCapture(id), down.id),
    ).toBe(true);
    await page.mouse.up();
    expect(shape(await events(page))).toEqual(['press:menu', 'release:menu']);
    await clear(page);
    await page.mouse.click(p.x, p.y, { button: 'right' });
    expect(await events(page)).toEqual([]);
  });

  test('pressing the slot artwork around a fader grabs the fader (hit-test by element, not by LAYOUT rect)', async ({ page }) => {
    await page.evaluate(() => window.__panel.view.setPhysical('trk2.fader', 0.4));
    const above = await pointOf(page, 'trk2.fader', 0, -(await pointOf(page, 'trk2.fader')).h / 2 - 25);
    const hit = await page.evaluate(
      ({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-id]')?.getAttribute('data-id') ?? null,
      above,
    );
    expect(hit).toBe('trk2.fader');
    await page.mouse.move(above.x, above.y);
    await page.mouse.down();
    await page.mouse.move(above.x, above.y - 20, { steps: 4 });
    await page.mouse.up();
    const evs = await events(page);
    expect(evs.length).toBeGreaterThan(0);
    expect(evs.every((e) => e.kind === 'set' && e.id === 'trk2.fader')).toBe(true);
  });

  test('a fader drag sets increasing values relative to the start, clamped to 0..1, and moves the cap', async ({ page }) => {
    await page.evaluate(() => window.__panel.view.setPhysical('trk1.fader', 0.2));
    const p = await pointOf(page, 'trk1.fader');
    const travel = p.h * p.k; // CSS px for the whole range
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    expect(await events(page)).toEqual([]); // grabbing does not move it
    for (let i = 1; i <= 6; i++) await page.mouse.move(p.x, p.y - (travel * 0.5 * i) / 6);
    const mid = await events(page);
    expect(mid.length).toBeGreaterThanOrEqual(2);
    expect(mid.every((e) => e.kind === 'set' && e.id === 'trk1.fader')).toBe(true);
    const v = sets(mid);
    for (let i = 1; i < v.length; i++) expect(v[i]).toBeGreaterThan(v[i - 1]);
    expect(v[0]).toBeGreaterThan(0.2);
    expect(v.at(-1)).toBeCloseTo(0.7, 2); // 0.2 + half the travel (WebKit rounds mouse positions to whole px: under 0.004 off)

    // the drawing follows the last value emitted
    expect(await page.evaluate(() => window.__panel.view.getPhysical('trk1.fader'))).toBe(v.at(-1));

    // Past the top stays at 1; past the bottom stays at 0.
    await page.mouse.move(p.x, p.y - travel * 3);
    await page.mouse.move(p.x, p.y + travel * 3);
    await page.mouse.up();
    const all = sets(await events(page));
    expect(Math.max(...all)).toBe(1);
    expect(Math.min(...all)).toBe(0);
    expect(all.every((x) => x >= 0 && x <= 1)).toBe(true);
    expect(await page.evaluate(() => window.__panel.view.getPhysical('trk1.fader'))).toBe(0);
  });

  test('an absolute knob drag is 200 px per full range', async ({ page }) => {
    await page.evaluate(() => window.__panel.view.setPhysical('in.knob', 0.25));
    const p = await pointOf(page, 'in.knob');
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.mouse.move(p.x, p.y - 100, { steps: 5 });
    await page.mouse.up();
    const v = sets(await events(page));
    expect(v.at(-1)).toBeCloseTo(0.75, 5);
    expect((await events(page)).every((e) => e.kind === 'set' && e.id === 'in.knob')).toBe(true);
    expect(await page.evaluate(() => window.__panel.view.getPhysical('in.knob'))).toBeCloseTo(0.75, 5);
  });

  test('encoder: a 36 px upward drag is turn +3 and no press', async ({ page }) => {
    const p = await pointOf(page, 'knob1');
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.mouse.move(p.x, p.y - 36, { steps: 6 });
    await page.mouse.up();
    const evs = await events(page);
    expect(turns(evs)).toBe(3);
    expect(evs.every((e) => e.kind === 'turn' && e.id === 'knob1')).toBe(true);
  });

  test('encoder: a quick small tap is press + release of the knob', async ({ page }) => {
    const p = await pointOf(page, 'knob4');
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.mouse.move(p.x + 3, p.y + 3);
    await page.mouse.up();
    expect(shape(await events(page))).toEqual(['press:knob4', 'release:knob4']);
  });

  test('encoder: hold 350 ms then drag is press, turns, release', async ({ page }) => {
    const p = await pointOf(page, 'knob3');
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.waitForTimeout(350);
    expect(shape(await events(page))).toEqual(['press:knob3']); // pushed as soon as the hold is recognised
    await page.mouse.move(p.x, p.y - 36, { steps: 6 });
    await page.mouse.up();
    const evs = await events(page);
    expect(evs[0]).toMatchObject({ kind: 'press', id: 'knob3' });
    expect(evs.at(-1)).toMatchObject({ kind: 'release', id: 'knob3' });
    expect(turns(evs)).toBe(3);
    expect(evs.slice(1, -1).every((e) => e.kind === 'turn')).toBe(true);
  });

  test('wheel over an encoder is one detent, over a knob or fader 0.02', async ({ page, browserName }) => {
    await page.evaluate(() => {
      window.__panel.view.setPhysical('in.knob', 0.5);
      window.__panel.view.setPhysical('trk3.fader', 0.5);
    });
    const e = await pointOf(page, 'knob2');
    await wheel(page, browserName, e, -100);
    await wheel(page, browserName, e, 100);
    await wheel(page, browserName, e, 100);
    expect(shape(await events(page))).toEqual(['turn:knob2:1', 'turn:knob2:-1', 'turn:knob2:-1']);

    await clear(page);
    const k = await pointOf(page, 'in.knob');
    await wheel(page, browserName, k, -100);
    await wheel(page, browserName, k, -100);
    await wheel(page, browserName, k, 100);
    expect(sets(await events(page))).toEqual([0.52, 0.54, 0.52]);

    await clear(page);
    const f = await pointOf(page, 'trk3.fader');
    await wheel(page, browserName, f, 100);
    expect(sets(await events(page))).toEqual([0.48]);
    expect(await page.evaluate(() => window.__panel.view.getPhysical('trk3.fader'))).toBeCloseTo(0.48, 5);
  });

  test('wheel over a knob at its end stop emits nothing more, and never leaves 0..1', async ({ page, browserName }) => {
    await page.evaluate(() => window.__panel.view.setPhysical('outputLevel', 0.99));
    const k = await pointOf(page, 'outputLevel');
    await wheel(page, browserName, k, -100); // 0.99 + 0.02 -> 1
    await wheel(page, browserName, k, -100); // already 1
    expect(sets(await events(page))).toEqual([1]);
  });

  test('wheel over a plain button does nothing', async ({ page, browserName }) => {
    await wheel(page, browserName, await pointOf(page, 'trk1.rec'), -100);
    expect(await events(page)).toEqual([]);
  });

  test('a trackpad-style burst of small wheel deltas moves a control a few steps, not one per event', async ({ page }) => {
    await page.evaluate(() => window.__panel.view.setPhysical('trk4.fader', 0.1));
    const at = await pointOf(page, 'trk4.fader');
    const burst = await page.evaluate(async ({ x, y }) => {
      const target = document.elementFromPoint(x, y) ?? document.body;
      const t0 = performance.now();
      let prevented = 0;
      for (let i = 0; i < 40; i++) {
        const ev = new WheelEvent('wheel', { deltaY: -2, clientX: x, clientY: y, bubbles: true, cancelable: true, composed: true });
        target.dispatchEvent(ev);
        if (ev.defaultPrevented) prevented++;
        await new Promise((r) => setTimeout(r, 5));
      }
      return { elapsed: performance.now() - t0, prevented };
    }, at);
    const v = sets(await events(page));
    expect(burst.prevented).toBe(40); // every event is ours, even the ones that give no step
    expect(v.length).toBeGreaterThanOrEqual(2);
    expect(v.length).toBeLessThanOrEqual(Math.floor(burst.elapsed / 50) + 1); // at most one step per 50 ms
    expect(v.length).toBeLessThan(10);
    for (let i = 1; i < v.length; i++) expect(v[i]).toBeCloseTo(v[i - 1] + 0.02, 5); // each is one 0.02 step up
  });
});

// ------------------------------------------------------------------------------------------------ keyboard

test.describe('keyboard', () => {
  test('A presses trk1.rec once (auto-repeat suppressed) and releases on keyup', async ({ page }) => {
    await logKeys(page);
    await page.keyboard.down('KeyA');
    await page.keyboard.down('KeyA'); // held: the browser sends repeat keydowns
    await page.keyboard.down('KeyA');
    expect(shape(await events(page))).toEqual(['press:trk1.rec']);
    expect((await keyLog(page)).filter((k) => k.repeat).length).toBeGreaterThanOrEqual(2); // the repeats did arrive
    await page.keyboard.up('KeyA');
    expect(shape(await events(page))).toEqual(['press:trk1.rec', 'release:trk1.rec']);
  });

  test('Tab and Space are ours: default prevented, on repeats too, and focus does not move', async ({ page }) => {
    await page.evaluate(() => {
      const b = document.createElement('button');
      b.id = 'other';
      document.body.append(b);
    });
    await logKeys(page);
    await page.keyboard.press('Tab');
    await page.keyboard.down('Space');
    await page.keyboard.down('Space');
    await page.keyboard.up('Space');
    expect(shape(await events(page))).toEqual([
      'press:undoRedo',
      'release:undoRedo',
      'press:allStartStop',
      'release:allStartStop',
    ]);
    const log = await keyLog(page);
    expect(log.map((k) => k.code)).toEqual(['Tab', 'Space', 'Space']);
    expect(log.every((k) => k.prevented)).toBe(true);
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
  });

  test('Shift+N is rhythmEdit even if Shift comes up first; plain N is rhythmStartStop', async ({ page }) => {
    await page.keyboard.down('Shift');
    await page.keyboard.down('KeyN');
    await page.keyboard.up('Shift');
    await page.keyboard.up('KeyN');
    await page.keyboard.press('KeyN');
    expect(shape(await events(page))).toEqual([
      'press:rhythmEdit',
      'release:rhythmEdit',
      'press:rhythmStartStop',
      'release:rhythmStartStop',
    ]);
  });

  test('Esc and Enter together are two held buttons', async ({ page }) => {
    await page.keyboard.down('Escape');
    await page.keyboard.down('Enter');
    await page.keyboard.up('Enter');
    await page.keyboard.up('Escape');
    expect(shape(await events(page))).toEqual(['press:exit', 'press:enter', 'release:enter', 'release:exit']);
  });

  test('a key and a click on the same button are one press until both let go', async ({ page }) => {
    const p = await pointOf(page, 'trk1.rec');
    await page.keyboard.down('KeyA');
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.keyboard.up('KeyA');
    expect(shape(await events(page))).toEqual(['press:trk1.rec']);
    await page.mouse.up();
    expect(shape(await events(page))).toEqual(['press:trk1.rec', 'release:trk1.rec']);
  });

  test('browser shortcuts (Ctrl+A) are left alone', async ({ page }) => {
    await logKeys(page);
    await page.keyboard.press('Control+KeyA');
    expect(await events(page)).toEqual([]);
    expect((await keyLog(page)).every((k) => !k.prevented)).toBe(true);
  });

  test('window blur releases every key still held, so none sticks when the user tabs away', async ({ page }) => {
    await page.keyboard.down('KeyA');
    await page.keyboard.down('KeyS');
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    expect(shape(await events(page))).toEqual(['press:trk1.rec', 'press:trk2.rec', 'release:trk1.rec', 'release:trk2.rec']);
    await page.keyboard.up('KeyA'); // the keyups that arrive after coming back add nothing
    await page.keyboard.up('KeyS');
    expect(await events(page)).toHaveLength(4);
  });

  test('an element in the page losing focus releases nothing: only the window losing focus does', async ({ page }) => {
    await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.id = 'probe-focus';
      probe.tabIndex = 0;
      document.body.append(probe);
    });
    await page.keyboard.down('KeyA');
    const m = await pointOf(page, 'trk2.rec');
    await page.mouse.move(m.x, m.y);
    await page.mouse.down();
    await page.evaluate(() => {
      const probe = document.getElementById('probe-focus')!;
      probe.focus();
      probe.blur(); // a blur event on the element, not on the window
    });
    expect(shape(await events(page))).toEqual(['press:trk1.rec', 'press:trk2.rec']);
    await page.keyboard.up('KeyA');
    await page.mouse.up();
    expect(shape(await events(page))).toEqual(['press:trk1.rec', 'press:trk2.rec', 'release:trk1.rec', 'release:trk2.rec']);
  });

  test('keys typed into an input or textarea are the field\'s, not the looper\'s', async ({ page }) => {
    await logKeys(page);
    await page.evaluate(() => {
      const input = document.createElement('input');
      input.id = 'probe';
      const area = document.createElement('textarea');
      area.id = 'probe2';
      document.body.append(input, area);
      input.focus();
    });
    await page.keyboard.type('a s'); // A, S and Space
    await page.keyboard.press('Backquote');
    await page.keyboard.press('Shift+Slash');
    expect(await events(page)).toEqual([]);
    expect(await special(page)).toEqual([]);
    expect(await page.locator('#probe').inputValue()).toBe('a s`?');
    expect((await keyLog(page)).every((k) => !k.prevented)).toBe(true);

    await page.locator('#probe2').focus();
    await page.keyboard.press('KeyD');
    expect(await events(page)).toEqual([]);

    // Focus back on the page: keys work again.
    await page.evaluate(() => (document.activeElement as HTMLElement).blur());
    await page.keyboard.press('KeyD');
    expect(shape(await events(page))).toEqual(['press:trk3.rec', 'release:trk3.rec']);
  });

  test('Backquote and ? are special keys, not ControlEvents', async ({ page }) => {
    await page.keyboard.press('Backquote');
    await page.keyboard.press('Shift+Slash');
    expect(await events(page)).toEqual([]);
    expect(await special(page)).toEqual(['recorder', 'overlay']);
  });
});

// ------------------------------------------------------------------------------------------------ overlay and lifecycle

const overlayCount = (page: Page): Promise<number> =>
  page.evaluate(() => window.__panel.view.rootSvg.querySelectorAll('g.key-overlay').length);

test.describe('key overlay', () => {
  test('? toggles it; it labels every mapped control and never takes a touch', async ({ page }) => {
    expect(await overlayCount(page)).toBe(0);
    await page.keyboard.press('Shift+Slash');
    expect(await overlayCount(page)).toBe(1);

    const info = await page.evaluate(() => {
      const root = window.__panel.view.rootSvg;
      const badges = [...root.querySelectorAll('g.key-overlay [data-key-for]')];
      const label = (id: string) => badges.find((b) => b.getAttribute('data-key-for') === id)?.textContent ?? null;
      const layer = root.querySelector('g.key-overlay') as SVGElement;
      return {
        ids: badges.map((b) => b.getAttribute('data-key-for')).sort(),
        a: label('trk1.rec'),
        space: label('allStartStop'),
        shiftN: label('rhythmEdit'),
        layerEvents: getComputedStyle(layer).pointerEvents,
        badgeEvents: getComputedStyle(badges[0]).pointerEvents,
        last: layer === root.lastElementChild,
      };
    });
    expect(info.ids).toHaveLength(41);
    expect(new Set(info.ids).size).toBe(41);
    expect(info.a).toBe('A');
    expect(info.space).toBe('Space');
    expect(info.shiftN).toBe('⇧N');
    expect(info.layerEvents).toBe('none');
    expect(info.badgeEvents).toBe('none');
    expect(info.last).toBe(true);

    // Touches go straight through the badge to the control underneath.
    const p = await pointOf(page, 'trk1.rec');
    const hit = await page.evaluate(
      ({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-id]')?.getAttribute('data-id') ?? null,
      p,
    );
    expect(hit).toBe('trk1.rec');
    await page.mouse.click(p.x, p.y);
    expect(shape(await events(page))).toEqual(['press:trk1.rec', 'release:trk1.rec']);

    await page.keyboard.press('Shift+Slash');
    expect(await overlayCount(page)).toBe(0);
    expect(await special(page)).toEqual(['overlay', 'overlay']);
    // The overlay is not a ControlEvent source.
    expect(shape(await events(page))).toEqual(['press:trk1.rec', 'release:trk1.rec']);
  });

  test('showKeyOverlay is idempotent in both directions', async ({ page }) => {
    const counts = await page.evaluate(() => {
      const { showKeyOverlay } = window.__input;
      const view = window.__panel.view;
      const n = () => view.rootSvg.querySelectorAll('g.key-overlay').length;
      const out: number[] = [n()];
      showKeyOverlay(view, false);
      out.push(n());
      showKeyOverlay(view, true);
      showKeyOverlay(view, true);
      showKeyOverlay(view, true);
      out.push(n(), view.rootSvg.querySelectorAll('g.key-overlay [data-key-for]').length);
      showKeyOverlay(view, false);
      showKeyOverlay(view, false);
      out.push(n());
      return out;
    });
    expect(counts).toEqual([0, 0, 1, 41, 0]);
  });

  test('badges sit on their controls', async ({ page }) => {
    await page.evaluate(() => window.__input.showKeyOverlay(window.__panel.view, true));
    const bad = await page.evaluate(() => {
      const p = window.__panel;
      const out: string[] = [];
      for (const b of p.view.rootSvg.querySelectorAll('g.key-overlay [data-key-for]')) {
        const id = b.getAttribute('data-key-for') as keyof typeof p.LAYOUT;
        const r = p.LAYOUT[id];
        const box = (b as SVGGraphicsElement).getBoundingClientRect();
        const el = p.view.elementFor(id as never).getBoundingClientRect();
        const bx = box.left + box.width / 2, by = box.top + box.height / 2;
        if (bx < el.left || bx > el.right || by < el.top || by > el.bottom) out.push(`${id} (${r.shape}) badge centre is off its control`);
      }
      return out;
    });
    expect(bad).toEqual([]);
  });
});

test.describe('lifecycle', () => {
  test('detach stops listening and releases whatever is held; attach again works', async ({ page, browserName }) => {
    const touch = new Touch(page, browserName);
    const p = await pointOf(page, 'trk5.rec');
    await page.keyboard.down('KeyA');
    await touch.down({ id: 1, x: p.x, y: p.y });
    await page.evaluate(() => window.__input.detach());
    expect(shape(await events(page)).sort()).toEqual(['press:trk1.rec', 'press:trk5.rec', 'release:trk1.rec', 'release:trk5.rec']);

    await clear(page);
    await page.keyboard.up('KeyA');
    await touch.up(1);
    await page.keyboard.press('KeyS');
    await page.mouse.click(p.x, p.y);
    expect(await events(page)).toEqual([]);

    await page.evaluate(() => window.__input.attach());
    await page.keyboard.press('KeyS');
    expect(shape(await events(page))).toEqual(['press:trk2.rec', 'release:trk2.rec']);
  });

  // Finger ids that cannot collide with the real mouse's pointerId (1 in both engines): WebKit's fingers are synthetic.
  const FINGER_A = 11;
  const FINGER_B = 12;

  /** Two fingers on two buttons and a mouse pushing an encoder knob: three things held at once. */
  async function holdThreeThings(page: Page, browserName: string): Promise<Touch> {
    const touch = new Touch(page, browserName);
    const a = await pointOf(page, 'trk1.rec');
    const b = await pointOf(page, 'trk2.stop');
    const k = await pointOf(page, 'knob1');
    await touch.down({ id: FINGER_A, x: a.x, y: a.y });
    await touch.down({ id: FINGER_B, x: b.x, y: b.y });
    await page.mouse.move(k.x, k.y);
    await page.mouse.down();
    await page.waitForTimeout(350); // the encoder hold is recognised: knob1 is pushed
    expect(shape(await events(page))).toEqual(['press:trk1.rec', 'press:trk2.stop', 'press:knob1']);
    return touch;
  }

  /** After the pointers were cancelled: every hold released once, the late lifts add nothing, and nothing is wedged. */
  async function expectCancelled(page: Page, touch: Touch): Promise<void> {
    expect(shape(await events(page)).slice(3).sort()).toEqual(['release:knob1', 'release:trk1.rec', 'release:trk2.stop']);
    await touch.up(FINGER_A);
    await touch.up(FINGER_B);
    await page.mouse.up();
    expect(await events(page)).toHaveLength(6);

    // The press-count gate is not wedged: the same buttons press and release afresh.
    await clear(page);
    const a = await pointOf(page, 'trk1.rec');
    await page.mouse.click(a.x, a.y);
    expect(shape(await events(page))).toEqual(['press:trk1.rec', 'release:trk1.rec']);
  }

  test('window blur cancels every active pointer, like pointercancel', async ({ page, browserName }) => {
    const touch = await holdThreeThings(page, browserName);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await expectCancelled(page, touch);
  });

  test('the page going hidden (app switch, lock screen) cancels every active pointer', async ({ page, browserName }) => {
    const touch = await holdThreeThings(page, browserName);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expectCancelled(page, touch);
  });

  test('a visibilitychange to visible leaves held pointers alone', async ({ page, browserName }) => {
    const touch = await holdThreeThings(page, browserName);
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); // still visible
    expect(await events(page)).toHaveLength(3);
    await touch.up(FINGER_A);
    await touch.up(FINGER_B);
    await page.mouse.up();
    expect(shape(await events(page)).slice(3).sort()).toEqual(['release:knob1', 'release:trk1.rec', 'release:trk2.stop']);
  });

  test('a blur cancels a pending encoder touch and its hold timer: no push appears later', async ({ page }) => {
    const k = await pointOf(page, 'knob2');
    await page.mouse.move(k.x, k.y);
    await page.mouse.down();
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await page.waitForTimeout(450); // well past the 300 ms hold
    await page.mouse.up();
    expect(await events(page)).toEqual([]);
  });

  test('detach removes the blur and visibility listeners with the rest', async ({ page }) => {
    await page.evaluate(() => window.__input.detach());
    await page.evaluate(() => {
      window.dispatchEvent(new Event('blur'));
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(await events(page)).toEqual([]);
  });

  test('the overlay is removed on detach', async ({ page }) => {
    await page.keyboard.press('Shift+Slash');
    expect(await overlayCount(page)).toBe(1);
    await page.evaluate(() => window.__input.detach());
    expect(await overlayCount(page)).toBe(0);
  });

  test('PanelView.getPhysical reports what setPhysical drew (faders rest at 1, knobs at 0.5)', async ({ page }) => {
    const r = await page.evaluate(() => {
      const v = window.__panel.view;
      const rest = [v.getPhysical('trk1.fader'), v.getPhysical('in.knob')];
      v.setPhysical('trk1.fader', 0.3);
      v.setPhysical('outputLevel', 7);
      return [...rest, v.getPhysical('trk1.fader'), v.getPhysical('outputLevel')];
    });
    expect(r).toEqual([1, 0.5, 0.3, 1]);
  });
});
