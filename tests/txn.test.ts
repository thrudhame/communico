// tests/txn.test.ts — transaction idempotency scoped to (device, room,
// txn) (plan §3g): same device + other token → same id; other room →
// different; content ignored; unsigned.transaction_id only for the
// sending device. Live doltgres, HTTP-level via the real endpoint trees.
import { assertEquals, assertNotEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { serverName } from '#engine/config.ts';
import { clientEvent, type EventIndexRow } from '#engine/event-format.ts';
import { lookupToken } from '#engine/tenant.ts';
import { serverDb, withDb } from '#engine/db.ts';
import { registerTestUser } from './util.ts';

const matrix = await pathfinder({ roots: ['api/endpoints/matrix/'] });

type Json = Record<string, unknown>;

async function call(
  path: string,
  init: { method?: string; token?: string; body?: unknown } = {},
): Promise<{ status: number; body: Json }> {
  const headers: Record<string, string> = {};
  if (init.token !== undefined) headers.Authorization = `Bearer ${init.token}`;
  let body: BodyInit | undefined;
  if (init.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(init.body);
  }
  const res = await matrix(
    new Request(`http://x${path}`, {
      method: init.method ?? 'GET',
      headers,
      body,
    }),
  );
  const text = await res.text();
  return { status: res.status, body: text === '' ? {} : JSON.parse(text) };
}

async function loginWithDevice(
  localpart: string,
  password: string,
  deviceId: string,
): Promise<string> {
  const res = await call('/_matrix/client/v3/login', {
    method: 'POST',
    body: {
      identifier: { type: 'm.id.user', user: `@${localpart}:${serverName()}` },
      type: 'm.login.password',
      password,
      device_id: deviceId,
    },
  });
  assertEquals(res.status, 200);
  return res.body.access_token as string;
}

Deno.test('txn idempotency: (device, room, txn) → same event id, content ignored, other room differs', async () => {
  const alice = await registerTestUser('txn-a', 'pw-txn-a');
  const tok = alice.access_token!;
  const device = (await lookupToken(serverName(), tok))!.device_id!;

  const mkRoom = async () => {
    const res = await call('/_matrix/client/v3/createRoom', {
      method: 'POST',
      token: tok,
      body: {},
    });
    return res.body.room_id as string;
  };
  const room1 = await mkRoom();
  const room2 = await mkRoom();

  const send = (roomId: string, body: unknown) =>
    call(
      `/_matrix/client/v3/rooms/${
        encodeURIComponent(roomId)
      }/send/m.room.message/m-txn`,
      {
        method: 'PUT',
        token: tok,
        body,
      },
    );

  const first = (await send(room1, { msgtype: 'm.text', body: 'first' })).body
    .event_id as string;
  // identical repeat → same id
  assertEquals(
    (await send(room1, { msgtype: 'm.text', body: 'first' })).body.event_id,
    first,
  );
  // content ignored — same (device, room, txn) wins
  assertEquals(
    (await send(room1, { msgtype: 'm.text', body: 'second' })).body.event_id,
    first,
  );
  // other room → a different event
  const otherRoom = (await send(room2, { msgtype: 'm.text', body: 'first' }))
    .body.event_id as string;
  assertNotEquals(otherRoom, first);

  // the event_index row carries the txn columns
  const idxRow = await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT txn_device, txn_id FROM event_index WHERE event_id = $1;',
      [first],
    );
    return r.rows[0];
  });
  assertEquals(String(idxRow.txn_device), device);
  assertEquals(String(idxRow.txn_id), 'm-txn');

  // a second token on the SAME device shares the txn scope
  const tok2 = await loginWithDevice('txn-a', 'pw-txn-a', device);
  const res = await call(
    `/_matrix/client/v3/rooms/${
      encodeURIComponent(room1)
    }/send/m.room.message/m-txn`,
    { method: 'PUT', token: tok2, body: { msgtype: 'm.text', body: 'first' } },
  );
  assertEquals(res.body.event_id, first);

  // unsigned.transaction_id renders for the sending device only
  const row: EventIndexRow = {
    event_id: first,
    room_id: room1,
    commit_hash: 'x',
    rejected: false,
    soft_failed: false,
    seq: 1,
    state_commit_hash: null,
    redacted_by: null,
    txn_device: device,
    txn_id: 'm-txn',
  };
  const pdu = {
    type: 'm.room.message',
    room_id: room1,
    sender: `@txn-a:${serverName()}`,
    content: { msgtype: 'm.text', body: 'first' },
    prev_events: [],
    auth_events: [],
    depth: 1,
    origin_server_ts: 1000,
    hashes: { sha256: '' },
    signatures: {},
  };
  const mine = clientEvent(pdu, row, { userId: 'u', deviceId: device });
  assertEquals(
    (mine.unsigned as Json).transaction_id,
    'm-txn',
  );
  const other = clientEvent(pdu, row, { userId: 'u', deviceId: 'other' });
  assertEquals(
    (other.unsigned as Json).transaction_id === undefined,
    true,
  );
});
