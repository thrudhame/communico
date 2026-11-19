import { assertEquals, assertRejects } from '@std/assert';
import { JournalClient } from '#engine/facade/client.ts';
import {
  EMPTY_CUT,
  LINK_CAPABILITIES,
  LINK_VERSION,
  LinkError,
} from '#engine/facade/protocol.ts';
import type { LinkClient } from '#engine/facade/transport.ts';
import { startInboxWorker } from '#engine/facade/worker.ts';
import type { Journal } from '#engine/facade/journal.ts';

Deno.test('typed client refuses forged response identity, stream ownership and malformed cuts', async () => {
  const peer = {
    server: 'logical.test',
    node: 'edge',
    incarnation: 'store',
    pairing: 'pair',
    revision: 2,
  };
  const valid = {
    protocol: LINK_VERSION,
    server: peer.server,
    required: LINK_CAPABILITIES,
    source: peer.node,
    incarnation: peer.incarnation,
    pairing: peer.pairing,
    revision: peer.revision,
    scopes: [],
    incoming: [],
    outgoing: [],
    exportAcks: [],
  };
  let answer: unknown = valid;
  const client = new JournalClient(
    {
      fetch: () => Promise.resolve(Response.json(answer)),
    } as unknown as LinkClient,
    peer,
    () => Promise.resolve(),
  );
  assertEquals((await client.hello()).revision, 2);
  for (
    const patch of [
      { source: 'home' },
      { incarnation: 'other-store' },
      { pairing: 'other-pair' },
      { revision: 1 },
      { protocol: { major: 2, minor: 0 } },
      {
        outgoing: [{
          source: 'home',
          incarnation: peer.pairing,
          stream: 'room:stolen',
          received: EMPTY_CUT,
          applied: EMPTY_CUT,
        }],
      },
      {
        incoming: [{
          source: 'home',
          incarnation: peer.pairing,
          stream: 'control',
          received: { sequence: 1, hash: 'bad' },
          applied: EMPTY_CUT,
        }],
      },
    ]
  ) {
    answer = { ...valid, ...patch };
    await assertRejects(() => client.hello(), LinkError);
  }
});

Deno.test('inbox reports the original pre-apply rejection without blocking another stream', async () => {
  const rejected = new Error('refused before journal apply');
  const failed = Promise.withResolvers<unknown>();
  const applied = Promise.withResolvers<void>();
  let through = 0;
  const streams = ['directory', 'public:@other:logical.test'].map((stream) => ({
    source: 'home',
    incarnation: 'pair',
    stream,
  }));
  const worker = startInboxWorker({
    journal: {
      streams: () => Promise.resolve(streams),
      heads: () => Promise.resolve({ applied: { sequence: through } }),
    } as unknown as Journal,
    peer: 'home',
    pollseconds: 3600,
    apply: (stream) => {
      if (stream.stream === 'directory') return Promise.reject(rejected);
      if (through) return Promise.resolve(false);
      through++;
      return Promise.resolve(true);
    },
    failed: (error, stream, after) => {
      assertEquals(stream, streams[0]);
      assertEquals(after, 0);
      failed.resolve(error);
    },
    changed: () => applied.resolve(),
  });
  try {
    assertEquals(await failed.promise, rejected);
    await applied.promise;
    assertEquals(through, 1);
  } finally {
    await worker.close();
  }
});
