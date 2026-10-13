/**
 * Screen Wake Lock while the unit is powered on, so the iPad does not dim and lock in the middle of a set.
 *
 * iPadOS honours it in Home Screen web apps from iOS 18.4, and releases it whenever the app is hidden, so it is asked
 * for again each time the page becomes visible. Everything fails silently: no API (older iOS, some browsers), a refused
 * request (no user activation, Low Power Mode) or a throwing one leave the screen to its normal timeout. The shell also
 * calls `ensure()` on panel taps, which retries a refused request with the tap's activation.
 */

export interface WakeLockSentinelLike {
  readonly released: boolean;
  release(): Promise<void>;
}

/** `navigator.wakeLock`. */
export interface WakeLockApi {
  request(type: 'screen'): Promise<WakeLockSentinelLike>;
}

/** `document`, for its visibility. */
export interface VisibilitySource {
  readonly visibilityState: string;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

export class WakeLockKeeper {
  private sentinel: WakeLockSentinelLike | null = null;
  private pending = false;
  private wanted = false;

  constructor(
    private readonly api: WakeLockApi | undefined,
    private readonly doc: VisibilitySource | null,
  ) {
    doc?.addEventListener('visibilitychange', this.onVisibility);
  }

  /** A wake lock is held right now. */
  get held(): boolean {
    return this.sentinel !== null && !this.sentinel.released;
  }

  /** Keeps the screen on from now (power-on). */
  acquire(): void {
    this.wanted = true;
    this.ensure();
  }

  /** Lets the screen sleep again (power-off). */
  release(): void {
    this.wanted = false;
    const s = this.sentinel;
    this.sentinel = null;
    if (s && !s.released) s.release().catch(() => undefined);
  }

  /** Asks for the lock if it is wanted, the page is visible, and none is held or on its way. Never throws. */
  ensure(): void {
    if (!this.wanted || !this.api || this.pending || this.held) return;
    if (this.doc !== null && this.doc.visibilityState !== 'visible') return;
    this.pending = true;
    let request: Promise<WakeLockSentinelLike>;
    try {
      request = this.api.request('screen');
    } catch {
      this.pending = false;
      return;
    }
    request.then(
      (s) => {
        this.pending = false;
        if (this.wanted) this.sentinel = s;
        else s.release().catch(() => undefined); // powered off while it was on its way
      },
      () => {
        this.pending = false; // refused: the screen keeps its normal timeout; a later ensure() tries again
      },
    );
  }

  dispose(): void {
    this.doc?.removeEventListener('visibilitychange', this.onVisibility);
    this.release();
  }

  private readonly onVisibility = (): void => {
    if (this.doc?.visibilityState === 'visible') this.ensure();
  };
}
