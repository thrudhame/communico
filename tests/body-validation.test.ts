// tests/body-validation.test.ts — band C D9: valid-JSON-non-object bodies
// → 400 M_BAD_JSON (10-json.ts); non-canonical numbers in event content →
// 400 M_BAD_JSON (author(), spec appendices § Canonical JSON); canonical
// JSON of the PDU > 65536 bytes → 413 M_TOO_LARGE (spec client-server-api
// § Size limits), covering /send and PUT /state. Live doltgres,
// HTTP-level via the real endpoint trees.
import { assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { registerTestUser } from './util.ts';

const matrix = await pathfinder({ roots: ['api/endpoints/matrix/'] });

type Json = Record<string, unknown>;

async function call(
  path: string,
  init: { method?: string; token?: string; rawBody?: string } = {},
): Promise<{ status: number; body: Json }> {
  const headers: Record<string, string> = {};
  if (init.token !== undefined) headers.Authorization = `Bearer ${init.token}`;
  if (init.rawBody !== undefined) headers['Content-Type'] = 'application/json';
  const res = await matrix(
    new Request(`http://x${path}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.rawBody,
    }),
  );
  const text = await res.text();
  return { status: res.status, body: text === '' ? {} : JSON.parse(text) };
}

Deno.test('body validation: non-object JSON → M_BAD_JSON; non-canonical numbers → M_BAD_JSON; >64KiB PDU → M_TOO_LARGE', async () => {
  const alice = await registerTestUser('bv-a', 'pw-bv-a');
  const tok = alice.access_token!;
  const created = await call('/_matrix/client/v3/createRoom', {
    method: 'POST',
    token: tok,
    rawBody: '{}',
  });
  assertEquals(created.status, 200);
  const roomId = created.body.room_id as string;

  // valid JSON, not an object → 400 M_BAD_JSON (the Complement TestJson
  // base64-string shape, plus number and array forms)
  for (const raw of ['"aGVsbG8="', '42', '[1,2]', 'true', 'null']) {
    const res = await call(
      `/_matrix/client/v3/rooms/${
        encodeURIComponent(roomId)
      }/send/m.room.message/bv-nonobj-${raw.length}`,
      { method: 'PUT', token: tok, rawBody: raw },
    );
    assertEquals(res.status, 400, `raw ${raw}`);
    assertEquals(res.body.errcode, 'M_BAD_JSON', `raw ${raw}`);
  }

  // non-canonical numbers in content → 400 M_BAD_JSON
  let n = 0;
  for (const num of ['9007199254740992', '-9007199254740992', '1.1']) {
    const res = await call(
      `/_matrix/client/v3/rooms/${
        encodeURIComponent(roomId)
      }/send/m.room.message/bv-num-${n++}`,
      {
        method: 'PUT',
        token: tok,
        rawBody: `{"msgtype":"m.text","body":${num}}`,
      },
    );
    assertEquals(res.status, 400, `num ${num}`);
    assertEquals(res.body.errcode, 'M_BAD_JSON', `num ${num}`);
  }

  // the canonical boundary integer (2^53-1) is accepted
  const okNum = await call(
    `/_matrix/client/v3/rooms/${
      encodeURIComponent(roomId)
    }/send/m.room.message/bv-num-ok`,
    {
      method: 'PUT',
      token: tok,
      rawBody: '{"msgtype":"m.text","body":"edge","big":9007199254740991}',
    },
  );
  assertEquals(okNum.status, 200);

  // > 65536-byte event via /send → 413 M_TOO_LARGE
  const big = 'x'.repeat(66000);
  const large = await call(
    `/_matrix/client/v3/rooms/${
      encodeURIComponent(roomId)
    }/send/m.room.message/bv-large`,
    {
      method: 'PUT',
      token: tok,
      rawBody: `{"msgtype":"m.text","body":"${big}"}`,
    },
  );
  assertEquals(large.status, 413);
  assertEquals(large.body.errcode, 'M_TOO_LARGE');

  // > 65536-byte state event via PUT /state → 413 M_TOO_LARGE
  const largeState = await call(
    `/_matrix/client/v3/rooms/${
      encodeURIComponent(roomId)
    }/state/com.example.big`,
    {
      method: 'PUT',
      token: tok,
      rawBody: `{"body":"${big}"}`,
    },
  );
  assertEquals(largeState.status, 413);
  assertEquals(largeState.body.errcode, 'M_TOO_LARGE');

  // a well under-size message still lands
  const small = await call(
    `/_matrix/client/v3/rooms/${
      encodeURIComponent(roomId)
    }/send/m.room.message/bv-small`,
    {
      method: 'PUT',
      token: tok,
      rawBody: '{"msgtype":"m.text","body":"fine"}',
    },
  );
  assertEquals(small.status, 200);
});
