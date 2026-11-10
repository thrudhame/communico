import { assert, assertEquals } from '@std/assert';
import { httpSuite } from '#tests/http-app.ts';
import { theApp } from '#engine/app.ts';
import { requireRoom } from '#engine/client/room.ts';
import { sendLocal } from '#engine/room/ingest.ts';
import {
  fedCaller,
  remoteServer,
  signTemplate,
} from '#tests/http-federation.ts';
import { toWire } from '#engine/federation/pdu.ts';

const { matrix, registerTestUser, test } = httpSuite('HTTP timestamp lookup');
async function call(path: string, token: string, body?: unknown) {
  const res = await matrix(
    new Request('http://x/_matrix/client/' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: 'Bearer ' + token },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return { status: res.status, body: await res.json() };
}

test('inclusive directions, causal ties, actual timestamps, visibility and strict input', async () => {
  const alice = await registerTestUser('timestamp-alice', 'pw');
  const bob = await registerTestUser('timestamp-bob', 'pw');
  const made = await call('v3/createRoom', alice.access_token!, {
    preset: 'public_chat',
  });
  const id = made.body.room_id as string;
  const room = await requireRoom(id);
  const signer = theApp().tenant.signer();
  const first = await sendLocal(room, {
    type: 'm.room.encrypted',
    sender: alice.user_id!,
    content: { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'first' },
    origin_server_ts: 100,
  }, signer);
  const second = await sendLocal(room, {
    type: 'm.room.encrypted',
    sender: alice.user_id!,
    content: { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'second' },
    origin_server_ts: 100,
  }, signer);
  const path = 'v1/rooms/' + encodeURIComponent(id) + '/timestamp_to_event';
  for (const [dir, expected] of [['f', first.eventId], ['b', second.eventId]]) {
    const got = await call(path + '?ts=100&dir=' + dir, alice.access_token!);
    assertEquals(got.status, 200, JSON.stringify(got.body));
    assertEquals(got.body, { event_id: expected, origin_server_ts: 100 });
  }
  assertEquals(
    (await call(path + '?ts=99&dir=b', alice.access_token!)).status,
    404,
  );
  assertEquals(
    (await call(path + '?ts=100&dir=f', bob.access_token!)).status,
    403,
  );
  for (
    const query of [
      '',
      '?ts=100',
      '?dir=f',
      '?ts=1.5&dir=f',
      '?ts=1e2&dir=f',
      '?ts=9007199254740992&dir=b',
      '?ts=&dir=f',
      '?ts=100&dir=x',
    ]
  ) {
    assertEquals(
      (await call(path + query, alice.access_token!)).status,
      400,
      query,
    );
  }
  const context = await call(
    'v3/rooms/' + encodeURIComponent(id) + '/context/' +
      encodeURIComponent(second.eventId),
    alice.access_token!,
  );
  assertEquals(context.status, 200);
  assertEquals(context.body.event.event_id, second.eventId);
});

test('federation timestamp authenticates and applies current room ACL', async () => {
  const alice = await registerTestUser('timestamp-fed-alice', 'pw');
  const made = await call('v3/createRoom', alice.access_token!, {
    preset: 'public_chat',
  });
  const id = made.body.room_id as string;
  const peer = await remoteServer('timestamp-peer.test');
  const fed = fedCaller(matrix, peer);
  const path = '/_matrix/federation/v1/timestamp_to_event/' +
    encodeURIComponent(id) + '?ts=0&dir=f';
  const noAuth = await matrix(new Request('http://x' + path));
  assertEquals(noAuth.status, 401);
  await noAuth.body?.cancel();
  const denied = await fed('GET', path);
  assertEquals(denied.status, 403);
  assert(denied.body.errcode);
  const user = '@member:' + peer.name;
  const template = await fed(
    'GET',
    '/_matrix/federation/v1/make_join/' + encodeURIComponent(id) + '/' +
      encodeURIComponent(user) + '?ver=11',
  );
  assertEquals(template.status, 200);
  const signed = await signTemplate(
    template.body.event as Record<string, unknown>,
    peer,
  );
  const joined = await fed(
    'PUT',
    '/_matrix/federation/v2/send_join/' + encodeURIComponent(id) + '/' +
      encodeURIComponent(signed.event_id!),
    toWire(signed, '11'),
  );
  assertEquals(joined.status, 200, JSON.stringify(joined.body));
  const got = await fed('GET', path);
  assertEquals(got.status, 200, JSON.stringify(got.body));
  assert(typeof got.body.event_id === 'string');
  const room = await requireRoom(id);
  const original = await room.tx((tx) =>
    tx.events.get(String(got.body.event_id))
  );
  assertEquals(got.body.origin_server_ts, original!.origin_ts);
  await sendLocal(room, {
    type: 'm.room.server_acl',
    sender: alice.user_id!,
    state_key: '',
    content: { allow: ['*'], deny: [peer.name] },
  }, theApp().tenant.signer());
  assertEquals((await fed('GET', path)).status, 403);
});
