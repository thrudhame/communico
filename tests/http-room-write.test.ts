// doltgres create-room/body-validation/state/txn/redact contracts over real HTTP.
import { assert, assertEquals, assertNotEquals } from '@std/assert';
import { httpSuite } from '#tests/http-app.ts';
import { theApp } from '#engine/app.ts';
import { requireRoom } from '#engine/client/room.ts';
import { renderEvent } from '#engine/client/render.ts';
const { matrix, registerTestUser: register, test } = httpSuite(
  'HTTP room writes',
);
async function registerTestUser(localpart: string, password: string) {
  const user = await register(localpart, password);
  assert(typeof user.access_token === 'string');
  return { ...user, access_token: user.access_token };
}
type Json = Record<string, unknown>;
async function call(
  path: string,
  token: string,
  body?: unknown,
  method = body === undefined ? 'GET' : 'PUT',
) {
  const res = await matrix(
    new Request('http://x/_matrix/client/v3/' + path, {
      method,
      headers: { Authorization: 'Bearer ' + token },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return { status: res.status, body: await res.json() as Json };
}
async function create(token: string, body: Json = {}) {
  const res = await call('createRoom', token, body, 'POST');
  assertEquals(res.status, 200, JSON.stringify(res.body));
  return res.body.room_id as string;
}
const roomPath = (id: string) => 'rooms/' + encodeURIComponent(id);
const state = (id: string, type: string, key = '') =>
  roomPath(id) + '/state/' + type + '/' + encodeURIComponent(key);

test('createRoom: malformed and non-object bodies are refused before any room write', async () => {
  const user = await registerTestUser('cr-bad-body', 'pw');
  const before = await theApp().store.rooms();
  for (const raw of ['{', 'null', '[]', '1', 'true', '"text"']) {
    const response = await matrix(
      new Request('http://x/_matrix/client/v3/createRoom', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + user.access_token },
        body: raw,
      }),
    );
    assertEquals(response.status, 400);
    assertEquals(
      (await response.json()).errcode,
      raw === '{' ? 'M_NOT_JSON' : 'M_BAD_JSON',
    );
    assertEquals(await theApp().store.rooms(), before);
  }
});

test('createRoom: presets, explicit default power levels, override merge and trusted invitees', async () => {
  const a = await registerTestUser('cr-preset', 'pw');
  const A = a.access_token;
  const pub = await create(A, { preset: 'public_chat' });
  assertEquals((await call(state(pub, 'm.room.join_rules'), A)).body, {
    join_rule: 'public',
  });
  assertEquals((await call(state(pub, 'm.room.history_visibility'), A)).body, {
    history_visibility: 'shared',
  });
  assertEquals((await call(state(pub, 'm.room.guest_access'), A)).status, 404);
  const priv = await create(A);
  assertEquals((await call(state(priv, 'm.room.join_rules'), A)).body, {
    join_rule: 'invite',
  });
  assertEquals((await call(state(priv, 'm.room.guest_access'), A)).status, 404);
  const vis = await create(A, { visibility: 'public' });
  assertEquals((await call(state(vis, 'm.room.join_rules'), A)).body, {
    join_rule: 'public',
  });
  const bad = await call('createRoom', A, { preset: 'nope' }, 'POST');
  assertEquals([bad.status, bad.body.errcode], [400, 'M_INVALID_PARAM']);
  const defaults = {
    ban: 50,
    events: {},
    events_default: 0,
    invite: 0,
    kick: 50,
    redact: 50,
    state_default: 50,
    users: { [a.user_id]: 100 },
    users_default: 0,
    notifications: { room: 50 },
  };
  assertEquals(
    (await call(state(priv, 'm.room.power_levels'), A)).body,
    defaults,
  );
  const bob = '@cr-pl-bob:' + a.home_server;
  const override = await create(A, {
    preset: 'public_chat',
    power_level_content_override: {
      users_default: 100,
      users: { [a.user_id]: 100, [bob]: 100 },
      events: {},
      notifications: {},
    },
  });
  assertEquals((await call(state(override, 'm.room.power_levels'), A)).body, {
    ...defaults,
    invite: 50,
    users: { [a.user_id]: 100, [bob]: 100 },
    users_default: 100,
  });
  const trusted = await create(A, {
    preset: 'trusted_private_chat',
    invite: [bob],
  });
  assertEquals(
    ((await call(state(trusted, 'm.room.power_levels'), A)).body.users as Json)[
      bob
    ],
    100,
  );
});

test('createRoom: initial state/name/topic order, local invites, aliases and version validation', async () => {
  const a = await registerTestUser('cr-init', 'pw');
  const b = await registerTestUser('cr-inv-b', 'pw');
  const A = a.access_token;
  const init = await create(A, {
    initial_state: [{ type: 'm.room.topic', content: { topic: 'Init' } }],
  });
  assertEquals((await call(state(init, 'm.room.topic'), A)).body, {
    topic: 'Init',
  });
  const alias = '#cr-alias:' + a.home_server;
  const id = await create(A, {
    name: 'Real Name',
    topic: 'Test Room',
    invite: [b.user_id],
    room_alias_name: 'cr-alias',
    visibility: 'public',
    initial_state: [
      { type: 'm.room.topic', content: { topic: 'Shenanigans' } },
      { type: 'm.room.name', content: { name: 'Init Name' } },
    ],
  });
  assertEquals((await call(state(id, 'm.room.name'), A)).body, {
    name: 'Real Name',
  });
  assertEquals((await call(state(id, 'm.room.topic'), A)).body, {
    topic: 'Test Room',
    'm.topic': { 'm.text': [{ body: 'Test Room' }] },
  });
  assertEquals(
    (await call(state(id, 'm.room.member', b.user_id), A)).body.membership,
    'invite',
  );
  assertEquals((await call(state(id, 'm.room.canonical_alias'), A)).body, {
    alias,
  });
  const repeat = await call(
    'createRoom',
    A,
    { room_alias_name: 'cr-alias' },
    'POST',
  );
  assertEquals([repeat.status, repeat.body.errcode], [409, 'M_ROOM_IN_USE']);
  const content = await create(A, {
    creation_content: { test: 'azerty', room_version: 'test' },
  });
  assertEquals((await call(state(content, 'm.room.create'), A)).body, {
    test: 'azerty',
    room_version: '11',
  });
  for (
    const [version, code] of [[1, 'M_BAD_JSON'], [
      'not-a-version',
      'M_UNSUPPORTED_ROOM_VERSION',
    ]]
  ) {
    const res = await call('createRoom', A, { room_version: version }, 'POST');
    assertEquals([res.status, res.body.errcode], [400, code]);
  }
  for (const version of ['3', '4', '5', '6', '7', '8', '9', '10', '11', '12']) {
    const id = await create(A, { room_version: version });
    const res = await call(state(id, 'm.room.create'), A);
    assertEquals(res.body.room_version, version);
    assertEquals(
      res.body.creator,
      Number(version) <= 10 ? a.user_id : undefined,
    );
    if (version === '12') assert(!id.includes(':'));
  }
  const v6 = await create(A, {
    room_version: '6',
    initial_state: [{
      type: 'm.room.join_rules',
      content: { join_rule: 'knock' },
    }],
  });
  const knock = await call(state(v6, 'm.room.member', b.user_id), A, {
    membership: 'knock',
  });
  assertEquals([knock.status, knock.body.errcode], [403, 'M_FORBIDDEN']);
  assert(String(knock.body.error).includes('rule 4.6'));
});

test('body validation: non-object, non-canonical numbers and >64KiB sends/state', async () => {
  const a = await registerTestUser('bv-a', 'pw');
  const id = await create(a.access_token);
  const send = roomPath(id) + '/send/m.room.message/';
  for (
    const [index, raw] of [
      '"aGVsbG8="',
      '42',
      '[1,2]',
      'true',
      'null',
      '{"body":9007199254740992}',
      '{"body":-9007199254740992}',
      '{"body":1.1}',
    ].entries()
  ) {
    const res = await matrix(
      new Request('http://x/_matrix/client/v3/' + send + index, {
        method: 'PUT',
        headers: { Authorization: 'Bearer ' + a.access_token },
        body: raw,
      }),
    );
    assertEquals(res.status, 400, raw);
    assertEquals((await res.json()).errcode, 'M_BAD_JSON');
  }
  assertEquals(
    (await call(send + 'edge', a.access_token, {
      msgtype: 'm.text',
      body: 'edge',
      big: 9007199254740991,
    })).status,
    200,
  );
  for (const url of [send + 'large', state(id, 'com.example.big')]) {
    const res = await call(url, a.access_token, { body: 'x'.repeat(66000) });
    assertEquals([res.status, res.body.errcode], [413, 'M_TOO_LARGE']);
  }
  assertEquals(
    (await call(send + 'small', a.access_token, {
      msgtype: 'm.text',
      body: 'fine',
    })).status,
    200,
  );
});

test('state routes: both depths, trailing slash, content/event shape, idempotency and prev_content', async () => {
  const a = await registerTestUser('state-a', 'pw');
  const b = await registerTestUser('state-b', 'pw');
  const A = a.access_token;
  const id = await create(A);
  const url = state(id, 'test.state');
  const first = await call(url, A, { body: 'one' });
  assertEquals(first.status, 200);
  assertEquals((await call(url.slice(0, -1), A)).body, { body: 'one' });
  assertEquals((await call(url, A, { body: 'one' })).body, first.body);
  assertEquals(
    (await call(url + '?format=event', A)).body.event_id,
    first.body.event_id,
  );
  const second = await call(url, A, { body: 'two' });
  assertNotEquals(second.body.event_id, first.body.event_id);
  const full = await call(url + '?format=event', A);
  assertEquals((full.body.unsigned as Json).prev_content, { body: 'one' });
  assertEquals((full.body.unsigned as Json).prev_sender, a.user_id);
  const keyed = state(id, 'test.state', 'key');
  assertEquals((await call(keyed, A, { body: 'keyed' })).status, 200);
  assertEquals((await call(keyed, A)).body, { body: 'keyed' });
  const denied = await call(url, b.access_token, {});
  assertEquals([denied.status, denied.body.errcode], [403, 'M_FORBIDDEN']);
  assertEquals((await call(state(id, 'm.room.create'), A, {})).status, 400);
  const all = await call(roomPath(id) + '/state', A);
  assertEquals(all.status, 200);
  assert(Array.isArray(all.body));
});

test('txn: repeat/content/token/device/room scope; redaction receipt and read-time projection', async () => {
  const a = await registerTestUser('txn-a', 'pw');
  let A = a.access_token;
  const id = await create(A);
  const id2 = await create(A);
  const send = (room: string, token: string, text: string) =>
    call(roomPath(room) + '/send/m.room.message/m-txn', token, {
      msgtype: 'm.text',
      body: text,
    });
  const first = await send(id, A, 'first');
  assertEquals(first.status, 200);
  assertEquals((await send(id, A, 'first')).body, first.body);
  assertEquals((await send(id, A, 'second')).body, first.body);
  assertNotEquals(
    (await send(id2, A, 'first')).body.event_id,
    first.body.event_id,
  );
  const login = await call('login', A, {
    type: 'm.login.password',
    user: a.user_id,
    password: 'pw',
    device_id: a.device_id,
  }, 'POST');
  assertEquals(login.status, 200);
  assertEquals((await send(id, A, 'revoked token')).status, 401);
  A = login.body.access_token as string;
  assertEquals(
    (await send(id, A, 'other token')).body,
    first.body,
  );
  const room = await requireRoom(id);
  const viewer = {
    userId: a.user_id,
    deviceId: a.device_id,
    tenant: theApp().tenant,
  };
  const event = await renderEvent(room, first.body.event_id as string, viewer);
  assertEquals((event!.unsigned as Json).transaction_id, 'm-txn');
  assertEquals(
    ((await renderEvent(room, first.body.event_id as string, {
      ...viewer,
      deviceId: 'other',
    }))!.unsigned as Json).transaction_id,
    undefined,
  );
  const url = roomPath(id) + '/redact/' +
    encodeURIComponent(first.body.event_id as string) + '/rt1';
  const redaction = await call(url, A, { reason: 'reasons...' });
  assertEquals(redaction.status, 200);
  assertEquals((await call(url, A, {})).body, redaction.body);
  const rendered = await renderEvent(
    room,
    first.body.event_id as string,
    viewer,
  );
  assertEquals(rendered!.content, {});
  const reason = (rendered!.unsigned as Json).redacted_because as Json;
  assertEquals(reason.type, 'm.room.redaction');
  assertEquals((reason.content as Json).redacts, first.body.event_id);
  assertEquals(
    (await call(roomPath(id) + '/redact/$does-not-exist:anywhere.test/ru1', A, {
      reason: 'moderation',
    })).status,
    200,
  );
  // Refresh rotates tokens, never the device-scoped transaction receipt.
  const refreshLogin = await call('login', A, {
    type: 'm.login.password',
    user: a.user_id,
    password: 'pw',
    device_id: a.device_id,
    refresh_token: true,
  }, 'POST');
  const rotated = await call('refresh', A, {
    refresh_token: refreshLogin.body.refresh_token,
  }, 'POST');
  assertEquals(rotated.status, 200);
  assertEquals(
    (await send(id, rotated.body.access_token as string, 'rotated')).body,
    first.body,
  );
});

test('txn: endpoint identity includes send type, operation and redaction target', async () => {
  const user = await registerTestUser('txn-path', 'pw');
  const token = user.access_token;
  const id = await create(token);
  const base = roomPath(id);
  const message = await call(base + '/send/m.room.message/shared', token, {
    msgtype: 'm.text',
    body: 'target one',
  });
  assertEquals(message.status, 200);
  const other = await call(base + '/send/com.example.custom/shared', token, {
    body: 'target two',
  });
  assertEquals(other.status, 200);
  assertNotEquals(other.body.event_id, message.body.event_id);
  const targets = [message.body.event_id, other.body.event_id];
  const redactions: string[] = [];
  for (const target of targets) {
    const path = base + '/redact/' + encodeURIComponent(String(target)) +
      '/shared';
    const result = await call(path, token, {});
    assertEquals(result.status, 200);
    assert(!targets.includes(result.body.event_id));
    assertEquals(
      (await call(path, token, { reason: 'retry' })).body,
      result.body,
    );
    redactions.push(String(result.body.event_id));
    const event = await call(
      base + '/event/' + encodeURIComponent(String(target)),
      token,
    );
    assertEquals(event.body.content, {});
    assertEquals(
      ((event.body.unsigned as Json).redacted_because as Json).event_id,
      result.body.event_id,
    );
  }
  assertNotEquals(redactions[0], redactions[1]);
  assertEquals(
    (await call(base + '/send/com.example.custom/shared', token, {
      body: 'retry',
    })).body,
    other.body,
  );
});

test('txn: concurrent retransmissions publish exactly one event', async () => {
  const user = await registerTestUser('txn-concurrent', 'pw');
  const id = await create(user.access_token);
  const base = roomPath(id);
  const results = await Promise.all(
    Array.from(
      { length: 8 },
      () =>
        call(base + '/send/m.room.message/concurrent', user.access_token, {
          msgtype: 'm.text',
          body: 'one transaction',
        }),
    ),
  );
  assert(results.every((r) => r.status === 200));
  assertEquals(new Set(results.map((r) => r.body.event_id)).size, 1);
  const messages = await call(
    base + '/messages?dir=b&limit=100',
    user.access_token,
  );
  assertEquals(
    (messages.body.chunk as Json[]).filter((e) =>
      (e.content as Json).body === 'one transaction'
    ).length,
    1,
  );
});
