import { assert, assertEquals } from '@std/assert';
import { httpSuite } from '#tests/http-app.ts';
import { theApp } from '#engine/app.ts';
import { requireRoom } from '#engine/client/room.ts';
import { createRoom } from '#engine/room/create.ts';
import { startInstance } from '#tests/federation/instance.ts';
import { keyStore, ourKeyDocument } from '#engine/federation/keys.ts';
import { directOnly } from '#tests/federation/doc-helper.ts';
const { matrix, registerTestUser, test } = httpSuite('HTTP membership');
type Json = Record<string, unknown>;
async function call(
  path: string,
  token: string | undefined,
  body?: unknown,
  method = 'POST',
) {
  const res = await matrix(
    new Request('http://x/_matrix/client/v3/' + path, {
      method,
      headers: { Authorization: 'Bearer ' + token },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    }),
  );
  return { status: res.status, body: await res.json() as Json };
}
const path = (id: string) => 'rooms/' + encodeURIComponent(id);
async function room(token: string | undefined, options: Json = {}) {
  const res = await call('createRoom', token, options);
  assertEquals(res.status, 200);
  return res.body.room_id as string;
}
test('join/invite/leave/kick/ban/unban: validation, reasons, idempotency and authorization', async () => {
  const a = await registerTestUser('mem-a', 'pw');
  const b = await registerTestUser('mem-b', 'pw');
  const c = await registerTestUser('mem-c', 'pw');
  const id = await room(a.access_token);
  const base = path(id);
  const op = (name: string, token: string | undefined, body?: Json) =>
    call(base + '/' + name, token, body);
  for (const name of ['invite', 'kick', 'ban', 'unban']) {
    assertEquals(
      (await op(name, a.access_token)).body.errcode,
      'M_MISSING_PARAM',
    );
  }
  assertEquals(
    (await op('invite', a.access_token, { user_id: 'bad' })).body.errcode,
    'M_INVALID_PARAM',
  );
  assertEquals(
    (await op('invite', a.access_token, { user_id: a.user_id })).status,
    403,
  );
  assertEquals((await op('join', b.access_token)).status, 403);
  assertEquals(
    (await op('kick', a.access_token, { user_id: b.user_id })).status,
    403,
  );
  assertEquals(
    (await op('invite', a.access_token, { user_id: b.user_id, reason: 'come' }))
      .body,
    {},
  );
  assertEquals(
    (await op('join', b.access_token, { displayname: 'custom' })).body,
    { room_id: id },
  );
  const memberUrl = base + '/state/m.room.member/' +
    encodeURIComponent(b.user_id);
  assertEquals((await call(memberUrl, a.access_token, undefined, 'GET')).body, {
    displayname: 'custom',
    membership: 'join',
  });
  const event =
    (await call(memberUrl + '?format=event', a.access_token, undefined, 'GET'))
      .body.event_id;
  await op('join', b.access_token);
  assertEquals(
    (await call(memberUrl + '?format=event', a.access_token, undefined, 'GET'))
      .body.event_id,
    event,
  );
  assertEquals(
    (await op('ban', c.access_token, { user_id: b.user_id })).status,
    403,
  );
  assertEquals(
    (await op('ban', a.access_token, { user_id: b.user_id, reason: 'out' }))
      .body,
    {},
  );
  assertEquals((await call(memberUrl, a.access_token, undefined, 'GET')).body, {
    membership: 'ban',
    reason: 'out',
  });
  const bad = await op('unban', a.access_token, { user_id: a.user_id });
  assertEquals([bad.status, bad.body.errcode], [400, 'M_BAD_STATE']);
  assertEquals(
    (await op('unban', a.access_token, { user_id: b.user_id, reason: 'back' }))
      .status,
    200,
  );
  await op('invite', a.access_token, { user_id: b.user_id });
  await op('join', b.access_token);
  assertEquals(
    (await op('kick', a.access_token, { user_id: b.user_id })).status,
    200,
  );
  assertEquals(
    (await op('kick', a.access_token, { user_id: b.user_id })).status,
    403,
  );
  assertEquals((await op('leave', c.access_token)).status, 403);
  const joined = await call('joined_rooms', a.access_token, undefined, 'GET');
  assert((joined.body.joined_rooms as string[]).includes(id));
  const aliasRoom = await room(a.access_token, {
    preset: 'public_chat',
    room_alias_name: 'membership-alias',
  });
  const aliasJoin = await call(
    'join/' + encodeURIComponent('#membership-alias:' + a.home_server),
    b.access_token,
  );
  assertEquals(aliasJoin.body, { room_id: aliasRoom });
});

test('forget: joined/no membership reject, forget persists across traffic, reinvite/join clears it', async () => {
  const a = await registerTestUser('fg-a', 'pw');
  const b = await registerTestUser('fg-b', 'pw');
  const id = await room(a.access_token, { preset: 'public_chat' });
  const base = path(id);
  assertEquals(
    (await call(base + '/forget', a.access_token)).body.errcode,
    'M_UNKNOWN',
  );
  assertEquals((await call(base + '/forget', b.access_token)).status, 400);
  await call(base + '/join', b.access_token);
  await call(base + '/leave', b.access_token);
  assertEquals((await call(base + '/forget', b.access_token)).status, 200);
  await call(base + '/send/m.room.message/after', a.access_token, {
    body: 'after',
  }, 'PUT');
  assertEquals(
    (await call(base + '/state', b.access_token, undefined, 'GET')).status,
    403,
  );
  await call(base + '/invite', a.access_token, { user_id: b.user_id });
  await call(base + '/join', b.access_token);
  assertEquals(
    (await call(base + '/state', b.access_token, undefined, 'GET')).status,
    200,
  );
});

test('archived local invite rejection keeps the stay closed; self-only rejoin opens a complete new pair', async () => {
  const a = await registerTestUser('archive-a', 'pw');
  const b = await registerTestUser('archive-b', 'pw');
  const id = await room(a.access_token, {
    preset: 'public_chat',
    invite: [b.user_id],
  });
  const held = await requireRoom(id);
  assertEquals((await call(path(id) + '/leave', a.access_token)).status, 200);
  assertEquals(await held.tx((tx) => tx.segments.openStay()), null);
  assertEquals((await call(path(id) + '/leave', b.access_token)).status, 200);
  assertEquals(await held.tx((tx) => tx.segments.openStay()), null);
  const old = await held.tx((tx) => tx.segments.latestStay());
  assertEquals((await call(path(id) + '/join', a.access_token)).status, 200);
  const next = await held.tx((tx) => tx.segments.openStay());
  assert(next !== null && next.id !== old!.id);
  assertEquals(next.prev, old!.id);
  assertEquals(
    (await held.tx((tx) => tx.segments.historyOf(next.id)))!.status,
    'complete',
  );
});

test('profile changes fan out member events to all joined rooms, preserving custom content', async () => {
  const a = await registerTestUser('profile-member', 'pw');
  const ids = [await room(a.access_token), await room(a.access_token)];
  for (const id of ids) {
    await call(
      path(id) + '/state/m.room.member/' + encodeURIComponent(a.user_id),
      a.access_token,
      { membership: 'join', displayname: 'before', custom: true },
      'PUT',
    );
  }
  for (
    const [field, value] of [['displayname', 'after'], [
      'avatar_url',
      'verbatim-not-mxc',
    ]] as const
  ) {
    assertEquals(
      (await call(
        'profile/' + encodeURIComponent(a.user_id) + '/' + field,
        a.access_token,
        { [field]: value },
        'PUT',
      )).status,
      200,
    );
    for (const id of ids) {
      const state = await call(
        path(id) + '/state/m.room.member/' + encodeURIComponent(a.user_id),
        a.access_token,
        undefined,
        'GET',
      );
      assertEquals(state.body[field], value);
      assertEquals(state.body.custom, true);
    }
  }
});

test('HTTP remote join uses the stage-4c second instance; createRoom countersigns remote invites', async () => {
  const remote = await startInstance();
  try {
    // This slice does not serve our key endpoint (5b). Seed the second
    // instance with the real tenant's self-signed key document, using the
    // existing fixture transport; request/PDU signatures are still verified.
    const tenant = theApp().tenant;
    const document = await ourKeyDocument(tenant.signer(), tenant.publicB64);
    await keyStore(remote.server, { deps: directOnly(document) }).acquireKeyDoc(
      tenant.serverName,
      0,
    );
    const a = await registerTestUser('remote-joiner', 'pw');
    const remoteRoom = await createRoom(remote.store, {
      creator: '@owner:' + remote.name,
      preset: 'public_chat',
    }, remote.signer);
    const joined = await call(
      'join/' + encodeURIComponent(remoteRoom.roomId) + '?via=' +
        encodeURIComponent(remote.name),
      a.access_token,
    );
    assertEquals(joined.status, 200, JSON.stringify(joined.body));
    assertEquals(joined.body.room_id, remoteRoom.roomId);
    const made = await call('createRoom', a.access_token, {
      invite: ['@invitee:' + remote.name],
      is_direct: true,
    });
    assertEquals(made.status, 200, JSON.stringify(made.body));
    const invite = await remote.server.query(
      'SELECT event_json FROM federation_invites WHERE room_id = ?',
      [made.body.room_id as string],
    );
    assertEquals(invite.length, 1);
    assertEquals(
      JSON.parse(String(invite[0].event_json)).content.is_direct,
      true,
    );
    const ours = await requireRoom(made.body.room_id as string);
    const rows = await ours.tx(async (tx) => {
      const stay = await tx.segments.openStay();
      const group = await tx.state.current(stay!.id);
      const id = await tx.state.groupKey(
        group!,
        'm.room.member',
        '@invitee:' + remote.name,
      );
      return await tx.events.get(id!);
    });
    const signatures = JSON.parse(rows!.pdu).signatures;
    assert(signatures[remote.name] !== undefined);
    assert(signatures[theApp().tenant.serverName] !== undefined);
  } finally {
    await remote.close();
  }
});
