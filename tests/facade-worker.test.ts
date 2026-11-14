import { assertEquals, assertRejects } from '@std/assert';
import { JournalClient } from '#engine/facade/client.ts';
import {
  EMPTY_CUT,
  LINK_CAPABILITIES,
  LINK_VERSION,
  LinkError,
} from '#engine/facade/protocol.ts';
import type { LinkClient } from '#engine/facade/transport.ts';

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
