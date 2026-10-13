import { describe, expect, it } from 'vitest';
import { WakeLockKeeper } from '../../src/app/wakeLock';
import type { WakeLockApi, WakeLockSentinelLike } from '../../src/app/wakeLock';

/** navigator.wakeLock as the tests drive it: each request is answered by the test (grant or refuse). */
class FakeWakeLock implements WakeLockApi {
  readonly requests: { resolve: (s: WakeLockSentinelLike) => void; reject: (e: unknown) => void }[] = [];
  readonly sentinels: FakeSentinel[] = [];
  request(type: 'screen'): Promise<WakeLockSentinelLike> {
    expect(type).toBe('screen');
    return new Promise((resolve, reject) => this.requests.push({ resolve, reject }));
  }
  /** Answers the oldest open request with a new sentinel. */
  grant(): FakeSentinel {
    const s = new FakeSentinel();
    this.sentinels.push(s);
    this.requests.shift()!.resolve(s);
    return s;
  }
  refuse(): void {
    this.requests.shift()!.reject(new DOMException('not allowed', 'NotAllowedError'));
  }
}

class FakeSentinel implements WakeLockSentinelLike {
  released = false;
  releases = 0;
  async release(): Promise<void> {
    this.releases++;
    this.released = true;
  }
}

class FakeDoc extends EventTarget {
  visibilityState: 'visible' | 'hidden' = 'visible';
  set(v: 'visible' | 'hidden'): void {
    this.visibilityState = v;
    this.dispatchEvent(new Event('visibilitychange'));
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('WakeLockKeeper', () => {
  it('requests the screen wake lock on acquire and only once while one is held or on its way', async () => {
    const api = new FakeWakeLock();
    const k = new WakeLockKeeper(api, new FakeDoc());
    k.acquire();
    k.ensure();
    expect(api.requests).toHaveLength(1);
    api.grant();
    await flush();
    k.ensure();
    expect(api.requests).toHaveLength(0);
    expect(k.held).toBe(true);
  });

  it('asks again when the page is visible again after the browser released it (it does on hide)', async () => {
    const api = new FakeWakeLock();
    const doc = new FakeDoc();
    const k = new WakeLockKeeper(api, doc);
    k.acquire();
    const first = api.grant();
    await flush();
    doc.set('hidden');
    first.released = true; // the browser lets go of it while the app is hidden
    expect(api.requests).toHaveLength(0); // never asked for while hidden
    doc.set('visible');
    expect(api.requests).toHaveLength(1);
    api.grant();
    await flush();
    expect(k.held).toBe(true);
  });

  it('does not ask while hidden, nor after release, and releases what it holds', async () => {
    const api = new FakeWakeLock();
    const doc = new FakeDoc();
    doc.visibilityState = 'hidden';
    const k = new WakeLockKeeper(api, doc);
    k.acquire();
    expect(api.requests).toHaveLength(0);
    doc.set('visible');
    const s = api.grant();
    await flush();
    k.release();
    expect(s.releases).toBe(1);
    doc.set('hidden');
    doc.set('visible');
    expect(api.requests).toHaveLength(0);
  });

  it('a lock granted after release (power off meanwhile) is let go at once', async () => {
    const api = new FakeWakeLock();
    const k = new WakeLockKeeper(api, new FakeDoc());
    k.acquire();
    k.release();
    const late = api.grant();
    await flush();
    expect(late.releases).toBe(1);
    expect(k.held).toBe(false);
  });

  it('fails silently: no API (iOS before 18.4), or a refused request, which a later ensure() retries', async () => {
    const none = new WakeLockKeeper(undefined, new FakeDoc());
    expect(() => {
      none.acquire();
      none.ensure();
      none.release();
    }).not.toThrow();

    const api = new FakeWakeLock();
    const k = new WakeLockKeeper(api, new FakeDoc());
    k.acquire();
    api.refuse();
    await flush();
    expect(k.held).toBe(false);
    k.ensure(); // a later tap tries again
    expect(api.requests).toHaveLength(1);
  });

  it('a request that throws synchronously is swallowed too', () => {
    const api: WakeLockApi = {
      request() {
        throw new TypeError('no');
      },
    };
    const k = new WakeLockKeeper(api, new FakeDoc());
    expect(() => k.acquire()).not.toThrow();
  });

  it('dispose stops listening for visibility and releases', async () => {
    const api = new FakeWakeLock();
    const doc = new FakeDoc();
    const k = new WakeLockKeeper(api, doc);
    k.acquire();
    const s = api.grant();
    await flush();
    k.dispose();
    expect(s.releases).toBe(1);
    s.released = true;
    doc.set('visible');
    expect(api.requests).toHaveLength(0);
  });
});
