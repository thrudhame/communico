import { assertEquals } from '@std/assert';
import { JournalClient } from '#engine/facade/client.ts';
import {
  EMPTY_CUT,
  LINK_CAPABILITIES,
  LINK_VERSION,
  recordHash,
} from '#engine/facade/protocol.ts';
import type { LinkClient } from '#engine/facade/transport.ts';

Deno.test('journal sender requires each new page record type before receiver mutation, without changing F1 requirements', async () => {
  const stream = {
    source: 'home',
    incarnation: 'pairing',
    stream: 'owner-control',
  };
  const body = {
    ...stream,
    sequence: 1,
    type: 'owner-control',
    version: 1,
    operationId: 'ownership',
    previous: '',
    payload: {},
  };
  const record = { ...body, hash: recordHash(body) };
  let required: { type: string; version: number }[] = [];
  const wire = {
    fetch: (_path: string, options: RequestInit) => {
      required = JSON.parse(String(options.body)).required;
      return Promise.resolve(Response.json({
        protocol: LINK_VERSION,
        server: 'logical.test',
        required: LINK_CAPABILITIES,
        source: 'edge_a',
        incarnation: 'edge-incarnation',
        pairing: 'pairing',
        ack: { received: EMPTY_CUT, applied: EMPTY_CUT, results: [] },
      }));
    },
  } as unknown as LinkClient;
  const client = new JournalClient(wire, {
    server: 'logical.test',
    node: 'edge_a',
    incarnation: 'edge-incarnation',
    pairing: 'pairing',
    revision: 1,
  }, () => Promise.resolve());
  await client.push(stream, [record, record], EMPTY_CUT);
  assertEquals(required.filter((item) => item.type === 'owner-control'), [{
    type: 'owner-control',
    version: 1,
  }]);
  assertEquals(required.length, LINK_CAPABILITIES.length + 1);
  assertEquals(
    LINK_CAPABILITIES.some((item) => item.type === 'owner-control'),
    false,
  );
});
