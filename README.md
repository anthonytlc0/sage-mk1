# Sage MK1

Sage MK1 is a software loop station for voice and beatbox looping. It is a browser recreation of the Boss RC-505mkII 5-track tabletop looper, written in TypeScript with Web Audio and no UI framework. It runs full screen on an iPad, added to the Home Screen, and on a desktop browser with the computer keyboard.

This is an unofficial fan project. It is not made by, affiliated with or endorsed by Roland Corporation or BOSS. The name Sage MK1 is the project's own; the panel artwork, LCD fonts and icons are drawn from scratch, and no Roland content is copied. See [CREDITS.md](CREDITS.md).

## Features

Phase 1, the core looper:

- **Panel replica.** An SVG copy of the unit's layout with five track columns, faders, knobs, buttons and LED rings, played by multi-touch on the iPad, by mouse, or by keyboard.
- **LCD.** A 128x64 one-bit screen with original bitmap fonts, the real MENU tree, the WRITE, CLEAR and NAME screens, and the manual's messages (MEMORY FULL, NOT EMPTY and so on).
- **Looper.** Five tracks with REC/DUB/PLAY, STOP and CLEAR, undo/redo and Mark Back, tap tempo, ALL START/STOP, LOOP SYNC and QUANTIZE, and the TRACK, REC and PLAY parameters of the Parameter Guide. Behavior follows the Owner's Manual; where the manuals are silent it is inferred.
- **Mixer.** One mic as MIC 1 with gain, compressor, noise suppressor and EQ, a fader and a pan setting per track, MASTER FX compressor and reverb, and the OUTPUT LEVEL knob.
- **Guide click.** The only rhythm in phase 1 is the GUIDE genre click, so LOOP SYNC and QUANTIZE have a tempo reference.
- **Memories.** 99 slots holding settings and the audio of all five tracks, kept in the browser (IndexedDB). WRITE saves, and changing memory drops unsaved edits, as on the hardware.
- **Installable and offline.** A web app that installs to the iPad Home Screen. A service worker caches the whole app on the first visit, so it starts without a network connection afterwards. A POWER switch starts the audio, and the screen is kept awake while the unit is on. See [Power](#power).
- **Recorder pod and memory files.** See [Exports](#exports).

Not in phase 1: the 53 Input FX and Track FX types (phase 2), the rhythm section with its genres and kits (phase 3), and MIDI and foot pedals (phase 4, optional). The FX and RHYTHM buttons are on the panel already.

## Running locally

Node 24 (what CI uses); 22.12 and later 22.x also work.

| Command | What it does |
| --- | --- |
| `npm install` | Install the dependencies (`npm ci` is the clean install CI uses) |
| `npm run dev` | Start the Vite dev server |
| `npm run build` | Typecheck, then build for production into `dist/` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Unit tests (Vitest, `tests/**/*.test.ts`) |
| `npm run e2e` | Browser tests (Playwright, `tests/e2e`; Chromium desktop + WebKit iPad Pro 11 landscape) |

Before the first `npm run e2e`, install the browsers Playwright drives: `npx playwright install chromium webkit`. The e2e run starts its own dev server on port 5199.

Browsers only give a page the microphone over HTTPS or on `localhost`. `npm run dev` on your own machine works. Opening the dev server from an iPad over your network (plain `http://` and an IP address) does not, so on the iPad use the deployed site.

## Install on iPad

1. Open the site in Safari: `https://<your-github-username>.github.io/<repo>/`. The real address is filled in when the site is published.
2. Tap Share, then Add to Home Screen, then Add.
3. Start Sage MK1 from the new Home Screen icon, not from Safari.

Why install it: the Home Screen app runs full screen without Safari's toolbars, and its storage is kept apart from Safari's tab storage and is much more likely to be kept by the iPad (the app asks for persistent storage when it powers on). The two storages do not share memories. Pick one and keep using it. The app also caches itself (see [Offline use](#offline-use)).

Then:

- **Use headphones, wired if you can.** Bluetooth headphones drop to mono hands-free audio as soon as the mic opens. Headphones also stop the speaker feeding back into the mic.
- **Hold the iPad in landscape.** A web app cannot lock the orientation, so when the screen is taller than it is wide the app shows a ROTATE TO LANDSCAPE card. That includes a narrow Split View window.
- **Tap POWER and allow the microphone.** See [Power](#power). A Home Screen app may ask for the mic again on a later launch.
- **Turn off the iPad multitasking gestures** (Settings, Multitasking & Gestures). iPadOS keeps edge swipes and 4 and 5 finger touches for itself, and the app cannot block them. The panel sits clear of the screen edges to help.

## Power

The POWER switch is at the bottom left of the screen, outside the panel. It is the tap the browser requires before it will start audio and ask for the mic, so the unit makes no sound until you tap it.

- **Tap when off.** Starts the audio engine and asks for the mic, loads the system settings and memory 01, and shows the boot screen (the name and version) for at least 1.5 seconds. The play screen appears when the unit is on. On the first run the LCD may first ask CALIBRATE?, and after a crash RECOVER?. A POWER tap while it is still starting is ignored for the first 3 seconds; after that it cancels a power-on that is stuck.
- **Tap when on.** Switches off. A take that is being recorded is finished first, the system settings are saved, and a clean shutdown is marked, so RECOVER? is not offered next time. Edits to the current memory that you did not WRITE are discarded, as on the hardware.
- **Audio lost.** If the audio stops while the unit is on (a call, Siri, another app, the lock screen) and does not come back by itself, a card covers the panel: AUDIO STOPPED, TAP POWER TO RESUME. A recording take that was running is ended. Tap POWER, or the card, to bring the audio and the mic back; the card says RESUMING... while it tries. If the resume fails, the card says RESUME FAILED and the next POWER tap switches the unit off (a tap on the card tries again). If a resume gets no answer for 5 seconds, the card says NOT RESPONDING and the next POWER tap switches off as well. In both cases the POWER light blinks faster.
- **Screen on.** While the unit is on, the app asks the browser to keep the screen awake (the Screen Wake Lock; iPadOS supports it in Home Screen apps from 18.4). It asks again when the app comes back to the front. Where the browser does not support it or refuses, nothing is shown and the screen sleeps on its normal timer. Switching off lets the screen sleep again.

## Offline use

Sage MK1 is a progressive web app. The first time it loads, a service worker (built by vite-plugin-pwa) caches the whole app: the page, the code, the AudioWorklet that runs the looper, the styles and the icons. After one visit online it opens and powers on without a network. Your memories and takes are stored on the device, not on a server.

A new version never replaces the running one in the middle of a set. It is downloaded in the background when you open the app, and takes over the next time you open the app after closing it completely. On the iPad, close it from the app switcher.

## Use on a PC

Open the same site in a current desktop browser (the tests run Chromium and WebKit), click POWER, and allow the microphone. The keyboard plays the buttons; the mouse plays the knobs and faders (drag, or turn the wheel over a control). Exports download as files.

### Keyboard map

Keys are matched by physical position, so the map is the same on any keyboard layout. The one exception is `?`, which is matched by the character it types, because it sits on different keys on different layouts. Press `?` to show a badge with the key name over each control on the panel; press `?` again to hide them. A held key is a held button, and key repeat is ignored. Ctrl, Cmd and Alt combinations and typing in a text field are left to the browser.

| Keys | Control |
| --- | --- |
| `1` `2` `3` `4` `5` | TRACK button of tracks 1 to 5 |
| `Q` `W` `E` `R` `T` | FX button of tracks 1 to 5 |
| `A` `S` `D` `F` `G` | REC/DUB/PLAY of tracks 1 to 5 |
| `Z` `X` `C` `V` `B` | STOP of tracks 1 to 5 (hold to clear the track) |
| `6` | INPUT FX EDIT |
| `7` `8` `9` `0` | INPUT FX A, B, C, D |
| `Y` | TRACK FX EDIT |
| `U` `I` `O` `P` | TRACK FX A, B, C, D |
| `Space` | ALL START/STOP |
| `Tab` | UNDO/REDO |
| `H` | TAP TEMPO |
| `N` | RHYTHM START/STOP |
| `Shift` + `N` | RHYTHM EDIT |
| `M` | MENU |
| `L` | LOOP |
| `←` `→` | Cursor buttons (left, right) |
| `Enter` | ENTER |
| `Esc` | EXIT |
| `` ` `` (backquote) | Recorder pod REC: start or stop a take |
| `?` | Show or hide the key overlay |

The four encoders [1] to [4], the track faders, the INPUT FX and TRACK FX knobs and OUTPUT LEVEL have no keys. Use the mouse for those. As on the unit, `Esc` and `Enter` together open the WRITE screen.

## Exports

Everything leaves the app as a file. On a PC the browser downloads it. On the iPad the file goes to the share sheet (Save to Files, AirDrop, Mail), which iPadOS only opens right after a tap. So a file that takes time to build is made first (the screen says PREPARING...), and your next tap on SAVE or ENTER opens the sheet. A finished take is already built when recording stops; an old one may need one extra tap.

- **Performance recording.** The recorder pod sits beside the unit. REC, or the backquote key, records everything you hear (the loops and the GUIDE click) plus your live mic, even while INPUT THRU monitoring is off, through MASTER FX. It streams to storage as it goes, so long sets are fine. The takes list plays, saves or deletes each take. Format: WAV, 44.1 kHz, 24-bit.
- **Loop mixdown.** LOOP MIX renders the playing loops offline as one full cycle, which is the least common multiple of the playing tracks' lengths, capped at 10 minutes (past the cap it uses the longest track). Faders, pan and MASTER FX are applied; the live input and the GUIDE click are not. The first tap prepares the mix, then the button becomes SAVE MIX. Format: WAV, 44.1 kHz, 24-bit.
- **Memory files.** In MENU > USB > STORAGE: EXPORT MEMORY, IMPORT MEMORY (into any slot; a slot that already holds audio refuses with NOT EMPTY), BACKUP ALL (all 99 memories and the system settings) and RESTORE ALL. A `.sagemk1` file is a zip holding `memory.json` and one 32-bit float WAV per track, so a memory moves between devices without loss. Export on the iPad, import on the PC.

## Non-hardware additions

Everything else behaves as the hardware manuals describe. These seven things do not exist on the real unit:

1. **POWER switch.** Also the tap that lets the browser start audio and ask for the mic. See [Power](#power).
2. **Latency calibration** (MENU > SETUP > LATENCY). Plays eight clicks, records them through the mic and stores the measured round-trip delay per device. Recorded audio is shifted earlier by that amount so overdubs line up.
3. **Crash recovery.** Unsaved work is checkpointed in the background. After an unexpected exit, the LCD asks RECOVER? at power-on. A normal power-off discards unsaved work, as on the hardware.
4. **Recorder pod.** The performance recorder, takes list and LOOP MIX, standing in for the computer you would plug the unit into.
5. **Keyboard map and the `?` overlay.**
6. **Rotate screen.** A ROTATE TO LANDSCAPE card, shown whenever the screen is taller than it is wide.
7. **MIC PROCESS** (MENU > SETUP > MIC PROCESS). Turns the browser's mic echo cancellation on or off.

One default is changed: OUTPUT > ROUTING > INPUT THRU starts OFF, so the live mic is not played through the speaker. Turn it on in the menu if you want to monitor through headphones.

## Known limits

- **Memory.** RAM is the ceiling, not storage. The audio budget is 384 MiB on touch devices (the iPad browser process is limited to roughly 1.5 to 4 GB in total) and 1 GiB on desktop. Only the current memory's audio is held in RAM. When the budget or the storage quota runs out, the LCD shows MEMORY FULL.
- **Latency.** iPadOS does not report input latency, and `outputLatency` reads 0 until playback starts. Run the calibration once on each device and audio route, at first power-on if the LCD offers CALIBRATE? ENTER. It plays clicks out loud for the mic to hear, so stop all tracks and take the headphones off for it. Until then the browser's reported latency is used.
- **Mic processing is off by default.** The app asks for the mic with echo cancellation off, because iOS 27 crackles page audio while it is on. If the mic is very quiet on your iPad, MIC PROCESS can turn it on, and the crackle may return.
- **Backgrounding.** When the app is interrupted (another app, Control Center, lock screen), a performance recording ends. On return the app resumes the audio and re-opens the mic; if audio does not come back, the TAP POWER TO RESUME card appears (see [Power](#power)).
- **Hardware-only settings** are in the menus and save and recall normally but do nothing: PHANTOM, INST GAIN, STEREO LINK, USB AUDIO MODE and ROUTING, the OUTPUT SUB 1/2 jacks (output is folded to MAIN), AUTO OFF, and CTL/EXP until phase 4. The INST inputs are silent.
- **Left out on purpose:** per-track stem export, importing a WAV into a track, USER rhythm patterns, USB audio-interface features, parallel outputs and linking two units.
- **Effects are not sample-exact copies.** Boss does not publish its DSP, so effects use standard techniques tuned by ear.

## Deploying

Pushing to `main` runs `.github/workflows/pages.yml`. It runs `npm ci`, the typecheck and the unit tests, builds with `--base=/<repo>/` (a project site is served from a subpath), and publishes `dist/` to GitHub Pages. In the repository settings, set Pages to build from GitHub Actions once. The manifest's `start_url` and `scope`, the service worker's URL and scope, and the cached file list all follow that base: nothing in `vite.config.ts` hard-codes `/`. To preview a subpath build locally: `npm run build -- --base=/sage-mk1/ && npx vite preview --base=/sage-mk1/`.

## Project layout

- `src/main.ts` and `src/app.ts` the entry point and the app shell: `bootApp` builds the page and wires every module to the browser (the panel, the shelf with POWER and the recorder pod, input, the rotate screen).
- `src/app/` the power cycle (`unit.ts`: POWER on and off, the boot, resuming lost audio, the TAP POWER TO RESUME states), the screen wake lock (`wakeLock.ts`) and the adapter that gives LOOP MIX its mixer (`renderAdapter.ts`).
- `src/shared/` contracts used by every module: control and panel types (`ids.ts`, `panel.ts`), the engine command and status protocol (`protocol.ts`) and constants (`constants.ts`).
- `src/schema/` the parameter schema that mirrors the Parameter Guide (name, range, default, display format, memory or system), and the memory and system settings built from it.
- `src/core/` the looper core: track state machine, transport and tempo, loop sync, fades, undo history, the tempo-sync time stretcher, and the pooled audio chunks. Pure TypeScript with no browser APIs, tested sample by sample in Node.
- `src/dsp/` the signal blocks: mic input chain (gain, compressor, noise suppressor, EQ), mixer, MASTER FX compressor and reverb, and biquad filters.
- `src/engine/` runs the core and the DSP inside an AudioWorklet (`processor.ts`) and wires the mic and speakers on the main thread (`host.ts`); also the latency-calibration capture.
- `src/control/` the main-thread controller: button semantics (holds and chords), the current memory and system settings, tap tempo, PREFERENCE handling, latency calibration, and the state the panel draws.
- `src/lcd/` the 128x64 LCD: framebuffer, bitmap fonts, icons, the screens and the MENU tree.
- `src/ui/` the SVG panel, LEDs, key overlay and recorder pod, plus the shell around them: the POWER switch and resume card (`power.ts`), the rotate screen (`rotate.ts`) and the page layout (`shell.css`). `src/ui/input/` turns touch, mouse and keyboard into control events.
- `src/recorder/` the performance recorder, the loop mixdown and WAV encoding and file names.
- `src/storage/` IndexedDB (memories, settings, audio chunks, crash recovery, takes), `.sagemk1` memory files, WAV, resampling, and saving or sharing files.
- `public/icons/` the Home Screen and favicon images.
- `vite.config.ts` the build, the web app manifest and the service worker (vite-plugin-pwa).
- `tests/` unit tests (`*.test.ts`, one folder per `src/` module) and Playwright specs (`e2e/*.spec.ts`).

## License and credits

License: to be decided before publishing.

Third-party licenses, the Roland trademark notice, and what was and was not used from the manuals are in [CREDITS.md](CREDITS.md).
