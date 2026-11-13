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

suite.test('filter and visibility omissions retain end cuts; limited windows have usable before cursors', async () => {
  const app = theApp();
  const alice = await suite.registerTestUser('gap-filter-a', 'pw');
  const bob = await suite.registerTestUser('gap-filter-b', 'pw');
  const signer = app.tenant.signer();
  const { roomId } = await createRoom(app.store, {
    creator: alice.user_id,
    preset: 'public_chat',
  }, signer);
  const room = await openRoom(app.store, roomId);
  await join(room, bob.user_id, signer);
  const baseline = await sync(alice.access_token!);
  const old = await sendLocal(room, {
    type: 'm.room.message',
    sender: alice.user_id,
    content: { body: 'old' },
  }, signer);
  const first = await sync(alice.access_token!);
  const kept = await sendLocal(room, {
    type: 'm.room.message',
    sender: alice.user_id,
    content: { body: 'kept' },
  }, signer);
  const hidden = await sendLocal(room, {
    type: 'u.hidden',
    sender: alice.user_id,
    content: {},
  }, signer);
  const ignored = await suite.matrix(
    new Request(
      'http://x/_matrix/client/v3/user/' + encodeURIComponent(alice.user_id) +
        '/account_data/m.ignored_user_list',
      {
        method: 'PUT',
        headers: { Authorization: 'Bearer ' + alice.access_token },
        body: JSON.stringify({ ignored_users: { [bob.user_id]: {} } }),
      },
    ),
  );
  assertEquals(ignored.status, 200);
  await sendLocal(room, {
    type: 'm.room.message',
    sender: bob.user_id,
    content: { body: 'ignored' },
  }, signer);
  for (const limit of [1, 100]) {
    const body = await sync(alice.access_token!, '&since=' + first.next_batch, {
      room: { timeline: { types: ['m.room.message'], limit } },
    });
    const result = entry(body, roomId);
    const timeline = result.timeline as Json;
    assertEquals(
      timeline.limited,
      false,
      'excluded events do not imply a missing eligible event',
    );
    assertEquals((timeline.events as Json[]).map((e) => e.event_id), [
      kept.eventId,
    ]);
    assertEquals(timeline.prev_batch, body.next_batch);
    let from = String(timeline.prev_batch);
    const found: unknown[] = [];
    for (let page = 0; page < 3; page++) {
      const response = await suite.matrix(
        new Request(
          'http://x/_matrix/client/v3/rooms/' + encodeURIComponent(roomId) +
            '/messages?dir=b&limit=1&from=' + encodeURIComponent(from),
          { headers: { Authorization: 'Bearer ' + alice.access_token } },
        ),
      );
      assertEquals(response.status, 200);
      const body = await response.json() as Json;
      found.push(...(body.chunk as Json[]).map((event) => event.event_id));
      if (page < 2) {
        assert(typeof body.end === 'string');
        from = body.end;
      }
    }
    // An ignored row no longer consumes a message page's result limit.
    assertEquals(found, [hidden.eventId, kept.eventId, old.eventId]);
  }
  const trimmed = entry(
    await sync(alice.access_token!, '&since=' + baseline.next_batch, {
      room: { timeline: { types: ['m.room.message'], limit: 1 } },
    }),
    roomId,
  ).timeline as Json;
  assertEquals(trimmed.limited, true);
  assertEquals((trimmed.events as Json[]).map((e) => e.event_id), [
    kept.eventId,
  ]);
  const page = await suite.matrix(
    new Request(
      'http://x/_matrix/client/v3/rooms/' + encodeURIComponent(roomId) +
        '/messages?dir=b&limit=1&from=' +
        encodeURIComponent(String(trimmed.prev_batch)) + '&filter=' +
        encodeURIComponent('{"types":["m.room.message"]}'),
      { headers: { Authorization: 'Bearer ' + alice.access_token } },
    ),
  );
  assertEquals(page.status, 200);
  assertEquals(
    ((await page.json()).chunk as Json[]).map((e) => e.event_id),
    [old.eventId],
  );
});

suite.test('a newly joined room retains a real missing prefix across a global since cut', async () => {
  const app = theApp();
  const alice = await suite.registerTestUser('gap-join-a', 'pw');
  const bob = await suite.registerTestUser('gap-join-b', 'pw');
  const signer = app.tenant.signer();
  const { roomId } = await createRoom(app.store, {
    creator: alice.user_id,
    preset: 'public_chat',
  }, signer);
  const room = await openRoom(app.store, roomId);
  const old: string[] = [];
  const recent: string[] = [];
  const message = async (body: string) =>
    (await sendLocal(room, {
      type: 'm.room.message',
      sender: alice.user_id,
      content: { body },
    }, signer)).eventId;
  for (let n = 0; n < 4; n++) old.push(await message('old-' + n));
  const before = await sync(bob.access_token!);
  for (let n = 0; n < 4; n++) recent.push(await message('recent-' + n));
  await join(room, bob.user_id, signer);
  for (const after of [false, true]) {
    const timeline = entry(
      await sync(
        bob.access_token!,
        '&since=' + before.next_batch + '&use_state_after=' + after,
        { room: { timeline: { types: ['m.room.message'], limit: 10 } } },
      ),
      roomId,
    ).timeline as Json;
    assertEquals(
      (timeline.events as Json[]).map((event) => event.event_id),
      recent,
    );
    assertEquals(
      timeline.limited,
      true,
      'the client has not received pre-since room history',
    );
    const page = await suite.matrix(
      new Request(
        'http://x/_matrix/client/v3/rooms/' + encodeURIComponent(roomId) +
          '/messages?dir=b&limit=4&from=' +
          encodeURIComponent(String(timeline.prev_batch)),
        { headers: { Authorization: 'Bearer ' + bob.access_token } },
      ),
    );
    assertEquals(page.status, 200);
    assertEquals(
      ((await page.json()).chunk as Json[]).map((event) => event.event_id),
      [...old].reverse(),
    );
  }
  const freshBefore = await sync(bob.access_token!);
  const fresh = await createRoom(app.store, {
    creator: alice.user_id,
    preset: 'public_chat',
  }, signer);
  await join(await openRoom(app.store, fresh.roomId), bob.user_id, signer);
  const body = await sync(
    bob.access_token!,
    '&since=' + freshBefore.next_batch,
  );
  const timeline = entry(body, fresh.roomId).timeline as Json;
  assertEquals(
    timeline.limited,
    false,
    'a room created after since has no missing prefix',
  );
  assertEquals(timeline.prev_batch, body.next_batch);
});

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
  const atCut = { ...window, fromToken: String(before.next_batch) };
  const cutEvent =
    ((entry(before, fr.roomId).timeline as Json).events as Json[])
      .at(-1)!.event_id;
  assertEquals(
    (await messages(atCut)).chunk.map((e) => e.event_id),
    [cutEvent],
    'a newer imported boundary cannot control an earlier stream cut',
  );
  const zero = await messages({ ...atCut, limit: 0 });
  assert(zero.end);
  assertEquals(
    (await messages({ ...atCut, fromToken: zero.end })).chunk.map((e) =>
      e.event_id
    ),
    [cutEvent],
    'zero-limit tokens preserve the inclusive stream cut',
  );
  await backfill(room, {
    from: [hidden.event_id!],
    limit: 1,
    via: fr.server.name,
    isolated: true,
  }, { keys, fetcher: recovery.fetcher });
  const repaired = await messages(window);
  assertEquals(repaired.chunk.map((e) => e.event_id), [hidden.event_id]);
});

suite.test('isolated backfill does not allocate empty anchors for evidence or overlap', async () => {
  const app = theApp();
  const alice = await suite.registerTestUser('gap-anchor', 'pw');
  const fr = await makeFakeRoom({ roomId: '!empty-anchor:remote.test' });
  const keys = fakeKeyResolver(fr.server, await testRemoteServer('localhost'));
  const transport = fakeFetcher({
    makeJoin: (u) => fr.makeJoinAnswer(u),
    sendJoin: (pdu) => fr.acceptSendJoin(pdu),
  });
  await joinRemote(app.store, {
    roomId: fr.roomId,
    user: alice.user_id,
    via: [fr.server.name],
    signer: app.tenant.signer(),
    deps: { keys, fetcher: transport.fetcher, self: 'localhost' },
  });
  const room = await openRoom(app.store, fr.roomId);
  const live = await fakeMessage(fr, 'held message');
  assertEquals(
    (await ingestRemote(room, [live], fr.server.name, {
      keys,
      fetcher: transport.fetcher,
      self: 'localhost',
      limits: { waitMs: 0, limit: 10, budgetMs: 8000 },
      ungroundedMs: 3600000,
    })).map((result) => result.outcome),
    ['accepted'],
  );
  await fakeMessage(fr, 'unavailable parent');
  const evidence = await fakeMessage(fr, 'evidence only');
  const initial = await room.tx((tx) => tx.segments.list());
  const fetcher = fakeFetcher({ backfill: [evidence] }).fetcher;
  for (let retry = 0; retry < 2; retry++) {
    const result = await backfill(room, {
      from: [evidence.event_id!],
      limit: 1,
      via: fr.server.name,
      isolated: true,
    }, { keys, fetcher });
    assertEquals(result.outcome, 'open');
    assertEquals(result.segment, null);
    assertEquals(await room.tx((tx) => tx.segments.list()), initial);
  }
  const overlap = await backfill(room, {
    from: [live.event_id!],
    limit: 1,
    via: fr.server.name,
    isolated: true,
  }, { keys, fetcher: fakeFetcher({ backfill: [live] }).fetcher });
  assertEquals(overlap, { outcome: 'complete', segment: null, positioned: [] });
  assertEquals(await room.tx((tx) => tx.segments.list()), initial);
});
