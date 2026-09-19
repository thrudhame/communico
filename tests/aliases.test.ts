// tests/aliases.test.ts — band C item 1: the TestRoomAlias /
// TestRoomDeleteAlias / TestRoomCanonicalAlias contract rows (plan §2,
// D3, §3a-§3b; spec v1.16 directory.yaml). Live doltgres, HTTP-level via
// the real endpoint trees.
import { assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { serverName } from '#engine/config.ts';
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

async function mkRoom(tok: string, body: unknown = {}): Promise<string> {
  const res = await call('/_matrix/client/v3/createRoom', {
    method: 'POST',
    token: tok,
    body,
  });
  return res.body.room_id as string;
}
const dir = (a: string) =>
  `/_matrix/client/v3/directory/room/${encodeURIComponent(a)}`;
const st = (roomId: string, type: string) =>
  `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/${type}`;

Deno.test('aliases: create/resolve/list, unicode, duplicates, delete permissions, canonical validation', async () => {
  const alice = await registerTestUser('al-a', 'pw-al-a');
  const bob = await registerTestUser('al-b', 'pw-al-b');
  const aTok = alice.access_token!;
  const bTok = bob.access_token!;
  const SN = serverName();

  // PUT creates; GET resolves — and GET is public (no token)
  const room1 = await mkRoom(aTok);
  const alias1 = `#creates:${SN}`;
  assertEquals(
    (await call(dir(alias1), {
      method: 'PUT',
      token: aTok,
      body: { room_id: room1 },
    })).status,
    200,
  );
  const resolved = await call(dir(alias1));
  assertEquals(resolved.status, 200);
  assertEquals(resolved.body.room_id, room1);
  assertEquals((resolved.body.servers as string[])[0], SN);

  // duplicate → 409 M_ROOM_IN_USE
  const dup = await call(dir(alias1), {
    method: 'PUT',
    token: aTok,
    body: { room_id: room1 },
  });
  assertEquals(dup.status, 409);
  assertEquals(dup.body.errcode, 'M_ROOM_IN_USE');

  // invalid syntax / foreign domain → 400 M_INVALID_PARAM
  for (const bad of ['%invalid:hs1', '#no-domain:', `#foreign:elsewhere`]) {
    const res = await call(dir(bad), {
      method: 'PUT',
      token: aTok,
      body: { room_id: room1 },
    });
    assertEquals(res.status, 400, bad);
    assertEquals(res.body.errcode, 'M_INVALID_PARAM', bad);
  }

  // unicode alias round-trips
  const unicode = `#老虎Â£я🤨👉ඞ:${SN}`;
  assertEquals(
    (await call(dir(unicode), {
      method: 'PUT',
      token: aTok,
      body: { room_id: room1 },
    })).status,
    200,
  );
  assertEquals((await call(dir(unicode))).body.room_id, room1);

  // unknown alias: GET → 404 M_NOT_FOUND; DELETE → 404 M_NOT_FOUND
  const nope = `#nope:${SN}`;
  assertEquals((await call(dir(nope))).status, 404);
  assertEquals((await call(dir(nope))).body.errcode, 'M_NOT_FOUND');
  const delNope = await call(dir(nope), { method: 'DELETE', token: aTok });
  assertEquals(delNope.status, 404);
  assertEquals(delNope.body.errcode, 'M_NOT_FOUND');

  // /rooms/:id/aliases — member lists (empty then both), non-member 403,
  // world_readable opens it to anyone
  const listPath = `/_matrix/client/v3/rooms/${
    encodeURIComponent(room1)
  }/aliases`;
  assertEquals(
    ((await call(listPath, { token: aTok })).body.aliases as string[])
      .length,
    2,
  );
  assertEquals((await call(listPath, { token: bTok })).status, 403);
  const pub = await mkRoom(aTok, {
    initial_state: [{
      type: 'm.room.history_visibility',
      content: { history_visibility: 'world_readable' },
    }],
  });
  assertEquals(
    (await call(
      `/_matrix/client/v3/rooms/${encodeURIComponent(pub)}/aliases`,
      { token: bTok },
    )).status,
    200,
  );

  // creator (PL 0) deletes own alias; other low-PL user is 403
  const room2 = await mkRoom(aTok, { invite: [`@al-b:${SN}`] });
  const join = await call(
    `/_matrix/client/v3/rooms/${encodeURIComponent(room2)}/join`,
    { method: 'POST', token: bTok, body: {} },
  );
  assertEquals(join.status, 200);
  const bAlias = `#bobs:${SN}`;
  assertEquals(
    (await call(dir(bAlias), {
      method: 'PUT',
      token: bTok,
      body: { room_id: room2 },
    })).status,
    200,
  );
  // alice (creator PL 100) may not delete bob's? — she may (PL >= 50);
  // a fresh PL-0 user may not. Re-create after each outcome.
  const aDel = await call(dir(bAlias), { method: 'DELETE', token: aTok });
  assertEquals(aDel.status, 200); // alice's PL 100 >= canonical_alias 50
  assertEquals(
    (await call(dir(bAlias), {
      method: 'PUT',
      token: bTok,
      body: { room_id: room2 },
    })).status,
    200,
  );
  const bDel = await call(dir(bAlias), { method: 'DELETE', token: bTok });
  assertEquals(bDel.status, 200); // bob created it

  // Users can't delete other's aliases (both PL 0 now): carol creates,
  // bob can't delete
  const carol = await registerTestUser('al-c', 'pw-al-c');
  const cTok = carol.access_token!;
  const cAlias = `#carols:${SN}`;
  assertEquals(
    (await call(dir(cAlias), {
      method: 'PUT',
      token: cTok,
      body: { room_id: room2 },
    })).status,
    200,
  );
  const xDel = await call(dir(cAlias), { method: 'DELETE', token: bTok });
  assertEquals(xDel.status, 403);
  assertEquals(xDel.body.errcode, 'M_FORBIDDEN');

  // m.room.aliases restricted to PL 50 — D3: NOT consulted; the creator
  // (bob, PL 0) still creates and deletes
  assertEquals(
    (await call(st(room2, 'm.room.power_levels'), {
      method: 'PUT',
      token: aTok,
      body: {
        events: { 'm.room.aliases': 50 },
        users: { [`@al-a:${SN}`]: 100 },
      },
    })).status,
    200,
  );
  const rAlias = `#restricted:${SN}`;
  assertEquals(
    (await call(dir(rAlias), {
      method: 'PUT',
      token: bTok,
      body: { room_id: room2 },
    })).status,
    200,
  );
  assertEquals(
    (await call(dir(rAlias), { method: 'DELETE', token: bTok })).status,
    200,
  );

  // canonical_alias validation (§3a)
  const room3 = await mkRoom(aTok);
  const okAlias = `#okcanon:${SN}`;
  assertEquals(
    (await call(dir(okAlias), {
      method: 'PUT',
      token: aTok,
      body: { room_id: room3 },
    })).status,
    200,
  );
  // accepts present alias + present alt
  const altOk = `#altok:${SN}`;
  assertEquals(
    (await call(dir(altOk), {
      method: 'PUT',
      token: aTok,
      body: { room_id: room3 },
    })).status,
    200,
  );
  assertEquals(
    (await call(st(room3, 'm.room.canonical_alias'), {
      method: 'PUT',
      token: aTok,
      body: { alias: okAlias, alt_aliases: [altOk] },
    })).status,
    200,
  );
  // missing → M_BAD_ALIAS
  let res = await call(st(room3, 'm.room.canonical_alias'), {
    method: 'PUT',
    token: aTok,
    body: { alias: `#missing:${SN}` },
  });
  assertEquals(res.status, 400);
  assertEquals(res.body.errcode, 'M_BAD_ALIAS');
  // invalid → M_INVALID_PARAM
  res = await call(st(room3, 'm.room.canonical_alias'), {
    method: 'PUT',
    token: aTok,
    body: { alias: '%invalid:hs1' },
  });
  assertEquals(res.status, 400);
  assertEquals(res.body.errcode, 'M_INVALID_PARAM');
  // points at another room → M_BAD_ALIAS
  res = await call(st(room3, 'm.room.canonical_alias'), {
    method: 'PUT',
    token: aTok,
    body: { alias: alias1 },
  });
  assertEquals(res.status, 400);
  assertEquals(res.body.errcode, 'M_BAD_ALIAS');
  // alt_aliases entries are validated too
  res = await call(st(room3, 'm.room.canonical_alias'), {
    method: 'PUT',
    token: aTok,
    body: { alt_aliases: [`#missing:${SN}`] },
  });
  assertEquals(res.status, 400);
  assertEquals(res.body.errcode, 'M_BAD_ALIAS');

  // §3b: deleting the canonical alias auto-emits an empty-content
  // canonical_alias event (alice, PL 100)
  assertEquals(
    (await call(dir(okAlias), { method: 'DELETE', token: aTok })).status,
    200,
  );
  const canon = await call(st(room3, 'm.room.canonical_alias'), {
    token: aTok,
  });
  assertEquals(canon.status, 200);
  assertEquals(canon.body, { alt_aliases: [altOk] });
});
