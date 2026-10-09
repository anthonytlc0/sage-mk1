# Sage MK1

A browser-based (TypeScript + Web Audio) recreation of a 5-track tabletop loop station. Runs on iPad Safari and desktop browsers.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the Vite dev server |
| `npm run build` | Typecheck, then build for production into `dist/` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Unit tests (Vitest, `tests/**/*.test.ts`) |
| `npm run e2e` | Browser tests (Playwright, `tests/e2e`; Chromium desktop + WebKit iPad Pro 11 landscape) |

First-time setup: `npm ci && npx playwright install chromium webkit`.

The e2e run starts its own dev server on port 5199.

## Layout

- `src/shared/` contracts shared by every module: control and panel types (`ids.ts`, `panel.ts`), the engine command/status protocol (`protocol.ts`) and constants (`constants.ts`).
- `src/schema/` settings schema types.
- `tests/` unit tests (`*.test.ts`) and Playwright specs (`e2e/*.spec.ts`).
