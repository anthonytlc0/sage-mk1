/**
 * MENU > USB > STORAGE: memory files (`.sagemk1`, see storage/memoryFile.ts). The app's stand-in for the hardware's
 * USB drive mode: turning (or pushing) the STORAGE knob on the USB page opens this screen.
 *
 *   [1] EXPORT MEMORY   the current memory as it is now, with its audio
 *   [2] IMPORT MEMORY   a file into a chosen slot; a slot holding a phrase is refused with NOT EMPTY
 *   [3] BACKUP ALL      memories 01-99 and the system settings in one file
 *   [4] RESTORE ALL     replaces every memory and the system settings (asks first)
 *
 * Push or turn a knob to pick a row, ENTER to run it.
 *
 * iPad Safari rules (spec, Platform constraints): the share sheet needs a fresh tap within a few seconds of the file
 * being ready, so an export is two-step: ENTER prepares the file (PREPARING...), then READY: ENTER=SAVE, and that
 * ENTER calls `saveFile` synchronously in its own handler. The file picker also needs the tap, so IMPORT's and
 * RESTORE's ENTER call `pickFile` at once; on iOS it has no type filter, and the file is validated afterwards.
 */

import type { Controller } from '../../control/controller';
import type { ControlEvent } from '../../shared/ids';
import { QuotaError } from '../../storage/db';
import {
  FileTooLarge, UnsupportedFile, defaultMaxDecodedBytes, packBackup, packMemory, unpackBackup, unpackMemory,
} from '../../storage/memoryFile';
import type { BackupContents, MemoryContents } from '../../storage/memoryFile';
import { pickFile, saveFile } from '../../storage/share';
import type { SaveResult } from '../../storage/share';
import { text } from '../draw';
import { FONT_LARGE, FONT_SMALL } from '../fonts';
import type { Framebuffer } from '../framebuffer';
import type { Screen, ScreenResult } from '../menu';
import { drawMessage } from './message';
import { drawLabelLines, drawTitleBar, knobIndex, turnSteps } from './common';
import { drawRows, looperBusy } from './prompt';

export const MSG_PREPARING = 'PREPARING...';
export const MSG_READY = 'READY: ENTER=SAVE';
export const MSG_RESTORE_CONFIRM = 'RESTORE ALL? ENTER/EXIT';
/** The extension of memory files and backups; IMPORT and RESTORE ask for it (desktop only: iOS greys it out). */
export const FILE_ACCEPT = '.sagemk1';

/** What the screen needs from the browser; the tests pass fakes. */
export interface StorageDeps {
  /** Saves a file (share sheet on iPad, download link elsewhere). Called synchronously in the ENTER handler. */
  saveFile(blob: Blob, filename: string): Promise<SaveResult>;
  /** Opens the file picker. Called synchronously in the ENTER handler. */
  pickFile(accept: string): Promise<File | null>;
  /** The bytes of a picked file. */
  readFile(file: File): Promise<Uint8Array>;
  /** The cap on decoded audio for this device (`defaultMaxDecodedBytes`). */
  maxDecodedBytes(): number;
}

export const browserStorageDeps: StorageDeps = {
  saveFile,
  pickFile,
  readFile: async (file) => new Uint8Array(await file.arrayBuffer()),
  maxDecodedBytes: () => defaultMaxDecodedBytes(),
};

const ITEMS = ['EXPORT MEMORY', 'IMPORT MEMORY', 'BACKUP ALL', 'RESTORE ALL'] as const;
const DEFAULT_RATE = 48000;
const CENTERED = { align: 'center', width: 128 } as const;

type State =
  | { readonly k: 'list' }
  | { readonly k: 'busy'; readonly text: string }
  | { readonly k: 'ready'; readonly blob: Blob; readonly name: string }
  | { readonly k: 'slot'; readonly contents: MemoryContents; slot: number }
  | { readonly k: 'confirm'; readonly backup: BackupContents };

const LIST: State = { k: 'list' };

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** `sage-mk1-m05-My_Loop.sagemk1`: the slot and the memory name, cut to characters every file system takes. */
export function memoryFileName(slot: number, name: string): string {
  const clean = name.trim().replace(/[^A-Za-z0-9-]+/g, '_');
  return `sage-mk1-m${pad2(slot)}${clean ? `-${clean}` : ''}.sagemk1`;
}

/** `sage-mk1-backup-2026-10-11.sagemk1` (local date). */
export function backupFileName(now: Date): string {
  return `sage-mk1-backup-${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}.sagemk1`;
}

/** The LCD message for a failed file operation; `fallback` for anything not about the file itself. */
function messageFor(e: unknown, fallback: string): string {
  if (e instanceof FileTooLarge) return 'FILE TOO LARGE';
  // unpack refuses audio over the device's cap as an unsupported file; it is really a file too large for this device
  if (e instanceof UnsupportedFile) return /too large/.test(e.reason) ? 'FILE TOO LARGE' : 'UNSUPPORTED FILE';
  if (e instanceof QuotaError) return 'MEMORY FULL';
  return fallback;
}

class StorageScreen implements Screen {
  readonly title = 'STORAGE';
  readonly items: readonly string[] = ITEMS;
  private _selected = 0;
  private state: State = LIST;
  /** Bumped whenever the state changes hands, so a late async result for an abandoned step is dropped. */
  private op = 0;
  private working = false;
  private disposed = false;

  constructor(private readonly deps: StorageDeps) {}

  /** The row ENTER runs, 0-3. */
  get selected(): number {
    return this._selected;
  }

  /** The popup the screen shows instead of the list (PREPARING..., READY: ENTER=SAVE, the RESTORE question), or null. */
  get prompt(): string | null {
    switch (this.state.k) {
      case 'busy': return this.state.text;
      case 'ready': return MSG_READY;
      case 'confirm': return MSG_RESTORE_CONFIRM;
      default: return null;
    }
  }

  /** The slot an import goes to while one is being chosen, else null. */
  get importSlot(): number | null {
    return this.state.k === 'slot' ? this.state.slot : null;
  }

  render(fb: Framebuffer): void {
    const st = this.state;
    if (st.k === 'slot') {
      drawTitleBar(fb, 'IMPORT MEMORY');
      text(fb, 0, 13, SLOT_TEXT[st.slot - 1]!, FONT_LARGE, CENTERED);
      text(fb, 0, 40, st.contents.settings.name, FONT_SMALL, CENTERED);
      drawLabelLines(fb, 0, SLOT_LABEL);
      drawLabelLines(fb, 3, ENTER_LABEL);
      return;
    }
    drawTitleBar(fb, this.title);
    const prompt = this.prompt;
    if (prompt !== null) drawMessage(fb, prompt);
    else drawRows(fb, this.items, this._selected);
  }

  onEvent(e: ControlEvent, ctx: Controller): ScreenResult {
    if (this.working) return e.kind === 'press' || e.kind === 'turn' ? 'handled' : 'unhandled';
    switch (this.state.k) {
      case 'list': return this.onList(e, ctx);
      case 'busy': return e.kind === 'press' && e.id === 'exit' ? this.toList() : this.swallow(e);
      case 'ready': return this.onReady(e, ctx, this.state);
      case 'slot': return this.onSlot(e, ctx, this.state);
      case 'confirm': return this.onConfirm(e, ctx, this.state);
    }
  }

  dispose(): void {
    this.disposed = true;
  }

  // ---- states -------------------------------------------------------------------------------------------------------

  private onList(e: ControlEvent, ctx: Controller): ScreenResult {
    if (e.kind === 'turn') {
      this._selected = Math.min(ITEMS.length - 1, Math.max(0, this._selected + e.steps));
      return 'handled';
    }
    if (e.kind !== 'press') return 'unhandled';
    const k = knobIndex(e.id);
    if (k >= 0) {
      this._selected = k;
      return 'handled';
    }
    if (e.id === 'exit') return 'pop';
    if (e.id !== 'enter') return 'unhandled';
    switch (this._selected) {
      case 0: this.exportMemory(ctx); break;
      case 1: this.pick(ctx, 'import'); break;
      case 2: this.backupAll(ctx); break;
      case 3: this.pick(ctx, 'restore'); break;
    }
    return 'handled';
  }

  private onReady(e: ControlEvent, ctx: Controller, st: Extract<State, { k: 'ready' }>): ScreenResult {
    if (e.kind !== 'press') return this.swallow(e);
    if (e.id === 'exit') return this.toList();
    if (e.id !== 'enter') return 'handled';
    // Synchronously, in this tap's handler: the share sheet needs the user activation. A cancelled share just leaves
    // the list showing; only a failure is reported.
    const saving = this.deps.saveFile(st.blob, st.name);
    this.toList();
    saving.then(
      (result) => {
        if (result === 'failed') ctx.showMessage('SAVE FAILED');
      },
      (err: unknown) => {
        console.error('saving the file failed', err);
        ctx.showMessage('SAVE FAILED');
      },
    );
    return 'handled';
  }

  private onSlot(e: ControlEvent, ctx: Controller, st: Extract<State, { k: 'slot' }>): ScreenResult {
    if (e.kind === 'turn') {
      st.slot = Math.min(99, Math.max(1, st.slot + turnSteps(e, ctx)));
      return 'handled';
    }
    if (e.kind !== 'press') return 'unhandled';
    if (e.id === 'exit') return this.toList();
    if (e.id !== 'enter') return 'handled';
    const op = this.op;
    this.working = true;
    ctx.showMessage('EXECUTING...', Infinity);
    ctx.importMemory(st.slot, st.contents).then(
      (result) => {
        this.working = false;
        ctx.clearMessage();
        if (this.disposed || op !== this.op) return;
        if (result === 'ok') this.toList();
        else ctx.showMessage(result);
      },
      (err: unknown) => {
        this.working = false;
        console.error('importing the memory failed', err);
        ctx.clearMessage();
        ctx.showMessage(messageFor(err, 'DATA WRITE ERR'));
      },
    );
    return 'handled';
  }

  private onConfirm(e: ControlEvent, ctx: Controller, st: Extract<State, { k: 'confirm' }>): ScreenResult {
    if (e.kind !== 'press') return this.swallow(e);
    if (e.id === 'exit') return this.toList();
    if (e.id !== 'enter') return 'handled';
    if (looperBusy(ctx)) {
      ctx.showMessage('STOP ALL');
      return 'handled';
    }
    this.working = true;
    ctx.showMessage('EXECUTING...', Infinity);
    ctx.restoreAll(st.backup).then(
      (result) => {
        this.working = false;
        ctx.clearMessage();
        if (!this.disposed) this.toList();
        if (result !== 'ok') ctx.showMessage(result);
      },
      (err: unknown) => {
        this.working = false;
        console.error('restoring the backup failed', err);
        ctx.clearMessage();
        if (!this.disposed) this.toList();
        ctx.showMessage(messageFor(err, 'DATA WRITE ERR'));
      },
    );
    return 'handled';
  }

  // ---- operations ---------------------------------------------------------------------------------------------------

  /** EXPORT MEMORY, step 1: the current memory and its audio, packed (PREPARING...), then READY: ENTER=SAVE. */
  private exportMemory(ctx: Controller): void {
    const op = this.setState({ k: 'busy', text: MSG_PREPARING });
    const slot = ctx.session.slot;
    ctx.exportCurrent()
      .then((m) => {
        if (!this.current(op)) return;
        const bytes = packMemory(m.settings, m.tracks, { maxDecodedBytes: this.deps.maxDecodedBytes() });
        this.ready(bytes, memoryFileName(slot, m.settings.name));
      })
      .catch((err: unknown) => this.failed(op, ctx, err, 'SAVE FAILED'));
  }

  /** BACKUP ALL, step 1: every stored memory and the system settings, packed, then READY: ENTER=SAVE. */
  private backupAll(ctx: Controller): void {
    const op = this.setState({ k: 'busy', text: MSG_PREPARING });
    ctx.backupAll()
      .then((b) => {
        if (!this.current(op)) return;
        const bytes = packBackup(b.memories, b.system, { maxDecodedBytes: this.deps.maxDecodedBytes() });
        this.ready(bytes, backupFileName(new Date()));
      })
      .catch((err: unknown) => this.failed(op, ctx, err, 'SAVE FAILED'));
  }

  /** IMPORT / RESTORE: the picker opens now; the list stays up while it is open (a cancel may never be reported). */
  private pick(ctx: Controller, kind: 'import' | 'restore'): void {
    const picking = this.deps.pickFile(FILE_ACCEPT);
    const op = this.op;
    picking.then(
      async (file) => {
        if (file === null || this.disposed || op !== this.op || this.state.k !== 'list') return;
        const busyOp = this.setState({ k: 'busy', text: MSG_PREPARING });
        try {
          const bytes = await this.deps.readFile(file);
          if (!this.current(busyOp)) return;
          const sr = ctx.status?.sampleRate ?? DEFAULT_RATE;
          const options = { maxDecodedBytes: this.deps.maxDecodedBytes() };
          if (kind === 'import') this.setState({ k: 'slot', contents: unpackMemory(bytes, sr, options), slot: ctx.session.slot });
          else this.setState({ k: 'confirm', backup: unpackBackup(bytes, sr, options) });
        } catch (err) {
          this.failed(busyOp, ctx, err, 'UNSUPPORTED FILE');
        }
      },
      (err: unknown) => console.error('the file picker failed', err),
    );
  }

  // ---- helpers ------------------------------------------------------------------------------------------------------

  private ready(bytes: Uint8Array, name: string): void {
    this.setState({ k: 'ready', blob: new Blob([bytes as Uint8Array<ArrayBuffer>]), name });
  }

  private failed(op: number, ctx: Controller, err: unknown, fallback: string): void {
    if (!this.current(op)) return;
    if (!(err instanceof FileTooLarge) && !(err instanceof UnsupportedFile)) console.error('memory file operation failed', err);
    this.toList();
    ctx.showMessage(messageFor(err, fallback));
  }

  private current(op: number): boolean {
    return !this.disposed && op === this.op;
  }

  private setState(st: State): number {
    this.state = st;
    return ++this.op;
  }

  private toList(): ScreenResult {
    this.setState(LIST);
    return 'handled';
  }

  private swallow(e: ControlEvent): ScreenResult {
    return e.kind === 'press' || e.kind === 'turn' ? 'handled' : 'unhandled';
  }
}

const SLOT_TEXT: readonly string[] = Array.from({ length: 99 }, (_, i) => pad2(i + 1));
const SLOT_LABEL: readonly string[] = ['MEMORY'];
const ENTER_LABEL: readonly string[] = ['ENTER'];

/** The STORAGE screen. `deps` default to the browser's file functions. */
export function storageScreen(deps: Partial<StorageDeps> = {}): Screen & {
  readonly items: readonly string[];
  readonly selected: number;
  readonly prompt: string | null;
  readonly importSlot: number | null;
} {
  return new StorageScreen({ ...browserStorageDeps, ...deps });
}
