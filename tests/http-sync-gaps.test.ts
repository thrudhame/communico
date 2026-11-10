import { assert, assertEquals } from '@std/assert';
import { theApp } from '#engine/app.ts';
import { createRoom } from '#engine/room/create.ts';
import { openRoom } from '#engine/room/index.ts';
import { sendLocal } from '#engine/room/ingest.ts';
import { join, leave } from '#engine/room/membership.ts';
import { joinRemote } from '#engine/room/join.ts';
import { ingestRemote } from '#engine/room/remote.ts';
import { backfill } from '#engine/room/history.ts';
import { messages } from '#engine/client/timeline.ts';
import { fakeFetcher, fakeKeyResolver } from '#tests/fixtures/remote.ts';
import { fakeMessage, makeFakeRoom } from '#tests/fixtures/remote-room.ts';
import { httpSuite } from '#tests/http-app.ts';
import { testRemoteServer } from '#tests/fixtures/signer.ts';

type Json = Record<string, unknown>;
const suite = httpSuite('HTTP sync gap contracts');
async function sync(token: string, query = '', filter: unknown = {}) {
  const response = await suite.matrix(
    new Request(
      'http://x/_matrix/client/v3/sync?timeout=0&filter=' +
        encodeURIComponent(JSON.stringify(filter)) + query,
      { headers: { Authorization: 'Bearer ' + token } },
    ),
  );
  assertEquals(response.status, 200);
  return await response.json() as Json;
}
function entry(body: Json, id: string) {
  return ((body.rooms as Json).join as Json)[id] as Json;
}

suite.test('lazy full-state zero timeline keeps own membership in both state forms', async () => {
  const app = theApp();
  const alice = await suite.registerTestUser('gap-own', 'pw');
  const signer = app.tenant.signer();
  const baseline = await sync(alice.access_token!);
  const { roomId } = await createRoom(
    app.store,
    { creator: alice.user_id },
    signer,
  );
  for (const after of [false, true]) {
    for (
      const since of [
        '',
        '&since=' + baseline.next_batch + '&full_state=true',
        '&since=' + baseline.next_batch,
      ]
    ) {
      const result = entry(
        await sync(alice.access_token!, since + '&use_state_after=' + after, {
          room: { timeline: { limit: 0 }, state: { lazy_load_members: true } },
        }),
        roomId,
      );
      assertEquals((result.timeline as Json).events, []);
      const state = (result[after ? 'state_after' : 'state'] as Json)
        .events as Json[];
      assert(
        state.some((e) =>
          e.state_key === alice.user_id &&
          (e.content as Json).membership === 'join'
        ),
      );
    }
  }
});

suite.test('lazy limited gaps retain changed absent senders and unchanged timeline senders', async () => {
  const app = theApp();
  const alice = await suite.registerTestUser('gap-lazy-a', 'pw');
  const bob = await suite.registerTestUser('gap-lazy-b', 'pw');
  const signer = app.tenant.signer();
  const { roomId } = await createRoom(app.store, {
    creator: alice.user_id,
    preset: 'public_chat',
  }, signer);
  const room = await openRoom(app.store, roomId);
  await join(room, bob.user_id, signer);
  const baseline = await sync(alice.access_token!);
  const profile = await sendLocal(room, {
    type: 'm.room.member',
    state_key: bob.user_id,
    sender: bob.user_id,
    content: { membership: 'join', displayname: 'in the gap' },
  }, signer);
  await sendLocal(room, {
    type: 'm.room.message',
    sender: alice.user_id,
    content: { body: 'gap' },
  }, signer);
  await sendLocal(room, {
    type: 'm.room.message',
    sender: alice.user_id,
    content: { body: 'returned' },
  }, signer);
  for (const after of [false, true]) {
    const result = entry(
      await sync(
        alice.access_token!,
        '&since=' + baseline.next_batch + '&use_state_after=' + after,
        {
          room: { timeline: { limit: 1 }, state: { lazy_load_members: true } },
        },
      ),
      roomId,
    );
    assertEquals((result.timeline as Json).limited, true);
    const state = (result[after ? 'state_after' : 'state'] as Json)
      .events as Json[];
    assert(
      state.some((e) => e.event_id === profile.eventId),
      'gap profile cannot be lost for an absent sender',
    );
    assert(
      state.some((e) => e.state_key === alice.user_id),
      'timeline sender membership must be available',
    );
  }
  const carol = await suite.registerTestUser('gap-lazy-c', 'pw');
  const second = await sync(alice.access_token!);
  const left = await leave(room, bob.user_id, signer);
  const joined = await join(room, carol.user_id, signer);
  await sendLocal(room, {
    type: 'm.room.message',
    sender: alice.user_id,
    content: { body: 'after memberships' },
  }, signer);
  for (const after of [false, true]) {
    const result = entry(
      await sync(
        alice.access_token!,
        '&since=' + second.next_batch + '&use_state_after=' + after,
        {
          room: { timeline: { limit: 1 }, state: { lazy_load_members: true } },
        },
      ),
      roomId,
    );
    const ids =
      ((result[after ? 'state_after' : 'state'] as Json).events as Json[]).map((
        e,
      ) => e.event_id);
    assert(ids.includes(left.eventId), 'gap departure is mandatory');
    assert(ids.includes(joined.eventId), 'gap join is mandatory');
  }
});

suite.test('remote imported gap limits sync and its cursor resumes through missing history', async () => {
  const app = theApp();
  const alice = await suite.registerTestUser('gap-remote', 'pw');
  const fr = await makeFakeRoom({ roomId: '!sync-gap:remote.test' });
  const keys = fakeKeyResolver(fr.server, await testRemoteServer('localhost'));
  const transport = fakeFetcher({
    makeJoin: (u) => fr.makeJoinAnswer(u),
    sendJoin: (pdu) => fr.acceptSendJoin(pdu),
    missingEvents: [],
    stateIds: new Map(),
    event: new Map(),
  });
  await joinRemote(app.store, {
    roomId: fr.roomId,
    user: alice.user_id,
    via: [fr.server.name],
    signer: app.tenant.signer(),
    deps: { keys, fetcher: transport.fetcher, self: 'localhost' },
  });
  const room = await openRoom(app.store, fr.roomId);
  const before = await sync(alice.access_token!);
  const hidden = await fakeMessage(fr, 'not recovered');
  const missing = await fakeMessage(fr, 'missing history');
  const tip = await fakeMessage(fr, 'gap tip');
  const newest = await fakeMessage(fr, 'newest');
  const recovery = fakeFetcher({
    missingEvents: [],
    stateIds: new Map(
      [...fr.events.keys()].map((id) => [id, fr.stateIdsAt(id)!]),
    ),
    event: new Map(fr.events),
    backfill: (from, limit) => fr.backfillPdus(from, limit),
  });
  const outcomes = await ingestRemote(room, [tip, newest], fr.server.name, {
    keys,
    fetcher: recovery.fetcher,
    self: 'localhost',
    limits: { waitMs: 0, limit: 10, budgetMs: 8000 },
    ungroundedMs: 3600000,
  });
  assertEquals(outcomes.map((o) => o.outcome), ['accepted', 'accepted']);
  let prevBatch = '';
  for (const query of ['', '&since=' + before.next_batch]) {
    const result = entry(
      await sync(alice.access_token!, query, {
        room: { timeline: { limit: 100 } },
      }),
      fr.roomId,
    );
    const timeline = result.timeline as Json;
    prevBatch = String(timeline.prev_batch);
    assertEquals(
      timeline.limited,
      true,
      'missing remote history is always signaled',
    );
    assertEquals((timeline.events as Json[]).map((e) => e.event_id), [
      missing.event_id,
      tip.event_id,
      newest.event_id,
    ]);
  }
  const window = {
    roomId: fr.roomId,
    userId: alice.user_id,
    deviceId: null,
    leaveAt: null,
    dir: 'b' as const,
    fromToken: prevBatch,
    toToken: null,
    limit: 1,
    lazyLoadMembers: false,
    localOnly: true,
  };
  const unavailable = await messages(window);
  assertEquals(
    unavailable.chunk,
    [],
    'cannot silently jump over an interior gap',
  );
  assert(unavailable.end, 'unfilled gap stays resumable');
  await backfill(room, {
    from: [hidden.event_id!],
    limit: 1,
    via: fr.server.name,
    isolated: true,
  }, { keys, fetcher: recovery.fetcher });
  const repaired = await messages(window);
  assertEquals(repaired.chunk.map((e) => e.event_id), [hidden.event_id]);
});
