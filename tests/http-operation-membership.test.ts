import { assertEquals } from '@std/assert';
import { httpSuite } from '#tests/http-app.ts';
import { fedCaller, remoteServer } from './http-federation.ts';

const suite = httpSuite('HTTP membership and state operation contracts');
type Json = Record<string, unknown>;
let token = '', targetToken = '', target = '', room = '', event = '';
async function call(
  path: string,
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST',
  auth = token,
) {
  const response = await suite.matrix(
    new Request('http://x/_matrix/client/v3/' + path, {
      method,
      headers: { Authorization: 'Bearer ' + auth },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return { status: response.status, body: await response.json() as Json };
}
suite.test('prepare membership, state and redaction fixtures', async () => {
  const a = await suite.registerTestUser('operation-member-a', 'pw');
  const b = await suite.registerTestUser('operation-member-b', 'pw');
  token = a.access_token!;
  targetToken = b.access_token!;
  target = b.user_id;
  const created = await call('createRoom', {
    preset: 'public_chat',
    name: 'Operation state',
  });
  assertEquals(created.status, 200);
  room = String(created.body.room_id);
  const sent = await call(
    'rooms/' + encodeURIComponent(room) + '/send/m.room.message/reason',
    { body: 'retained', msgtype: 'm.text' },
    'PUT',
  );
  assertEquals(sent.status, 200);
  event = String(sent.body.event_id);
});
for (
  const operation of [
    'ban',
    'unban',
    'invite',
    'kick',
    'leave',
    'join',
    'joinAlias',
    'knock',
    'redact',
  ]
) {
  for (const reason of [null, false, 1, {}]) {
    suite.test(
      operation + ' rejects malformed reason ' + JSON.stringify(reason),
      async () => {
        const base = 'rooms/' + encodeURIComponent(room);
        const path = operation === 'joinAlias'
          ? 'join/' + encodeURIComponent(room)
          : operation === 'knock'
          ? 'knock/' + encodeURIComponent(room)
          : operation === 'redact'
          ? base + '/redact/' + encodeURIComponent(event) + '/' +
            crypto.randomUUID()
          : base + '/' + operation;
        assertEquals(
          (await call(
            path,
            { user_id: target, reason },
            operation === 'redact' ? 'PUT' : 'POST',
          )).status,
          400,
        );
      },
    );
  }
}
suite.test('valid and empty reasons reach membership and redaction events', async () => {
  const base = 'rooms/' + encodeURIComponent(room);
  assertEquals(
    (await call(base + '/state/m.room.member/' + encodeURIComponent(target)))
      .status,
    404,
  );
  assertEquals(
    ((await call(base + '/event/' + encodeURIComponent(event))).body
      .content as Json).body,
    'retained',
  );
  for (
    const [operation, reason] of [['invite', 'invited'], ['ban', 'banned'], [
      'unban',
      '',
    ]] as const
  ) {
    assertEquals(
      (await call(base + '/' + operation, { user_id: target, reason })).status,
      200,
    );
    assertEquals(
      (await call(base + '/state/m.room.member/' + encodeURIComponent(target)))
        .body.reason,
      reason,
    );
  }
  assertEquals(
    (await call(base + '/join', { reason: 'joining' }, 'POST', targetToken))
      .status,
    200,
  );
  assertEquals(
    (await call(base + '/state/m.room.member/' + encodeURIComponent(target)))
      .body.reason,
    'joining',
  );
  assertEquals(
    (await call(base + '/kick', { user_id: target, reason: 'kicked' })).status,
    200,
  );
  assertEquals(
    (await call(base + '/state/m.room.member/' + encodeURIComponent(target)))
      .body.reason,
    'kicked',
  );
  assertEquals(
    (await call(
      'join/' + encodeURIComponent(room),
      { reason: 'alias route' },
      'POST',
      targetToken,
    )).status,
    200,
  );
  assertEquals(
    (await call(base + '/leave', { reason: 'leaving' }, 'POST', targetToken))
      .status,
    200,
  );
  assertEquals(
    (await call(base + '/state/m.room.member/' + encodeURIComponent(target)))
      .body.reason,
    'leaving',
  );
  const redacted = await call(
    base + '/redact/' + encodeURIComponent(event) + '/valid',
    { reason: '' },
    'PUT',
  );
  assertEquals(redacted.status, 200);
  const redaction = await call(
    base + '/event/' + encodeURIComponent(String(redacted.body.event_id)),
  );
  assertEquals((redaction.body.content as Json).reason, '');
});
suite.test('state format and membership enums are validated without changing their valid meanings', async () => {
  const base = 'rooms/' + encodeURIComponent(room);
  const state = base + '/state/m.room.name';
  assertEquals((await call(state)).body, { name: 'Operation state' });
  assertEquals((await call(state + '?format=content')).body, {
    name: 'Operation state',
  });
  assertEquals((await call(state + '?format=event')).body.type, 'm.room.name');
  for (const query of ['format=invalid', 'format=']) {
    assertEquals((await call(state + '?' + query)).status, 400);
  }
  for (const field of ['membership', 'not_membership']) {
    for (const value of ['', 'joined', 'invalid']) {
      assertEquals(
        (await call(base + '/members?' + field + '=' + value)).status,
        400,
      );
    }
  }
  const joined = (await call(base + '/members?membership=join')).body
    .chunk as Json[];
  assertEquals(joined.length, 1);
  assertEquals((joined[0].content as Json).membership, 'join');
  const left = (await call(base + '/members?not_membership=join')).body
    .chunk as Json[];
  assertEquals(left.map((e) => e.state_key), [target]);
});
suite.test('federation profile field enum retains explicit field projections', async () => {
  const remote = fedCaller(suite.matrix, await remoteServer());
  const path = '/_matrix/federation/v1/query/profile?user_id=' +
    encodeURIComponent(target);
  assertEquals((await remote('GET', path + '&field=displayname')).body, {
    displayname: 'operation-member-b',
  });
  for (const field of ['', 'other']) {
    assertEquals((await remote('GET', path + '&field=' + field)).status, 400);
  }
});
