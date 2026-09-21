// tests/upgrade.test.ts — /rooms/:id/upgrade (plan D7): the six
// _Upgrades PL/creator outcomes, _UpgradedRooms shape (10/11/12 → 12),
// tombstone + predecessor, the alias move, and the permission/version
// errors. Live doltgres, HTTP-level via the real endpoint trees.
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

Deno.test('upgrade: six PL/creator outcomes, room-id shape, tombstone+predecessor, alias move, permission errors', async () => {
  const alice = await registerTestUser('up-a', 'pw-up-a');
  const bob = await registerTestUser('up-b', 'pw-up-b');
  const charlie = await registerTestUser('up-c', 'pw-up-c');
  const aTok = alice.access_token!;
  const bTok = bob.access_token!;
  const cTok = charlie.access_token!;
  const aId = alice.user_id as string;
  const bId = bob.user_id as string;
  const cId = charlie.user_id as string;

  const mk = async (tok: string, body: unknown): Promise<string> => {
    const res = await call('/_matrix/client/v3/createRoom', {
      method: 'POST',
      token: tok,
      body,
    });
    assertEquals(res.status, 200);
    return res.body.room_id as string;
  };
  const join = async (tok: string, roomId: string) => {
    assertEquals(
      (await call(
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`,
        {
          method: 'POST',
          token: tok,
          body: {},
        },
      )).status,
      200,
    );
  };
  const setPl = async (tok: string, roomId: string, users: Json) => {
    assertEquals(
      (await call(
        `/_matrix/client/v3/rooms/${
          encodeURIComponent(roomId)
        }/state/m.room.power_levels`,
        { method: 'PUT', token: tok, body: { users } },
      )).status,
      200,
    );
  };
  const stateOf = async (tok: string, roomId: string, type: string) =>
    (await call(
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/${type}`,
      { token: tok },
    )).body;
  const createEventOf = async (tok: string, roomId: string) =>
    (await call(
      `/_matrix/client/v3/rooms/${
        encodeURIComponent(roomId)
      }/state/m.room.create?format=event`,
      { token: tok },
    )).body;

  // --- the six _Upgrades outcomes ---------------------------------------------
  const cases: {
    name: string;
    version: string;
    users: Json;
    upgrader: 'alice' | 'bob';
    additionalCreators?: string[];
    wantCreate: { additionalCreators?: string[] };
    wantUsers: Json;
  }[] = [
    {
      name: 'a: v11, bob upgrades, bob removed',
      version: '11',
      users: { [bId]: 100 },
      upgrader: 'bob',
      wantCreate: {},
      wantUsers: {},
    },
    {
      name: 'b: v11, bob upgrades, charlie stays',
      version: '11',
      users: { [bId]: 100, [cId]: 100 },
      upgrader: 'bob',
      wantCreate: {},
      wantUsers: { [cId]: 100 },
    },
    {
      name: 'c: v12, bob upgrades with charlie as creator',
      version: '12',
      users: { [bId]: 150 },
      upgrader: 'bob',
      additionalCreators: [cId],
      wantCreate: { additionalCreators: [cId] },
      wantUsers: {},
    },
    {
      name: 'd: v12, bob upgrades, charlie removed as new creator',
      version: '12',
      users: { [bId]: 150, [cId]: 50 },
      upgrader: 'bob',
      additionalCreators: [cId],
      wantCreate: { additionalCreators: [cId] },
      wantUsers: {},
    },
    {
      name: 'e: v11, alice upgrades with bob as creator',
      version: '11',
      users: { [aId]: 100, [bId]: 100 },
      upgrader: 'alice',
      additionalCreators: [bId],
      wantCreate: { additionalCreators: [bId] },
      wantUsers: {},
    },
    {
      name: 'f: v11, alice upgrades, charlie stays',
      version: '11',
      users: { [aId]: 100, [bId]: 100, [cId]: 50 },
      upgrader: 'alice',
      additionalCreators: [bId],
      wantCreate: { additionalCreators: [bId] },
      wantUsers: { [cId]: 50 },
    },
  ];

  for (const tc of cases) {
    const roomId = await mk(aTok, {
      room_version: tc.version,
      invite: [bId, cId],
    });
    await join(bTok, roomId);
    await join(cTok, roomId);
    await setPl(aTok, roomId, tc.users);
    const upgraderTok = tc.upgrader === 'alice' ? aTok : bTok;
    const body: Json = { new_version: '12' };
    if (tc.additionalCreators !== undefined) {
      body.additional_creators = tc.additionalCreators;
    }
    const res = await call(
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/upgrade`,
      { method: 'POST', token: upgraderTok, body },
    );
    assertEquals(res.status, 200, tc.name);
    const newRoomId = res.body.replacement_room as string;
    const create = await stateOf(upgraderTok, newRoomId, 'm.room.create');
    assertEquals(create.room_version, '12', tc.name);
    if (tc.wantCreate.additionalCreators !== undefined) {
      assertEquals(
        create.additional_creators,
        tc.wantCreate.additionalCreators,
        tc.name,
      );
    } else {
      assertEquals('additional_creators' in create, false, tc.name);
    }
    const pl = await stateOf(upgraderTok, newRoomId, 'm.room.power_levels');
    assertEquals(pl.users, tc.wantUsers, tc.name);
  }

  // --- _UpgradedRooms: 10/11/12 → 12, room id = create id, tombstone,
  //     predecessor (room_id present, event_id absent) -----------------------
  for (const v of ['10', '11', '12']) {
    const oldId = await mk(aTok, { room_version: v, invite: [bId] });
    await join(bTok, oldId);
    const res = await call(
      `/_matrix/client/v3/rooms/${encodeURIComponent(oldId)}/upgrade`,
      { method: 'POST', token: aTok, body: { new_version: '12' } },
    );
    assertEquals(res.status, 200, `upgrade from v${v}`);
    const newId = res.body.replacement_room as string;
    const createEvent = await createEventOf(aTok, newId);
    assertEquals(newId, '!' + (createEvent.event_id as string).slice(1));
    const create = await stateOf(aTok, newId, 'm.room.create');
    const predecessor = create.predecessor as Json;
    assertEquals(predecessor.room_id, oldId);
    assertEquals('event_id' in predecessor, false);
    const tombstone = await stateOf(aTok, oldId, 'm.room.tombstone');
    assertEquals(tombstone.replacement_room, newId);
    assertEquals(typeof tombstone.body, 'string');
  }

  // --- the alias move -----------------------------------------------------------
  const oldId = await mk(aTok, { room_alias_name: 'upgrade-src' });
  const alias = `#upgrade-src:${serverName()}`;
  // the old room's canonical alias resolves before…
  const before = await call(
    `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
    { token: aTok },
  );
  assertEquals(before.body.room_id, oldId);
  const res = await call(
    `/_matrix/client/v3/rooms/${encodeURIComponent(oldId)}/upgrade`,
    { method: 'POST', token: aTok, body: { new_version: '12' } },
  );
  const newId = res.body.replacement_room as string;
  // …and the moved alias resolves to the new room after
  const after = await call(
    `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
    { token: aTok },
  );
  assertEquals(after.body.room_id, newId);
  // the new room re-emitted its canonical alias (the transfer's step 4)
  const canon = await stateOf(aTok, newId, 'm.room.canonical_alias');
  assertEquals(canon.alias, alias);

  // --- permission + version errors ----------------------------------------------
  const noRoom = await call(
    `/_matrix/client/v3/rooms/${
      encodeURIComponent('!nope:' + serverName())
    }/upgrade`,
    { method: 'POST', token: aTok, body: { new_version: '12' } },
  );
  assertEquals(noRoom.status, 404);
  const lowRoom = await mk(aTok, { invite: [cId] });
  await join(cTok, lowRoom);
  const forbidden = await call(
    `/_matrix/client/v3/rooms/${encodeURIComponent(lowRoom)}/upgrade`,
    { method: 'POST', token: cTok, body: { new_version: '12' } },
  );
  assertEquals(forbidden.status, 403);
  assertEquals(forbidden.body.errcode, 'M_FORBIDDEN');
  const badVersion = await call(
    `/_matrix/client/v3/rooms/${encodeURIComponent(lowRoom)}/upgrade`,
    { method: 'POST', token: aTok, body: { new_version: '99' } },
  );
  assertEquals(badVersion.status, 400);
  assertEquals(badVersion.body.errcode, 'M_UNSUPPORTED_ROOM_VERSION');
});
