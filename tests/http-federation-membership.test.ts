// doltgres federation-serve-joins: preserve template/errors/wire contracts.
import { assert, assertEquals } from '@std/assert';
import { theApp } from '#engine/app.ts';
import { serverName } from '#engine/config.ts';
import { createRoom } from '#engine/room/create.ts';
import { openRoom } from '#engine/room/index.ts';
import { ban, invite, leave } from '#engine/room/membership.ts';
import { membershipOf } from '#engine/server/read.ts';
import { toWire } from '#engine/federation/pdu.ts';
import { inviteFor } from '#engine/federation/invites.ts';
import { inviteDeps } from '#engine/federation/context.ts';
import { httpSuite } from './http-app.ts';
import {
  fedCaller,
  type Json,
  remoteServer,
  signTemplate,
} from './http-federation.ts';
import type { TestServer } from './federation/doc-helper.ts';

const { matrix, test } = httpSuite(
  'HTTP federation membership and transactions',
);
let remote: TestServer;
let call: ReturnType<typeof fedCaller>;
const zoe = '@zoe:remote.test';
const path = (op: string, room: string, id: string, version = 'v1') =>
  `/_matrix/federation/${version}/${op}/${encodeURIComponent(room)}/${
    encodeURIComponent(id)
  }`;
const creator = () => '@dev:' + serverName();
async function room(preset: 'public_chat' | 'private_chat' = 'public_chat') {
  return (await createRoom(
    theApp().store,
    { creator: creator(), preset },
    theApp().tenant.signer(),
  )).roomId;
}
async function make(roomId: string, op = 'make_join') {
  const answer = await call('GET', path(op, roomId, zoe));
  assertEquals(answer.status, 200);
  return await signTemplate(answer.body.event as Json, remote);
}

test('make_join: template fields; incompatible version/domain/room/ban/invite errors', async () => {
  remote = await remoteServer();
  call = fedCaller(matrix, remote);
  const id = await room();
  const result = await call('GET', path('make_join', id, zoe) + '?ver=11');
  assertEquals(result.status, 200);
  assertEquals(result.body.room_version, '11');
  const t = result.body.event as Json;
  assertEquals(t.type, 'm.room.member');
  assertEquals(t.state_key, zoe);
  assertEquals(t.sender, zoe);
  assertEquals(t.room_id, id);
  assertEquals(t.content, { membership: 'join' });
  assertEquals(t.origin, serverName());
  assert(Array.isArray(t.prev_events));
  assert(Array.isArray(t.auth_events));
  assertEquals(typeof t.depth, 'number');
  assertEquals(typeof t.origin_server_ts, 'number');
  for (const key of ['event_id', 'hashes', 'signatures', 'unsigned']) {
    assert(!(key in t));
  }
  const bad = await call('GET', path('make_join', id, zoe) + '?ver=3');
  assertEquals(bad.status, 400);
  assertEquals(bad.body.errcode, 'M_INCOMPATIBLE_ROOM_VERSION');
  assertEquals(bad.body.room_version, '11');
  assertEquals(
    (await call('GET', path('make_join', id, '@zoe:other.test'))).status,
    403,
  );
  assertEquals(
    (await call('GET', path('make_join', '!missing:localhost', zoe))).status,
    404,
  );
  const held = await openRoom(theApp().store, id);
  await ban(held, creator(), zoe, theApp().tenant.signer());
  assertEquals((await call('GET', path('make_join', id, zoe))).status, 403);
  assertEquals(
    (await call('GET', path('make_join', await room('private_chat'), zoe)))
      .status,
    403,
  );
});

test('send_join v2: validation, merged signatures, snapshot and forwarding excludes joiner', async () => {
  const id = await room();
  const join = await make(id);
  const wire = toWire(join, '11');
  const target = path('send_join', id, String(join.event_id), 'v2');
  for (
    const change of [{ type: 'm.room.message' }, {
      state_key: '@other:remote.test',
    }, { room_id: '!elsewhere:remote.test' }]
  ) {
    assertEquals(
      (await call('PUT', target, { ...wire, ...change })).status,
      400,
    );
  }
  assertEquals(
    (await call('PUT', path('send_join', id, '$not-the-id', 'v2'), wire))
      .status,
    400,
  );
  assertEquals(
    (await call('PUT', target, {
      ...wire,
      signatures: { 'remote.test': { [remote.keyId]: 'AAAA' } },
    })).status,
    403,
  );
  const response = await call('PUT', target, wire);
  assertEquals(response.status, 200);
  assert(Array.isArray(response.body.state));
  assert(Array.isArray(response.body.auth_chain));
  assertEquals(response.body.members_omitted, false);
  assertEquals(response.body.servers_in_room, [serverName()]);
  const event = response.body.event as Json;
  const sigs = event.signatures as Json;
  assert(sigs[remote.name] !== undefined);
  assert(sigs[serverName()] !== undefined);
  assert(!('event_id' in event));
  assertEquals(
    (await membershipOf(theApp().server, id, zoe))?.membership,
    'join',
  );
  assertEquals(
    await theApp().server.query(
      'SELECT destination FROM outbox WHERE event = ?',
      [String(join.event_id)],
    ),
    [],
  );
});

test('send_join v1 and make/send_leave v1/v2 preserve wrappers and membership effects', async () => {
  for (const version of ['v1', 'v2']) {
    const id = await room();
    const join = await make(id);
    const response = await call(
      'PUT',
      path('send_join', id, String(join.event_id), 'v1'),
      toWire(join, '11'),
    );
    assertEquals(response.status, 200);
    const arr = response.body as unknown as [number, Json];
    assertEquals(arr[0], 200);
    for (const key of ['state', 'auth_chain', 'event']) assert(key in arr[1]);
    assertEquals(
      (await call('GET', path('make_leave', id, '@nobody:remote.test'))).status,
      403,
    );
    const leaving = await make(id, 'make_leave');
    assertEquals(leaving.content.membership, 'leave');
    const result = await call(
      'PUT',
      path('send_leave', id, String(leaving.event_id), version),
      toWire(leaving, '11'),
    );
    assertEquals(result.status, 200);
    assertEquals<unknown>(result.body, version === 'v2' ? {} : [200, {}]);
    assertEquals(
      (await membershipOf(theApp().server, id, zoe))?.membership,
      'leave',
    );
  }
});

test('remote rejection after archive changes the invite without reopening the stay', async () => {
  const id = await room('private_chat');
  const held = await openRoom(theApp().store, id);
  await invite(held, creator(), zoe, theApp().tenant.signer());
  await leave(held, creator(), theApp().tenant.signer());
  const rejection = await make(id, 'make_leave');
  const result = await call(
    'PUT',
    path('send_leave', id, String(rejection.event_id), 'v2'),
    toWire(rejection, '11'),
  );
  assertEquals(result.status, 200);
  assertEquals(
    (await membershipOf(theApp().server, id, zoe))?.membership,
    'leave',
  );
  assertEquals(await held.tx((tx) => tx.segments.openStay()), null);
});

test('send: body memoization, origin/caps and empty replay', async () => {
  const target = '/_matrix/federation/v1/send/txn-test';
  assertEquals(
    (await call('PUT', target, { origin: 'wrong', pdus: [] })).status,
    403,
  );
  assertEquals(
    (await call('PUT', target, {
      origin: remote.name,
      pdus: Array(51).fill({}),
    })).status,
    400,
  );
  const body = {
    origin: remote.name,
    pdus: [],
    edus: [{ edu_type: 'unknown', content: {} }],
  };
  const result = await call('PUT', target, body);
  assertEquals(result, { status: 200, body: { pdus: {} } });
  assertEquals(await call('PUT', target, body), result);
});

test('invite v2: validate, countersign and persist an out-of-band invite', async () => {
  const id = '!invited:remote.test';
  const user = '@guest:' + serverName();
  const event = await signTemplate({
    room_id: id,
    type: 'm.room.member',
    sender: zoe,
    state_key: user,
    content: { membership: 'invite', is_direct: true },
    prev_events: [],
    auth_events: [],
    depth: 1,
  }, remote);
  const target = path('invite', id, String(event.event_id), 'v2');
  const body = {
    room_version: '11',
    event: toWire(event, '11'),
    invite_room_state: [],
  };
  const wrongVersion = await call('PUT', target, {
    ...body,
    room_version: 'unknown',
  });
  assertEquals(wrongVersion.status, 400);
  assertEquals(wrongVersion.body.errcode, 'M_INCOMPATIBLE_ROOM_VERSION');
  for (
    const change of [
      { type: 'm.room.message' },
      { state_key: '@nope:elsewhere.test' },
    ]
  ) {
    assertEquals(
      (await call('PUT', target, {
        ...body,
        event: { ...body.event, ...change },
      })).status,
      400,
    );
  }
  assertEquals(
    (await call('PUT', path('invite', id, '$wrong-id', 'v2'), body)).status,
    400,
  );
  assertEquals(
    (await call('PUT', target, {
      ...body,
      event: {
        ...body.event,
        signatures: { [remote.name]: { [remote.keyId]: 'AAAA' } },
      },
    })).status,
    403,
  );
  const result = await call('PUT', target, body);
  assertEquals(result.status, 200);
  const signed = result.body.event as Json;
  const signatures = signed.signatures as Json;
  assert(signatures[remote.name] !== undefined);
  assert(signatures[serverName()] !== undefined);
  assert(!('event_id' in signed));
  const row = await inviteFor(id, user, inviteDeps());
  assertEquals(row?.status, 'pending');
  assertEquals(row?.origin, remote.name);
  assertEquals(JSON.parse(row!.eventJson).content.is_direct, true);
  const rescind = async (sender: string, txn: string) => {
    const leave = await signTemplate({
      room_id: id,
      type: 'm.room.member',
      sender,
      state_key: user,
      content: { membership: 'leave' },
      prev_events: [String(event.event_id)],
      auth_events: [],
      depth: 2,
    }, remote);
    const result = await call('PUT', '/_matrix/federation/v1/send/' + txn, {
      origin: remote.name,
      origin_server_ts: Date.now(),
      pdus: [toWire(leave, '11')],
    });
    assertEquals(result.status, 200);
    return (result.body.pdus as Json)[String(leave.event_id)] as Json;
  };
  assert(
    String((await rescind('@third-party:' + remote.name, 'not-inviter')).error)
      .includes('unknown room'),
  );
  assertEquals((await inviteFor(id, user, inviteDeps()))?.status, 'pending');
  assertEquals(await rescind(zoe, 'original-inviter'), {});
  assertEquals((await inviteFor(id, user, inviteDeps()))?.status, 'rejected');
});
