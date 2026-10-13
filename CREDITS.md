# Credits

## Trademarks

RC-505mkII is a trademark of Roland Corporation. BOSS and Roland are trademarks or registered trademarks of Roland Corporation. Sage MK1 is an unofficial fan project. It is not made by, affiliated with, sponsored by or endorsed by Roland Corporation or BOSS. The names are used only to say which instrument this project imitates.

Sage MK1 contains no Roland or BOSS logos, factory rhythm patterns, drum samples or manual text. Parameter names, value ranges and pattern and genre names are facts about how the instrument works and are used as they appear in the manuals.

## Reference material

The behavior of Sage MK1 follows two documents published by Roland:

- RC-505mkII Owner's Manual (2021)
- RC-505mkII Parameter Guide, version 1.3

They were used as reference only and are not part of this repository or of the published site. The local copies are in `reference/`, which is listed in `.gitignore` and is not committed. The manuals belong to Roland; get your own copies from Roland's website.

The looper, the mixer and the DSP are written from scratch with standard, documented techniques. Roland does not publish the unit's firmware or DSP, and none of it was used.

## Third-party software that ships in the app

| Package | Version | License | Use |
| --- | --- | --- | --- |
| [fflate](https://github.com/101arrowz/fflate) | 0.8.3 | MIT | Zip packing and unpacking for `.sagemk1` memory files |

fflate is the only entry under `dependencies` in `package.json`, and it has no dependencies of its own. It is bundled into the production JavaScript. Its license text, as it appears in `node_modules/fflate/LICENSE`:

```
MIT License

Copyright (c) 2026 Arjun Barrett

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Development tooling

These are in `devDependencies`. They build and test the app and are not part of it, with one exception: the service worker that vite-plugin-pwa generates is built on Workbox, so a Workbox runtime file (`workbox-*.js`, MIT, Copyright 2018 Google LLC) is written into `dist/` next to it.

| Package | Version | License | Use |
| --- | --- | --- | --- |
| [Vite](https://vite.dev) | 8.3.4 | MIT | Dev server and production build |
| [Vitest](https://vitest.dev) | 5.0.3 | MIT | Unit tests |
| [Playwright](https://playwright.dev) (`@playwright/test`) | 1.64.0 | Apache-2.0 | Browser tests (Chromium and WebKit) |
| [TypeScript](https://www.typescriptlang.org) | 7.0.2 | Apache-2.0 | Language and typecheck |
| [vite-plugin-pwa](https://github.com/vite-pwa/vite-plugin-pwa) | 2.0.0 | MIT | Web app manifest and service worker |
| [Workbox](https://github.com/GoogleChrome/workbox) (`workbox-build` and friends) | 7.4.1 | MIT | Service worker runtime, pulled in by vite-plugin-pwa |
| [fake-indexeddb](https://github.com/dumbmatter/fakeIndexedDB) | 6.2.5 | Apache-2.0 | IndexedDB in the Node unit tests |

Versions are the ones in `package-lock.json` when this file was written. Those packages have dependencies of their own, all installed from npm under their own licenses (`package-lock.json` lists each one). They are used at build and test time only and none of them is shipped, but a few are not MIT, BSD or Apache: lightningcss (MPL-2.0, used by Vite for CSS), caniuse-lite (CC-BY-4.0, browser support data) and some packages under BlueOak-1.0.0 (file-matching helpers).

The GitHub Actions workflows use `actions/checkout`, `actions/setup-node`, `actions/upload-pages-artifact` and `actions/deploy-pages`, which are published by GitHub under the MIT license.

## Fonts, icons and other assets

There are no font files, image files, audio samples or other binary assets in the source tree, apart from two Playwright screenshots of the app's own panel in `tests/e2e/panel.spec.ts-snapshots/`.

- **LCD fonts.** The three LCD fonts in `src/lcd/fonts.ts` (small 5x7, medium 7x11, large 14x24 digits) are hand-made bitmaps, drawn glyph by glyph as text in the source. They are original pixel designs.
- **LCD icons.** The track, lock, note and other icons in `src/lcd/icons.ts` are original one-bit drawings.
- **Panel.** The panel is drawn as SVG by code (`src/ui/panelView.ts`). The panel text uses the system fonts of the device it runs on (a font stack in `src/ui/panel.css`); no web fonts are loaded.
- **Sound.** Every sound the app makes by itself, such as the latency-calibration clicks and the GUIDE click, is synthesized in code. No recorded samples are used.
