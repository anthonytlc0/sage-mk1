import { expect, test, type Page } from '@playwright/test';

const PANEL_URL = '/tests/e2e/pages/panel.html';

async function openPanel(page: Page): Promise<void> {
  await page.goto(PANEL_URL);
  await page.waitForFunction(() => window.__panel !== undefined);
}

test.beforeEach(async ({ page }) => {
  await openPanel(page);
});

test('the panel replica matches the baseline (trk1 red, trk2 green, INPUT FX A pink)', async ({ page }) => {
  await page.evaluate(async () => {
    const p = window.__panel;
    p.view.setPhysical('trk1.fader', 0.8);
    p.view.setPhysical('trk2.fader', 0.65);
    p.view.setPhysical('trk3.fader', 0.9);
    p.view.setPhysical('trk4.fader', 0.5);
    p.view.setPhysical('trk5.fader', 0.75);
    p.view.setPhysical('in.knob', 0.3);
    p.view.setPhysical('tr.knob', 0.7);
    p.view.setPhysical('outputLevel', 0.6);
    p.render({
      leds: {
        'trk1.rec': { color: 'red', blink: 'none' },
        'trk2.rec': { color: 'green', blink: 'none' },
        'in.A': { color: 'pink', blink: 'none' },
      },
      rings: [
        { color: 'red', blink: 'none', mode: 'position', amount: 0.35 },
        { color: 'green', blink: 'none', mode: 'position', amount: 0.7 },
      ],
      lcd: 'demo',
    }, 0);
    await document.fonts.ready;
  });
  await expect(page).toHaveScreenshot('panel.png', { maxDiffPixelRatio: 0.01 });
});

test('every ButtonId and AbsoluteId has its own element, hit at the centre of its LAYOUT rect', async ({ page }) => {
  const problems = await page.evaluate(() => {
    const p = window.__panel;
    const svg = p.view.rootSvg;
    const sr = svg.getBoundingClientRect();
    const k = Math.min(sr.width / p.PANEL_VIEWBOX.w, sr.height / p.PANEL_VIEWBOX.h);
    const ox = sr.left + (sr.width - p.PANEL_VIEWBOX.w * k) / 2;
    const oy = sr.top + (sr.height - p.PANEL_VIEWBOX.h * k) / 2;
    const out: string[] = [];
    const seen = new Set<Element>();
    for (const id of [...p.ALL_BUTTON_IDS, ...p.ALL_ABSOLUTE_IDS]) {
      const el = p.view.elementFor(id);
      if (!el || !svg.contains(el)) { out.push(`${id}: no element in the svg`); continue; }
      if (seen.has(el)) out.push(`${id}: shares an element`);
      seen.add(el);
      if (el.getAttribute('data-id') !== id) out.push(`${id}: data-id is ${el.getAttribute('data-id')}`);
      const r = p.LAYOUT[id];
      const x = ox + (r.x + r.w / 2) * k;
      const y = oy + (r.y + r.h / 2) * k;
      const hit = document.elementFromPoint(x, y)?.closest('[data-id]');
      if (hit !== el) out.push(`${id}: centre hits ${hit?.getAttribute('data-id') ?? 'nothing'}`);
    }
    return out;
  });
  expect(problems).toEqual([]);
});

test('LEDs light in their colour and blink fast / slow / tempo', async ({ page }) => {
  const r = await page.evaluate(() => {
    const p = window.__panel;
    const glow = (id: 'in.B' | 'in.C' | 'in.D' | 'tapTempo') => {
      const fill = p.view.elementFor(id).querySelector('.led-glow')?.getAttribute('fill') ?? 'missing';
      return fill === 'none' ? 'off' : fill;
    };
    const leds = {
      'in.B': { color: 'red', blink: 'none' },
      'in.C': { color: 'blue', blink: 'fast' },
      'in.D': { color: 'yellow', blink: 'slow' },
      tapTempo: { color: 'red', blink: 'tempo' },
    } as const;
    const snap = () => [glow('in.B'), glow('in.C'), glow('in.D'), glow('tapTempo')];
    p.render({ leds, beatPhase: 0.2 }, 0);
    const a = snap();
    p.render({ leds, beatPhase: 0.7 }, 100); // fast (6 Hz) in its dark half; slow (2 Hz) still lit
    const b = snap();
    p.render({ leds, beatPhase: 0.1 }, 350); // slow in its dark half; fast lit again
    const c = snap();
    p.render({}, 350);
    const d = snap();
    return { a, b, c, d };
  });
  expect(r.a).toEqual(['url(#glow-red)', 'url(#glow-blue)', 'url(#glow-yellow)', 'url(#glow-red)']);
  expect(r.b).toEqual(['url(#glow-red)', 'off', 'url(#glow-yellow)', 'off']);
  expect(r.c).toEqual(['url(#glow-red)', 'url(#glow-blue)', 'off', 'url(#glow-red)']);
  expect(r.d).toEqual(['off', 'off', 'off', 'off']);
});

test('rings light 24 segments by mode', async ({ page }) => {
  const lit = await page.evaluate(() => {
    const p = window.__panel;
    p.render({
      rings: [
        { color: 'green', blink: 'none', mode: 'status', amount: 0 },
        { color: 'red', blink: 'none', mode: 'position', amount: 0.5 },
        { color: 'yellow', blink: 'none', mode: 'level', amount: 0.25 },
        { color: 'off', blink: 'none', mode: 'status', amount: 1 },
        { color: 'blue', blink: 'fast', mode: 'status', amount: 0 },
      ],
    }, 100);
    const count = (n: number) => {
      const segs = [...p.view.rootSvg.querySelectorAll(`[data-ring="${n}"] .ring-seg`)];
      return { total: segs.length, lit: segs.filter((s) => s.getAttribute('data-level') !== '0').length,
        hot: segs.filter((s) => s.getAttribute('data-level') === '2').length };
    };
    return [1, 2, 3, 4, 5].map(count);
  });
  expect(lit).toEqual([
    { total: 24, lit: 24, hot: 0 },
    { total: 24, lit: 13, hot: 1 },
    { total: 24, lit: 6, hot: 0 },
    { total: 24, lit: 0, hot: 0 },
    { total: 24, lit: 0, hot: 0 }, // fast blink, dark half at t = 100 ms
  ]);
});

test('render() only touches attributes that changed since the previous frame', async ({ page }) => {
  const r = await page.evaluate(() => {
    const p = window.__panel;
    const svg = p.view.rootSvg;
    const mo = new MutationObserver(() => {});
    mo.observe(svg, { attributes: true, childList: true, subtree: true, characterData: true });
    const s1 = {
      leds: { 'trk1.rec': { color: 'red', blink: 'none' }, 'in.A': { color: 'pink', blink: 'none' } },
      rings: [{ color: 'red', blink: 'none', mode: 'position', amount: 0.25 }],
      lcd: 'demo',
    } as const;
    p.render(s1, 0);
    const first = mo.takeRecords().length;
    p.render(s1, 16); // a fresh but identical state object
    const same = mo.takeRecords().length;
    p.render({ ...s1, leds: { ...s1.leds, 'in.B': { color: 'red', blink: 'none' } } }, 32);
    const ledRecs = mo.takeRecords();
    const inB = p.view.elementFor('in.B');
    p.render({ ...s1, leds: { ...s1.leds, 'in.B': { color: 'red', blink: 'none' } },
      rings: [{ color: 'red', blink: 'none', mode: 'position', amount: 0.3 }] }, 48);
    const ringRecs = mo.takeRecords();
    const ring1 = svg.querySelector('[data-ring="1"]');
    mo.disconnect();
    return {
      first,
      same,
      led: ledRecs.length,
      ledOutside: ledRecs.filter((m) => !inB.contains(m.target)).length,
      ring: ringRecs.length,
      ringOutside: ringRecs.filter((m) => !ring1?.contains(m.target)).length,
    };
  });
  expect(r.first).toBeGreaterThan(0);
  expect(r.same).toBe(0);
  expect(r.led).toBeGreaterThan(0);
  expect(r.ledOutside).toBe(0);
  expect(r.ring).toBeGreaterThan(0);
  expect(r.ring).toBeLessThanOrEqual(8); // two segments changed (hot -> lit, dark -> hot), not all 24
  expect(r.ringOutside).toBe(0);
});

test('setPhysical moves fader caps and knob pointers', async ({ page }) => {
  const r = await page.evaluate(() => {
    const p = window.__panel;
    const v = p.view;
    const centre = (el: Element | null) => {
      const b = el!.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    };
    const cap = v.elementFor('trk2.fader').querySelector('.fader-cap');
    v.setPhysical('trk2.fader', 0);
    const low = centre(cap);
    v.setPhysical('trk2.fader', 1);
    const high = centre(cap);
    v.setPhysical('trk2.fader', 5); // clamps to 1
    const clamped = centre(cap);
    const ptr = v.elementFor('in.knob').querySelector('.knob-pointer');
    v.setPhysical('in.knob', 0);
    const k0 = centre(ptr);
    v.setPhysical('in.knob', 1);
    const k1 = centre(ptr);
    const svgW = v.rootSvg.getBoundingClientRect().width;
    const k = Math.min(svgW / p.PANEL_VIEWBOX.w, v.rootSvg.getBoundingClientRect().height / p.PANEL_VIEWBOX.h);
    return { travel: low.y - high.y, expected: p.LAYOUT['trk2.fader'].h * k, clampedSame: clamped.y === high.y, k0, k1 };
  });
  expect(r.travel).toBeCloseTo(r.expected, 0);
  expect(r.clampedSame).toBe(true);
  expect(r.k0.x).toBeLessThan(r.k1.x); // pointer swings from lower-left (0) to lower-right (1)
});

test('the LCD shows each LCD pixel as exactly s x s device pixels, centred in the glass, and follows resizes', async ({ page }) => {
  const measure = () => page.evaluate(() => {
    const p = window.__panel;
    const c = p.view.lcdCanvas;
    const dpr = devicePixelRatio;
    const sr = p.view.rootSvg.getBoundingClientRect();
    const k = Math.min(sr.width / p.PANEL_VIEWBOX.w, sr.height / p.PANEL_VIEWBOX.h);
    const ox = sr.left + (sr.width - p.PANEL_VIEWBOX.w * k) / 2;
    const oy = sr.top + (sr.height - p.PANEL_VIEWBOX.h * k) / 2;
    const L = p.LAYOUT.lcd;
    const glass = { left: ox + L.x * k, top: oy + L.y * k, width: L.w * k, height: L.h * k };
    const cr = c.getBoundingClientRect();
    const g = c.getContext('2d')!;
    const centre = g.getImageData(c.width >> 1, c.height >> 1, 1, 1).data;
    // Row 0 of the demo screen is solid dark (the inverted header bar): with no grid every device pixel matches.
    const row = g.getImageData(0, 0, c.width, 1).data;
    let rowColours = 0;
    for (let i = 0, prev = ''; i < row.length; i += 4) {
      const key = `${row[i]},${row[i + 1]},${row[i + 2]}`;
      if (key !== prev) { rowColours++; prev = key; }
    }
    const frac = (v: number) => Math.abs(v - Math.round(v));
    return {
      w: c.width, h: c.height, dpr, s: c.width / 128,
      expectedS: Math.max(1, Math.floor((glass.width * dpr) / 128)),
      clientDev: c.clientWidth * dpr, rectDevW: cr.width * dpr, rectDevH: cr.height * dpr,
      leftFrac: frac(cr.left * dpr), topFrac: frac(cr.top * dpr),
      dcx: Math.abs(cr.left + cr.width / 2 - (glass.left + glass.width / 2)),
      dcy: Math.abs(cr.top + cr.height / 2 - (glass.top + glass.height / 2)),
      inside: cr.left >= glass.left - 0.01 && cr.top >= glass.top - 0.01 &&
        cr.right <= glass.left + glass.width + 0.01 && cr.bottom <= glass.top + glass.height + 0.01,
      alpha: centre[3], rowColours,
    };
  });
  await page.evaluate(() => window.__panel.render({ lcd: 'demo' }, 0));
  for (const size of [null, { width: 1000, height: 700 }, { width: 1366, height: 1024 }]) {
    if (size) {
      await page.setViewportSize(size);
      await page.waitForFunction(({ w }) => Math.abs(window.__panel.view.rootSvg.getBoundingClientRect().width - w) < 1, { w: size.width });
      await page.evaluate(() => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res))));
    }
    const m = await measure();
    const info = JSON.stringify({ size, ...m });
    expect(m.w % 128, info).toBe(0);
    expect(m.h * 2, info).toBe(m.w);
    expect(m.s, info).toBe(m.expectedS); // s = max(1, floor(glass device width / 128))
    // Displayed at exactly the backing size in device pixels: an integer multiple of 128 x 64, no resampling.
    const mult = m.clientDev / 128;
    expect(Math.abs(mult - Math.round(mult)), info).toBeLessThan(0.01);
    expect(Math.abs(m.rectDevW - m.w), info).toBeLessThan(0.01);
    expect(Math.abs(m.rectDevH - m.h), info).toBeLessThan(0.01);
    expect(Math.max(m.leftFrac, m.topFrac), info).toBeLessThan(0.01); // on the device-pixel grid
    expect(m.inside, info).toBe(true);
    expect(Math.max(m.dcx, m.dcy), info).toBeLessThan(1); // centred in the glass
    expect(m.alpha, info).toBe(255); // painted, not blank
    if (m.s < 4) expect(m.rowColours, info).toBe(1); // solid pixels below scale 4: no grid lines
  }
});

test('legend tones and weights from CSS classes reach the rendered text', async ({ page }) => {
  const r = await page.evaluate(() => {
    const p = window.__panel;
    const texts = [...p.view.rootSvg.querySelectorAll('text')];
    const style = (s: string) => {
      const t = texts.find((e) => e.textContent === s);
      return t ? getComputedStyle(t) : null;
    };
    const letter = p.view.elementFor('in.A').querySelector('text');
    return {
      jack: style('MIC 1')?.fill, group: style('MIDI')?.fill, clear: style('CLEAR: HOLD')?.fill,
      menu: style('MENU')?.fill, red: style('INPUT FX')?.fill,
      letterWeight: letter ? getComputedStyle(letter).fontWeight : null,
      pillWeight: style('TRACK')?.fontWeight,
    };
  });
  expect(r).toEqual({
    jack: 'rgb(142, 146, 152)', group: 'rgb(142, 146, 152)', clear: 'rgb(163, 167, 173)',
    menu: 'rgb(183, 187, 193)', red: 'rgb(226, 37, 45)', letterWeight: '800', pillWeight: '700',
  });
});

test('render() x600 stays under 200 ms', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'timing budget is measured in Chromium');
  const r = await page.evaluate(() => {
    const p = window.__panel;
    const colors = ['red', 'green', 'yellow', 'pink', 'blue'] as const;
    const run = (lcdEvery: number) => {
      const st = p.makeState({
        lcd: 'demo',
        leds: {
          'trk1.track': { color: 'red', blink: 'none' }, 'trk2.track': { color: 'red', blink: 'none' },
          'in.A': { color: 'red', blink: 'slow' }, tapTempo: { color: 'red', blink: 'tempo' },
          'tr.edit': { color: 'blue', blink: 'fast' }, allStartStop: { color: 'green', blink: 'none' },
        },
        rings: [
          { color: 'red', blink: 'none', mode: 'position', amount: 0 },
          { color: 'green', blink: 'none', mode: 'position', amount: 0 },
          { color: 'yellow', blink: 'none', mode: 'level', amount: 0 },
          { color: 'green', blink: 'tempo', mode: 'status', amount: 0 },
          { color: 'blue', blink: 'fast', mode: 'position', amount: 0 },
        ],
      });
      for (let i = 0; i < 30; i++) p.view.render(st, i * 16); // warm up
      const t0 = performance.now();
      for (let f = 0; f < 600; f++) {
        const t = 1000 + f * (1000 / 60);
        st.beatPhase = (f % 30) / 30;
        for (let i = 0; i < 5; i++) st.rings[i].amount = ((f + i * 37) % 240) / 240;
        for (let i = 1; i <= 5; i++) {
          st.leds[`trk${i as 1 | 2 | 3 | 4 | 5}.rec`] = { color: colors[((f >> 5) + i) % 5], blink: i === 3 ? 'fast' : 'none' };
        }
        if (f % lcdEvery === 0) st.lcd[(f * 131) % st.lcd.length] ^= 1;
        p.view.render(st, t);
      }
      return performance.now() - t0;
    };
    return { lcdEvery4: run(4), lcdEveryFrame: run(1) };
  });
  testInfo.annotations.push({ type: 'perf', description: JSON.stringify(r) });
  console.log(`[panel perf] 600 renders: ${JSON.stringify(r)}`);
  expect(r.lcdEveryFrame).toBeLessThan(200);
});
