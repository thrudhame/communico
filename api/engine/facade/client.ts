// Typed home-initiated exchanges. All response identities are checked against
// the durable grant, not the most recent socket or an untrusted hello.
import { canonicalJson } from '#engine/canonical.ts';
import type {
  Acknowledgement,
  Heads,
  Page,
  TerminalResult,
} from './journal.ts';
import { type NoticeHead, noticeHeads, sseMessages } from './notices.ts';
import type { Pairings } from './pairing.ts';
import {
  type Cut,
  cutOf,
  integer,
  LINK_CAPABILITIES,
  LINK_VERSION,
  LinkError,
  negotiate,
  object,
  recordOf,
  type Stream,
  streamOf,
  text,
} from './protocol.ts';
import { LINK_PREFIX, LinkClient, type LinkTls } from './transport.ts';

export type Hello = {
  revision: number;
  scopes: string[];
  incoming: Heads[];
  outgoing: Heads[];
  exportAcks: Heads[];
};
export type Cuts = { received: Cut; applied: Cut };

function list(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) {
    throw new LinkError('LINK_BAD_RECORD', 'expected link array', 400);
  }
  return raw;
}
function cuts(raw: unknown): Cuts {
  const value = object(raw);
  const received = cutOf(value.received);
  const applied = cutOf(value.applied);
  if (applied.sequence > received.sequence) {
    throw new LinkError('LINK_DIVERGED', 'applied exceeds received');
  }
  return { received, applied };
}
function acknowledgement(raw: unknown): Acknowledgement {
  const value = object(raw);
  const results: TerminalResult[] = list(value.results).map((raw) => {
    const entry = object(raw);
    if (!Object.hasOwn(entry, 'result')) {
      throw new LinkError('LINK_BAD_RECORD', 'missing terminal result', 400);
    }
    return { ...cutOf(entry), result: entry.result };
  });
  return { ...cuts(value), results };
}

export async function openJournalClient(
  pairings: Pairings,
  id: string,
  tls: LinkTls,
): Promise<JournalClient> {
  const peer = await pairings.connection(id);
  if (peer.state !== 'paired' || !peer.grant) {
    throw new LinkError(
      'LINK_UNPAIRED',
      'journal requires completed enrollment',
      503,
    );
  }
  const transcript = peer.grant.body.transcript.body;
  return new JournalClient(
    new LinkClient(tls, { url: peer.context.url, pin: peer.context.facadePin }),
    {
      server: peer.context.server,
      node: peer.context.node,
      incarnation: transcript.incarnation,
      pairing: id,
      revision: peer.grant.body.revision,
    },
    async () => {
      const current = await pairings.connection(id);
      if (
        current.state !== 'paired' ||
        canonicalJson(current.grant) !== canonicalJson(peer.grant)
      ) {
        throw new LinkError(
          'LINK_UNPAIRED',
          'home link grant is no longer active',
          403,
        );
      }
    },
  );
}

export class JournalClient {
  constructor(
    private readonly wire: LinkClient,
    readonly peer: {
      server: string;
      node: string;
      incarnation: string;
      pairing: string;
      revision: number;
    },
    private readonly authorized: () => Promise<void>,
  ) {}

  private envelope() {
    return {
      protocol: LINK_VERSION,
      server: this.peer.server,
      required: LINK_CAPABILITIES,
      source: 'home',
      incarnation: this.peer.pairing,
      pairing: this.peer.pairing,
    };
  }

  private response(raw: unknown): Record<string, unknown> {
    const value = object(raw);
    negotiate(value, this.peer.server, LINK_CAPABILITIES);
    if (
      value.source !== this.peer.node ||
      value.incarnation !== this.peer.incarnation ||
      value.pairing !== this.peer.pairing
    ) {
      throw new LinkError(
        'LINK_IDENTITY_MISMATCH',
        'wrong journal response authority',
        403,
      );
    }
    return value;
  }

  private stream(raw: unknown, home: boolean): Stream {
    const stream = streamOf(raw);
    if (
      stream.source !== (home ? 'home' : this.peer.node) ||
      stream.incarnation !== (home ? this.peer.pairing : this.peer.incarnation)
    ) {
      throw new LinkError(
        'LINK_IDENTITY_MISMATCH',
        'wrong journal stream authority',
        403,
      );
    }
    return stream;
  }

  private async call(
    route: string,
    fields: Record<string, unknown> | undefined,
    signal?: AbortSignal,
  ) {
    await this.authorized();
    const response = await this.wire.fetch(
      LINK_PREFIX + route,
      fields
        ? {
          method: 'POST',
          signal,
          headers: { 'content-type': 'application/json' },
          body: canonicalJson({ ...this.envelope(), ...fields }),
        }
        : {
          signal,
          headers: { 'x-communico-link': canonicalJson(this.envelope()) },
        },
    );
    const raw = await response.json().catch(() => {
      throw new LinkError('LINK_BAD_RECORD', 'invalid journal response', 400);
    });
    if (!response.ok) {
      throw new LinkError(
        typeof object(raw).code === 'string'
          ? String(object(raw).code)
          : 'LINK_UNAVAILABLE',
        'journal exchange refused',
        response.status,
      );
    }
    return this.response(raw);
  }

  async hello(signal?: AbortSignal): Promise<Hello> {
    const value = await this.call('hello', undefined, signal);
    const heads = (raw: unknown, home: boolean): Heads[] => {
      const entries = list(raw).map((entry) => ({
        ...this.stream(entry, home),
        ...cuts(entry),
      }));
      if (
        new Set(entries.map((entry) => canonicalJson(streamOf(entry)))).size !==
          entries.length
      ) {
        throw new LinkError('LINK_BAD_RECORD', 'duplicate hello stream', 400);
      }
      return entries;
    };
    const revision = integer(value.revision, 1);
    if (revision < this.peer.revision) {
      throw new LinkError('LINK_DIVERGED', 'regressing control revision');
    }
    return {
      revision,
      scopes: list(value.scopes).map(text),
      incoming: heads(value.incoming, true),
      outgoing: heads(value.outgoing, false),
      exportAcks: heads(value.exportAcks, false),
    };
  }

  async pull(
    stream: Stream,
    after: number,
    signal?: AbortSignal,
  ): Promise<Page> {
    this.stream(stream, false);
    const value = await this.call(
      'records?stream=' + encodeURIComponent(canonicalJson(streamOf(stream))) +
        '&after=' + integer(after),
      undefined,
      signal,
    );
    const page = object(value.page);
    const records = list(page.records).map((raw) => {
      const record = recordOf(raw);
      if (
        canonicalJson(this.stream(record, false)) !==
          canonicalJson(streamOf(stream))
      ) {
        throw new LinkError(
          'LINK_IDENTITY_MISMATCH',
          'record belongs to another stream',
          403,
        );
      }
      return record;
    });
    const head = cutOf(page.head);
    if (
      head.sequence < after ||
      records.some((record) => record.sequence > head.sequence)
    ) {
      throw new LinkError('LINK_DIVERGED', 'page exceeds source head');
    }
    return { records, head };
  }

  async push(
    stream: Stream,
    records: readonly unknown[],
    after: Cut,
    signal?: AbortSignal,
  ): Promise<Acknowledgement> {
    this.stream(stream, true);
    const value = await this.call('records', {
      stream: streamOf(stream),
      records,
      after: cutOf(after),
    }, signal);
    return acknowledgement(value.ack);
  }

  async ack(
    stream: Stream,
    ack: Acknowledgement,
    signal?: AbortSignal,
  ): Promise<Cuts> {
    this.stream(stream, false);
    const value = await this.call(
      'ack',
      { stream: streamOf(stream), ...ack },
      signal,
    );
    const confirmed = cuts(value.ack);
    if (
      canonicalJson(confirmed) !==
        canonicalJson({ received: ack.received, applied: ack.applied })
    ) {
      throw new LinkError(
        'LINK_DIVERGED',
        'ACK confirmation differs from submitted cuts',
      );
    }
    return confirmed;
  }

  private heads(raw: unknown): NoticeHead[] {
    const value = this.response(raw);
    return noticeHeads(value.heads).map((entry) => ({
      ...this.stream(entry, entry.source === 'home'),
      head: entry.head,
    }));
  }

  async poll(signal?: AbortSignal): Promise<NoticeHead[]> {
    return this.heads(await this.call('notices', undefined, signal));
  }

  async *notices(
    mode: 'websocket' | 'sse',
    signal: AbortSignal,
  ): AsyncGenerator<NoticeHead[]> {
    await this.authorized();
    const headers = { 'x-communico-link': canonicalJson(this.envelope()) };
    if (mode === 'websocket') {
      const body = await this.wire.websocket(LINK_PREFIX + 'notices', {
        headers,
        signal,
      });
      for await (const message of body) {
        await this.authorized();
        yield this.heads(JSON.parse(message));
      }
    } else {
      const response = await this.wire.fetch(LINK_PREFIX + 'notices', {
        headers: { ...headers, accept: 'text/event-stream' },
        signal,
      });
      if (
        !response.ok ||
        response.headers.get('content-type') !== 'text/event-stream' ||
        !response.body
      ) {
        await response.body?.cancel();
        throw new LinkError(
          'LINK_UNAVAILABLE',
          'SSE notice admission refused',
          response.status,
        );
      }
      for await (const message of sseMessages(response.body)) {
        await this.authorized();
        yield this.heads(JSON.parse(message));
      }
    }
  }
}
