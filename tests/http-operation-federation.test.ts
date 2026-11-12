import { assertEquals, assertThrows } from '@std/assert';
import { missingEventsRequest } from '#engine/federation/history-request.ts';
import { transactionRequest } from '#engine/federation/transaction-request.ts';
import { httpSuite } from '#tests/http-app.ts';
import { theApp } from '#engine/app.ts';
import { createRoom } from '#engine/room/create.ts';
import { openRoom, type Room } from '#engine/room/index.ts';
import { sendLocal } from '#engine/room/ingest.ts';
import { keyStore } from '#engine/federation/keys.ts';
import { directOnly, makeDoc, makeServer } from './federation/doc-helper.ts';
import { fedCaller, remoteServer, signTemplate } from './http-federation.ts';
import { toWire } from '#engine/federation/pdu.ts';

const suite = httpSuite('HTTP federation operation contracts');
type Json = Record<string, unknown>;
let fed: ReturnType<typeof fedCaller>,
  room: Room,
  earliest = '',
  latest = '',
  middle = '',
  depth = 0;
let origin = '';
const prefix = '/_matrix/federation/v1/';
suite.test('make_join omission means version1, while explicit supported versions negotiate', async () => {
  const remote = await remoteServer('operation-fed.test');
  origin = remote.name;
  fed = fedCaller(suite.matrix, remote);
  const created = await createRoom(theApp().store, {
    creator: '@dev:localhost',
    preset: 'public_chat',
  }, theApp().tenant.signer());
  room = await openRoom(theApp().store, created.roomId);
  const path = prefix + 'make_join/' + encodeURIComponent(room.id) + '/' +
    encodeURIComponent('@other:' + origin);
  const omitted = await fed('GET', path);
  const supported = await fed('GET', path + '?ver=11');
  assertEquals(supported.status, 200);
  const joined = await signTemplate(supported.body.event as Json, remote);
  assertEquals(
    (await fed(
      'PUT',
      '/_matrix/federation/v2/send_join/' + encodeURIComponent(room.id) + '/' +
        encodeURIComponent(String(joined.event_id)),
      toWire(joined, '11'),
    )).status,
    200,
  );
  earliest = String(joined.event_id);
  for (const body of ['middle', 'latest']) {
    const sent = await sendLocal(room, {
      type: 'm.room.message',
      sender: '@dev:localhost',
      content: { body, msgtype: 'm.text' },
    }, theApp().tenant.signer());
    if (body === 'middle') {
      middle = sent.eventId;
      depth = (await room.tx((tx) => tx.events.get(middle)))!.depth;
    } else latest = sent.eventId;
  }
  assertEquals(omitted.status, 400);
  assertEquals(omitted.body.errcode, 'M_INCOMPATIBLE_ROOM_VERSION');
});
suite.test('missing-event depth applies before the result limit, inclusively, without changing DAG ordering', async () => {
  const path = prefix + 'get_missing_events/' + encodeURIComponent(room.id);
  const base = {
    earliest_events: [earliest],
    latest_events: [latest],
    limit: 1,
  };
  const included = await fed('POST', path, { ...base, min_depth: depth });
  assertEquals(included.status, 200);
  assertEquals(
    (included.body.events as Json[]).map((e) => (e.content as Json).body),
    ['middle'],
  );
  const excluded = await fed('POST', path, { ...base, min_depth: depth + 1 });
  assertEquals(excluded.status, 200);
  assertEquals(excluded.body.events, []);
});
suite.test('backfill requires v and strictly decodes limit', async () => {
  const path = prefix + 'backfill/' + encodeURIComponent(room.id);
  for (const query of ['limit=1', 'v=x', 'v=x&limit=no', 'v=x&limit=1.5']) {
    assertEquals((await fed('GET', path + '?' + query)).status, 400);
  }
  const valid = await fed(
    'GET',
    path + '?v=' + encodeURIComponent(latest) + '&limit=1',
  );
  assertEquals(valid.status, 200);
  assertEquals((valid.body.pdus as Json[]).length, 1);
});
for (
  const fields of [
    {},
    { earliest_events: [], latest_events: null },
    { earliest_events: 'x', latest_events: [] },
    { earliest_events: [4], latest_events: [] },
    { earliest_events: [], latest_events: [false] },
    { earliest_events: [], latest_events: [], limit: '2' },
    { earliest_events: [], latest_events: [], limit: 1.5 },
    { earliest_events: [], latest_events: [], min_depth: '2' },
    { earliest_events: [], latest_events: [], min_depth: 1.5 },
  ]
) {
  suite.test(
    'missing-events rejects malformed envelope ' + JSON.stringify(fields),
    async () => {
      if (
        Object.values(fields).some((value) =>
          typeof value === 'number' && !Number.isInteger(value)
        )
      ) {
        // Canonical federation signatures cannot encode fractions. Exercise the
        // operation boundary directly rather than pretend the signer sent one.
        assertThrows(() => missingEventsRequest(fields));
        return;
      }
      assertEquals(
        (await fed(
          'POST',
          prefix + 'get_missing_events/' + encodeURIComponent(room.id),
          fields,
        )).status,
        400,
      );
    },
  );
}
async function notary(body?: unknown, query = '') {
  const response = await suite.matrix(
    new Request(
      'http://x/_matrix/key/v2/query' +
        (body === undefined ? '/operation-keys.test' + query : ''),
      {
        method: body === undefined ? 'GET' : 'POST',
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    ),
  );
  return { status: response.status, body: await response.json() as Json };
}
suite.test('notary honors explicit/default floors and validates all nested criteria', async () => {
  const remote = await makeServer('operation-keys.test');
  const validUntil = Date.now() + 60000;
  const doc = await makeDoc(remote, { validUntilMs: validUntil });
  await keyStore(theApp().server, { deps: directOnly(doc) }).acquireKeyDoc(
    remote.name,
    0,
  );
  for (
    const [floor, count] of [[validUntil, 1], [validUntil + 1, 0]] as const
  ) {
    assertEquals(
      (await notary(undefined, '?minimum_valid_until_ts=' + floor)).body
        .server_keys instanceof Array,
      true,
    );
    assertEquals(
      ((await notary(undefined, '?minimum_valid_until_ts=' + floor)).body
        .server_keys as Json[]).length,
      count,
    );
    assertEquals(
      ((await notary({
        server_keys: {
          [remote.name]: { 'ed25519:any': { minimum_valid_until_ts: floor } },
        },
      })).body.server_keys as Json[]).length,
      count,
    );
  }
  assertEquals(((await notary()).body.server_keys as Json[]).length, 1);
  await theApp().server.execute(
    'UPDATE server_key_docs SET key_json=? WHERE server_name=?',
    [JSON.stringify({ ...doc, valid_until_ts: 1 }), remote.name],
  );
  assertEquals((await notary()).body.server_keys, []);
  assertEquals(
    (await notary({ server_keys: { [remote.name]: {} } })).body.server_keys,
    [],
  );
  for (
    const value of [
      {},
      { server_keys: null },
      { server_keys: [] },
      { server_keys: { x: [] } },
      { server_keys: { x: { key: null } } },
      { server_keys: { x: { key: { minimum_valid_until_ts: '2' } } } },
      { server_keys: { x: { key: { minimum_valid_until_ts: 1.5 } } } },
    ]
  ) {
    assertEquals((await notary(value)).status, 400);
  }
  for (const value of ['no', '1.5', '']) {
    assertEquals(
      (await notary(undefined, '?minimum_valid_until_ts=' + value)).status,
      400,
    );
  }
  assertEquals((await notary({ server_keys: {} })).body, { server_keys: [] });
});
for (
  const fields of [
    { pdus: [] },
    { pdus: [], origin_server_ts: null },
    { pdus: [], origin_server_ts: '1' },
    { pdus: [], origin_server_ts: 1.5 },
    { origin_server_ts: 1 },
    { origin_server_ts: 1, pdus: {} },
    { origin_server_ts: 1, pdus: [], edus: {} },
  ]
) {
  suite.test(
    'transactions reject malformed envelope without caching success ' +
      JSON.stringify(fields),
    async () => {
      const id = crypto.randomUUID();
      if (
        Object.values(fields).some((value) =>
          typeof value === 'number' && !Number.isInteger(value)
        )
      ) {
        assertThrows(() => transactionRequest({ origin, ...fields }, origin));
      } else {assertEquals(
          (await fed('PUT', prefix + 'send/' + id, { origin, ...fields }))
            .status,
          400,
        );}
      assertEquals(
        await theApp().server.query(
          'SELECT txn_id FROM federation_txns WHERE origin=? AND txn_id=?',
          [origin, id],
        ),
        [],
      );
      assertEquals(
        (await fed('PUT', prefix + 'send/' + id, {
          origin,
          origin_server_ts: 1,
          pdus: [],
        })).status,
        200,
      );
    },
  );
}
