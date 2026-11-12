import { assert, assertEquals } from '@std/assert';
import { theApp } from '#engine/app.ts';
import { createRoom } from '#engine/room/create.ts';
import { openRoom } from '#engine/room/index.ts';
import { sendLocal } from '#engine/room/ingest.ts';
import { eventStreamMax } from '#engine/server/stream.ts';
import { heldRoomSummary } from '#engine/client/summary.ts';
import { httpSuite } from '#tests/http-app.ts';

type Json = Record<string, unknown>;
const suite = httpSuite('HTTP shared state admission');
const secret = 'PRIVATE-STATE-NEVER-ADMITTED';
const json = (value: unknown) => JSON.stringify(value);
async function call(path: string, token: string, body?: unknown) {
  const response = await suite.matrix(
    new Request('http://x/_matrix/client/' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + token },
      body: body === undefined ? undefined : json(body),
    }),
  );
  return { status: response.status, body: await response.json() as Json };
}
async function fixture(prefix: string, visibility = 'shared', space = false) {
  const app = theApp();
  const alice = await suite.registerTestUser(prefix + '-a', 'pw');
  const bob = await suite.registerTestUser(prefix + '-b', 'pw');
  const signer = app.tenant.signer();
  const { roomId } = await createRoom(app.store, {
    creator: alice.user_id,
    version: '11',
    preset: 'private_chat',
    name: 'Allowed discovery name',
    ...(space ? { creation_content: { type: 'm.space' } } : {}),
    initial_state: [{
      type: 'm.room.history_visibility',
      state_key: '',
      content: { history_visibility: visibility },
    }],
  }, signer);
  const room = await openRoom(app.store, roomId);
  const send = async (
    type: string,
    content: Json,
    key?: string,
    sender = alice.user_id,
  ) => {
    const result = await sendLocal(room, {
      type,
      sender,
      content,
      ...(key === undefined ? {} : { state_key: key }),
    }, signer);
    assertEquals(result.standing, 'accepted', result.reason ?? undefined);
    return result.eventId;
  };
  await send('org.example.private', { secret }, '');
  await send(
    'm.room.member',
    { membership: 'join', displayname: secret },
    alice.user_id,
  );
  const beforeInvite = await eventStreamMax(app.server);
  const invite = await send(
    'm.room.member',
    { membership: 'invite' },
    bob.user_id,
  );
  const invited = await eventStreamMax(app.server);
  const decline = async () =>
    await send(
      'm.room.member',
      { membership: 'leave' },
      bob.user_id,
      bob.user_id,
    );
  const base = 'v3/rooms/' + encodeURIComponent(roomId);
  return {
    app,
    alice,
    bob,
    room,
    roomId,
    send,
    beforeInvite,
    invite,
    invited,
    decline,
    base,
  };
}

for (const after of [false, true]) {
  suite.test(
    'declined never-joined invite: sync ' + (after ? 'state_after' : 'state') +
      ' admits only visible state',
    async () => {
      const f = await fixture('admit-sync-' + after);
      const leave = await f.decline();
      const response = await call(
        'v3/sync?since=s' + f.invited + '&full_state=true&use_state_after=' +
          after,
        f.bob.access_token!,
      );
      assertEquals(response.status, 200);
      assert(!json(response.body).includes(secret));
      assert(
        json(response.body).includes(leave),
        'own departure remains visible',
      );
    },
  );
}
for (const reader of ['state', 'state/org.example.private/', 'members']) {
  suite.test(
    'declined never-joined invite: ' + reader +
      ' cannot turn a leave row into full-state permission',
    async () => {
      const f = await fixture('admit-' + reader.replaceAll('/', '-'));
      await f.decline();
      const response = await call(f.base + '/' + reader, f.bob.access_token!);
      assert([200, 403, 404].includes(response.status));
      assert(!json(response.body).includes(secret));
    },
  );
}
suite.test('context on own departure does not disclose the surrounding private snapshot', async () => {
  const f = await fixture('admit-context');
  const leave = await f.decline();
  const response = await call(
    f.base + '/context/' + encodeURIComponent(leave) + '?limit=0',
    f.bob.access_token!,
  );
  assertEquals(response.status, 200);
  assertEquals((response.body.event as Json).event_id, leave);
  assert(!json(response.body.state).includes(secret));
});
suite.test('messages lazy-member state cannot reveal an invisible sender profile through own membership events', async () => {
  const f = await fixture('admit-messages');
  await f.decline();
  const filter = encodeURIComponent(json({ lazy_load_members: true }));
  const response = await call(
    f.base + '/messages?dir=b&limit=20&filter=' + filter,
    f.bob.access_token!,
  );
  assertEquals(response.status, 200);
  assert(!json(response.body.state).includes(secret));
});
suite.test('members at a joined-only prejoin token do not inherit a later join permission', async () => {
  const f = await fixture('admit-members-at', 'joined');
  await f.send(
    'm.room.member',
    { membership: 'join' },
    f.bob.user_id,
    f.bob.user_id,
  );
  const response = await call(
    f.base + '/members?at=s' + f.beforeInvite,
    f.bob.access_token!,
  );
  assert([200, 403].includes(response.status));
  assert(!json(response.body).includes(secret));
});
suite.test('search include_state and profiles respect the former member departure ceiling', async () => {
  const f = await fixture('admit-search');
  await f.send(
    'm.room.member',
    { membership: 'join' },
    f.bob.user_id,
    f.bob.user_id,
  );
  await f.send('m.room.message', {
    body: 'needle-admission',
    msgtype: 'm.text',
  });
  await f.send(
    'org.example.private',
    { secret: 'visible before departure' },
    '',
  );
  const newer = 'PRIVATE-AFTER-DEPARTURE';
  // Leave after search captures its joined-room scope but before state rendering.
  const original = f.app.server.query.bind(f.app.server);
  let changed = false;
  f.app.server.query = async (sql, params) => {
    const rows = await original(sql, params);
    if (!changed && sql.includes('FROM search s')) {
      changed = true;
      await f.decline();
      await f.send('org.example.private', { secret: newer }, '');
    }
    return rows;
  };
  let response: Awaited<ReturnType<typeof call>>;
  try {
    response = await call('v3/search', f.bob.access_token!, {
      search_categories: {
        room_events: {
          search_term: 'needle-admission',
          include_state: true,
          event_context: {
            before_limit: 0,
            after_limit: 0,
            include_profile: true,
          },
        },
      },
    });
  } finally {
    f.app.server.query = original;
  }
  assert(changed);
  assertEquals(response.status, 200);
  assert(!json(response.body).includes(newer));
  assert(json(response.body).includes('visible before departure'));
});
suite.test('joined snapshots retain old state in joined-only rooms and real departures retain their cut', async () => {
  const f = await fixture('admit-positive', 'joined');
  await f.send(
    'm.room.member',
    { membership: 'join' },
    f.bob.user_id,
    f.bob.user_id,
  );
  for (const reader of ['state', 'members', 'joined_members', 'initialSync']) {
    const response = await call(f.base + '/' + reader, f.bob.access_token!);
    assertEquals(response.status, 200, reader);
    assert(
      json(response.body).includes(secret),
      'admitted snapshot includes old state: ' + reader,
    );
  }
  await f.decline();
  await f.send(
    'org.example.private',
    { secret: 'AFTER-POSITIVE-DEPARTURE' },
    '',
  );
  const response = await call(f.base + '/state', f.bob.access_token!);
  assertEquals(response.status, 200);
  assert(json(response.body).includes(secret));
  assert(!json(response.body).includes('AFTER-POSITIVE-DEPARTURE'));
});
suite.test('initialSync, joined_members and private discovery keep their existing denial after an unjoined decline', async () => {
  const f = await fixture('admit-safe-gates', 'shared', true);
  await f.decline();
  for (
    const path of [
      f.base + '/initialSync',
      f.base + '/joined_members',
      'v1/room_summary/' + encodeURIComponent(f.roomId),
      'v1/rooms/' + encodeURIComponent(f.roomId) + '/hierarchy',
    ]
  ) {
    const response = await call(path, f.bob.access_token!);
    assert([403, 404].includes(response.status), path + ':' + response.status);
    assert(!json(response.body).includes(secret));
  }
});
suite.test('world-readable state and bounded invited discovery are not mistaken for full private state grants', async () => {
  const f = await fixture('admit-discovery', 'world_readable', true);
  const outsider = await suite.registerTestUser('admit-outsider', 'pw');
  const state = await call(f.base + '/initialSync', outsider.access_token!);
  assertEquals(state.status, 200);
  assert(json(state.body).includes(secret));
  await f.send(
    'm.room.history_visibility',
    { history_visibility: 'shared' },
    '',
  );
  const summary = await call(
    'v1/room_summary/' + encodeURIComponent(f.roomId),
    f.bob.access_token!,
  );
  assertEquals(summary.status, 200);
  assertEquals(summary.body.name, 'Allowed discovery name');
  assert(!json(summary.body).includes(secret));
  const hierarchy = await call(
    'v1/rooms/' + encodeURIComponent(f.roomId) + '/hierarchy',
    f.bob.access_token!,
  );
  assertEquals(hierarchy.status, 200);
  assert(!json(hierarchy.body).includes(secret));
});

suite.test('historical members cannot reuse a shared invitation grant after an unjoined decline', async () => {
  const f = await fixture('admit-historical-decline');
  const invited = await call(
    f.base + '/members?at=s' + f.invited,
    f.bob.access_token!,
  );
  assertEquals(invited.status, 200);
  assert(
    json(invited.body).includes(secret),
    'a current invitation retains the existing historical shared-state contract',
  );
  await f.decline();
  const declined = await call(
    f.base + '/members?at=s' + f.invited,
    f.bob.access_token!,
  );
  assertEquals(declined.status, 200);
  assert(
    !json(declined.body).includes(secret),
    'the at parameter is not an ongoing invitation grant',
  );
});

suite.test('context at a later own ban retains the real departure snapshot instead of omitting overwritten keys', async () => {
  const f = await fixture('admit-context-departure');
  await f.send(
    'm.room.member',
    { membership: 'join' },
    f.bob.user_id,
    f.bob.user_id,
  );
  await f.decline();
  await f.send(
    'org.example.private',
    { secret: 'AFTER-DEPARTURE-CONTEXT' },
    '',
  );
  const ban = await f.send(
    'm.room.member',
    { membership: 'ban' },
    f.bob.user_id,
  );
  const response = await call(
    f.base + '/context/' + encodeURIComponent(ban) + '?limit=0',
    f.bob.access_token!,
  );
  assertEquals(response.status, 200);
  const rows = response.body.state as Json[];
  assertEquals(
    (rows.find((row) => row.type === 'org.example.private')?.content as
      | Json
      | undefined)?.secret,
    secret,
  );
  assert(!json(rows).includes('AFTER-DEPARTURE-CONTEXT'));
});

suite.test('summary metadata and permission IDs come from one admitted publication', async () => {
  const f = await fixture('admit-summary-race');
  const original = f.app.server.query.bind(f.app.server);
  let changed = false;
  f.app.server.query = async (sql, params) => {
    if (
      !changed && sql === "SELECT value FROM counters WHERE name = 'events'"
    ) {
      changed = true;
      await f.send('m.room.name', { name: 'SUMMARY-NEW-NAME' }, '');
      await f.send('m.room.join_rules', { join_rule: 'public' }, '');
    }
    return await original(sql, params);
  };
  try {
    const summary = await heldRoomSummary(f.roomId);
    assert(changed);
    assertEquals(summary.name, 'SUMMARY-NEW-NAME');
    assertEquals(summary.join_rule, 'public');
  } finally {
    f.app.server.query = original;
  }
});

suite.test('a later join cannot authorize a joined-only snapshot from an earlier declined invitation', async () => {
  const f = await fixture('admit-later-join', 'joined');
  await f.decline();
  const declined = await eventStreamMax(f.app.server);
  await f.send('m.room.member', { membership: 'invite' }, f.bob.user_id);
  await f.send(
    'm.room.member',
    { membership: 'join' },
    f.bob.user_id,
    f.bob.user_id,
  );
  const response = await call(
    f.base + '/members?at=s' + declined,
    f.bob.access_token!,
  );
  assert([200, 403].includes(response.status));
  assert(!json(response.body).includes(secret));
});

suite.test('join history stops at the real departure, not a later ban or a declined reinvitation', async () => {
  for (const transition of ['decline', 'ban']) {
    const f = await fixture('admit-real-departure-' + transition);
    await f.send(
      'm.room.member',
      { membership: 'join' },
      f.bob.user_id,
      f.bob.user_id,
    );
    await f.send(
      'org.example.private',
      { secret: 'LAST-AUTHORIZED-STATE' },
      '',
    );
    await f.decline();
    const newer = 'NEVER-AUTHORIZED-AFTER-LEAVE';
    await f.send('org.example.private', { secret: newer }, '');
    if (transition === 'decline') {
      await f.send('m.room.member', { membership: 'invite' }, f.bob.user_id);
      await f.decline();
    } else await f.send('m.room.member', { membership: 'ban' }, f.bob.user_id);
    const response = await call(f.base + '/state', f.bob.access_token!);
    assertEquals(response.status, 200);
    assert(!json(response.body).includes(newer));
    assert(json(response.body).includes('LAST-AUTHORIZED-STATE'));
  }
});
