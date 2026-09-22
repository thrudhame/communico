// tests/legacy-rooms.test.ts — live legacy rooms (the older-versions
// plan, group A): createRoom for each of '3'..'9' — the create content
// carries creator + room_version, the spec-default power levels, a
// message, and a redaction with the ≤10 shape (top-level redacts —
// pdu_v6.yaml:27-30; v11 keeps it in content — v11.md:70-81). Plus
// /capabilities.available 3–12 and the v3 event-id alphabet through a
// URL path (plan 3e/D9). Live doltgres, HTTP-level via the real
// endpoint trees (the create-room.test.ts pattern).
import { assertEquals } from '@std/assert';
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

async function stateKey(
  token: string,
  roomId: string,
  type: string,
  key = '',
): Promise<{ status: number; body: Json }> {
  return await call(
    `/_matrix/client/v3/rooms/${
      encodeURIComponent(roomId)
    }/state/${type}/${key}`,
    { token },
  );
}

Deno.test('legacy rooms: createRoom 3–9 — create content, PL, message, redaction', async (t) => {
  const alice = await registerTestUser('legacy', 'pw-legacy');
  const tok = alice.access_token!;
  const aId = alice.user_id as string;

  for (const v of ['3', '4', '5', '6', '7', '8', '9']) {
    await t.step(`room version ${v}`, async () => {
      const cr = await call('/_matrix/client/v3/createRoom', {
        method: 'POST',
        token: tok,
        body: { room_version: v },
      });
      assertEquals(cr.status, 200);
      const roomId = cr.body.room_id as string;

      // the create content: creator + room_version (≤10 —
      // v3-auth-rules.md:32)
      const create = await stateKey(tok, roomId, 'm.room.create');
      assertEquals(create.status, 200);
      assertEquals((create.body as Json).creator, aId);
      assertEquals((create.body as Json).room_version, v);

      // the spec-default power levels: the creator at 100
      const pl = await stateKey(tok, roomId, 'm.room.power_levels');
      assertEquals(pl.status, 200);
      assertEquals(((pl.body as Json).users as Json)[aId], 100);

      // a message
      const sent = await call(
        `/_matrix/client/v3/rooms/${
          encodeURIComponent(roomId)
        }/send/m.room.message/legacy-msg-${v}`,
        {
          method: 'PUT',
          token: tok,
          body: { msgtype: 'm.text', body: 'hello v' + v },
        },
      );
      assertEquals(sent.status, 200);
      const eventId = sent.body.event_id as string;

      // a redaction — ≤10 carries redacts top-level on the PDU
      // (pdu_v6.yaml:27-30); size the response event by /event
      const red = await call(
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/redact/${
          encodeURIComponent(eventId)
        }/legacy-red-${v}`,
        { method: 'PUT', token: tok, body: { reason: 'cleanup' } },
      );
      assertEquals(red.status, 200);
      const redEv = await call(
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/event/${
          encodeURIComponent(red.body.event_id as string)
        }`,
        { token: tok },
      );
      assertEquals(redEv.status, 200);
      assertEquals(redEv.body.redacts, eventId);
      assertEquals((redEv.body.content as Json).redacts, undefined);
      assertEquals((redEv.body.content as Json).reason, 'cleanup');
    });
  }
});

Deno.test('legacy rooms: v11 keeps redacts in content (v11.md:70-81)', async () => {
  const alice = await registerTestUser('legacy11', 'pw-legacy11');
  const tok = alice.access_token!;
  const cr = await call('/_matrix/client/v3/createRoom', {
    method: 'POST',
    token: tok,
    body: { room_version: '11' },
  });
  assertEquals(cr.status, 200);
  const roomId = cr.body.room_id as string;
  const sent = await call(
    `/_matrix/client/v3/rooms/${
      encodeURIComponent(roomId)
    }/send/m.room.message/legacy11-msg`,
    {
      method: 'PUT',
      token: tok,
      body: { msgtype: 'm.text', body: 'hello v11' },
    },
  );
  assertEquals(sent.status, 200);
  const eventId = sent.body.event_id as string;
  const red = await call(
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/redact/${
      encodeURIComponent(eventId)
    }/legacy11-red`,
    { method: 'PUT', token: tok, body: {} },
  );
  assertEquals(red.status, 200);
  const redEv = await call(
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/event/${
      encodeURIComponent(red.body.event_id as string)
    }`,
    { token: tok },
  );
  assertEquals(redEv.status, 200);
  assertEquals((redEv.body.content as Json).redacts, eventId);
  assertEquals(redEv.body.redacts, undefined);
});

Deno.test('legacy rooms: /capabilities.available lists 3–12, default 11', async () => {
  const alice = await registerTestUser('legacy-caps', 'pw-legacy-caps');
  const caps = await call('/_matrix/client/v3/capabilities', {
    token: alice.access_token!,
  });
  assertEquals(caps.status, 200);
  const rv = ((caps.body as Json).capabilities as Json)[
    'm.room_versions'
  ] as Json;
  assertEquals(rv.default, '11');
  assertEquals(Object.keys(rv.available as Json).sort(), [
    '10',
    '11',
    '12',
    '3',
    '4',
    '5',
    '6',
    '7',
    '8',
    '9',
  ]);
});

// Plan 3e/D9: a v3 event id may contain + or / (v3.md:13-22). The id
// enters URL paths percent-encoded; pathfinder must decode %2F inside
// the segment, not split on it. If this fails, that is the
// stop-and-file case — never re-encode ids.
Deno.test('legacy rooms: a v3 event id with + or / survives the URL path', async () => {
  const alice = await registerTestUser('legacy-v3url', 'pw-legacy-v3url');
  const tok = alice.access_token!;
  const cr = await call('/_matrix/client/v3/createRoom', {
    method: 'POST',
    token: tok,
    body: { room_version: '3' },
  });
  assertEquals(cr.status, 200);
  const roomId = cr.body.room_id as string;

  // Send until an id carries + or / (≈75% per message at 43 chars).
  let eventId: string | null = null;
  for (let i = 0; i < 30 && eventId === null; i++) {
    const sent = await call(
      `/_matrix/client/v3/rooms/${
        encodeURIComponent(roomId)
      }/send/m.room.message/legacy-v3url-${i}`,
      {
        method: 'PUT',
        token: tok,
        body: { msgtype: 'm.text', body: 'alphabet probe ' + i },
      },
    );
    assertEquals(sent.status, 200);
    const id = sent.body.event_id as string;
    if (/[+/]/.test(id)) eventId = id;
  }
  assertEquals(typeof eventId, 'string', 'no +// id in 30 messages');

  const got = await call(
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/event/${
      encodeURIComponent(eventId!)
    }`,
    { token: tok },
  );
  assertEquals(got.status, 200);
  assertEquals(got.body.event_id, eventId);
});
