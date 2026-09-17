// tests/redact.test.ts — redactions (plan §3g): /redact authors the
// m.room.redaction, marks the target's row, is txn-idempotent; the
// client rendering applies the room version's keep-table and carries
// unsigned.redacted_because; a non-author below the redact level gets
// 403; one's own event needs only the (message) event level. Live
// doltgres, HTTP-level via the real endpoint trees.
import { assert, assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { eventIndexRow, lookupRoom } from '#engine/room.ts';
import { clientEventForRow } from '#engine/timeline.ts';
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

Deno.test('redact: own event redacts; rendering applies the keep-table; txn-idempotent', async () => {
  const alice = await registerTestUser('red-a', 'pw-red-a');
  const tok = alice.access_token!;
  const roomRes = await call('/_matrix/client/v3/createRoom', {
    method: 'POST',
    token: tok,
    body: {},
  });
  const roomId = roomRes.body.room_id as string;

  const sendRes = await call(
    `/_matrix/client/v3/rooms/${
      encodeURIComponent(roomId)
    }/send/m.room.message/t1`,
    {
      method: 'PUT',
      token: tok,
      body: { msgtype: 'm.text', body: 'redact me' },
    },
  );
  const targetId = sendRes.body.event_id as string;

  const redactRes = await call(
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/redact/${
      encodeURIComponent(targetId)
    }/rt1`,
    { method: 'PUT', token: tok, body: { reason: 'reasons...' } },
  );
  assertEquals(redactRes.status, 200);
  const redactionId = redactRes.body.event_id as string;

  // txn-idempotent: a repeat returns the same redaction event id
  const again = await call(
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/redact/${
      encodeURIComponent(targetId)
    }/rt1`,
    { method: 'PUT', token: tok, body: { reason: 'reasons...' } },
  );
  assertEquals(again.body.event_id, redactionId);

  // the target's row is marked; the client rendering applies the v11
  // keep-table (content {}) and carries unsigned.redacted_because
  const room = (await lookupRoom(roomId))!;
  const row = (await eventIndexRow(roomId, targetId))!;
  assertEquals(row.redacted_by, redactionId);
  const rendered = await clientEventForRow(room.dbName, room.roomVersion, row, {
    userId: alice.user_id,
    deviceId: null,
  });
  assert(rendered !== null);
  assertEquals(rendered.content, {});
  const unsigned = rendered.unsigned as Json;
  assertEquals((unsigned.redacted_because as Json).type, 'm.room.redaction');
  assertEquals(
    ((unsigned.redacted_because as Json).content as Json).redacts,
    targetId,
  );
});

Deno.test('redact: a non-author below the redact level gets 403; own event needs only the event level', async () => {
  const alice = await registerTestUser('red-b', 'pw-red-b');
  const bob = await registerTestUser('red-c', 'pw-red-c');
  const roomRes = await call('/_matrix/client/v3/createRoom', {
    method: 'POST',
    token: alice.access_token!,
    body: { preset: 'public_chat' },
  });
  const roomId = roomRes.body.room_id as string;
  await call(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`, {
    method: 'POST',
    token: bob.access_token!,
    body: {},
  });

  const sendRes = await call(
    `/_matrix/client/v3/rooms/${
      encodeURIComponent(roomId)
    }/send/m.room.message/t1`,
    {
      method: 'PUT',
      token: alice.access_token!,
      body: { msgtype: 'm.text', body: 'alice says' },
    },
  );
  const targetId = sendRes.body.event_id as string;

  // bob (PL 0) redacts alice's event -> 403 (redact level is 50)
  const denied = await call(
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/redact/${
      encodeURIComponent(targetId)
    }/rt9`,
    { method: 'PUT', token: bob.access_token!, body: {} },
  );
  assertEquals(denied.status, 403);
  assertEquals(denied.body.errcode, 'M_FORBIDDEN');

  // bob sends and redacts his OWN event -> allowed (event level 0)
  const bobSend = await call(
    `/_matrix/client/v3/rooms/${
      encodeURIComponent(roomId)
    }/send/m.room.message/t2`,
    {
      method: 'PUT',
      token: bob.access_token!,
      body: { msgtype: 'm.text', body: 'bob says' },
    },
  );
  const bobTarget = bobSend.body.event_id as string;
  const ok = await call(
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/redact/${
      encodeURIComponent(bobTarget)
    }/rt10`,
    { method: 'PUT', token: bob.access_token!, body: {} },
  );
  assertEquals(ok.status, 200);
});
