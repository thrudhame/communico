import { assertEquals, assertNotEquals } from '@std/assert';
import { canonicalJson } from '#engine/canonical.ts';
import { transactionReplayCanonical } from '#engine/federation/transaction-request.ts';

Deno.test('transaction replay identity excludes only the envelope timestamp, never nested PDU or EDU fields', () => {
  const original = {
    method: 'PUT',
    uri: '/_matrix/federation/v1/send/one?original=yes',
    origin: 'remote.test',
    destination: 'home.test',
    content: {
      origin: 'remote.test',
      origin_server_ts: 1,
      pdus: [{ origin_server_ts: 2, content: { origin_server_ts: 3 } }],
      edus: [{ edu_type: 'test', content: { origin_server_ts: 4 } }],
      extension: true,
    },
  };
  const identity = (value: unknown) =>
    transactionReplayCanonical(canonicalJson(value));
  const expected = identity(original);
  assertEquals(
    identity({
      ...original,
      content: { ...original.content, origin_server_ts: 100 },
    }),
    expected,
  );
  for (
    const changed of [
      { ...original, origin: 'other.test' },
      { ...original, destination: 'other.test' },
      { ...original, method: 'POST' },
      { ...original, uri: original.uri + '&changed=yes' },
      { ...original, content: { ...original.content, origin: 'other.test' } },
      { ...original, content: { ...original.content, extension: false } },
      { ...original, content: { ...original.content, pdus: [] } },
      { ...original, content: { ...original.content, edus: [] } },
      ...[0, 1, 2].map((field) => {
        const value = structuredClone(original);
        if (field === 0) value.content.pdus[0].origin_server_ts++;
        if (field === 1) value.content.pdus[0].content.origin_server_ts++;
        if (field === 2) value.content.edus[0].content.origin_server_ts++;
        return value;
      }),
    ]
  ) assertNotEquals(identity(changed), expected);
});
