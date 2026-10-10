/**
 * Getting files out of and into the browser: `saveFile` (memory files, backups, WAV exports) and `pickFile` (imports).
 *
 * The browser-specific wrappers at the bottom are thin. What they decide is in small pure helpers that take `nav` / `doc`
 * like objects (no DOM needed), so the decisions can be unit tested with stubs.
 *
 * iPad Safari, often as a Home Screen web app, is the tight target:
 *  - `a[download]` is unreliable in iOS Home Screen apps, so on touch devices that can share files the file goes to the
 *    share sheet (Save to Files, AirDrop, Mail...) with `navigator.share({ files })`;
 *  - `share()` needs a fresh user activation, so `saveFile` must be called synchronously inside the tap handler, with the
 *    Blob already built: nothing may be awaited before it (an export that takes time is built first, then a second
 *    tap saves it). `saveFile` itself runs straight through to the `share()` call without awaiting anything;
 *  - an iPad reports a Mac user agent, so touch is detected by `navigator.maxTouchPoints > 1`, never by sniffing the UA;
 *  - iOS greys out files in the picker when `accept` lists types it does not know (a `.sagemk1`), so on touch devices
 *    `pickFile` leaves the filter off and the caller validates what it gets.
 */

export type SaveResult = 'saved' | 'cancelled' | 'failed';

/** The part of `navigator` the share logic reads. */
export interface ShareNavigator {
  maxTouchPoints?: number;
  canShare?: (data: { files: File[] }) => boolean;
  share?: (data: { files: File[] }) => Promise<void>;
}

/** True for a touch device (an iPad, a phone, a touch laptop): more than one touch point. Never reads the user agent. */
export function isTouchDevice(nav: { maxTouchPoints?: number } | undefined): boolean {
  return (nav?.maxTouchPoints ?? 0) > 1;
}

/** The MIME type for a shared file: the Blob's own when it has one, otherwise a guess from the extension. */
export function mimeTypeFor(filename: string, blobType: string): string {
  if (blobType) return blobType;
  return /\.wav$/i.test(filename) ? 'audio/wav' : 'application/octet-stream';
}

function errorName(e: unknown): string {
  return typeof e === 'object' && e !== null && typeof (e as { name?: unknown }).name === 'string' ? (e as { name: string }).name : '';
}

export interface SaveDeps {
  nav: ShareNavigator | undefined;
  makeFile(blob: Blob, filename: string, type: string): File;
  /** Starts a download through a link; throws if it cannot. */
  download(blob: Blob, filename: string): void;
}

/**
 * Saves `blob` as `filename`: through the share sheet on a touch device that can share files, otherwise through a
 * download link.
 *  - 'saved'     the share sheet accepted the file, or the download link was clicked (a link cannot report more);
 *  - 'cancelled' the user dismissed the share sheet (AbortError);
 *  - 'failed'    anything else went wrong.
 * A NotAllowedError from `share()` (the tap's user activation had expired) falls back to the download link.
 *
 * Not `await`ing anything before `share()` is the point: this is an async function only so that it can return a
 * promise, and it runs synchronously up to the `share()` call.
 */
export async function saveWith(deps: SaveDeps, blob: Blob, filename: string): Promise<SaveResult> {
  const { nav } = deps;
  let data: { files: File[] } | null = null;
  try {
    if (isTouchDevice(nav) && typeof nav?.canShare === 'function' && typeof nav.share === 'function') {
      const candidate = { files: [deps.makeFile(blob, filename, mimeTypeFor(filename, blob.type))] };
      if (nav.canShare(candidate)) data = candidate;
    }
  } catch {
    data = null; // an engine that cannot build a File, or rejects the data: use the link
  }

  if (data) {
    try {
      await nav!.share!(data);
      return 'saved';
    } catch (e) {
      const name = errorName(e);
      if (name === 'AbortError') return 'cancelled';
      if (name !== 'NotAllowedError') return 'failed';
      // NotAllowedError: fall through to the link
    }
  }

  try {
    deps.download(blob, filename);
    return 'saved';
  } catch {
    return 'failed';
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Download link
// ---------------------------------------------------------------------------------------------------------------------

export interface AnchorLike {
  href: string;
  download: string;
  rel?: string;
  style?: { display: string };
  click(): void;
  remove(): void;
}

export interface DownloadDoc {
  createElement(tag: 'a'): AnchorLike;
  body: { appendChild(a: AnchorLike): unknown };
}

/** Clicks a hidden `a[download]` (attached to the page first: Firefox ignores a detached link) and removes it again. */
export function clickDownloadLink(doc: DownloadDoc, url: string, filename: string): void {
  const a = doc.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  if (a.style) a.style.display = 'none';
  doc.body.appendChild(a);
  try {
    a.click();
  } finally {
    a.remove();
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// File picker
// ---------------------------------------------------------------------------------------------------------------------

export interface PickInput {
  type: string;
  accept: string;
  style: { display: string };
  files: ArrayLike<File> | null;
  addEventListener(type: 'change' | 'cancel', listener: () => void): void;
  click(): void;
  remove(): void;
}

export interface PickDoc {
  createElement(tag: 'input'): PickInput;
  body: { appendChild(input: PickInput): unknown };
}

/**
 * Opens the system file picker with a hidden `input[type=file]` and resolves the chosen file, or null when the picker
 * is cancelled (browsers that report cancel with the `cancel` event; on an older one the promise stays pending) or
 * nothing was chosen. Call it synchronously inside a tap handler. `accept` (e.g. '.sagemk1') is not applied on touch
 * devices, so the caller validates the file it gets.
 */
export function pickWith(doc: PickDoc, nav: { maxTouchPoints?: number } | undefined, accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = doc.createElement('input');
    input.type = 'file';
    if (accept && !isTouchDevice(nav)) input.accept = accept;
    input.style.display = 'none';
    let settled = false;
    const finish = (file: File | null): void => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(file);
    };
    input.addEventListener('change', () => finish(input.files?.[0] ?? null));
    input.addEventListener('cancel', () => finish(null));
    doc.body.appendChild(input); // iOS needs the input in the page, and kept referenced, for `change` to fire
    input.click();
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Browser wiring
// ---------------------------------------------------------------------------------------------------------------------

/** Object URLs are revoked after the browser has had time to start the download. */
const REVOKE_AFTER_MS = 60_000;

const browserNav = (): ShareNavigator | undefined => (typeof navigator === 'undefined' ? undefined : navigator);

// The helpers take structural types so tests can stub them; these adapters hand them the real document.
const downloadDoc = (): DownloadDoc => ({
  createElement: (tag) => document.createElement(tag),
  body: { appendChild: (a) => document.body.appendChild(a as HTMLAnchorElement) },
});
const pickDoc = (): PickDoc => ({
  createElement: (tag) => document.createElement(tag),
  body: { appendChild: (input) => document.body.appendChild(input as HTMLInputElement) },
});

/** Saves `blob` as `filename`. Call it synchronously inside the tap handler, with the Blob already built. */
export function saveFile(blob: Blob, filename: string): Promise<SaveResult> {
  return saveWith(
    {
      nav: browserNav(),
      makeFile: (b, name, type) => new File([b], name, { type }),
      download: (b, name) => {
        const url = URL.createObjectURL(b);
        try {
          clickDownloadLink(downloadDoc(), url, name);
        } finally {
          setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
        }
      },
    },
    blob,
    filename,
  );
}

/** Lets the user choose a file. Call it synchronously inside the tap handler. See `pickWith`. */
export function pickFile(accept: string): Promise<File | null> {
  return pickWith(pickDoc(), browserNav(), accept);
}
