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

export class JournalReconciler {
  private readonly running = new Map<string, Promise<void>>();
  constructor(private readonly options: Options) {}

  async reconcile(signal?: AbortSignal): Promise<Hello> {
    const hello = await this.options.client.hello(signal);
    const { client, journal } = this.options;
    const outgoing = await journal.streams(client.peer.node, 'out');
    const incoming = await journal.streams(client.peer.node, 'in');
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
      this.start('out', stream, () => this.push(stream, hello, signal), signal);
    }
    for (const stream of hello.outgoing) {
      this.start('in', stream, () => this.pull(stream, hello, signal), signal);
    }
    return hello;
  }

  private start(
    direction: string,
    stream: Stream,
    work: () => Promise<void>,
    signal?: AbortSignal,
  ) {
    const id = direction + ':' + key(stream);
    if (this.running.has(id)) return;
    const job = work().catch((error) => {
      if (
        signal?.aborted &&
        (error === signal.reason ||
          (error instanceof Error && error.name === 'AbortError'))
      ) return;
      this.options.failed(error, stream);
    });
    this.running.set(id, job);
    void job.finally(() => this.running.delete(id));
  }

  async drain(): Promise<void> {
    await Promise.all(this.running.values());
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
      const next = await client.push(stream, page.records, ack.applied, signal);
      await journal.ack(
        peer,
        stream,
        next.received,
        next.applied,
        next.results,
      );
      const progressed = !sameCut(ack.received, next.received) ||
        !sameCut(ack.applied, next.applied);
      ack = next;
      if (
        !progressed ||
        (ack.received.sequence >= page.head.sequence &&
          ack.applied.sequence >= (remote?.applied.sequence ?? 0))
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
export function startInboxWorker(options: {
  journal: Journal;
  peer: string;
  pollseconds: number;
  apply(stream: Stream): Promise<boolean>;
  changed(): void;
  failed(error: unknown, stream?: Stream): void;
}) {
  let stopped = false;
  let scanning: Promise<void> | undefined;
  const running = new Map<string, Promise<void>>();
  const scan = () =>
    scanning ??= (async () => {
      try {
        for (
          const stream of await options.journal.streams(options.peer, 'in')
        ) {
          const id = key(stream);
          if (stopped || running.has(id)) continue;
          const work = (async () => {
            let applied = stream.applied.sequence;
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
              options.changed();
            }
          })().catch((error) => options.failed(error, stream));
          running.set(id, work);
          void work.finally(() => running.delete(id));
        }
      } catch (error) {
        options.failed(error);
      } finally {
        scanning = undefined;
      }
    })();
  const timer = setInterval(() => void scan(), options.pollseconds * 1000);
  void scan();
  let closed: Promise<void> | undefined;
  return {
    wake: () => {
      if (!stopped) void scan();
    },
    close() {
      return closed ??= (async () => {
        stopped = true;
        clearInterval(timer);
        await scanning;
        await Promise.all(running.values());
      })();
    },
  };
}
