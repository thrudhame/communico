import { assert, assertEquals } from '@std/assert';
import { theApp } from '#engine/app.ts';
import { admitState } from '#engine/client/state-admission.ts';
import {
  receiveInvite,
  rejectInviteRemote,
} from '#engine/federation/invites.ts';
import {
  fakeKeyResolver,
  makeRemoteServer,
  remoteEvent,
  wireOf,
} from '#tests/fixtures/remote.ts';
import { localpartOf } from '#engine/ids.ts';
import { createRoom } from '#engine/room/create.ts';
import { openRoom } from '#engine/room/index.ts';
import { sendLocal } from '#engine/room/ingest.ts';
import { putAccountData } from '#engine/tenant/accountdata.ts';
import { slidingSyncRequest } from '#engine/sliding-sync/request.ts';
import { captureLists, selectLists } from '#engine/sliding-sync/lists.ts';
import { httpSuite } from '#tests/http-app.ts';

const suite = httpSuite('sliding lists');
type Json = Record<string, unknown>;
const configs = (entries: Json) =>
  Object.fromEntries(
    Object.entries(entries).map((
      [name, value],
    ) => [name, { required_state: [], timeline_limit: 0, ...(value as Json) }]),
  );
const request = (lists: Json = {}, room_subscriptions: Json = {}) =>
  slidingSyncRequest(
    { lists: configs(lists), room_subscriptions: configs(room_subscriptions) },
    new URLSearchParams(),
    30000,
  );
const ids = (result: Awaited<ReturnType<typeof selectLists>>, name = 'a') =>
  result.lists[name].ops.flatMap((op) => op.room_ids);

async function fixture(prefix: string) {
  const app = theApp();
  const user = await suite.registerTestUser(prefix, 'pw');
  const signer = app.tenant.signer();
  const create = async (name: string, extra: Json = {}) => {
    const { roomId } = await createRoom(app.store, {
      creator: user.user_id,
      preset: 'public_chat',
      name,
      ...extra,
    }, signer);
    return roomId;
  };
  const send = async (
    id: string,
    type: string,
    content: Json,
    stateKey?: string,
    sender = user.user_id,
  ) =>
    await sendLocal(await openRoom(app.store, id), {
      type,
      sender,
      content,
      ...(stateKey === undefined ? {} : { state_key: stateKey }),
    }, signer);
  return { app, user, create, send };
}

suite.test('count, inclusive windows, activity cuts and merged configurations use persisted rooms', async () => {
  const { user, create, send } = await fixture('lists-a');
  const a = await create('A'), b = await create('B'), c = await create('C');
  await send(a, 'm.room.message', { body: 'latest' });
  const captured = await captureLists(user.user_id);
  await send(c, 'm.room.message', { body: 'after captured cut' });
  const req = request({
    a: {
      ranges: [[0, 1]],
      required_state: [['m.room.name', '']],
      timeline_limit: 1,
    },
    b: {
      ranges: [[1, 2]],
      required_state: [['m.room.avatar', '']],
      timeline_limit: 7,
    },
    empty: { ranges: [] },
  }, {
    [a]: { required_state: [['m.room.member', '$ME']], timeline_limit: 4 },
  });
  const selected = await selectLists(user.user_id, req, { snapshot: captured });
  assertEquals(selected.lists.a.count, 3);
  assertEquals(ids(selected), [a, c]);
  assertEquals(ids(selected, 'b'), [c, b]);
  assertEquals(ids(selected, 'empty'), []);
  assertEquals(selected.rooms.get(c)?.config, {
    requiredState: [['m.room.name', ''], ['m.room.avatar', '']],
    timelineLimit: 7,
  });
  assertEquals(selected.rooms.get(a)?.config.timelineLimit, 4);
  assertEquals(ids(await selectLists(user.user_id, request({ a: {} }))), [
    c,
    a,
    b,
  ]);
  assertEquals(
    ids(await selectLists(user.user_id, request({ a: { ranges: [[8, 10]] } }))),
    [],
  );
  assertEquals(
    ids(
      await selectLists(
        user.user_id,
        request({ a: { ranges: [[0, 0], [0, 1]] } }),
      ),
    ),
    [c, a],
  );
});

suite.test('DM, tag, type, encryption, name and direct-space filters compose at captured cuts', async () => {
  const { app, user, create, send } = await fixture('lists-f');
  const a = await create('Needle room'), b = await create('Other');
  const space = await create('Space', {
    creation_content: { type: 'm.space' },
  });
  await send(space, 'm.space.child', { via: ['test'] }, a);
  await send(space, 'm.space.child', { via: [] }, b);
  await send(a, 'm.room.encryption', { algorithm: 'm.megolm.v1.aes-sha2' }, '');
  const lp = localpartOf(user.user_id);
  await putAccountData(app.tenant, lp, '', 'm.direct', { '@friend:test': [a] });
  await putAccountData(app.tenant, lp, a, 'm.tag', { tags: { favorite: {} } });
  const captured = await captureLists(user.user_id);
  await putAccountData(app.tenant, lp, '', 'm.direct', {});
  await putAccountData(app.tenant, lp, a, 'm.tag', { tags: {} });
  await send(a, 'm.room.name', { name: 'renamed later' }, '');
  const select = (filters: Json) =>
    selectLists(user.user_id, request({ a: { filters } }), {
      snapshot: captured,
    });
  assertEquals(
    ids(
      await select({
        is_dm: true,
        tags: ['favorite'],
        is_encrypted: true,
        room_types: [null],
        room_name_like: 'NEEDLE',
        spaces: [space],
      }),
    ),
    [a],
  );
  assertEquals(
    ids(await select({ tags: ['favorite'], not_tags: ['favorite'] })),
    [],
  );
  assertEquals(
    ids(await select({ room_types: [null], not_room_types: [null] })),
    [],
  );
  assertEquals(ids(await select({ spaces: [] })), []);
  assertEquals(ids(await select({ room_types: ['m.space'] })), [space]);
  assert(!ids(await select({ is_dm: false })).includes(a));
  assertEquals(ids(await select({ tags: [] })), []);
});

suite.test('membership admission excludes outsiders, forgotten, never-joined bans and old self leaves', async () => {
  const { app, user, create, send } = await fixture('lists-m');
  const other = await suite.registerTestUser('lists-other', 'pw');
  const joined = await create('joined');
  const left = await create('left');
  const cut = (await captureLists(user.user_id)).eventCut;
  await send(left, 'm.room.member', { membership: 'leave' }, user.user_id);
  const invited = await create('invited');
  await send(invited, 'm.room.member', { membership: 'invite' }, other.user_id);
  const banned = await create('never joined');
  await send(banned, 'm.room.member', { membership: 'ban' }, other.user_id);
  const kicked = await create('kicked');
  await send(
    kicked,
    'm.room.member',
    { membership: 'join' },
    other.user_id,
    other.user_id,
  );
  await send(kicked, 'm.room.member', { membership: 'leave' }, other.user_id);
  const first = await selectLists(user.user_id, request({ a: {} }));
  assert(!ids(first).includes(left));
  assert(
    ids(await selectLists(user.user_id, request({ a: {} }), { since: cut }))
      .includes(left),
  );
  const theirs = await selectLists(other.user_id, request({ a: {} }), {});
  assertEquals(new Set(ids(theirs)), new Set([invited, kicked]));
  assertEquals(
    ids(
      await selectLists(
        other.user_id,
        request({ a: { filters: { is_invite: true } } }),
      ),
    ),
    [invited],
  );
  const subscription = await selectLists(
    other.user_id,
    request({}, { [joined]: {}, '!unknown:test': {} }),
  );
  assertEquals(subscription.rooms.size, 0);
  await app.server.execute('INSERT INTO forgotten(user,room) VALUES (?,?)', [
    other.user_id,
    kicked,
  ]);
  assert(
    !ids(await selectLists(other.user_id, request({ a: {} }))).includes(kicked),
  );
  const former = await create('former joined');
  await send(
    former,
    'm.room.member',
    { membership: 'join' },
    other.user_id,
    other.user_id,
  );
  await send(
    former,
    'm.room.member',
    { membership: 'leave' },
    other.user_id,
    other.user_id,
  );
  await send(former, 'm.room.member', { membership: 'ban' }, other.user_id);
  assert(
    ids(await selectLists(other.user_id, request({ a: {} }))).includes(former),
  );
});

suite.test('declining an unjoined invitation cannot disclose private metadata through list filters', async () => {
  const { create, send } = await fixture('lists-decline');
  const other = await suite.registerTestUser('lists-decline-other', 'pw');
  const room = await create('PRIVATE-LIST-NAME', { preset: 'private_chat' });
  await send(room, 'm.room.member', { membership: 'invite' }, other.user_id);
  assertEquals(
    ids(
      await selectLists(
        other.user_id,
        request({ a: { filters: { room_name_like: 'PRIVATE-LIST-NAME' } } }),
      ),
    ),
    [room],
    'a current invite retains its stripped display metadata',
  );
  const before = (await captureLists(other.user_id)).eventCut;
  await send(
    room,
    'm.room.member',
    { membership: 'leave' },
    other.user_id,
    other.user_id,
  );
  const selected = await selectLists(
    other.user_id,
    request({ a: { filters: { room_name_like: 'PRIVATE-LIST-NAME' } } }),
    { since: before },
  );
  assertEquals(
    ids(selected),
    [],
    'a visible own departure is not permission for private room metadata',
  );
  assertEquals(selected.lists.a.count, 0);
});

suite.test('former-member metadata stops at the real departure rather than a later ban', async () => {
  const { create, send } = await fixture('lists-departure');
  const other = await suite.registerTestUser('lists-departure-other', 'pw');
  const room = await create('ADMITTED-LIST-NAME');
  await send(
    room,
    'm.room.member',
    { membership: 'join' },
    other.user_id,
    other.user_id,
  );
  await send(
    room,
    'm.room.member',
    { membership: 'leave' },
    other.user_id,
    other.user_id,
  );
  await send(room, 'm.room.name', { name: 'PRIVATE-LATER-NAME' }, '');
  await send(room, 'm.room.member', { membership: 'ban' }, other.user_id);
  const selected = (name: string) =>
    selectLists(
      other.user_id,
      request({ a: { filters: { room_name_like: name } } }),
    );
  assertEquals(ids(await selected('ADMITTED-LIST-NAME')), [room]);
  assertEquals(ids(await selected('PRIVATE-LATER-NAME')), []);
});

suite.test('admission projects exact and wildcard state keys before PDU hydration', async () => {
  const { app, user, create, send } = await fixture('lists-project');
  const id = await create('Projected');
  await send(id, 'org.test.private', { secret: 'not requested' }, 'one');
  await send(id, 'org.test.private', { secret: 'not requested either' }, 'two');
  const room = await openRoom(app.store, id);
  const original = room.tx.bind(room);
  let maps = 0;
  const loaded: string[] = [];
  room.tx = (fn) =>
    original((tx) => {
      const map = tx.state.groupMap;
      tx.state.groupMap = (...args) => {
        maps++;
        return map(...args);
      };
      const get = tx.events.get;
      tx.events.get = async (...args) => {
        const row = await get(...args);
        if (row !== null) loaded.push(row.type);
        return row;
      };
      return fn(tx);
    });
  try {
    const exact = await admitState(room, {
      userId: user.user_id,
      keys: [['m.room.name', '']],
    });
    assertEquals(exact.rows.map((row) => row.content), [{ name: 'Projected' }]);
    assertEquals(maps, 0, 'exact projection must not load the full group map');
    assert(!loaded.includes('org.test.private'));
    loaded.length = 0;
    const wildcard = await admitState(room, {
      userId: user.user_id,
      keys: [['m.room.name', '*']],
    });
    assertEquals(wildcard.rows, exact.rows);
    assert(!loaded.includes('org.test.private'));
    assertEquals(
      (await admitState(room, { userId: user.user_id, keys: [] })).rows,
      [],
    );
  } finally {
    room.tx = original;
  }
});

suite.test('encryption-only connection does not open rooms or hydrate state/timelines', async () => {
  const { app, user, create } = await fixture('lists-empty');
  await create('not selected');
  const original = app.store.room.bind(app.store);
  let opens = 0;
  app.store.room = (...args) => {
    opens++;
    return original(...args);
  };
  try {
    const selected = await selectLists(
      user.user_id,
      slidingSyncRequest(
        { conn_id: 'encryption', extensions: { e2ee: { enabled: true } } },
        new URLSearchParams(),
        30000,
      ),
    );
    assertEquals(selected.rooms.size, 0);
    assertEquals(selected.lists, {});
    assertEquals(opens, 0);
  } finally {
    app.store.room = original;
  }
});

suite.test('historical self-left subscriptions are independent from list eligibility', async () => {
  const { user, create, send } = await fixture('lists-sub-left');
  const room = await create('Left subscription');
  await send(room, 'm.room.member', { membership: 'leave' }, user.user_id);
  const selected = await selectLists(
    user.user_id,
    request({ a: {} }, { [room]: {} }),
  );
  assertEquals(ids(selected), [], 'old self-leaves stay out of list windows');
  assertEquals(selected.rooms.get(room)?.candidate.membership, 'leave');
  assertEquals(selected.listRooms.get('a'), new Set());
});

suite.test('held invite and knock filters use stripped display even in joined-only rooms', async () => {
  const { create, send } = await fixture('lists-prejoin-display');
  const other = await suite.registerTestUser(
    'lists-prejoin-display-other',
    'pw',
  );
  for (const membership of ['invite', 'knock']) {
    const room = await create('STRIPPED DISPLAY ' + membership, {
      preset: 'private_chat',
    });
    await send(room, 'm.room.history_visibility', {
      history_visibility: 'joined',
    }, '');
    if (membership === 'knock') {
      await send(room, 'm.room.join_rules', { join_rule: 'knock' }, '');
    }
    await send(
      room,
      'm.room.member',
      { membership },
      other.user_id,
      membership === 'knock' ? other.user_id : undefined,
    );
    const selected = await selectLists(
      other.user_id,
      request({
        a: { filters: { room_name_like: 'STRIPPED DISPLAY ' + membership } },
      }),
    );
    assertEquals(ids(selected), [room], membership);
  }
});

suite.test('redacted encryption state still classifies a room as encrypted', async () => {
  const { user, create, send } = await fixture('lists-redacted-encryption');
  const room = await create('Encrypted');
  const encryption = await send(room, 'm.room.encryption', {
    algorithm: 'm.megolm.v1.aes-sha2',
  }, '');
  assertEquals(encryption.standing, 'accepted');
  const redaction = await send(room, 'm.room.redaction', {
    redacts: encryption.eventId,
  });
  assertEquals(redaction.standing, 'accepted');
  assertEquals(
    ids(
      await selectLists(
        user.user_id,
        request({ a: { filters: { is_encrypted: true } } }),
      ),
    ),
    [room],
  );
  assertEquals(
    ids(
      await selectLists(
        user.user_id,
        request({ a: { filters: { is_encrypted: false } } }),
      ),
    ),
    [],
  );
});

suite.test('OOB invitations filter saved hints without provisioning rooms; ignored and rejected invitations disappear', async () => {
  const { app, user } = await fixture('lists-oob');
  const remote = await makeRemoteServer('remote.test');
  const deps = {
    store: app.store,
    server: app.server,
    signer: app.tenant.signer(),
    keys: fakeKeyResolver(remote),
    self: 'localhost',
    wake: () => {},
  };
  const roomId = '!lists-oob:remote.test';
  const event = await remoteEvent(roomId, remote, '11', {
    type: 'm.room.member',
    sender: '@zoe:remote.test',
    state_key: user.user_id,
    content: { membership: 'invite' },
    prev_events: [],
    auth_events: [],
  });
  await receiveInvite(
    roomId,
    event.event_id!,
    {
      room_version: '11',
      event: wireOf(event),
      invite_room_state: [{
        type: 'm.room.name',
        state_key: '',
        sender: event.sender,
        content: { name: 'Saved invite' },
      }],
    },
    remote.name,
    deps,
  );
  const select = () =>
    selectLists(
      user.user_id,
      request({ a: { filters: { is_invite: true, room_name_like: 'saved' } } }),
    );
  assertEquals(ids(await select()), [roomId]);
  assertEquals(
    await app.server.query('SELECT room_id FROM rooms WHERE room_id=?', [
      roomId,
    ]),
    [],
  );
  await putAccountData(
    app.tenant,
    localpartOf(user.user_id),
    '',
    'm.ignored_user_list',
    { ignored_users: { [event.sender]: {} } },
  );
  assertEquals(ids(await select()), []);
  await putAccountData(
    app.tenant,
    localpartOf(user.user_id),
    '',
    'm.ignored_user_list',
    {},
  );
  await rejectInviteRemote(roomId, user.user_id, deps);
  assertEquals(ids(await select()), []);
});

suite.test('ordinary list windows do not hydrate joined rooms and arbitrary list keys remain own data', async () => {
  const { app, user, create } = await fixture('lists-bounded');
  await create('A');
  await create('B');
  await create('C');
  const original = app.store.room.bind(app.store);
  let opens = 0;
  app.store.room = (...args) => {
    opens++;
    return original(...args);
  };
  try {
    const selected = await selectLists(
      user.user_id,
      request(Object.fromEntries([
        ['__proto__', { ranges: [[0, 0]] }],
        ['constructor', { ranges: [] }],
      ])),
    );
    assertEquals(opens, 0);
    assertEquals(Object.hasOwn(selected.lists, '__proto__'), true);
    assertEquals(selected.lists['__proto__'].count, 3);
    assertEquals(selected.rooms.size, 1);
  } finally {
    app.store.room = original;
  }
});
