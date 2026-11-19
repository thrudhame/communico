// One asynchronous owner per stream. A blocked domain holds only its own apply
// cut; hello reconciliation and unrelated streams continue independently.
import { setTimeout as delay } from 'node:timers/promises';
import { canonicalJson } from '#engine/canonical.ts';
import type { Hello, JournalClient } from './client.ts';
import type { Heads, Journal, PageLimits } from './journal.ts';
import {
  type Cut,
  EMPTY_CUT,
  LinkError,
  type Stream,
  streamOf,
} from './protocol.ts';

type Peer = Pick<
  JournalClient,
  'peer' | 'hello' | 'pull' | 'push' | 'ack' | 'notices'
>;
type Options = {
  journal: Journal;
  client: Peer;
  limits: PageLimits;
  // The owning domain chooses Journal.apply for same-file effects, or idempotent
  // domain commit then Journal.complete for cross-file effects. No network in tx.
  apply(stream: Stream): Promise<boolean>;
  failed(error: unknown, stream?: Stream): void;
  acknowledged?(stream: Stream): void;
};
function key(stream: Stream) {
  return canonicalJson(streamOf(stream));
}
function sameCut(a: Cut, b: Cut) {
  return a.sequence === b.sequence && a.hash === b.hash;
}
function advance(held: Cut, remote: Cut) {
  if (
    remote.sequence < held.sequence ||
    (remote.sequence === held.sequence && remote.hash !== held.hash)
  ) {
    throw new LinkError(
      'LINK_DIVERGED',
      'remote journal head regressed or changed',
    );
  }
}

/** Local domains can depend on another stream's application, not its receipt.
 * Keep one current retry per incomplete stream, including while it is running.
 * Empty streams are not dependencies and never amplify a completion wake. */
class ApplicationDependencies {
  private readonly pending = new Map<string, () => void>();

  track(stream: Stream, heads: Heads, retry: () => void) {
    const id = key(stream);
    if (heads.received.sequence > heads.applied.sequence) {
      this.pending.set(id, retry);
    } else {
      this.pending.delete(id);
    }
  }

  progressed(stream: Stream) {
    const id = key(stream);
    for (const [other, retry] of this.pending) {
      if (other !== id) retry();
    }
  }
}

export class JournalReconciler {
  private readonly running = new Map<string, Promise<void>>();
  private readonly rerun = new Set<string>();
  private readonly dependencies = new ApplicationDependencies();
  constructor(private readonly options: Options) {}

  async reconcile(signal?: AbortSignal): Promise<Hello> {
    const hello = await this.options.client.hello(signal);
    const { client, journal } = this.options;
    const outgoing = (await journal.streams(client.peer.node, 'out')).filter((
      stream,
    ) =>
      stream.source === 'home' && stream.incarnation === client.peer.pairing
    );
    const incoming = (await journal.streams(client.peer.node, 'in')).filter((
      stream,
    ) =>
      stream.source === client.peer.node &&
      stream.incarnation === client.peer.incarnation
    );
    const remoteOut = new Map(
      hello.outgoing.map((stream) => [key(stream), stream]),
    );
    // A source disappearing on an unchanged incarnation is data loss, not an
    // empty stream to forget or silently replace with a new source identity.
    for (const held of incoming) {
      if (!remoteOut.has(key(held))) {
        this.options.failed(
          new LinkError('LINK_DIVERGED', 'facade source stream disappeared'),
          held,
        );
      }
    }
    for (const stream of outgoing) {
      this.start('out', stream, signal);
    }
    for (const stream of hello.outgoing) {
      this.start('in', stream, signal);
    }
    return hello;
  }

  private start(
    direction: string,
    stream: Heads,
    signal?: AbortSignal,
  ) {
    const id = direction + ':' + key(stream);
    if (this.running.has(id)) {
      this.rerun.add(id);
      return;
    }
    const job = (async () => {
      try {
        do {
          this.rerun.delete(id);
          try {
            // A wake received during an admitted pass is retained. Its next pass
            // obtains fresh cuts, never the hello preceding the previous ACK.
            const current = await this.options.client.hello(signal);
            if (direction === 'out') await this.push(stream, current, signal);
            else {
              const source = current.outgoing.find((entry) =>
                key(entry) === key(stream)
              );
              if (!source) {
                throw new LinkError(
                  'LINK_DIVERGED',
                  'facade source stream disappeared',
                );
              }
              await this.pull(source, current, signal);
            }
          } catch (error) {
            if (
              signal?.aborted &&
              (error === signal.reason ||
                (error instanceof Error && error.name === 'AbortError'))
            ) return;
            this.options.failed(error, stream);
          }
        } while (!signal?.aborted && this.rerun.delete(id));
      } finally {
        this.running.delete(id);
      }
    })();
    this.running.set(id, job);
  }

  async drain(): Promise<void> {
    // Completing one admitted domain may admit a dependent stream's retry.
    while (this.running.size) await Promise.all(this.running.values());
  }

  private async push(stream: Heads, hello: Hello, signal?: AbortSignal) {
    const { client, journal, limits } = this.options;
    const peer = client.peer.node;
    const remote = hello.incoming.find((entry) => key(entry) === key(stream));
    let ack = await journal.acknowledged(peer, stream);
    advance(ack.received, remote?.received ?? EMPTY_CUT);
    advance(ack.applied, remote?.applied ?? EMPTY_CUT);
    for (;;) {
      signal?.throwIfAborted();
      const page = await journal.page(
        peer,
        'out',
        stream,
        ack.received.sequence,
        limits,
      );
      const next = await client.push(
        stream,
        page.records,
        ack.applied,
        signal,
        page.head,
      );
      await journal.ack(
        peer,
        stream,
        next.received,
        next.applied,
        next.results,
      );
      if (next.applied.sequence > ack.applied.sequence) {
        this.options.acknowledged?.(stream);
      }
      const progressed = !sameCut(ack.received, next.received) ||
        !sameCut(ack.applied, next.applied);
      ack = next;
      // Receipt can advance before the receiver's application commits. Drain
      // toward this page's source head, not the old hello's applied cut; a
      // no-progress response still yields rather than spinning on blocked work.
      if (
        !progressed ||
        (ack.received.sequence >= page.head.sequence &&
          ack.applied.sequence >= page.head.sequence)
      ) break;
    }
  }

  private async pull(stream: Heads, hello: Hello, signal?: AbortSignal) {
    const { client, journal, limits } = this.options;
    const peer = client.peer.node;
    let held = await journal.heads(peer, 'in', stream);
    advance(held.received, stream.received);
    let target = stream.received;
    while (held.received.sequence < target.sequence) {
      signal?.throwIfAborted();
      const page = await client.pull(stream, held.received.sequence, signal);
      if (!page.records.length) {
        throw new LinkError(
          'LINK_DIVERGED',
          'source omitted records below its head',
        );
      }
      await journal.receive(peer, page.records);
      held = await journal.heads(peer, 'in', stream);
      target = page.head;
      advance(held.received, target);
    }
    const remote = hello.exportAcks.find((entry) => key(entry) === key(stream));
    let remoteApplied = remote?.applied ?? EMPTY_CUT;
    advance(remote?.received ?? EMPTY_CUT, held.received);
    advance(remoteApplied, held.applied);
    const track = () =>
      this.dependencies.track(
        stream,
        held,
        () => this.start('in', stream, signal),
      );
    track();
    const acknowledge = async () => {
      for (;;) {
        const ack = await journal.acknowledgement(
          peer,
          stream,
          remoteApplied,
          limits,
        );
        await client.ack(stream, ack, signal);
        const previous = remoteApplied;
        remoteApplied = ack.applied;
        if (
          sameCut(previous, remoteApplied) ||
          remoteApplied.sequence >=
            (await journal.heads(peer, 'in', stream)).applied.sequence
        ) break;
      }
    };
    // Receipt survives even if the next domain operation blocks or refuses.
    await acknowledge();
    while (!signal?.aborted && await this.options.apply(stream)) {
      // A callback cannot report success without completing a contiguous record.
      const next = await journal.heads(peer, 'in', stream);
      if (next.applied.sequence <= held.applied.sequence) {
        throw new LinkError(
          'LINK_DIVERGED',
          'domain reported application without a durable completion',
        );
      }
      held = next;
      track();
      this.dependencies.progressed(stream);
      await acknowledge();
    }
    signal?.throwIfAborted();
    await acknowledge();
  }
}

export function startHomeLinkWorker(
  options: Options & {
    notify: 'websocket' | 'sse' | 'poll';
    pollseconds: number;
    reconnectmaxseconds: number;
  },
): { wake(): void; close(): Promise<void> } {
  const controller = new AbortController();
  const signal = controller.signal;
  const reconciler = new JournalReconciler(options);
  let dirty = true;
  let waiting: (() => void) | undefined;
  const wake = () => {
    dirty = true;
    waiting?.();
  };
  const periodic = setInterval(wake, options.pollseconds * 1000);
  const loop = (async () => {
    while (!signal.aborted) {
      if (!dirty) {
        await new Promise<void>((resolve) => {
          waiting = resolve;
        });
      }
      waiting = undefined;
      if (signal.aborted) break;
      dirty = false;
      try {
        await reconciler.reconcile(signal);
      } catch (error) {
        if (!signal.aborted) options.failed(error);
      }
    }
  })();
  const notices = (async () => {
    if (options.notify === 'poll') return;
    let backoff = Math.min(options.pollseconds, options.reconnectmaxseconds) *
      1000;
    while (!signal.aborted) {
      try {
        wake(); // A reconnect never trusts that every notice was delivered.
        for await (
          const _heads of options.client.notices(options.notify, signal)
        ) {
          backoff = Math.min(options.pollseconds, options.reconnectmaxseconds) *
            1000;
          wake();
        }
      } catch (error) {
        if (!signal.aborted) options.failed(error);
      }
      if (!signal.aborted) {
        await delay(backoff, undefined, { signal }).catch(() => {});
        backoff = Math.min(backoff * 2, options.reconnectmaxseconds * 1000);
      }
    }
  })();
  let closed: Promise<void> | undefined;
  return {
    wake,
    close() {
      return closed ??= (async () => {
        clearInterval(periodic);
        controller.abort();
        wake();
        await Promise.all([loop, notices]);
        // Domain work already admitted is not cancelled by transport shutdown.
        await reconciler.drain();
      })();
    },
  };
}

/** Facade application is local and independent of the home socket. The same
 * explicit domain completion contract is used by both runtime roles. */
type InboxOptions = {
  journal: Journal;
  peer: string;
  pollseconds: number;
  apply(stream: Stream): Promise<boolean>;
  changed(): void;
  failed(error: unknown, stream?: Stream, after?: number): void;
};

export function startInboxWorker(options: InboxOptions) {
  return new InboxWorker(options);
}

export class InboxWorker {
  readonly wake: () => void;
  readonly close: () => Promise<void>;

  get peer(): string {
    return this.options.peer;
  }

  /** Includes domain validation before Journal.apply and transaction failures. */
  failed(error: unknown, stream?: Stream, after?: number): void {
    this.options.failed(error, stream, after);
  }

  constructor(private readonly options: InboxOptions) {
    let stopped = false;
    let scanning: Promise<void> | undefined;
    const running = new Map<string, Promise<void>>();
    const rerun = new Set<string>();
    const dependencies = new ApplicationDependencies();
    let dirty = false;
    const start = (stream: Stream) => {
      if (stopped) return;
      const id = key(stream);
      if (running.has(id)) {
        rerun.add(id);
        return;
      }
      const work = (async () => {
        try {
          do {
            rerun.delete(id);
            let applied: number | undefined;
            try {
              const heads = await options.journal.heads(
                options.peer,
                'in',
                stream,
              );
              applied = heads.applied.sequence;
              dependencies.track(stream, heads, () => start(stream));
              while (!stopped && await options.apply(stream)) {
                const next = await options.journal.heads(
                  options.peer,
                  'in',
                  stream,
                );
                if (next.applied.sequence <= applied) {
                  throw new LinkError(
                    'LINK_DIVERGED',
                    'domain reported application without durable completion',
                  );
                }
                applied = next.applied.sequence;
                dependencies.track(stream, next, () => start(stream));
                dependencies.progressed(stream);
                options.changed();
              }
            } catch (error) {
              this.failed(error, stream, applied);
            }
          } while (!stopped && rerun.delete(id));
        } finally {
          running.delete(id);
        }
      })();
      running.set(id, work);
    };
    const scan = () => {
      dirty = true;
      return scanning ??= (async () => {
        try {
          do {
            dirty = false;
            try {
              for (
                const stream of await options.journal.streams(
                  options.peer,
                  'in',
                )
              ) {
                if (stopped) break;
                start(stream);
              }
            } catch (error) {
              this.failed(error);
            }
          } while (!stopped && dirty);
        } finally {
          scanning = undefined;
        }
      })();
    };
    const timer = setInterval(() => void scan(), options.pollseconds * 1000);
    void scan();
    let closed: Promise<void> | undefined;
    this.wake = () => {
      if (!stopped) void scan();
    };
    this.close = () => {
      return closed ??= (async () => {
        stopped = true;
        clearInterval(timer);
        await scanning;
        await Promise.all(running.values());
      })();
    };
  }
}
