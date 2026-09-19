// tests/receipts.test.ts — band C item 3: the TestRoomReceipts /
// TestRoomReadMarkers contract rows (plan §2, D1; spec v1.16
// receipts.yaml + read_markers.yaml + receipts.md). m.read.private is
// accepted and stored but never broadcast. Live doltgres, HTTP-level via
// the real endpoint trees.
import { assert, assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
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

const sync = (token: string, query = '') =>
  call(`/_matrix/client/v3/sync?timeout=0${query}`, { token });

function roomEntry(body: Json, roomId: string): Json {
  const rooms = ((body.rooms as Json)?.join ?? {}) as Json;
  return (rooms[roomId] ?? {}) as Json;
}

Deno.test('receipts: m.read surfacing, no room_id, read_markers, m.read.private stored-not-broadcast, bad types', async () => {
  const alice = await registerTestUser('rc-a', 'pw-rc-a');
  const bob = await registerTestUser('rc-b', 'pw-rc-b');
  const aTok = alice.access_token!;
  const bTok = bob.access_token!;
  const roomId = (await call('/_matrix/client/v3/createRoom', {
    method: 'POST',
    token: aTok,
    body: { invite: [bob.user_id as string] },
  })).body.room_id as string;
  assertEquals(
    (await call(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`, {
      method: 'POST',
      token: bTok,
      body: {},
    })).status,
    200,
  );
  const send = async (txn: string): Promise<string> => {
    const res = await call(
      `/_matrix/client/v3/rooms/${
        encodeURIComponent(roomId)
      }/send/m.room.message/${txn}`,
      { method: 'PUT', token: aTok, body: { msgtype: 'm.text', body: 'hi' } },
    );
    return res.body.event_id as string;
  };
  const ev1 = await send('rc-1');
  const receiptPath = (type: string, eventId: string) =>
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/receipt/${
      encodeURIComponent(type)
    }/${encodeURIComponent(eventId)}`;

  // post a receipt; it shows up in sync (initial AND incremental),
  // with no room_id on the ephemeral event
  assertEquals(
    (await call(receiptPath('m.read', ev1), {
      method: 'POST',
      token: aTok,
      body: {},
    })).status,
    200,
  );
  const bBefore = (await sync(bTok)).body.next_batch as string;
  const initial = await sync(bTok);
  let receipts = (roomEntry(initial.body, roomId).ephemeral as Json)
    ?.events as Json[] ?? [];
  let receipt = receipts.find((e) => e.type === 'm.receipt');
  assert(receipt !== undefined, 'initial sync carries the receipt');
  assertEquals('room_id' in receipt!, false);
  const content = receipt!.content as Json;
  const byUser = ((content[ev1] as Json)['m.read'] ?? {}) as Json;
  assert((alice.user_id as string) in byUser, 'receipt content shape');
  assertEquals(typeof (byUser[alice.user_id as string] as Json).ts, 'number');

  // a second receipt surfaces in an incremental sync since the token
  const ev2 = await send('rc-2');
  assertEquals(
    (await call(receiptPath('m.read', ev2), {
      method: 'POST',
      token: aTok,
      body: {},
    })).status,
    200,
  );
  const inc = await sync(bTok, `&since=${encodeURIComponent(bBefore)}`);
  receipts = (roomEntry(inc.body, roomId).ephemeral as Json)
    ?.events as Json[] ?? [];
  receipt = receipts.find((e) => e.type === 'm.receipt');
  assert(receipt !== undefined, 'incremental sync carries the receipt');
  assertEquals('room_id' in receipt!, false);

  // read_markers: fully_read → room account_data; m.read → receipt
  const ev3 = await send('rc-3');
  assertEquals(
    (await call(
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/read_markers`,
      {
        method: 'POST',
        token: aTok,
        body: { 'm.fully_read': ev3, 'm.read': ev3 },
      },
    )).status,
    200,
  );
  const afterMarkers = await sync(aTok);
  const ad = ((roomEntry(afterMarkers.body, roomId).account_data as Json)
    ?.events ?? []) as Json[];
  const fr = ad.find((e) => e.type === 'm.fully_read');
  assert(fr !== undefined, 'm.fully_read in room account_data');
  assertEquals((fr!.content as Json).event_id, ev3);
  const aReceipts = ((roomEntry(afterMarkers.body, roomId).ephemeral as Json)
    ?.events ?? []) as Json[];
  assert(
    aReceipts.some((e) => e.type === 'm.receipt'),
    'read_markers m.read produced a receipt',
  );

  // m.read.private: accepted (200) but never broadcast — bob sees no
  // m.receipt for it
  const ev4 = await send('rc-4');
  assertEquals(
    (await call(receiptPath('m.read.private', ev4), {
      method: 'POST',
      token: aTok,
      body: {},
    })).status,
    200,
  );
  const bNow = (await sync(bTok)).body.next_batch as string;
  const bInc = await sync(bTok, `&since=${encodeURIComponent(bNow)}`);
  const bReceipts = ((roomEntry(bInc.body, roomId).ephemeral as Json)
    ?.events ?? []) as Json[];
  assertEquals(
    bReceipts.some((e) =>
      e.type === 'm.receipt' &&
      (e.content as Json)[ev4] !== undefined
    ),
    false,
    'm.read.private must not broadcast',
  );

  // unsupported receipt types are refused
  const bad = await call(receiptPath('m.fully_read', ev4), {
    method: 'POST',
    token: aTok,
    body: {},
  });
  assertEquals(bad.status, 400);
  assertEquals(bad.body.errcode, 'M_INVALID_PARAM');
});
