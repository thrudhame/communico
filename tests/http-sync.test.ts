// Observable sync contracts from doltgres:sync.test.ts. Room setup uses
// the landed core while the parallel rooms endpoint stream is in flight.
import { assert, assertEquals } from '@std/assert';
import { theApp } from '#engine/app.ts';
import { createRoom } from '#engine/room/create.ts';
import { openRoom } from '#engine/room/index.ts';
import { sendLocal } from '#engine/room/ingest.ts';
import { join, leave } from '#engine/room/membership.ts';
import { putAccountData } from '#engine/tenant/accountdata.ts';
import { recordTransaction } from '#engine/tenant/txns.ts';
import { revokeToken } from '#engine/tenant/auth.ts';
import { httpSuite } from '#tests/http-app.ts';
import {
  acceptRescind,
  receiveInvite,
  rejectInviteRemote,
} from '#engine/federation/invites.ts';
import {
  fakeFetcher,
  fakeKeyResolver,
  makeRemoteServer,
  remoteEvent,
  wireOf,
} from '#tests/fixtures/remote.ts';
import { fakeMessage, makeFakeRoom } from '#tests/fixtures/remote-room.ts';
import { testRemoteServer, testSigner } from '#tests/fixtures/signer.ts';
import { joinRemote } from '#engine/room/join.ts';
import { backfill } from '#engine/room/history.ts';
import { PL_DEFAULTS } from '#tests/fixtures/genesis.ts';
import { storeFilter } from '#engine/tenant/filters.ts';

type Json = Record<string, unknown>;
const suite = httpSuite('HTTP sync');
const sync = async (token: string, query = '') => {
  const response = await suite.matrix(
    new Request('http://x/_matrix/client/v3/sync?timeout=0' + query, {
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
  assertEquals(response.status, 200, await response.clone().text());
  return await response.json() as Json;
};
const roomSection = (body: Json, section: string, roomId: string) =>
  ((body.rooms as Json)[section] as Json)[roomId] as Json | undefined;

suite.test('initial, incremental and full_state; global tokens; account data; revoked sync token', async () => {
  const app = theApp();
  const alice = await suite.registerTestUser('sy-a', 'pw-sy-a');
  const bob = await suite.registerTestUser('sy-b', 'pw-sy-b');
  const signer = app.tenant.signer();
  const { roomId } = await createRoom(app.store, {
    creator: alice.user_id,
    preset: 'public_chat',
  }, signer);
  const room = await openRoom(app.store, roomId);
  const initial = await sync(alice.access_token!);
  const tl = roomSection(initial, 'join', roomId)!.timeline as Json;
  assertEquals(tl.limited, false);
  assertEquals(
    tl.prev_batch,
    initial.next_batch,
    'untrimmed prev_batch is window end',
  );
  assert((tl.events as Json[]).every((e) => !('room_id' in e)));
  assertEquals(
    ((initial.account_data as Json).events as Json[]).some((e) =>
      e.type === 'm.push_rules'
    ),
    true,
  );
  const since = String(initial.next_batch);
  assertEquals(
    roomSection(
      await sync(alice.access_token!, '&since=' + since),
      'join',
      roomId,
    ),
    undefined,
  );
  assert(
    roomSection(
      await sync(alice.access_token!, '&since=' + since + '&full_state=true'),
      'join',
      roomId,
    ),
  );
  const sent = await sendLocal(room, {
    type: 'm.room.message',
    sender: alice.user_id,
    content: { body: 'ping', msgtype: 'm.text' },
  }, signer);
  await recordTransaction(
    app.tenant,
    alice.device_id!,
    roomId,
    'local-echo',
    sent.eventId,
  );
  const after = await sync(alice.access_token!, '&since=' + since);
  const events = (roomSection(after, 'join', roomId)!.timeline as Json)
    .events as Json[];
  assertEquals(events.map((e) => e.event_id), [sent.eventId]);
  assertEquals((events[0].unsigned as Json).transaction_id, 'local-echo');
  assertEquals((events[0].unsigned as Json).membership, 'join');
  assertEquals(
    Object.keys(
      (await sync(bob.access_token!, '&since=' + since)).rooms as Json,
    ).sort(),
    ['invite', 'join', 'leave'],
  );
  await putAccountData(app.tenant, 'sy-a', '', 'custom.test', { value: 1 });
  const data = await sync(
    alice.access_token!,
    '&since=' + String(after.next_batch),
  );
  assertEquals((data.account_data as Json).events, [{
    type: 'custom.test',
    content: { value: 1 },
  }]);
  const bad = await suite.matrix(
    new Request('http://x/_matrix/client/v3/sync?since=garbage', {
      headers: { Authorization: `Bearer ${alice.access_token}` },
    }),
  );
  assertEquals(bad.status, 400);
  assertEquals((await bad.json()).errcode, 'M_INVALID_PARAM');
  await revokeToken(app.tenant, bob.access_token!);
  const revoked = await suite.matrix(
    new Request('http://x/_matrix/client/v3/sync', {
      headers: { Authorization: `Bearer ${bob.access_token}` },
    }),
  );
  assertEquals(revoked.status, 401);
  assertEquals((await revoked.json()).errcode, 'M_UNKNOWN_TOKEN');
});

suite.test('invite snapshots, summary, join prev_content and membership cuts, leave selection', async () => {
  const app = theApp();
  const alice = await suite.registerTestUser('sy-inviter', 'pw');
  const bob = await suite.registerTestUser('sy-invitee', 'pw');
  const signer = app.tenant.signer();
  const { roomId } = await createRoom(app.store, {
    creator: alice.user_id,
    name: 'at invite',
    invite: [bob.user_id],
    is_direct: true,
  }, signer);
  const room = await openRoom(app.store, roomId);
  const aliceSync = await sync(alice.access_token!);
  assertEquals(
    (roomSection(aliceSync, 'join', roomId)!.summary as Json)[
      'm.invited_member_count'
    ],
    1,
  );
  await sendLocal(room, {
    type: 'm.room.name',
    state_key: '',
    sender: alice.user_id,
    content: { name: 'after invite' },
  }, signer);
  const invited = roomSection(await sync(bob.access_token!), 'invite', roomId)!;
  const stripped = (invited.invite_state as Json).events as Json[];
  assertEquals(
    (stripped.find((e) => e.type === 'm.room.name')!.content as Json).name,
    'at invite',
  );
  assertEquals(
    (stripped.find((e) => e.state_key === bob.user_id)!.content as Json)
      .is_direct,
    true,
  );
  const joined = await join(room, bob.user_id, signer);
  const body = await sync(bob.access_token!);
  const events = (roomSection(body, 'join', roomId)!.timeline as Json)
    .events as Json[];
  let membership = 'leave';
  for (const ev of events) {
    if (ev.type === 'm.room.member' && ev.state_key === bob.user_id) {
      membership = String((ev.content as Json).membership);
    }
    assertEquals((ev.unsigned as Json).membership, membership);
  }
  const joinedEvent = events.find((e) => e.event_id === joined.eventId)!;
  assertEquals(
    ((joinedEvent.unsigned as Json).prev_content as Json).membership,
    'invite',
  );
  assertEquals(
    ((joinedEvent.unsigned as Json).prev_content as Json).is_direct,
    true,
  );
  const before = body.next_batch;
  await leave(room, bob.user_id, signer);
  assert(
    roomSection(
      await sync(bob.access_token!, '&since=' + before),
      'leave',
      roomId,
    ),
  );
  assertEquals(
    roomSection(await sync(bob.access_token!), 'leave', roomId),
    undefined,
  );
  assert(
    roomSection(
      await sync(
        bob.access_token!,
        '&filter=' + encodeURIComponent('{"room":{"include_leave":true}}'),
      ),
      'leave',
      roomId,
    ),
  );
});

suite.test('OOB invitation and rejection advance tokens once; ignored invitations stay hidden', async () => {
  const app = theApp();
  const user = await suite.registerTestUser('sy-oob', 'pw');
  const remote = await makeRemoteServer('remote.test');
  const deps = {
    store: app.store,
    server: app.server,
    signer: app.tenant.signer(),
    keys: fakeKeyResolver(remote),
    self: 'localhost',
    wake: () => {},
  };
  const roomId = '!oob:remote.test';
  const event = await remoteEvent(roomId, remote, '11', {
    type: 'm.room.member',
    state_key: user.user_id,
    sender: '@zoe:remote.test',
    content: { membership: 'invite', is_direct: true },
    prev_events: [],
    auth_events: [],
  });
  const initial = await sync(user.access_token!);
  await receiveInvite(
    roomId,
    event.event_id!,
    { room_version: '11', event: wireOf(event), invite_room_state: [] },
    remote.name,
    deps,
  );
  const invited = await sync(
    user.access_token!,
    '&since=' + initial.next_batch,
  );
  assert(invited.next_batch !== initial.next_batch);
  assertEquals(
    (((roomSection(invited, 'invite', roomId)!.invite_state as Json)
      .events as Json[])[0].content as Json).is_direct,
    true,
  );
  await rejectInviteRemote(roomId, user.user_id, deps);
  const rejected = await sync(
    user.access_token!,
    '&since=' + invited.next_batch,
  );
  assert(roomSection(rejected, 'leave', roomId));
  assert(rejected.next_batch !== invited.next_batch);
  assertEquals(
    roomSection(
      await sync(user.access_token!, '&since=' + rejected.next_batch),
      'leave',
      roomId,
    ),
    undefined,
  );
  const rescind = await remoteEvent(roomId, remote, '11', {
    type: 'm.room.member',
    state_key: user.user_id,
    sender: '@zoe:remote.test',
    content: { membership: 'leave' },
    prev_events: [event.event_id!],
    auth_events: [],
  });
  assert(await acceptRescind(roomId, rescind, deps));
  const rescinded = await sync(
    user.access_token!,
    '&since=' + rejected.next_batch,
  );
  assertEquals(
    (((roomSection(rescinded, 'leave', roomId)!.state as Json)
      .events as Json[])[0].content as Json).membership,
    'leave',
  );
  await receiveInvite(
    roomId,
    event.event_id!,
    { room_version: '11', event: wireOf(event), invite_room_state: [] },
    remote.name,
    deps,
  );
  await putAccountData(app.tenant, 'sy-oob', '', 'm.ignored_user_list', {
    ignored_users: { '@zoe:remote.test': {} },
  });
  assertEquals(
    roomSection(await sync(user.access_token!), 'invite', roomId),
    undefined,
  );
});

suite.test('incremental sync exposes fork-resolved published state, not just the trigger DAG state', async () => {
  const app = theApp();
  const alice = await suite.registerTestUser('sy-fork', 'pw');
  const signer = app.tenant.signer();
  const { roomId } = await createRoom(app.store, {
    creator: alice.user_id,
    invite: ['@fork-bob:localhost', '@fork-eve:localhost'],
  }, signer);
  const room = await openRoom(app.store, roomId);
  const bob = '@fork-bob:localhost', eve = '@fork-eve:localhost';
  const bobJoin = await join(room, bob, signer);
  const eveJoin = await join(room, eve, signer);
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
  const before = await sync(alice.access_token!);
  await sendLocal(room, {
    type: 'm.room.power_levels',
    state_key: '',
    sender: alice.user_id,
    content: PL_DEFAULTS(alice.user_id),
    prev_events: [eveJoin.eventId],
    origin_server_ts: 600,
  }, signer);
  const after = await sync(alice.access_token!, '&since=' + before.next_batch);
  const state = (roomSection(after, 'join', roomId)!.state as Json)
    .events as Json[];
  assert(
    state.some((e) => e.event_id === bobJoin.eventId),
    'resolved join replacing ban must reach sync state',
  );
});

suite.test('backfilled history never appears as new in HTTP sync', async () => {
  const app = theApp();
  const user = await suite.registerTestUser('sy-history', 'pw');
  const fr = await makeFakeRoom({
    roomId: '!sy-history:remote.test',
    joinRule: 'public',
  });
  const old = await fakeMessage(fr, 'old history');
  const signer = await testSigner('localhost');
  const keys = fakeKeyResolver(fr.server, await testRemoteServer('localhost'));
  const transport = fakeFetcher({
    makeJoin: (u) => fr.makeJoinAnswer(u),
    sendJoin: (pdu) => fr.acceptSendJoin(pdu),
    backfill: (from, limit) => fr.backfillPdus(from, limit),
    stateIds: new Map(
      [...fr.events.keys()].map((id) => [id, fr.stateIdsAt(id)!]),
    ),
    event: new Map(fr.events),
  });
  await joinRemote(app.store, {
    roomId: fr.roomId,
    user: user.user_id,
    via: [fr.server.name],
    signer,
    deps: { keys, fetcher: transport.fetcher, self: 'localhost' },
  });
  const before = await sync(user.access_token!);
  const room = await openRoom(app.store, fr.roomId);
  const result = await backfill(room, {
    from: [old.event_id!],
    limit: 20,
    via: fr.server.name,
  }, {
    keys,
    fetcher: transport.fetcher,
  });
  assertEquals(result.outcome, 'complete');
  const after = await sync(user.access_token!, '&since=' + before.next_batch);
  assertEquals(after.next_batch, before.next_batch);
  assertEquals(roomSection(after, 'join', fr.roomId), undefined);
  const stored = await room.tx((tx) => tx.events.get(old.event_id!));
  assert(
    stored !== null,
    'history really was stored, not dropped to avoid sync',
  );
});

suite.test('timeline limits, type filters, stored filters, zero limit and lazy-loaded member state', async () => {
  const app = theApp();
  const alice = await suite.registerTestUser('sy-filter', 'pw');
  const signer = app.tenant.signer();
  const { roomId } = await createRoom(app.store, {
    creator: alice.user_id,
    invite: ['@filter-bob:localhost'],
  }, signer);
  const room = await openRoom(app.store, roomId);
  for (let n = 0; n < 15; n++) {
    await sendLocal(room, {
      type: 'm.room.message',
      sender: alice.user_id,
      content: { body: 'm' + n },
    }, signer);
  }
  const limited = await sync(
    alice.access_token!,
    '&filter=' + encodeURIComponent('{"room":{"timeline":{"limit":10}}}'),
  );
  const tl = roomSection(limited, 'join', roomId)!.timeline as Json;
  assertEquals((tl.events as Json[]).length, 10);
  assertEquals(tl.limited, true);
  assert(tl.prev_batch !== limited.next_batch);
  const id = await storeFilter(app.tenant, 'sy-filter', {
    room: {
      timeline: { types: ['m.room.message'], limit: 1 },
      state: { lazy_load_members: true },
    },
  });
  const stored = roomSection(
    await sync(alice.access_token!, '&filter=' + id),
    'join',
    roomId,
  )!;
  assertEquals(
    ((stored.timeline as Json).events as Json[]).map((e) =>
      (e.content as Json).body
    ),
    ['m14'],
  );
  const members = ((stored.state as Json).events as Json[]).filter((e) =>
    e.type === 'm.room.member'
  );
  assertEquals(members.map((e) => e.state_key), [alice.user_id]);
  const empty = await sync(
    alice.access_token!,
    '&filter=' + encodeURIComponent('{"room":{"timeline":{"limit":0}}}'),
  );
  const zero = roomSection(empty, 'join', roomId)!.timeline as Json;
  assertEquals(zero.events, []);
  assertEquals(zero.prev_batch, empty.next_batch);
  // The s2 fork shape: a late state change is the first returned event,
  // and its own effect belongs in state even when the later event is filtered.
  const name = await sendLocal(room, {
    type: 'm.room.name',
    state_key: '',
    sender: alice.user_id,
    content: { name: 'S2' },
  }, signer);
  await sendLocal(room, {
    type: 'please_filter_me',
    sender: alice.user_id,
    content: {},
  }, signer);
  const filtered = roomSection(
    await sync(
      alice.access_token!,
      '&filter=' +
        encodeURIComponent(
          '{"room":{"timeline":{"not_types":["please_filter_me"],"limit":1}}}',
        ),
    ),
    'join',
    roomId,
  )!;
  assert(
    ((filtered.state as Json).events as Json[]).some((e) =>
      e.event_id === name.eventId
    ),
  );
});

suite.test('long poll wakes on relevant projections and committed tenant changes, not unrelated users', async () => {
  const app = theApp();
  const alice = await suite.registerTestUser('sy-wait', 'pw');
  const bob = await suite.registerTestUser('sy-unrelated', 'pw');
  const signer = app.tenant.signer();
  const { roomId } = await createRoom(
    app.store,
    { creator: alice.user_id },
    signer,
  );
  const room = await openRoom(app.store, roomId);
  let before = await sync(alice.access_token!);
  const longPoll = (since: unknown) =>
    suite.matrix(
      new Request(
        'http://x/_matrix/client/v3/sync?timeout=3000&since=' + since,
        { headers: { Authorization: `Bearer ${alice.access_token}` } },
      ),
    ).then((r) => r.json() as Promise<Json>);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let finished = false;
  let waiting = longPoll(before.next_batch).then((body) => {
    finished = true;
    return body;
  });
  await sleep(60);
  await putAccountData(app.tenant, 'sy-unrelated', '', 'other.test', {});
  await sleep(60);
  assertEquals(
    finished,
    false,
    'unrelated account data must not complete this sync',
  );
  let start = performance.now();
  const sent = await sendLocal(room, {
    type: 'm.room.message',
    sender: alice.user_id,
    content: { body: 'wake' },
  }, signer);
  const projected = await waiting;
  assert(
    performance.now() - start < 450,
    'projection wake must beat the polling fallback',
  );
  assert(
    ((roomSection(projected, 'join', roomId)!.timeline as Json)
      .events as Json[]).some((e) => e.event_id === sent.eventId),
  );
  before = projected;
  finished = false;
  waiting = longPoll(before.next_batch).then((body) => {
    finished = true;
    return body;
  });
  await sleep(60);
  start = performance.now();
  await putAccountData(app.tenant, 'sy-wait', '', 'wake.test', { value: 2 });
  const account = await waiting;
  assert(
    performance.now() - start < 450,
    'tenant wake must beat the polling fallback',
  );
  assertEquals((account.account_data as Json).events, [{
    type: 'wake.test',
    content: { value: 2 },
  }]);
  void bob;
});
