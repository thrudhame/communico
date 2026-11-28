// Typed home-initiated exchanges. All response identities are checked against
// the durable grant, not the most recent socket or an untrusted hello.
import { canonicalJson } from '#engine/canonical.ts';
import type { KeyDoc } from '#engine/federation/keys.ts';
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
  DOMAIN_OPERATION_V2_CAPABILITY,
  integer,
  LINK_CAPABILITIES,
  LINK_SUPPORTED,
  LINK_VERSION,
  LinkError,
  LIVE_ACTIVITY_CAPABILITY,
  type LiveActivity,
  MEDIA_COPY_CAPABILITY,
  MEDIA_WANTS_CAPABILITY,
  negotiate,
  object,
  recordOf,
  type Stream,
  streamOf,
  text,
} from './protocol.ts';
import { LINK_PREFIX, LinkClient, type LinkTls } from './transport.ts';
import type { MediaCopyRoute } from './media-copy.ts';

export type Hello = {
  revision: number;
  scopes: string[];
  incoming: Heads[];
  outgoing: Heads[];
  exportAcks: Heads[];
  mediaCopy?: true;
  mediaWants?: true;
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
  private activityRequest?: string;
  #domainReaderVersion?: 1 | 2;

  get domainReaderVersion(): 1 | 2 | undefined {
    return this.#domainReaderVersion;
  }

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
    negotiate(value, this.peer.server, LINK_SUPPORTED);
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
    const hello = {
      revision,
      scopes: list(value.scopes).map(text),
      incoming: heads(value.incoming, true),
      outgoing: heads(value.outgoing, false),
      exportAcks: heads(value.exportAcks, false),
    };
    const supported = value.supported === undefined
      ? []
      : list(value.supported);
    const readers = supported.map((raw) => {
      const entry = object(raw);
      return { type: text(entry.type), version: integer(entry.version, 1) };
    });
    const v2 = DOMAIN_OPERATION_V2_CAPABILITY;
    // A concurrent hello started before the reader upgraded may arrive late.
    // The supported rolling direction for this enrollment is v1 to v2.
    if (
      readers.some((entry) =>
        entry.type === v2.type && entry.version === v2.version
      )
    ) {
      this.#domainReaderVersion = 2;
    } else this.#domainReaderVersion ??= 1;
    const mediaCopy = readers.some((entry) =>
      entry.type === MEDIA_COPY_CAPABILITY.type &&
      entry.version === MEDIA_COPY_CAPABILITY.version
    );
    const mediaWants = readers.some((entry) =>
      entry.type === MEDIA_WANTS_CAPABILITY.type &&
      entry.version === MEDIA_WANTS_CAPABILITY.version
    );
    return {
      ...hello,
      ...(mediaCopy ? { mediaCopy: true } as const : {}),
      ...(mediaWants ? { mediaWants: true } as const : {}),
    };
  }

  async pushMedia(
    route: import('./media-wants.ts').MediaWantRoute,
    fields: Record<string, unknown>,
    signal: AbortSignal,
  ) {
    const value = await this.call(route, {
      ...fields,
      required: [...LINK_CAPABILITIES, MEDIA_WANTS_CAPABILITY],
    }, signal);
    if (
      !negotiate(value, this.peer.server, LINK_SUPPORTED).required.some((
        entry,
      ) =>
        entry.type === MEDIA_WANTS_CAPABILITY.type &&
        entry.version === MEDIA_WANTS_CAPABILITY.version
      )
    ) {
      throw new LinkError(
        'LINK_CAPABILITY_MISMATCH',
        'media wants response not negotiated',
      );
    }
    return value;
  }

  async pullMedia(
    route: MediaCopyRoute,
    fields: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    const required = [...LINK_CAPABILITIES, MEDIA_COPY_CAPABILITY];
    const value = await this.call(route, { ...fields, required }, signal);
    if (
      !negotiate(value, this.peer.server, LINK_SUPPORTED).required.some((
        entry,
      ) =>
        entry.type === MEDIA_COPY_CAPABILITY.type &&
        entry.version === MEDIA_COPY_CAPABILITY.version
      )
    ) {
      throw new LinkError(
        'LINK_CAPABILITY_MISMATCH',
        'media copy response not negotiated',
      );
    }
    return value;
  }

  /** Both legs use a receiver challenge from this attempt, never from a
   * previous wake. Receiver-local age bounds the flight without wall-clock
   * synchronization or subtracting an unrelated poll/reconnect interval. */
  async activity(owner: LiveActivity, signal?: AbortSignal): Promise<void> {
    const challenge = crypto.randomUUID();
    const started = performance.now();
    this.activityRequest = challenge;
    const required = [...LINK_CAPABILITIES, LIVE_ACTIVITY_CAPABILITY];
    const validate = (value: Record<string, unknown>, expected: string) => {
      if (
        !negotiate(value, this.peer.server, LINK_SUPPORTED).required.some((
          entry,
        ) =>
          entry.type === LIVE_ACTIVITY_CAPABILITY.type &&
          entry.version === LIVE_ACTIVITY_CAPABILITY.version
        )
      ) {
        throw new LinkError(
          'LINK_CAPABILITY_MISMATCH',
          'live activity response not negotiated',
        );
      }
      if (value.challenge !== expected) {
        throw new LinkError('LINK_DIVERGED', 'wrong live activity challenge');
      }
    };
    try {
      const value = await this.call(
        'activity',
        { required, challenge, relayPresence: true },
        signal,
      );
      await this.authorized();
      signal?.throwIfAborted();
      if (this.activityRequest !== challenge) return;
      validate(value, challenge);
      const next = text(value.nextChallenge);
      const send = async () => {
        const snapshot = await owner.capture(this.peer.pairing);
        signal?.throwIfAborted();
        if (this.activityRequest !== challenge) return;
        const finish = crypto.randomUUID();
        // Older listeners treat this as an ordinary answer and return an
        // extra snapshot. It is never applied or kept for the next wake.
        const reply = await this.call('activity', {
          required,
          challenge: finish,
          answer: { challenge: next, snapshot },
          finish: true,
        }, signal);
        validate(reply, finish);
      };
      const results = await Promise.allSettled([
        send(),
        owner.apply(
          this.peer.pairing,
          value.snapshot,
          () => Math.max(0, performance.now() - started),
        ),
      ]);
      for (const result of results) {
        if (result.status === 'rejected') throw result.reason;
      }
    } finally {
      if (this.activityRequest === challenge) {
        this.activityRequest = undefined;
      }
    }
  }

  async signKeyDocument(
    document: KeyDoc,
    signal?: AbortSignal,
  ): Promise<string> {
    const value = await this.call('key-signature', { document }, signal);
    return text(value.signature);
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
    head?: Cut,
  ): Promise<Acknowledgement> {
    this.stream(stream, true);
    const value = await this.call('records', {
      required: [...new Map([
        ...LINK_CAPABILITIES,
        ...records.map(recordOf).map(({ type, version }) => ({
          type,
          version,
        })),
      ].map((item) => [`${item.type}/${item.version}`, item])).values()],
      stream: streamOf(stream),
      records,
      after: cutOf(after),
      ...(head ? { head: cutOf(head) } : {}),
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
