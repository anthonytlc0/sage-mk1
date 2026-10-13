/// <reference types="vite/client" />
/**
 * The recorder pod: a small separate device on the tabletop next to the panel. REC records the whole performance as a
 * take; LOOP MIX renders the loops that are playing to a file; the list below holds the takes, each with play, save
 * and delete.
 *
 * iPad Safari (often a Home Screen web app) shapes it:
 *  - SAVE calls `saveFile` synchronously in the tap handler, because `navigator.share` needs the tap's user activation.
 *    So a take's Blob is assembled as soon as recording stops and kept (up to a memory cap), and LOOP MIX is two
 *    steps: the first tap renders it (PREPARING...), the button becomes SAVE MIX, and the second tap saves it.
 *    A take that is not in the cache (an old one, or one evicted) is prepared by the first tap, and used by the next.
 *  - The buttons are plain `div`s with pointer handlers, never focusable: Space, Enter and Tab belong to the panel's
 *    keyboard map, and a focused `<button>` would also click on Space.
 *
 * Keyboard: Backquote toggles REC, but the pod attaches no key listener; the shell calls `toggleRecord()` (the input
 * layer's `onSpecialKey('recorder')`).
 */

import './recorderPod.css';
import type { Controller } from '../control/controller';
import { NothingToMixError, exportLoopMix } from '../recorder/loopMix';
import type { RenderMixFn } from '../recorder/loopMix';
import { formatClock, mixFilename, takeFilename } from '../recorder/names';
import type { Recorder, RecorderEvent } from '../recorder/recorder';
import { QuotaError } from '../storage/db';
import { saveFile } from '../storage/share';
import type { TakeInfo } from '../storage/takes';
import { TakePlayer } from './takePlayer';

export interface RecorderPodOptions {
  /** The mixer behind LOOP MIX: Task 9's `renderMix`. */
  render: RenderMixFn;
  /** Most bytes of take Blobs kept ready for SAVE and play (the newest is always kept). Default 256 MB. */
  cacheBytes?: number;
}

export interface RecorderPod {
  /** REC pressed: starts a take, or ends the running one. Resolves when that has happened. */
  toggleRecord(): Promise<void>;
  /** Removes the pod and releases everything it holds. */
  dispose(): void;
}

export const DEFAULT_CACHE_BYTES = 256 * 1024 * 1024;
/** How long a message, a SAVED / FAILED note and the armed DEL stay up. */
const NOTE_MS = 2500;
const SAVED_MS = 1500;
const ARM_MS = 3000;
const TICK_MS = 100;
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
  armed: boolean;
  armTimer: ReturnType<typeof setTimeout> | undefined;
  /** SAVED / FAILED, shown in place of SAVE for a moment. */
  note: string | null;
  noteTimer: ReturnType<typeof setTimeout> | undefined;
}

export function mountRecorderPod(root: HTMLElement, recorder: Recorder, controller: Controller, opts: RecorderPodOptions): RecorderPod {
  const doc = root.ownerDocument;
  const cacheBytes = opts.cacheBytes ?? DEFAULT_CACHE_BYTES;

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
  const player = new TakePlayer(audio, undefined, () => rows.forEach(updateRow));
  let mix: { phase: 'idle' | 'preparing' | 'ready'; blob: Blob | null; at: number } = { phase: 'idle', blob: null, at: 0 };
  let noteTimer: ReturnType<typeof setTimeout> | undefined;
  let tickTimer: ReturnType<typeof setInterval> | undefined;
  let disposed = false;

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
    if (e.kind === 'error') setNote(e.error instanceof QuotaError ? 'MEMORY FULL: TAKE ENDED' : 'REC FAILED: TAKE ENDED', 6000);
    if (e.kind === 'stop') void refresh().then(() => prepare(e.takeId));
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
    const row: Row = { info, li, len, play, save, del, preparing: false, armed: false, armTimer: undefined, note: null, noteTimer: undefined };
    updateRow(row);
    return row;
  }

  function dropRow(r: Row): void {
    clearTimeout(r.armTimer);
    clearTimeout(r.noteTimer);
    player.forget(r.info.id);
    cache.delete(r.info.id);
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
  function remember(id: number, blob: Blob): void {
    cache.delete(id);
    cache.set(id, blob);
    let total = 0;
    for (const b of cache.values()) total += b.size;
    for (const [oldId, b] of cache) {
      if (total <= cacheBytes || oldId === id) break;
      cache.delete(oldId);
      total -= b.size;
      const r = rows.get(oldId);
      if (r) updateRow(r);
    }
  }

  /** Assembles take `id`'s Blob into the cache (the take must be listed). Resolves null if that failed. */
  async function prepare(id: number): Promise<Blob | null> {
    const r = rows.get(id);
    if (!r) return null;
    const hit = cache.get(id);
    if (hit) {
      remember(id, hit); // most recently used
      return hit;
    }
    if (r.preparing) return null;
    r.preparing = true;
    updateRow(r);
    try {
      const blob = await recorder.takes.blob(id);
      if (!rows.has(id) || disposed) return null; // deleted meanwhile
      remember(id, blob);
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
      void prepare(r.info.id);
      return;
    }
    remember(r.info.id, blob);
    player.toggle(r.info.id, blob); // synchronous: iOS only starts audio inside the gesture
  }

  function saveTap(r: Row): void {
    const blob = cache.get(r.info.id);
    if (!blob) {
      void prepare(r.info.id);
      return;
    }
    // Synchronous, with nothing awaited before it: the share sheet needs this tap's user activation.
    const result = saveFile(blob, takeFilename(r.info.createdAt));
    void result.then((res) => {
      if (res === 'cancelled' || disposed) return;
      r.note = res === 'saved' ? 'SAVED' : 'FAILED';
      updateRow(r);
      clearTimeout(r.noteTimer);
      r.noteTimer = setTimeout(
        () => {
          r.note = null;
          updateRow(r);
        },
        res === 'saved' ? SAVED_MS : NOTE_MS,
      );
    });
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
  }

  async function renderMix(): Promise<void> {
    mix = { phase: 'preparing', blob: null, at: 0 };
    syncMix();
    try {
      await afterPaint(); // the label shows before the render takes the thread
      const blob = await exportLoopMix(controller, opts.render);
      if (disposed) return;
      mix = { phase: 'ready', blob, at: Date.now() };
    } catch (e) {
      if (!(e instanceof NothingToMixError)) console.error('loop mix failed', e);
      mix = { phase: 'idle', blob: null, at: 0 };
      setNote(e instanceof NothingToMixError ? 'NOTHING PLAYING' : 'MIX FAILED');
    }
    syncMix();
  }

  function saveMix(): void {
    const { blob, at } = mix;
    if (!blob) return;
    const result = saveFile(blob, mixFilename(at)); // synchronous, as for a take
    void result.then((res) => {
      if (disposed) return;
      if (res === 'saved') {
        mix = { phase: 'idle', blob: null, at: 0 };
        syncMix();
      } else if (res === 'failed') setNote('SAVE FAILED');
    });
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
        if (mix.phase === 'idle') void renderMix();
        else if (mix.phase === 'ready') saveMix();
        break;
      case 'mix-discard':
        mix = { phase: 'idle', blob: null, at: 0 };
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
  void refresh();

  const handle: RecorderPod = {
    toggleRecord: () => toggleRec(),
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
      cache.clear();
      rows.clear();
      pod.remove();
      if (active === handle) active = null;
    },
  };
  active = handle;
  return handle;
}
