/**
 * Plays one take at a time through a shared `<audio>` element and an object URL.
 *
 * An object URL keeps its Blob alive until it is revoked, so each URL is revoked as soon as nothing needs it: when the
 * take stops, ends, errors, is refused by the browser, is replaced by another take, is deleted, or the pod goes away.
 * At most one URL is alive at a time.
 *
 * `toggle` is meant to be called from the tap handler with the Blob already in hand: on iOS `audio.play()` only works
 * inside the user's gesture, so nothing may be awaited before it.
 */

/** The part of `HTMLAudioElement` this uses. */
export interface PlayerAudio {
  src: string;
  play(): Promise<void> | void;
  pause(): void;
  load?(): void;
  removeAttribute(name: 'src'): void;
  addEventListener(type: 'ended' | 'error', fn: () => void): void;
  removeEventListener(type: 'ended' | 'error', fn: () => void): void;
}

export interface ObjectUrls {
  create(blob: Blob): string;
  revoke(url: string): void;
}

export const browserUrls: ObjectUrls = {
  create: (blob) => URL.createObjectURL(blob),
  revoke: (url) => URL.revokeObjectURL(url),
};

export class TakePlayer {
  private current: { id: number; url: string } | null = null;
  private readonly onEnd = (): void => this.stop();

  constructor(
    private readonly audio: PlayerAudio,
    private readonly urls: ObjectUrls = browserUrls,
    /** Called whenever `playingId` changes. */
    private readonly onChange: () => void = () => {},
  ) {
    audio.addEventListener('ended', this.onEnd);
    audio.addEventListener('error', this.onEnd);
  }

  /** The id of the take that is playing, or null. */
  get playingId(): number | null {
    return this.current?.id ?? null;
  }

  /** Plays take `id` (whose audio is `blob`), or stops it if it is the one playing. Replaces any other take. */
  toggle(id: number, blob: Blob): void {
    const wasPlaying = this.current?.id === id;
    this.release();
    if (wasPlaying) {
      this.onChange();
      return;
    }
    const entry = { id, url: this.urls.create(blob) };
    this.current = entry;
    this.audio.src = entry.url;
    try {
      const started = this.audio.play();
      if (started) {
        // A refusal (autoplay policy, a media error) ends this take, but must not end one that replaced it meanwhile.
        started.catch(() => {
          if (this.current === entry) this.stop();
        });
      }
    } catch {
      this.release();
    }
    this.onChange();
  }

  /** Stops whatever is playing and revokes its URL. */
  stop(): void {
    if (!this.current) return;
    this.release();
    this.onChange();
  }

  /** The take is gone (deleted): stop it if it is the one playing. */
  forget(id: number): void {
    if (this.current?.id === id) this.stop();
  }

  /** Stops, revokes and detaches from the audio element. */
  dispose(): void {
    this.audio.removeEventListener('ended', this.onEnd);
    this.audio.removeEventListener('error', this.onEnd);
    this.release();
  }

  private release(): void {
    const entry = this.current;
    if (!entry) return;
    this.current = null;
    this.audio.pause();
    this.audio.removeAttribute('src'); // not `src = ''`: that raises an error event
    this.audio.load?.();
    this.urls.revoke(entry.url);
  }
}
