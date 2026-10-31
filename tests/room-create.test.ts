// tests/room-create.test.ts — createRoom (the old create-room.test.ts's
// engine-observable contracts): presets, the spec-default power levels and
// the override merge, initial_state vs name/topic ordering, the invite
// list, the canonical alias event, creation_content minus room_version,
// the version validations and the version-specific create content (v10
// creator, v12 derived room id / additional_creators). The alias
// uniqueness 409 and the visibility row are the server file's — stage 4.
import { assert, assertEquals, assertMatch, assertRejects } from '@std/assert';
import { MatrixError } from '#engine/matrix-error.ts';
import type { Pdu } from '#engine/pdu.ts';
import { createRoom } from '#engine/room/create.ts';
import { openRoom, type Room, roomSchema } from '#engine/room/index.ts';
import { sendLocal } from '#engine/room/ingest.ts';
import { openStore, type Store } from '#engine/store/index.ts';
import { testSigner } from './fixtures/signer.ts';

const config = (dir: string) => ({
  dir,
  library: './.native/libturso_ffi.so',
  checkpointlogbytes: 65536,
  maxopenfiles: 8,
  idleseconds: 300,
});

async function withStore(
  fn: (store: Store) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const store = await openStore(config(dir), {
    schemas: { room: roomSchema },
  });
  try {
    await fn(store);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
}

async function open(store: Store, roomId: string): Promise<Room> {
  return await openRoom(store, roomId);
}

async function stateContent(
  room: Room,
  type: string,
  key = '',
): Promise<Record<string, unknown> | null> {
  return await room.tx(async (tx) => {
    const stay = await tx.segments.openStay();
    if (stay === null) return null;
    const group = await tx.state.current(stay.id);
    if (group === null) return null;
    const id = await tx.state.groupKey(group, type, key);
    if (id === null) return null;
    const row = await tx.events.get(id);
    return row === null ? null : (JSON.parse(row.pdu) as Pdu).content;
  });
}

// The room's timeline in arrival order: (type, state_key, depth) per event.
async function timeline(
  room: Room,
): Promise<{ type: string; stateKey: string | null; depth: number }[]> {
  return await room.tx(async (tx) => {
    const stay = await tx.segments.openStay();
    if (stay === null) return [];
    const page = await tx.segments.positionsPage(stay.id, 0, 'f', 50);
    const out = [];
    for (const p of page) {
      const row = (await tx.events.get(p.event))!;
      out.push({
        type: row.type,
        stateKey: row.state_key,
        depth: row.depth,
      });
    }
    return out;
  });
}

const ID_SHAPE = /^\$[A-Za-z0-9_-]{43}$/;

Deno.test('createRoom: presets set join_rules/history_visibility (guest_access never preset-emitted)', async () => {
  await withStore(async (store) => {
    const signer = await testSigner();
    const creator = '@dev:test';
    const pub = await createRoom(store, {
      creator,
      preset: 'public_chat',
    }, signer);
    const pubRoom = await open(store, pub.roomId);
    assertEquals(await stateContent(pubRoom, 'm.room.join_rules'), {
      join_rule: 'public',
    });
    assertEquals(await stateContent(pubRoom, 'm.room.history_visibility'), {
      history_visibility: 'shared',
    });
    // no guest_access event — 'forbidden' is the default, never emitted
    assertEquals(await stateContent(pubRoom, 'm.room.guest_access'), null);

    // default preset: visibility absent -> private_chat
    const priv = await createRoom(store, { creator }, signer);
    const privRoom = await open(store, priv.roomId);
    assertEquals(await stateContent(privRoom, 'm.room.join_rules'), {
      join_rule: 'invite',
    });
    assertEquals(await stateContent(privRoom, 'm.room.guest_access'), null);

    // visibility: public without a preset -> public_chat
    const vis = await createRoom(
      store,
      { creator, visibility: 'public' },
      signer,
    );
    const visRoom = await open(store, vis.roomId);
    assertEquals(await stateContent(visRoom, 'm.room.join_rules'), {
      join_rule: 'public',
    });

    // unknown preset -> 400 M_INVALID_PARAM
    const bad = await assertRejects(() =>
      createRoom(store, { creator, preset: 'nope' }, signer)
    );
    assert(bad instanceof MatrixError);
    assertEquals(bad.status, 400);
    assertEquals(bad.errcode, 'M_INVALID_PARAM');
  });
});

Deno.test('createRoom: spec-default power levels, every key explicit; override deep-merges', async () => {
  await withStore(async (store) => {
    const signer = await testSigner();
    const creator = '@dev:test';
    const res = await createRoom(store, { creator }, signer);
    const room = await open(store, res.roomId);
    assertEquals(await stateContent(room, 'm.room.power_levels'), {
      ban: 50,
      events: {},
      events_default: 0,
      invite: 0,
      kick: 50,
      redact: 50,
      state_default: 50,
      users: { [creator]: 100 },
      users_default: 0,
      notifications: { room: 50 },
    });

    // override deep-merges over the defaults
    const bob = '@bob:test';
    const res2 = await createRoom(store, {
      creator,
      preset: 'public_chat',
      power_level_content_override: {
        users_default: 100,
        users: { [creator]: 100, [bob]: 100 },
        events: {},
        notifications: {},
      },
    }, signer);
    const room2 = await open(store, res2.roomId);
    assertEquals(await stateContent(room2, 'm.room.power_levels'), {
      ban: 50,
      events: {},
      events_default: 0,
      invite: 0,
      kick: 50,
      redact: 50,
      state_default: 50,
      users: { [creator]: 100, [bob]: 100 },
      users_default: 100,
      notifications: { room: 50 },
    });

    // trusted_private_chat: every invite user gets users[u]=100
    const res3 = await createRoom(store, {
      creator,
      preset: 'trusted_private_chat',
      invite: [bob],
    }, signer);
    const room3 = await open(store, res3.roomId);
    const pl3 = (await stateContent(room3, 'm.room.power_levels'))!;
    assertEquals((pl3.users as Record<string, unknown>)[bob], 100);
  });
});

Deno.test('createRoom: initial_state, then name/topic override it (rich topic form)', async () => {
  await withStore(async (store) => {
    const signer = await testSigner();
    const creator = '@dev:test';
    // initial_state alone: content verbatim (no m.topic added)
    const res = await createRoom(store, {
      creator,
      initial_state: [
        { type: 'm.room.topic', state_key: '', content: { topic: 'Init' } },
      ],
      preset: 'public_chat',
    }, signer);
    const room = await open(store, res.roomId);
    assertEquals(await stateContent(room, 'm.room.topic'), { topic: 'Init' });

    // name + topic come after initial_state and override it
    const res2 = await createRoom(store, {
      creator,
      name: 'Real Name',
      topic: 'Test Room',
      initial_state: [
        {
          type: 'm.room.topic',
          state_key: '',
          content: { topic: 'Shenanigans' },
        },
        { type: 'm.room.name', state_key: '', content: { name: 'Init Name' } },
      ],
      preset: 'public_chat',
    }, signer);
    const room2 = await open(store, res2.roomId);
    assertEquals(await stateContent(room2, 'm.room.name'), {
      name: 'Real Name',
    });
    assertEquals(await stateContent(room2, 'm.room.topic'), {
      topic: 'Test Room',
      'm.topic': { 'm.text': [{ body: 'Test Room' }] },
    });
  });
});

Deno.test('createRoom: the invite list authors the invite member events (is_direct rides)', async () => {
  await withStore(async (store) => {
    const signer = await testSigner();
    const creator = '@dev:test';
    const res = await createRoom(store, {
      creator,
      invite: ['@bob:test', '@carol:remote.test'],
      is_direct: true,
    }, signer);
    const room = await open(store, res.roomId);
    // the local invitee is invited, is_direct carried
    assertEquals(await stateContent(room, 'm.room.member', '@bob:test'), {
      membership: 'invite',
      is_direct: true,
    });
    // the remote invitee waits for the transport dance (3c) — no event
    assertEquals(
      await stateContent(room, 'm.room.member', '@carol:remote.test'),
      null,
    );
  });
});

Deno.test('createRoom: room_alias_name emits the canonical_alias event before the presets', async () => {
  await withStore(async (store) => {
    const signer = await testSigner();
    const res = await createRoom(store, {
      creator: '@dev:test',
      alias: 'my-room',
      visibility: 'public',
    }, signer);
    assertEquals(res.roomAlias, '#my-room:test');
    const room = await open(store, res.roomId);
    assertEquals(await stateContent(room, 'm.room.canonical_alias'), {
      alias: '#my-room:test',
    });
    // the spec's order (create_room.yaml item 4): alias after power
    // levels, before the preset events — depths create..hv = 1..7
    const line = await timeline(room);
    assertEquals(
      line.map((e) => e.type),
      [
        'm.room.create',
        'm.room.member',
        'm.room.power_levels',
        'm.room.canonical_alias',
        'm.room.join_rules',
        'm.room.history_visibility',
      ],
    );
    assertEquals(line.map((e) => e.depth), [1, 2, 3, 4, 5, 6]);
  });
});

Deno.test('createRoom: creation_content lands minus room_version; version validations', async () => {
  await withStore(async (store) => {
    const signer = await testSigner();
    const res = await createRoom(store, {
      creator: '@dev:test',
      creation_content: { test: 'azerty', room_version: 'test' },
    }, signer);
    const room = await open(store, res.roomId);
    assertEquals(await stateContent(room, 'm.room.create'), {
      test: 'azerty',
      room_version: '11',
    });

    const numeric = await assertRejects(() =>
      createRoom(store, {
        creator: '@dev:test',
        version: 1 as unknown as string,
      }, signer)
    );
    assert(numeric instanceof MatrixError);
    assertEquals(numeric.status, 400);
    assertEquals(numeric.errcode, 'M_BAD_JSON');

    const unknown = await assertRejects(() =>
      createRoom(store, {
        creator: '@dev:test',
        version: 'ahfgwjyerhgiuveisbruvybseyrugvi',
      }, signer)
    );
    assert(
      String(unknown).includes('M_UNSUPPORTED_ROOM_VERSION'),
      String(unknown),
    );
  });
});

Deno.test('createRoom: the v11 genesis sequence passes the rulebook (shape, depths, signatures)', async () => {
  await withStore(async (store) => {
    const signer = await testSigner();
    const res = await createRoom(store, { creator: '@dev:test' }, signer);
    assertMatch(res.createEventId, ID_SHAPE);
    assertMatch(res.memberEventId, ID_SHAPE);
    const room = await open(store, res.roomId);
    const line = await timeline(room);
    // genesis shape: create (no creator, room_version 11), join, PL,
    // join_rules, history_visibility — depths chain 1..5
    assertEquals(
      line.map((e) => e.type),
      [
        'm.room.create',
        'm.room.member',
        'm.room.power_levels',
        'm.room.join_rules',
        'm.room.history_visibility',
      ],
    );
    assertEquals(line.map((e) => e.depth), [1, 2, 3, 4, 5]);
    const create = await stateContent(room, 'm.room.create');
    assertEquals(create, { room_version: '11' });
    assert(!('creator' in create!), 'v11 create has no creator');
    const pl = await stateContent(room, 'm.room.power_levels');
    assertEquals((pl!.users as Record<string, unknown>)['@dev:test'], 100);
    assertEquals(pl!.state_default, 50);
    // every genesis event is signed and id-shaped
    await room.tx(async (tx) => {
      const stay = (await tx.segments.openStay())!;
      for (const p of await tx.segments.positionsPage(stay.id, 0, 'f', 50)) {
        const row = (await tx.events.get(p.event))!;
        const pdu = JSON.parse(row.pdu) as Pdu;
        assertMatch(String(pdu.event_id), ID_SHAPE);
        assert(Object.keys(pdu.signatures).length > 0);
      }
      // the create has no auth events and depth 1
      const createRow = (await tx.events.get(res.createEventId))!;
      const createPdu = JSON.parse(createRow.pdu) as Pdu;
      assertEquals(createPdu.auth_events, []);
      assertEquals(createPdu.depth, 1);
    });
  });
});

Deno.test('createRoom: v10 writes content.creator; v12 omits it and derives the room id from the create', async () => {
  await withStore(async (store) => {
    const signer = await testSigner();
    const creator = '@dev:test';
    // v10: the create carries content.creator (v10.md:114)
    const v10 = await createRoom(store, { creator, version: '10' }, signer);
    const room10 = await open(store, v10.roomId);
    const create10 = (await stateContent(room10, 'm.room.create'))!;
    assertEquals(create10.creator, creator);
    assertEquals(create10.room_version, '10');

    // v12: no creator key (the sender is the creator), and the room id is
    // the create's own event id with ! for $ (v12.md:98-101, 108-109)
    const v12 = await createRoom(store, { creator, version: '12' }, signer);
    assertEquals(v12.roomId, '!' + v12.createEventId.slice(1));
    const room12 = await open(store, v12.roomId);
    const create12 = (await stateContent(room12, 'm.room.create'))!;
    assertEquals('creator' in create12, false);
    assertEquals(create12.room_version, '12');
    // v12 defaults: no users entry for the creator (infinite power) and
    // m.room.tombstone explicitly above state_default (create_room.yaml:39-52)
    const pl12 = (await stateContent(room12, 'm.room.power_levels'))!;
    assertEquals(pl12.users, {});
    assertEquals(
      (pl12.events as Record<string, unknown>)['m.room.tombstone'],
      150,
    );
  });
});

Deno.test('createRoom: v12 additional_creators combine for trusted_private_chat; the override must not name a creator', async () => {
  await withStore(async (store) => {
    const signer = await testSigner();
    const creator = '@dev:test';
    const res = await createRoom(store, {
      creator,
      version: '12',
      preset: 'trusted_private_chat',
      invite: ['@bob:test'],
      creation_content: { additional_creators: ['@carol:test'] },
    }, signer);
    const room = await open(store, res.roomId);
    const create = (await stateContent(room, 'm.room.create'))!;
    // the creation_content list and the invite array, combined, deduplicated
    assertEquals(create.additional_creators, ['@carol:test', '@bob:test']);
    // override users naming a creator -> 400 (rule 10.4)
    const bad = await assertRejects(() =>
      createRoom(store, {
        creator,
        version: '12',
        power_level_content_override: { users: { [creator]: 100 } },
      }, signer)
    );
    assert(bad instanceof MatrixError);
    assertEquals(bad.status, 400);
    assertEquals(bad.errcode, 'M_INVALID_PARAM');
  });
});

Deno.test('createRoom: a knock initial_state join_rule in a v6 room is legal state; the knock member event rejects', async () => {
  await withStore(async (store) => {
    const signer = await testSigner();
    const creator = '@dev:test';
    // the spec's auth rules never validate join_rule VALUES (the schema
    // enum is version-agnostic) — knock in v6 is legal state
    const res = await createRoom(store, {
      creator,
      version: '6',
      initial_state: [
        {
          type: 'm.room.join_rules',
          state_key: '',
          content: { join_rule: 'knock' },
        },
      ],
    }, signer);
    const room = await open(store, res.roomId);
    assertEquals(await stateContent(room, 'm.room.join_rules'), {
      join_rule: 'knock',
    });
    // ...but a knock member event in v6 rejects (v6 has no knock rule —
    // v6 numbering 4.6)
    const knock = await sendLocal(room, {
      type: 'm.room.member',
      sender: creator,
      state_key: '@bob:test',
      content: { membership: 'knock' },
      origin_server_ts: 1000,
    }, signer);
    assertEquals(knock.standing, 'rejected');
    assertEquals(knock.reason, 'state');
    assert(
      knock.rule !== null && knock.rule.includes('4.6'),
      knock.rule ?? '<no rule>',
    );
  });
});
