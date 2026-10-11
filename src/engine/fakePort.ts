import type { MessagePortLike } from './processor';
import type { EngineEvent, TimedCommand } from '../shared/protocol';

type EventOf<T extends EngineEvent['t']> = Extract<EngineEvent, { t: T }>;

/**
 * A MessagePort stand-in for running the engine in Node: the processor end in the processor tests, or both ends (a
 * pair from `FakePort.pair()`) between an EngineHost and a SageProcessor.
 *
 * Like a real port it posts structured clones and honours the transfer list (a transferred buffer is detached on the
 * sending side). Unlike one it delivers synchronously, so a test sees the effect of a post at once.
 */
export class FakePort implements MessagePortLike {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  /** Everything this end posted, as the other end receives it, with the transfer list it was posted with. */
  readonly posted: { data: unknown; transfer: Transferable[] }[] = [];
  private peer: FakePort | null = null;

  /** Two ports wired to each other: what one posts, the other's `onmessage` receives. */
  static pair(): [FakePort, FakePort] {
    const a = new FakePort();
    const b = new FakePort();
    a.peer = b;
    b.peer = a;
    return [a, b];
  }

  postMessage(message: unknown, transfer: Transferable[] = []): void {
    const data = structuredClone(message, { transfer });
    this.posted.push({ data, transfer });
    this.peer?.deliver(data);
  }

  /** Hands `message` to this end's `onmessage` (as a clone), as if the other side had posted it. */
  receive(message: unknown): void {
    this.deliver(structuredClone(message));
  }

  /** The EngineEvents of type `t` this end posted, in order. */
  events<T extends EngineEvent['t']>(t: T): EventOf<T>[] {
    return this.posted.flatMap(({ data }) => (isTagged(data) && data.t === t ? [data as EventOf<T>] : []));
  }

  /** The TimedCommands this end posted, in order. */
  commands(): TimedCommand[] {
    return this.posted.flatMap(({ data }) =>
      typeof data === 'object' && data !== null && 'cmd' in data && isTagged((data as { cmd: unknown }).cmd) ? [data as TimedCommand] : [],
    );
  }

  /** Forgets what was posted. */
  clear(): void {
    this.posted.length = 0;
  }

  private deliver(data: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data }));
  }
}

function isTagged(v: unknown): v is { t: string } {
  return typeof v === 'object' && v !== null && typeof (v as { t?: unknown }).t === 'string';
}
