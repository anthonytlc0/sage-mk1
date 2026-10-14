/// <reference types="vite/client" />
/**
 * The recorder pod: a small separate device on the tabletop next to the panel. REC records the whole performance as a
 * take; LOOP MIX renders the loops that are playing to a file; the list below holds the takes, each with play, save
 * and delete.
 *
 * iPad Safari (often a Home Screen web app) shapes it:
 *  - SAVE calls `saveFile` synchronously in the tap handler, because `navigator.share` needs the tap's user activation.
 *    So a take's Blob is assembled as soon as recording stops and kept, and LOOP MIX is two steps: the first tap
 *    renders it (PREPARING...), the button becomes SAVE MIX, and the second tap saves it.
 *  - Take Blobs live in memory, next to the engine's loops, so what the pod keeps is capped (`cacheBytes`, 64 MB by
 *    default, about 4 minutes of take). Only a take that fits is prepared on its own; the oldest are evicted to make
 *    room, and a Blob is dropped once it has been saved. A take that is not in the cache (an old one, an evicted one,
 *    or one over the cap) is prepared by the first tap on its SAVE or play and used by the next. Such a Blob is held on
 *    the user's request even when it is over the cap, but only one over-cap Blob at a time, and it is let go after the
 *    save, after the playback, or after a minute unused.
 *  - The buttons are plain `div`s with pointer handlers, never focusable: Space, Enter and Tab belong to the panel's
 *    keyboard map, and a focused `<button>` would also click on Space.
 *
 * Keyboard: Backquote toggles REC, but the pod attaches no key listener; the shell calls `toggleRecord()` (the input
 * layer's `onSpecialKey('recorder')`).
 */

import './recorderPod.css';
import type { Controller } from '../control/controller';
import { NothingToMixError, exportLoopMix, mixCutNote } from '../recorder/loopMix';
import type { RenderMixFn } from '../recorder/loopMix';
import { formatClock, mixFilename, takeFilename } from '../recorder/names';
import type { Recorder, RecorderEvent } from '../recorder/recorder';
import { QuotaError } from '../storage/db';
import { saveFile } from '../storage/share';
import type { SaveResult } from '../storage/share';
import type { TakeInfo } from '../storage/takes';
import { TakePlayer } from './takePlayer';

export interface RecorderPodOptions {
  /** The mixer behind LOOP MIX: Task 9's `mixRenderer` (the app's renderAdapter). Null: LOOP MIX says NOT READY (R56). */
  render: RenderMixFn | null;
  /** Most bytes of take Blobs kept ready for SAVE and play. Default 64 MB (`DEFAULT_CACHE_BYTES`). */
  cacheBytes?: number;
  /** Saves a file (the share sheet or a download). Default `saveFile`; a test passes a stand-in. */
  save?: (blob: Blob, filename: string) => Promise<SaveResult>;
}

export interface RecorderPod {
  /** REC pressed: starts a take, or ends the running one. Resolves when that has happened. */
  toggleRecord(): Promise<void>;
  /**
   * Whether REC and LOOP MIX may start (the app shell: only while the unit is on with its audio running). Disabled,
   * they are dimmed and start nothing, though a running take can still be ended. Enabled by default.
   */
  setEnabled(on: boolean): void;
  /** Removes the pod and releases everything it holds. */
  dispose(): void;
}

export const DEFAULT_CACHE_BYTES = 64 * 1024 * 1024;
/** How long a message, a SAVED / FAILED note and the armed DEL stay up. */
const NOTE_MS = 2500;
const SAVED_MS = 1500;
const ARM_MS = 3000;
const TICK_MS = 100;
/** A Blob over the cache cap, held for a tap that asked for it, is let go after this long unused. */
const OVERCAP_HOLD_MS = 60_000;
/** U+FE0E asks for the text form: iOS draws a bare ▶ as an emoji. */
const PLAY = '▶︎';
const STOP = '■';
const WAV_HEADER_BYTES = 44;
const PCM24_FRAME_BYTES = 6;

/** The pod that `toggleRecord()` drives: the latest one mounted. */
let active: RecorderPod | null = null;

/** Toggles REC on the mounted pod (for the shell's Backquote handler). Does nothing when no pod is mounted. */
export function toggleRecord(): Promise<void> {
  return active ? active.toggleRecord() : Promise.resolve();
}

function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = doc.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** A button: not focusable, driven by the pod's pointer handler through `data-act`. */
function button(doc: Document, cls: string, act: string, label: string, text: string): HTMLDivElement {
  const b = el(doc, 'div', `rp-btn ${cls}`, text);
  b.setAttribute('role', 'button');
  b.setAttribute('aria-label', label);
  b.dataset.act = act;
  return b;
}

/** Resolves after the browser has painted what was just changed (or soon anyway, in a tab that does not paint). */
function afterPaint(): Promise<void> {
  return new Promise((resolve) => {
    const fallback = setTimeout(resolve, 80);
    requestAnimationFrame(() =>
      setTimeout(() => {
        clearTimeout(fallback);
        resolve();
      }, 0),
    );
  });
}

interface Row {
  info: TakeInfo;
  li: HTMLLIElement;
  len: HTMLElement;
  play: HTMLElement;
  save: HTMLElement;
  del: HTMLElement;
  preparing: boolean;
  /** SAVE was tapped and `saveFile` has not answered yet: more taps are ignored. */
  saving: boolean;
  armed: boolean;
  armTimer: ReturnType<typeof setTimeout> | undefined;
  /** SAVED / FAILED, shown in place of SAVE for a moment. */
  note: string | null;
  noteTimer: ReturnType<typeof setTimeout> | undefined;
}

export function mountRecorderPod(root: HTMLElement, recorder: Recorder, controller: Controller, opts: RecorderPodOptions): RecorderPod {
  const doc = root.ownerDocument;
  const cacheBytes = opts.cacheBytes ?? DEFAULT_CACHE_BYTES;
  const save = opts.save ?? saveFile;

  // ------------------------------------------------------------------------------------------------------- DOM
  const pod = el(doc, 'div', 'recorder-pod');
  pod.setAttribute('aria-label', 'Recorder');
  const recBtn = button(doc, 'rp-rec', 'rec', 'Record', '');
  recBtn.setAttribute('aria-pressed', 'false');
  recBtn.append(el(doc, 'span', 'rp-led'), el(doc, 'span', 'rp-rec-text', 'REC'));
  const clock = el(doc, 'div', 'rp-clock', '00:00');
  clock.setAttribute('role', 'timer');
  const mixBtn = button(doc, 'rp-mix', 'mix', 'Mix the playing loops', 'LOOP MIX');
  const mixDiscard = button(doc, 'rp-mix-discard', 'mix-discard', 'Discard the mix', '✕');
  mixDiscard.hidden = true;
  const head = el(doc, 'div', 'rp-head');
  head.append(recBtn, clock, mixBtn, mixDiscard);
  const noteLine = el(doc, 'div', 'rp-note');
  noteLine.setAttribute('role', 'status');
  const list = el(doc, 'ul', 'rp-takes');
  pod.append(head, noteLine, list);
  root.appendChild(pod);

  // ------------------------------------------------------------------------------------------------------- state
  const rows = new Map<number, Row>();
  /** Take Blobs ready for SAVE and play, least recently used first. */
  const cache = new Map<number, Blob>();
  const audio = doc.createElement('audio');
  audio.preload = 'none';
  /** The take that was playing when the player last changed, to tell when a playback has ended. */
  let wasPlaying: number | null = null;
  const player = new TakePlayer(audio, undefined, () => {
    const was = wasPlaying;
    wasPlaying = player.playingId;
    if (was !== null && was !== wasPlaying) dropIfOverCap(was); // played to the end, stopped or replaced
    rows.forEach(updateRow);
  });
  /** Timers that let go of an over-cap Blob nobody used for a while. */
  const holdTimers = new Map<number, ReturnType<typeof setTimeout>>();
  let mix: { phase: 'idle' | 'preparing' | 'ready'; blob: Blob | null; at: number; saving: boolean } = { phase: 'idle', blob: null, at: 0, saving: false };
  let noteTimer: ReturnType<typeof setTimeout> | undefined;
  let tickTimer: ReturnType<typeof setInterval> | undefined;
  let disposed = false;
  /** REC and LOOP MIX may start (`setEnabled`). */
  let enabled = true;

  // ------------------------------------------------------------------------------------------------------- message line
  function setNote(text: string, ms = NOTE_MS): void {
    clearTimeout(noteTimer);
    noteLine.textContent = text;
    noteTimer = setTimeout(() => {
      noteLine.textContent = '';
    }, ms);
  }

  // ------------------------------------------------------------------------------------------------------- REC and the clock
  function syncRecording(): void {
    const on = recorder.state === 'recording' || recorder.state === 'starting';
    recBtn.classList.toggle('is-on', on);
    recBtn.setAttribute('aria-pressed', String(on));
    clock.classList.toggle('is-on', on);
    syncDisabled();
    if (recorder.state === 'idle') clock.textContent = formatClock(0);
    if ((recorder.state === 'recording' || recorder.state === 'stopping') && tickTimer === undefined) {
      tickTimer = setInterval(tick, TICK_MS);
    } else if (recorder.state === 'idle' && tickTimer !== undefined) {
      clearInterval(tickTimer);
      tickTimer = undefined;
    }
  }

  function tick(): void {
    clock.textContent = formatClock(recorder.recordingFrames);
  }

  async function toggleRec(): Promise<void> {
    try {
      const s = recorder.state;
      if (s === 'idle') {
        if (!enabled) return; // the unit is off or has lost its audio: a take would be empty
        recBtn.classList.add('is-on'); // lit at once; the take itself exists a moment later
        await recorder.start();
      } else if (s === 'recording' || s === 'starting') {
        await recorder.stop();
      }
    } catch (e) {
      console.error('recorder failed', e);
      setNote(e instanceof QuotaError ? 'MEMORY FULL' : 'REC FAILED', 4000);
    } finally {
      syncRecording();
    }
  }

  const unsubscribe = recorder.onChange((e: RecorderEvent) => {
    syncRecording();
    if (e.kind === 'halted') setNote('AUDIO STOPPED: TAKE ENDED', 6000);
    if (e.kind === 'error') setNote(e.error instanceof QuotaError ? 'MEMORY FULL: TAKE ENDED' : 'REC FAILED: TAKE ENDED', 6000);
    if (e.kind === 'stop') void refresh().then(() => autoPrepare(e.takeId));
  });

  // ------------------------------------------------------------------------------------------------------- takes list
  function lengthText(r: Row): string {
    if (r.info.frames !== null) return formatClock(r.info.frames);
    const blob = cache.get(r.info.id);
    return blob ? formatClock((blob.size - WAV_HEADER_BYTES) / PCM24_FRAME_BYTES) : '--:--'; // never finished: a crash
  }

  function updateRow(r: Row): void {
    const cold = !cache.has(r.info.id);
    r.li.classList.toggle('is-cold', cold && !r.preparing);
    r.li.classList.toggle('is-preparing', r.preparing);
    r.save.classList.toggle('is-saving', r.saving);
    r.li.classList.toggle('is-playing', player.playingId === r.info.id);
    r.len.textContent = lengthText(r);
    r.play.textContent = player.playingId === r.info.id ? STOP : PLAY;
    r.play.setAttribute('aria-label', player.playingId === r.info.id ? 'Stop' : 'Play take');
    r.save.textContent = r.preparing ? '…' : (r.note ?? 'SAVE');
    r.del.textContent = r.armed ? 'SURE?' : 'DEL';
    r.del.classList.toggle('is-armed', r.armed);
  }

  function makeRow(info: TakeInfo): Row {
    const li = el(doc, 'li', 'rp-take');
    li.dataset.take = String(info.id);
    const start = new Date(info.createdAt);
    const time = el(doc, 'span', 'rp-take-time', `${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`);
    const len = el(doc, 'span', 'rp-take-len');
    const meta = el(doc, 'div', 'rp-take-meta');
    meta.append(time, len);
    const play = button(doc, 'rp-play', 'play', 'Play take', PLAY);
    const save = button(doc, 'rp-save', 'save', 'Save take', 'SAVE');
    const del = button(doc, 'rp-del', 'del', 'Delete take', 'DEL');
    li.append(play, meta, save, del);
    const row: Row = { info, li, len, play, save, del, preparing: false, saving: false, armed: false, armTimer: undefined, note: null, noteTimer: undefined };
    updateRow(row);
    return row;
  }

  function dropRow(r: Row): void {
    clearTimeout(r.armTimer);
    clearTimeout(r.noteTimer);
    player.forget(r.info.id);
    uncache(r.info.id);
    rows.delete(r.info.id);
    r.li.remove();
  }

  /** Brings the list in line with the store: newest first. */
  async function refresh(): Promise<void> {
    let infos: TakeInfo[];
    try {
      infos = await recorder.takes.list();
    } catch (e) {
      console.error('listing takes failed', e);
      return;
    }
    if (disposed) return;
    const ids = new Set(infos.map((t) => t.id));
    for (const r of [...rows.values()]) if (!ids.has(r.info.id)) dropRow(r);
    infos.sort((a, b) => b.id - a.id);
    let prev: Element | null = null;
    for (const info of infos) {
      let r = rows.get(info.id);
      if (r) r.info = info;
      else {
        r = makeRow(info);
        rows.set(info.id, r);
      }
      const want: Element | null = prev ? prev.nextElementSibling : list.firstElementChild;
      if (want !== r.li) list.insertBefore(r.li, want);
      updateRow(r);
      prev = r.li;
    }
    pod.classList.toggle('has-takes', rows.size > 0);
  }

  // ------------------------------------------------------------------------------------------------------- blob cache
  /** Lets go of take `id`'s cached Blob (the row becomes cold: its next SAVE or play prepares it again). */
  function uncache(id: number): void {
    cache.delete(id);
    clearTimeout(holdTimers.get(id));
    holdTimers.delete(id);
  }

  /**
   * Keeps `blob` for take `id`, evicting the oldest others until the cache fits `cacheBytes`. Without `requested`, a Blob
   * over the cap is not kept at all. With it (a tap asked for this take) it is kept even over the cap, alone: the next
   * Blob remembered evicts it, and it is let go after a minute unused.
   */
  function remember(id: number, blob: Blob, requested: boolean): void {
    uncache(id);
    const r = rows.get(id);
    if (blob.size > cacheBytes && !requested) {
      if (r) updateRow(r);
      return;
    }
    cache.set(id, blob);
    let total = 0;
    for (const b of cache.values()) total += b.size;
    for (const [oldId, b] of cache) {
      if (total <= cacheBytes || oldId === id) break;
      uncache(oldId);
      total -= b.size;
      const old = rows.get(oldId);
      if (old) updateRow(old);
    }
    if (blob.size > cacheBytes) {
      holdTimers.set(
        id,
        setTimeout(() => {
          holdTimers.delete(id);
          if (player.playingId === id) return remember(id, blob, true); // still playing: hold on
          uncache(id);
          const row = rows.get(id);
          if (row) updateRow(row);
        }, OVERCAP_HOLD_MS),
      );
    }
    if (r) updateRow(r);
  }

  /** A playback of take `id` is over: an over-cap Blob is not kept for it. */
  function dropIfOverCap(id: number): void {
    const blob = cache.get(id);
    if (blob && blob.size > cacheBytes) uncache(id);
  }

  /** After a take is finished: prepare it on the pod's own initiative if it fits the cache. */
  function autoPrepare(id: number): void {
    const frames = rows.get(id)?.info.frames;
    if (frames === null || frames === undefined) return;
    if (WAV_HEADER_BYTES + frames * PCM24_FRAME_BYTES > cacheBytes) return; // stays cold: a tap prepares it
    void prepare(id, false);
  }

  /** Assembles take `id`'s Blob into the cache (the take must be listed). Resolves null if that failed. */
  async function prepare(id: number, requested: boolean): Promise<Blob | null> {
    const r = rows.get(id);
    if (!r) return null;
    const hit = cache.get(id);
    if (hit) {
      remember(id, hit, requested); // most recently used
      return hit;
    }
    if (r.preparing) return null;
    r.preparing = true;
    updateRow(r);
    try {
      const blob = await recorder.takes.blob(id);
      if (!rows.has(id) || disposed) return null; // deleted meanwhile
      remember(id, blob, requested);
      return blob;
    } catch (e) {
      console.error('assembling take failed', e);
      setNote('TAKE UNREADABLE');
      return null;
    } finally {
      r.preparing = false;
      updateRow(r);
    }
  }

  // ------------------------------------------------------------------------------------------------------- take buttons
  function playTap(r: Row): void {
    const blob = cache.get(r.info.id);
    if (!blob) {
      void prepare(r.info.id, true);
      return;
    }
    remember(r.info.id, blob, true);
    player.toggle(r.info.id, blob); // synchronous: iOS only starts audio inside the gesture
  }

  function saveTap(r: Row): void {
    if (r.saving) return; // a share sheet or download is already on its way
    const blob = cache.get(r.info.id);
    if (!blob) {
      void prepare(r.info.id, true);
      return;
    }
    r.saving = true;
    updateRow(r);
    // Synchronous, with nothing awaited before it: the share sheet needs this tap's user activation.
    const result = save(blob, takeFilename(r.info.createdAt));
    const settle = (res: SaveResult): void => {
      r.saving = false;
      if (disposed) return;
      if (res === 'saved') uncache(r.info.id); // the file is out: do not keep the take in memory
      if (res !== 'cancelled') {
        r.note = res === 'saved' ? 'SAVED' : 'FAILED';
        clearTimeout(r.noteTimer);
        r.noteTimer = setTimeout(
          () => {
            r.note = null;
            updateRow(r);
          },
          res === 'saved' ? SAVED_MS : NOTE_MS,
        );
      }
      updateRow(r);
    };
    result.then(settle, () => settle('failed'));
  }

  function delTap(r: Row): void {
    if (!r.armed) {
      r.armed = true;
      updateRow(r);
      r.armTimer = setTimeout(() => {
        r.armed = false;
        updateRow(r);
      }, ARM_MS);
      return;
    }
    clearTimeout(r.armTimer);
    const id = r.info.id;
    dropRow(r); // gone from the screen and the cache at once; the store follows
    pod.classList.toggle('has-takes', rows.size > 0);
    recorder.takes.remove(id).catch((e: unknown) => {
      console.error('deleting take failed', e);
      setNote('DELETE FAILED');
      void refresh();
    });
  }

  // ------------------------------------------------------------------------------------------------------- LOOP MIX
  function syncMix(): void {
    mixBtn.textContent = mix.phase === 'preparing' ? 'PREPARING…' : mix.phase === 'ready' ? 'SAVE MIX' : 'LOOP MIX';
    mixBtn.classList.toggle('is-busy', mix.phase === 'preparing');
    mixBtn.classList.toggle('is-ready', mix.phase === 'ready');
    mixBtn.setAttribute('aria-label', mix.phase === 'ready' ? 'Save the mix' : 'Mix the playing loops');
    mixDiscard.hidden = mix.phase !== 'ready';
    syncDisabled();
  }

  async function renderMix(): Promise<void> {
    const render = opts.render;
    if (render === null) {
      setNote('NOT READY'); // no mixer yet: nothing is asked of the engine
      return;
    }
    mix = { phase: 'preparing', blob: null, at: 0, saving: false };
    syncMix();
    try {
      await afterPaint(); // the label shows before the render takes the thread
      let cut: number | null = null;
      const blob = await exportLoopMix(controller, render, { onCut: (s) => (cut = s) });
      if (disposed) return;
      mix = { phase: 'ready', blob, at: Date.now(), saving: false };
      if (cut !== null) setNote(mixCutNote(cut), 6000); // a touch device caps the mix (ruling R63)
    } catch (e) {
      if (!(e instanceof NothingToMixError)) console.error('loop mix failed', e);
      mix = { phase: 'idle', blob: null, at: 0, saving: false };
      setNote(e instanceof NothingToMixError ? 'NOTHING PLAYING' : 'MIX FAILED');
    }
    syncMix();
  }

  function saveMix(): void {
    const { blob, at } = mix;
    if (!blob || mix.saving) return; // already on its way
    mix.saving = true;
    mixBtn.classList.add('is-saving');
    const result = save(blob, mixFilename(at)); // synchronous, as for a take
    const settle = (res: SaveResult): void => {
      mixBtn.classList.remove('is-saving');
      if (disposed) return;
      mix.saving = false;
      if (res === 'saved') {
        mix = { phase: 'idle', blob: null, at: 0, saving: false };
        syncMix();
      } else if (res === 'failed') setNote('SAVE FAILED');
    };
    result.then(settle, () => settle('failed'));
  }

  // ------------------------------------------------------------------------------------------------------- taps
  pod.addEventListener('mousedown', (e) => {
    if ((e.target as Element).closest('[data-act]')) e.preventDefault(); // no focus, no text selection
  });
  pod.addEventListener('click', (e) => {
    const target = (e.target as Element).closest<HTMLElement>('[data-act]');
    if (!target || !pod.contains(target)) return;
    const row = target.closest<HTMLElement>('[data-take]');
    const r = row ? rows.get(Number(row.dataset.take)) : undefined;
    switch (target.dataset.act) {
      case 'rec':
        void toggleRec();
        break;
      case 'mix':
        if (mix.phase === 'idle' && enabled) void renderMix();
        else if (mix.phase === 'ready') saveMix();
        break;
      case 'mix-discard':
        mix = { phase: 'idle', blob: null, at: 0, saving: false };
        syncMix();
        break;
      case 'play':
        if (r) playTap(r);
        break;
      case 'save':
        if (r && !r.preparing) saveTap(r);
        break;
      case 'del':
        if (r) delTap(r);
        break;
    }
  });

  // ------------------------------------------------------------------------------------------------------- go
  syncRecording();
  syncMix();
  setEnabled(true);
  void refresh();

  function setEnabled(on: boolean): void {
    enabled = on;
    pod.classList.toggle('is-disabled', !on);
    syncDisabled();
  }

  /** REC is disabled only when it would start a take; LOOP MIX only when it would start a render. */
  function syncDisabled(): void {
    recBtn.setAttribute('aria-disabled', String(!enabled && recorder.state === 'idle'));
    mixBtn.setAttribute('aria-disabled', String(!enabled && mix.phase === 'idle'));
  }

  const handle: RecorderPod = {
    toggleRecord: () => toggleRec(),
    setEnabled,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      clearTimeout(noteTimer);
      clearInterval(tickTimer);
      for (const r of rows.values()) {
        clearTimeout(r.armTimer);
        clearTimeout(r.noteTimer);
      }
      player.dispose();
      for (const t of holdTimers.values()) clearTimeout(t);
      holdTimers.clear();
      cache.clear();
      rows.clear();
      pod.remove();
      if (active === handle) active = null;
    },
  };
  active = handle;
  return handle;
}
