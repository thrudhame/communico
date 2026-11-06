// Public-interface restart proof. The only shared engine code here is the
// canonical JSON/signature implementation; this client never opens a store.
import { canonicalJson } from '#engine/canonical.ts';
import {
  b64decode,
  importPublicKeyFromRaw,
  verifyJson,
} from '#engine/signing-primitives.js';

const base = 'http://localhost:8008';
const content = { body: 'continuity-probe', msgtype: 'm.text' };

async function request(
  path: string,
  method = 'GET',
  body?: unknown,
  token?: string,
  expected = 200,
) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const value = await response.json();
  if (response.status !== expected) {
    throw new Error(
      `${method} ${path}: ${response.status} ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function equal(actual: unknown, expected: unknown, label: string) {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(`${label} changed across restart`);
  }
}

function eventPath(room: string, event: string) {
  return `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/event/${
    encodeURIComponent(event)
  }`;
}

if (Deno.args[0] === 'before') {
  const keys = await request('/_matrix/key/v2/server');
  if (Object.keys(keys.verify_keys).length === 0) {
    throw new Error('no verify keys');
  }
  const registration = { username: 'carol', password: 'pw' };
  const uia = await request(
    '/_matrix/client/v3/register',
    'POST',
    registration,
    undefined,
    401,
  );
  const user = await request('/_matrix/client/v3/register', 'POST', {
    ...registration,
    auth: { type: 'm.login.dummy', session: uia.session },
  });
  const room = await request('/_matrix/client/v3/createRoom', 'POST', {
    room_version: '11',
  }, user.access_token);
  const sent = await request(
    `/_matrix/client/v3/rooms/${
      encodeURIComponent(room.room_id)
    }/send/m.room.message/t1`,
    'PUT',
    content,
    user.access_token,
  );
  const event = await request(
    eventPath(room.room_id, sent.event_id),
    'GET',
    undefined,
    user.access_token,
  );
  equal(event.event_id, sent.event_id, 'event id');
  equal(event.content, content, 'event content');
  await request('/_matrix/client/v3/logout', 'POST', {}, user.access_token);
  console.log(
    JSON.stringify({ keys, userId: user.user_id, roomId: room.room_id, event }),
  );
} else if (Deno.args[0] === 'after') {
  const before = JSON.parse(Deno.env.get('C_BEFORE')!);
  const keys = await request('/_matrix/key/v2/server');
  equal(keys.server_name, before.keys.server_name, 'server name');
  equal(keys.verify_keys, before.keys.verify_keys, 'verify_keys');
  for (const [keyId, value] of Object.entries(before.keys.verify_keys)) {
    const key = await importPublicKeyFromRaw(
      b64decode((value as { key: string }).key),
    );
    if (!await verifyJson(keys, before.keys.server_name, keyId, key)) {
      throw new Error(`post-restart key-document signature broken: ${keyId}`);
    }
  }
  console.log('KEY-DOCUMENT-SIGNATURE: PASS');
  const user = await request('/_matrix/client/v3/login', 'POST', {
    type: 'm.login.password',
    identifier: { type: 'm.id.user', user: 'carol' },
    password: 'pw',
  });
  equal(user.user_id, before.userId, 'user id');
  const event = await request(
    eventPath(before.roomId, before.event.event_id),
    'GET',
    undefined,
    user.access_token,
  );
  equal(event.event_id, before.event.event_id, 'event id');
  equal(event.content, before.event.content, 'event content');
  await request('/_matrix/client/v3/logout', 'POST', {}, user.access_token);
  console.log('USER-AND-EVENT-PERSISTENCE: PASS');
} else {
  throw new Error('usage: continuity.ts before|after');
}
