import { assert, assertEquals } from '@std/assert';
import { theApp } from '#engine/app.ts';
import { stateAtSeq } from '#engine/client/read.ts';
import { messages } from '#engine/client/timeline.ts';
import { localpartOf } from '#engine/ids.ts';
import { createRoom } from '#engine/room/create.ts';
import { openRoom } from '#engine/room/index.ts';
import { sendLocal } from '#engine/room/ingest.ts';
import { join } from '#engine/room/membership.ts';
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
import { PL_DEFAULTS } from '#tests/fixtures/genesis.ts';
import { putAccountData } from '#engine/tenant/accountdata.ts';
import { captureLists, selectLists } from '#engine/sliding-sync/lists.ts';
import { slidingSyncRequest } from '#engine/sliding-sync/request.ts';
import { roomPayloads, type SentRoom } from '#engine/sliding-sync/rooms.ts';
import { httpSuite } from '#tests/http-app.ts';

const suite = httpSuite('sliding room payloads');
type Json = Record<string, unknown>;
const events = (value: unknown) => (value ?? []) as Json[];
const ids = (value: unknown) => events(value).map((e) => e.event_id);
const content = (event: Json) => event.content as Json;
async function fixture(prefix: string) {
  const app = theApp();
  const alice = await suite.registerTestUser(prefix + '-a', 'pw');
  const bob = await suite.registerTestUser(prefix + '-b', 'pw');
  const signer = app.tenant.signer();
  const { roomId } = await createRoom(app.store, {
    creator: alice.user_id,
    preset: 'public_chat',
    name: 'Original',
  }, signer);
  const room = await openRoom(app.store, roomId);
  const send = async (
    type: string,
    body: Json,
    key?: string,
    sender = alice.user_id,
  ) => {
    const result = await sendLocal(room, {
      type,
      sender,
      content: body,
      ...(key === undefined ? {} : { state_key: key }),
    }, signer);
    assertEquals(result.standing, 'accepted', result.reason ?? undefined);
    return result.eventId;
  };
  const viewer = {
    userId: alice.user_id,
    deviceId: alice.device_id,
    tenant: app.tenant,
  };
  const sync = async (options: {
    required?: [string, string][];
    limit?: number;
    since?: number;
    previous?: Record<string, SentRoom>;
    snapshot?: Awaited<ReturnType<typeof captureLists>>;
    selected?: boolean;
  } = {}) => {
    const snapshot = options.snapshot ?? await captureLists(alice.user_id);
    const req = slidingSyncRequest(
      {
        room_subscriptions: options.selected === false ? {} : {
          [roomId]: {
            required_state: options.required ?? [],
            timeline_limit: options.limit ?? 2,
          },
        },
      },
      new URLSearchParams(),
      30000,
    );
    const selection = await selectLists(alice.user_id, req, {
      snapshot,
      since: options.since,
      previousRooms: new Set(Object.keys(options.previous ?? {})),
    });
    const result = await roomPayloads(viewer, selection, {
      eventCut: snapshot.eventCut,
      requestSince: options.since ?? null,
      direct: snapshot.direct,
      previous: options.previous ?? {},
    });
    return {
      ...result,
      cut: snapshot.eventCut,
      entry: result.rooms[roomId] ?? {},
    };
  };
  return { app, alice, bob, roomId, room, send, sync };
}

suite.test('initial windows use captured state and real pagination; expansions reload history without inventing live events', async () => {
  const { alice, roomId, send, sync } = await fixture('payload-cut');
  await send('m.room.message', { body: 'one' });
  const second = await send('m.room.message', { body: 'two' });
  const third = await send('m.room.message', { body: 'three' });
  const snapshot = await captureLists(alice.user_id);
  await send('m.room.name', { name: 'Future name' }, '');
  const first = await sync({ snapshot, required: [['m.room.name', '']] });
  assertEquals(first.entry.initial, true);
  assertEquals(first.entry.name, 'Original');
  assertEquals(first.entry.num_live, 0);
  assertEquals(first.entry.limited, true);
  assertEquals(ids(first.entry.timeline), [second, third]);
  assertEquals(content(events(first.entry.required_state)[0]).name, 'Original');
  const page = await messages({
    roomId,
    userId: alice.user_id,
    deviceId: alice.device_id,
    leaveAt: null,
    dir: 'b',
    fromToken: String(first.entry.prev_batch),
    toToken: null,
    limit: 1,
    lazyLoadMembers: false,
    localOnly: true,
  });
  assertEquals(content(page.chunk[0]).body, 'one');
  const expanded = await sync({
    previous: first.sent,
    since: first.cut,
    limit: 4,
  });
  assertEquals(expanded.entry.initial, undefined);
  assertEquals(expanded.entry.unstable_expanded_timeline, true);
  assertEquals(events(expanded.entry.timeline).length, 4);
  assertEquals(expanded.entry.num_live, 1);
  assertEquals(expanded.entry.name, 'Future name');
});

suite.test('out-of-window room cuts survive JSON positions; request cut alone never skips missed room events', async () => {
  const { send, sync } = await fixture('payload-window');
  const first = await sync({ limit: 20 });
  const missed = await send('m.room.message', { body: 'while outside' });
  const outside = await sync({
    previous: first.sent,
    since: first.cut,
    selected: false,
  });
  assertEquals(outside.rooms, {});
  const live = await send('m.room.message', { body: 'after outside' });
  const returned = await sync({
    previous: JSON.parse(JSON.stringify(outside.sent)),
    since: outside.cut,
    limit: 20,
  });
  assertEquals(returned.entry.initial, undefined);
  assertEquals(ids(returned.entry.timeline), [missed, live]);
  assertEquals(returned.entry.num_live, 1);
  assertEquals(returned.entry.limited, false);
});

suite.test('required-state growth, wildcards and ME select end publications even with a zero timeline', async () => {
  const { alice, send, sync } = await fixture('payload-state');
  const topic = await send('m.room.topic', { topic: 'old topic' }, '');
  const custom = await send(
    'org.example.state',
    { value: 'mine' },
    alice.user_id,
  );
  const initial = await sync({ limit: 0 });
  assertEquals(initial.entry.timeline, undefined);
  const grown = await sync({
    previous: initial.sent,
    since: initial.cut,
    limit: 0,
    required: [['m.room.topic', ''], ['org.example.state', '$ME']],
  });
  assertEquals(
    new Set(ids(grown.entry.required_state)),
    new Set([topic, custom]),
  );
  const unchanged = await sync({
    previous: grown.sent,
    since: grown.cut,
    limit: 0,
    required: [['m.room.topic', ''], ['org.example.state', '$ME']],
  });
  assertEquals(events(unchanged.entry.required_state), []);
  const updated = await send('m.room.topic', { topic: 'new topic' }, '');
  await send('m.room.message', { body: 'last event is not state' });
  const delta = await sync({
    previous: grown.sent,
    since: grown.cut,
    limit: 0,
    required: [['m.room.topic', '']],
  });
  assertEquals(ids(delta.entry.required_state), [updated]);
  const all = await sync({
    required: [['*', '*'], ['m.room.member', '$ME']],
    limit: 0,
  });
  assert(ids(all.entry.required_state).includes(custom));
  assert(ids(all.entry.required_state).includes(updated));
  const wildcardType = await sync({ required: [['*', '$ME']], limit: 0 });
  // Synapse deliberately returns the all-state superset for wildcard types.
  assert(ids(wildcardType.entry.required_state).includes(updated));
});

suite.test('lazy state covers senders and member targets, suppresses unchanged members and sends nonlimited membership deltas', async () => {
  const { alice, bob, send, sync } = await fixture('payload-lazy');
  const joined = await send(
    'm.room.member',
    { membership: 'join', displayname: 'Bob' },
    bob.user_id,
    bob.user_id,
  );
  await send('m.room.message', { body: 'bob says hi' }, undefined, bob.user_id);
  const first = await sync({
    required: [['m.room.member', '$LAZY']],
    limit: 1,
  });
  assertEquals(ids(first.entry.required_state), [joined]);
  await send('m.room.message', { body: 'again' }, undefined, bob.user_id);
  const next = await sync({
    previous: first.sent,
    since: first.cut,
    required: [['m.room.member', '$LAZY']],
    limit: 1,
  });
  assertEquals(events(next.entry.required_state), []);
  const invited = await suite.registerTestUser('payload-target', 'pw');
  const invite = await send(
    'm.room.member',
    { membership: 'invite' },
    invited.user_id,
  );
  const target = await sync({
    previous: next.sent,
    since: next.cut,
    required: [['m.room.member', '$LAZY']],
    limit: 1,
  });
  assert(ids(target.entry.required_state).includes(invite));
  assert(
    events(target.entry.required_state).some((e) =>
      e.state_key === alice.user_id
    ),
  );
  const renamed = await send(
    'm.room.member',
    { membership: 'join', displayname: 'Robert' },
    bob.user_id,
    bob.user_id,
  );
  const delta = await sync({
    previous: target.sent,
    since: target.cut,
    required: [['m.room.member', '$LAZY']],
    limit: 20,
  });
  assert(ids(delta.entry.required_state).includes(renamed));
});

suite.test('metadata resets, counts and DM removal are explicit and viewer-rendered at the cut', async () => {
  const { app, alice, bob, roomId, send, sync } = await fixture('payload-meta');
  await send('m.room.avatar', { url: 'mxc://test/avatar' }, '');
  await send(
    'm.room.member',
    { membership: 'join', displayname: 'Bob' },
    bob.user_id,
    bob.user_id,
  );
  await putAccountData(app.tenant, localpartOf(alice.user_id), '', 'm.direct', {
    [bob.user_id]: [roomId],
  });
  const first = await sync();
  assertEquals(first.entry.joined_count, 2);
  assertEquals(first.entry.invited_count, 0);
  assertEquals(first.entry.is_dm, true);
  assertEquals(first.entry.avatar, 'mxc://test/avatar');
  await send('m.room.name', {}, '');
  await send('m.room.avatar', {}, '');
  await putAccountData(
    app.tenant,
    localpartOf(alice.user_id),
    '',
    'm.direct',
    {},
  );
  const reset = await sync({ previous: first.sent, since: first.cut });
  assertEquals(reset.entry.name, '');
  assertEquals(reset.entry.avatar, '');
  assertEquals(reset.entry.is_dm, false);
  assertEquals(reset.entry.heroes, [{
    user_id: bob.user_id,
    displayname: 'Bob',
  }]);
  await send('m.room.member', { membership: 'leave' }, bob.user_id);
  const left = await sync({ previous: reset.sent, since: reset.cut });
  assertEquals(left.entry.joined_count, 1);
  assertEquals(left.entry.heroes, [{ user_id: bob.user_id }]);
});

suite.test('rejoin reloads history and state but profile-only changes do not; departures never read later state', async () => {
  const { alice, bob, room, roomId, send, sync } = await fixture(
    'payload-rejoin',
  );
  await send('m.room.member', { membership: 'join' }, bob.user_id, bob.user_id);
  const cut = await captureLists(alice.user_id);
  const power =
    (await stateAtSeq(room, cut.eventCut)).find((r) =>
      r.type === 'm.room.power_levels'
    )!.content;
  await send('m.room.power_levels', {
    ...power,
    users: { ...(power.users as Json), [bob.user_id]: 100 },
  }, '');
  const first = await sync({ required: [['m.room.name', '']] });
  await send(
    'm.room.member',
    { membership: 'join', displayname: 'Alice 2' },
    alice.user_id,
  );
  const profile = await sync({ previous: first.sent, since: first.cut });
  assertEquals(profile.entry.initial, undefined);
  await send('m.room.member', { membership: 'leave' }, alice.user_id);
  const leftSnapshot = await captureLists(alice.user_id);
  await send('m.room.name', { name: 'After departure' }, '', bob.user_id);
  const departure = await sync({
    previous: profile.sent,
    since: profile.cut,
    snapshot: leftSnapshot,
    required: [['m.room.name', '']],
  });
  assertEquals(departure.entry.name, undefined);
  assert(
    !events(departure.entry.required_state).some((e) =>
      content(e).name === 'After departure'
    ),
  );
  await send(
    'm.room.member',
    { membership: 'join' },
    alice.user_id,
    alice.user_id,
  );
  await send(
    'm.room.member',
    { membership: 'join', displayname: 'Alice 3' },
    alice.user_id,
  );
  const rejoined = await sync({
    previous: profile.sent,
    since: departure.cut,
    required: [['m.room.name', '']],
    limit: 20,
  });
  assertEquals(rejoined.entry.initial, true);
  assertEquals(rejoined.entry.name, 'After departure');
  assert(
    events(rejoined.entry.required_state).some((e) => e.type === 'm.room.name'),
  );
  assertEquals(rejoined.sent[roomId].cut, rejoined.cut);
});

suite.test('held invitations use only stripped prejoin display, never private state or timeline', async () => {
  const { app, alice, bob, roomId, send } = await fixture('payload-invite');
  await send('org.example.private', { secret: 'not for invitees' }, '');
  await send('m.room.member', { membership: 'invite' }, bob.user_id);
  const snapshot = await captureLists(bob.user_id);
  await send('m.room.name', { name: 'after invite' }, '');
  const req = slidingSyncRequest(
    {
      room_subscriptions: {
        [roomId]: { required_state: [['*', '*']], timeline_limit: 100 },
      },
    },
    new URLSearchParams(),
    30000,
  );
  const selection = await selectLists(bob.user_id, req, { snapshot });
  const result = await roomPayloads(
    { userId: bob.user_id, deviceId: bob.device_id, tenant: app.tenant },
    selection,
    {
      eventCut: snapshot.eventCut,
      requestSince: null,
      direct: snapshot.direct,
      previous: {},
    },
  );
  const entry = result.rooms[roomId];
  assertEquals(entry.initial, true);
  for (
    const field of [
      'required_state',
      'timeline',
      'joined_count',
      'heroes',
      'name',
    ]
  ) assertEquals(entry[field], undefined);
  assert(
    events(entry.invite_state).some((e) =>
      e.type === 'm.room.member' && e.state_key === bob.user_id
    ),
  );
  assert(
    events(entry.invite_state).some((e) =>
      e.type === 'm.room.name' && content(e).name === 'Original'
    ),
  );
  assert(!JSON.stringify(entry).includes('not for invitees'));
  assert(!JSON.stringify(entry).includes('after invite'));
  assert(!JSON.stringify(entry).includes(alice.access_token!));
});

suite.test('OOB invites and durable departures use their saved owner without provisioning a room', async () => {
  const app = theApp();
  const alice = await suite.registerTestUser('payload-oob', 'pw');
  const remote = await makeRemoteServer('remote.test');
  const deps = {
    store: app.store,
    server: app.server,
    signer: app.tenant.signer(),
    keys: fakeKeyResolver(remote),
    self: 'localhost',
    wake: () => {},
  };
  const roomId = '!payload-oob:remote.test';
  const event = await remoteEvent(roomId, remote, '11', {
    type: 'm.room.member',
    sender: '@zoe:remote.test',
    state_key: alice.user_id,
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
        content: { name: 'Saved display' },
      }],
    },
    remote.name,
    deps,
  );
  const req = slidingSyncRequest(
    {
      room_subscriptions: {
        [roomId]: { required_state: [['*', '*']], timeline_limit: 10 },
      },
    },
    new URLSearchParams(),
    30000,
  );
  const viewer = {
    userId: alice.user_id,
    deviceId: alice.device_id,
    tenant: app.tenant,
  };
  const snapshot = await captureLists(alice.user_id);
  const first = await roomPayloads(
    viewer,
    await selectLists(alice.user_id, req, { snapshot }),
    {
      eventCut: snapshot.eventCut,
      requestSince: null,
      direct: snapshot.direct,
      previous: {},
    },
  );
  assert(
    events(first.rooms[roomId].invite_state).some((e) =>
      content(e).name === 'Saved display'
    ),
  );
  await rejectInviteRemote(roomId, alice.user_id, deps);
  const nextSnapshot = await captureLists(alice.user_id);
  const next = await roomPayloads(
    viewer,
    await selectLists(alice.user_id, req, {
      snapshot: nextSnapshot,
      since: snapshot.eventCut,
      previousRooms: new Set([roomId]),
    }),
    {
      eventCut: nextSnapshot.eventCut,
      requestSince: snapshot.eventCut,
      direct: nextSnapshot.direct,
      previous: first.sent,
    },
  );
  const left = events(next.rooms[roomId].required_state);
  assertEquals(left.length, 1);
  assertEquals(left[0].state_key, alice.user_id);
  assertEquals(content(left[0]).membership, 'leave');
  assertEquals(typeof left[0].event_id, 'string');
  assertEquals(next.rooms[roomId].invite_state, undefined);
  assertEquals(
    await app.server.query('SELECT room_id FROM rooms WHERE room_id=?', [
      roomId,
    ]),
    [],
  );
});

suite.test('required-state delta follows a fork-resolved publication rather than the final event DAG', async () => {
  const app = theApp();
  const alice = await suite.registerTestUser('payload-fork', 'pw');
  const bob = '@payload-fork-bob:localhost',
    eve = '@payload-fork-eve:localhost';
  const signer = app.tenant.signer();
  const { roomId } = await createRoom(app.store, {
    creator: alice.user_id,
    invite: [bob, eve],
  }, signer);
  const room = await openRoom(app.store, roomId);
  const bobJoin = await join(room, bob, signer),
    eveJoin = await join(room, eve, signer);
  const promote = await sendLocal(room, {
    type: 'm.room.power_levels',
    state_key: '',
    sender: alice.user_id,
    content: {
      ...PL_DEFAULTS(alice.user_id),
      users: { [alice.user_id]: 100, [eve]: 50 },
    },
    prev_events: [eveJoin.eventId],
    origin_server_ts: 400,
  }, signer);
  await sendLocal(room, {
    type: 'm.room.member',
    state_key: bob,
    sender: eve,
    content: { membership: 'ban' },
    prev_events: [promote.eventId],
    origin_server_ts: 500,
  }, signer);
  const request = slidingSyncRequest(
    {
      room_subscriptions: {
        [roomId]: {
          required_state: [['m.room.member', '*']],
          timeline_limit: 0,
        },
      },
    },
    new URLSearchParams(),
    30000,
  );
  const viewer = {
    userId: alice.user_id,
    deviceId: alice.device_id,
    tenant: app.tenant,
  };
  const before = await captureLists(alice.user_id);
  const first = await roomPayloads(
    viewer,
    await selectLists(alice.user_id, request, { snapshot: before }),
    {
      eventCut: before.eventCut,
      requestSince: null,
      direct: before.direct,
      previous: {},
    },
  );
  await sendLocal(room, {
    type: 'm.room.power_levels',
    state_key: '',
    sender: alice.user_id,
    content: PL_DEFAULTS(alice.user_id),
    prev_events: [eveJoin.eventId],
    origin_server_ts: 600,
  }, signer);
  const after = await captureLists(alice.user_id);
  const second = await roomPayloads(
    viewer,
    await selectLists(alice.user_id, request, { snapshot: after }),
    {
      eventCut: after.eventCut,
      requestSince: before.eventCut,
      direct: after.direct,
      previous: first.sent,
    },
  );
  assert(ids(second.rooms[roomId].required_state).includes(bobJoin.eventId));
  assertEquals(second.rooms[roomId].timeline, undefined);
});

suite.test('declining a held invitation never grants private full-state access in either sync protocol', async () => {
  const { app, bob, roomId, send } = await fixture('payload-decline');
  await send('org.example.private', { secret: 'private before decline' }, '');
  await send('m.room.member', { membership: 'invite' }, bob.user_id);
  const snapshot = await captureLists(bob.user_id);
  await send(
    'm.room.member',
    { membership: 'leave' },
    bob.user_id,
    bob.user_id,
  );
  const req = slidingSyncRequest(
    {
      room_subscriptions: {
        [roomId]: { required_state: [['*', '*']], timeline_limit: 10 },
      },
    },
    new URLSearchParams(),
    30000,
  );
  const after = await captureLists(bob.user_id);
  const selected = await selectLists(bob.user_id, req, {
    snapshot: after,
    since: snapshot.eventCut,
  });
  const result = await roomPayloads(
    { userId: bob.user_id, deviceId: bob.device_id, tenant: app.tenant },
    selected,
    {
      eventCut: after.eventCut,
      requestSince: snapshot.eventCut,
      direct: after.direct,
      previous: {},
    },
  );
  for (const stateAfter of [false, true]) {
    const response = await suite.matrix(
      new Request(
        'http://x/_matrix/client/v3/sync?since=s' + snapshot.eventCut +
          '&use_state_after=' + stateAfter + '&full_state=true',
        { headers: { Authorization: 'Bearer ' + bob.access_token } },
      ),
    );
    assertEquals(response.status, 200);
    const body = await response.json() as Json;
    const entry = ((body.rooms as Json).leave as Json)[roomId];
    assert(
      !JSON.stringify(entry).includes('private before decline'),
      'ordinary full state must remain membership-only',
    );
  }
  assert(
    !JSON.stringify(result.rooms).includes('private before decline'),
    'sliding state must remain membership-only',
  );
  const entry = result.rooms[roomId];
  for (
    const field of ['name', 'avatar', 'heroes', 'joined_count', 'invited_count']
  ) {
    assertEquals(
      entry[field],
      undefined,
      'decline cannot disclose room metadata',
    );
  }
  assert(
    events(entry.required_state).every((event) =>
      event.type === 'm.room.member' && event.state_key === bob.user_id
    ),
  );
});

suite.test('later bans do not move a former member payload beyond the actual departure', async () => {
  const { alice, bob, room, roomId, send, sync } = await fixture(
    'payload-ban-cut',
  );
  await send('m.room.member', { membership: 'join' }, bob.user_id, bob.user_id);
  const power =
    (await stateAtSeq(room, (await captureLists(alice.user_id)).eventCut))
      .find((row) => row.type === 'm.room.power_levels')!.content;
  await send('m.room.power_levels', {
    ...power,
    users: {
      ...(power.users as Json),
      [alice.user_id]: 50,
      [bob.user_id]: 100,
    },
  }, '');
  const first = await sync({ required: [['*', '*']], limit: 100 });
  await send('m.room.member', { membership: 'leave' }, alice.user_id);
  const departure = await captureLists(alice.user_id);
  await send(
    'm.room.name',
    { name: 'PRIVATE AFTER DEPARTURE' },
    '',
    bob.user_id,
  );
  await send(
    'org.example.private',
    { secret: 'PRIVATE NEW STATE' },
    '',
    bob.user_id,
  );
  await send(
    'm.room.member',
    { membership: 'ban' },
    alice.user_id,
    bob.user_id,
  );
  const result = await sync({
    previous: first.sent,
    since: first.cut,
    required: [['*', '*']],
    limit: 100,
  });
  assert(!JSON.stringify(result.rooms).includes('PRIVATE AFTER DEPARTURE'));
  assert(!JSON.stringify(result.rooms).includes('PRIVATE NEW STATE'));
  assertEquals(result.sent[roomId].cut, departure.eventCut);
  assert(
    events(result.entry.required_state).some((event) =>
      event.type === 'm.room.member' && event.state_key === alice.user_id &&
      content(event).membership === 'ban'
    ),
  );
});
