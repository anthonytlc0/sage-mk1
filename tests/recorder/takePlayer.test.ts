import { describe, expect, it, vi } from 'vitest';
import { TakePlayer } from '../../src/ui/takePlayer';
import type { ObjectUrls, PlayerAudio } from '../../src/ui/takePlayer';

class FakeAudio implements PlayerAudio {
  src = '';
  plays = 0;
  pauses = 0;
  loads = 0;
  /** What play() returns. */
  playResult: Promise<void> | void = undefined;
  private readonly handlers = new Map<string, Set<() => void>>();
  play(): Promise<void> | void {
    this.plays++;
    return this.playResult;
  }
  pause(): void {
    this.pauses++;
  }
  load(): void {
    this.loads++;
  }
  removeAttribute(name: 'src'): void {
    if (name === 'src') this.src = '';
  }
  addEventListener(type: string, fn: () => void): void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(fn);
  }
  removeEventListener(type: string, fn: () => void): void {
    this.handlers.get(type)?.delete(fn);
  }
  fire(type: 'ended' | 'error'): void {
    for (const fn of [...(this.handlers.get(type) ?? [])]) fn();
  }
  listenerCount(): number {
    return [...this.handlers.values()].reduce((n, s) => n + s.size, 0);
  }
}

class FakeUrls implements ObjectUrls {
  readonly created: string[] = [];
  readonly revoked: string[] = [];
  private n = 0;
  create(): string {
    const url = `blob:fake/${++this.n}`;
    this.created.push(url);
    return url;
  }
  revoke(url: string): void {
    this.revoked.push(url);
  }
  /** Object URLs created and not yet revoked. */
  get live(): string[] {
    return this.created.filter((u) => !this.revoked.includes(u));
  }
}

const blob = (): Blob => new Blob(['x'], { type: 'audio/wav' });

function setup() {
  const audio = new FakeAudio();
  const urls = new FakeUrls();
  const changes = vi.fn();
  const player = new TakePlayer(audio, urls, changes);
  return { audio, urls, changes, player };
}

describe('TakePlayer', () => {
  it('plays a take through an object URL, straight away', () => {
    const { audio, urls, player, changes } = setup();
    player.toggle(1, blob());
    expect(urls.created).toEqual(['blob:fake/1']);
    expect(audio.src).toBe('blob:fake/1');
    expect(audio.plays).toBe(1);
    expect(player.playingId).toBe(1);
    expect(changes).toHaveBeenCalledTimes(1);
  });

  it('toggling the playing take stops it and revokes its URL', () => {
    const { audio, urls, player } = setup();
    player.toggle(1, blob());
    player.toggle(1, blob());
    expect(player.playingId).toBeNull();
    expect(audio.pauses).toBe(1);
    expect(audio.src).toBe('');
    expect(urls.live).toEqual([]);
  });

  it('starting another take revokes the one before it: never more than one URL alive', () => {
    const { urls, player } = setup();
    player.toggle(1, blob());
    player.toggle(2, blob());
    expect(urls.revoked).toEqual(['blob:fake/1']);
    expect(player.playingId).toBe(2);
    player.toggle(3, blob());
    expect(urls.live).toEqual(['blob:fake/3']);
  });

  it('revokes the URL when the take plays to its end', () => {
    const { audio, urls, player, changes } = setup();
    player.toggle(1, blob());
    audio.fire('ended');
    expect(urls.live).toEqual([]);
    expect(player.playingId).toBeNull();
    expect(changes).toHaveBeenCalledTimes(2);
  });

  it('revokes the URL when the audio element errors', () => {
    const { audio, urls, player } = setup();
    player.toggle(1, blob());
    audio.fire('error');
    expect(urls.live).toEqual([]);
    expect(player.playingId).toBeNull();
  });

  it('gives up cleanly when play() is refused, and a late refusal does not stop the next take', async () => {
    const { audio, urls, player } = setup();
    let refuse!: (e: unknown) => void;
    audio.playResult = new Promise<void>((_, reject) => (refuse = reject));
    player.toggle(1, blob());
    audio.playResult = undefined;
    player.toggle(2, blob()); // take 2 is playing when take 1's play() is finally refused
    refuse(new DOMException('no', 'NotAllowedError'));
    await Promise.resolve();
    await Promise.resolve();
    expect(player.playingId).toBe(2);
    expect(urls.live).toEqual(['blob:fake/2']);

    audio.playResult = Promise.reject(new DOMException('no', 'NotAllowedError'));
    player.toggle(3, blob());
    await vi.waitFor(() => expect(player.playingId).toBeNull());
    expect(urls.live).toEqual([]);
  });

  it('forget() stops a take that is deleted while playing, and leaves other takes alone', () => {
    const { urls, player } = setup();
    player.toggle(1, blob());
    player.forget(2);
    expect(player.playingId).toBe(1);
    expect(urls.live).toHaveLength(1);
    player.forget(1);
    expect(player.playingId).toBeNull();
    expect(urls.live).toEqual([]);
  });

  it('dispose() revokes the URL and stops listening', () => {
    const { audio, urls, player, changes } = setup();
    player.toggle(1, blob());
    player.dispose();
    expect(urls.live).toEqual([]);
    expect(audio.listenerCount()).toBe(0);
    const calls = changes.mock.calls.length;
    audio.fire('ended');
    expect(changes.mock.calls.length).toBe(calls);
  });

  it('stop() with nothing playing is harmless', () => {
    const { audio, urls, player, changes } = setup();
    player.stop();
    expect(audio.pauses).toBe(0);
    expect(urls.revoked).toEqual([]);
    expect(changes).not.toHaveBeenCalled();
  });
});
