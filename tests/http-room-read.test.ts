// doltgres messages/context/event-visibility/legacy-room contracts.
import { assert, assertEquals } from '@std/assert';
import { httpSuite } from '#tests/http-app.ts';
import { theApp } from '#engine/app.ts';
import { eventStreamMax } from '#engine/server/stream.ts';
import { joinRemote } from '#engine/room/join.ts';
import { formatCursor, openRoom } from '#engine/room/index.ts';
import { backfill } from '#engine/room/history.ts';
import { ingestRemote } from '#engine/room/remote.ts';
import { makeFakeRoom } from '#tests/fixtures/remote-room.ts';
import { fakeFetcher, fakeKeyResolver } from '#tests/fixtures/remote.ts';
const { matrix, registerTestUser, test } = httpSuite('HTTP room reads');
type Json = Record<string, unknown>;
async function call(
  path: string,
  token: string | undefined,
  body?: unknown,
  method = 'GET',
  version = 'v3',
) {
  const res = await matrix(
    new Request('http://x/_matrix/client/' + version + '/' + path, {
      method,
      headers: { Authorization: 'Bearer ' + token },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    }),
  );
  return { status: res.status, body: await res.json() as Json };
}
const path = (id: string) => 'rooms/' + encodeURIComponent(id);
const bodies = (events: unknown) =>
  (events as Json[]).map((e) => (e.content as Json).body ?? '');
async function create(token: string | undefined, body: Json = {}) {
  const res = await call('createRoom', token, body, 'POST');
  assertEquals(res.status, 200);
  return res.body.room_id as string;
}
async function send(
  id: string,
  token: string | undefined,
  text: string,
  extra: Json = {},
) {
  const res = await call(
    path(id) + '/send/m.room.message/' + crypto.randomUUID(),
    token,
    { msgtype: 'm.text', body: text, ...extra },
    'PUT',
  );
  assertEquals(res.status, 200);
  return res.body.event_id as string;
}
const stream = async () =>
  's' + await eventStreamMax(theApp().server) + '_p0_t0_r0_a0';

test('messages: five-part/bare stream tokens, bounds, c-token paging, filtered end, lazy members and r0', async () => {
  const a = await registerTestUser('messages-a', 'pw');
  const A = a.access_token;
  const id = await create(A);
  const base = path(id);
  await send(id, A, 'm1');
  await send(id, A, 'm2');
  const s1 = await stream();
  await send(id, A, 'm3');
  await send(id, A, 'm4');
  const s2 = await stream();
  await send(id, A, 'm5');
  const get = (q: string) => call(base + '/messages?' + q, A);
  assertEquals(bodies((await get('dir=f&from=' + s1)).body.chunk), [
    'm3',
    'm4',
    'm5',
  ]);
  assertEquals(
    bodies((await get('dir=f&from=' + s1 + '&to=' + s2)).body.chunk),
    ['m3', 'm4'],
  );
  assertEquals(bodies((await get('dir=b&limit=4&from=' + s2)).body.chunk), [
    'm4',
    'm3',
    'm2',
    'm1',
  ]);
  const bad = await get('dir=f&from=not-a-token');
  assertEquals([bad.status, bad.body.errcode], [400, 'M_INVALID_PARAM']);
  assertEquals((await get('')).body.errcode, 'M_MISSING_PARAM');
  assertEquals((await get('dir=x')).body.errcode, 'M_INVALID_PARAM');
  assertEquals((await get('dir=b&filter=not-json')).body.errcode, 'M_BAD_JSON');
  const one = await get('dir=b&limit=2');
  assert(/^c\d+_-?\d+$/.test(String(one.body.end)));
  const two = await get('dir=b&limit=2&from=' + one.body.end);
  assertEquals(bodies(two.body.chunk), ['m3', 'm2']);
  assertEquals(
    (await call(base + '/messages?dir=b&limit=1', A, undefined, 'GET', 'r0'))
      .status,
    200,
  );
  const small = await create(A);
  await send(small, A, 'plain');
  await send(small, A, 'link', { url: 'https://example.test/x' });
  const filtered = await call(
    path(small) + '/messages?dir=b&limit=100&filter=' +
      encodeURIComponent('{"contains_url":true}'),
    A,
  );
  assertEquals(bodies(filtered.body.chunk), ['link']);
  assert(typeof filtered.body.end === 'string');
  const next = await call(
    path(small) + '/messages?dir=b&from=' + filtered.body.end,
    A,
  );
  assertEquals(next.body.chunk, []);
  assertEquals(next.body.end, undefined);
  const full = await call(path(small) + '/messages?dir=b&limit=100', A);
  assertEquals(full.body.end, undefined);
  const lazy = await get(
    'dir=b&limit=2&filter=' + encodeURIComponent('{"lazy_load_members":true}'),
  );
  assertEquals((lazy.body.state as Json[]).map((e) => e.state_key), [
    a.user_id,
  ]);
});

test('B10 history_visibility: seven wire outcomes; left state/members/messages/context clamp', async () => {
  const a = await registerTestUser('visibility-a', 'pw'),
    b = await registerTestUser('visibility-b', 'pw'),
    c = await registerTestUser('visibility-c', 'pw');
  const A = a.access_token, B = b.access_token;
  for (
    const [hv, phase, status] of [
      ['shared', 'join-first', 200],
      ['joined', 'join-after', 404],
      ['shared', 'join-after', 200],
      ['invited', 'invite-first', 200],
      ['invited', 'invite-after', 404],
      ['shared', 'never', 404],
      ['world_readable', 'never', 200],
    ] as const
  ) {
    const id = await create(A, {
      preset: 'public_chat',
      initial_state: [{
        type: 'm.room.history_visibility',
        content: { history_visibility: hv },
      }],
    });
    if (phase === 'join-first') await call(path(id) + '/join', B, {}, 'POST');
    if (phase === 'invite-first') {
      await call(path(id) + '/invite', A, { user_id: b.user_id }, 'POST');
    }
    const event = await send(id, A, 'Hello world');
    if (phase === 'invite-after') {
      await call(path(id) + '/invite', A, { user_id: b.user_id }, 'POST');
    }
    if (
      phase === 'join-after' || phase === 'invite-after' ||
      phase === 'invite-first'
    ) await call(path(id) + '/join', B, {}, 'POST');
    const res = await call(path(id) + '/event/' + encodeURIComponent(event), B);
    assertEquals(res.status, status, hv + '/' + phase);
    if (status === 200) {
      assertEquals(res.body.content, {
        msgtype: 'm.text',
        body: 'Hello world',
      });
      assertEquals(res.body.room_id, id);
      assertEquals(res.body.sender, a.user_id);
    }
  }
  const id = await create(A, {
    preset: 'public_chat',
    initial_state: [{
      type: 'm.room.history_visibility',
      content: { history_visibility: 'joined' },
    }],
  });
  const base = path(id);
  await call(base + '/join', B, {}, 'POST');
  await call(
    base + '/state/m.room.name',
    A,
    { name: 'N1. before A left' },
    'PUT',
  );
  await call(base + '/state/madeup.test.state', A, {
    body: 'S1. before A left',
  }, 'PUT');
  await send(id, A, 'M1. before A left');
  const pivot = await send(id, A, 'M2. before A left');
  await call(base + '/leave', B, {}, 'POST');
  const since = await stream();
  await call(
    base + '/state/m.room.name',
    A,
    { name: 'N2. after A left' },
    'PUT',
  );
  await call(
    base + '/state/madeup.test.state',
    A,
    { body: 'S2. after A left' },
    'PUT',
  );
  await send(id, A, 'M3. after A left');
  await call(base + '/join', c.access_token, {}, 'POST');
  assertEquals((await call(base + '/state/madeup.test.state', B)).body, {
    body: 'S1. before A left',
  });
  assertEquals((await call(base + '/state/madeup.test.state', A)).body, {
    body: 'S2. after A left',
  });
  assertEquals((await call(base + '/state/m.room.name', B)).body, {
    name: 'N1. before A left',
  });
  const members = await call(base + '/members', B);
  assertEquals(
    (members.body.chunk as Json[]).map((e) =>
      [e.type, e.state_key, (e.content as Json).membership].join('|')
    ).sort(),
    [`m.room.member|${a.user_id}|join`, `m.room.member|${b.user_id}|leave`],
  );
  const back = await call(base + '/messages?dir=b&limit=3&from=' + since, B);
  assertEquals(bodies(back.body.chunk), [
    '',
    'M2. before A left',
    'M1. before A left',
  ]);
  assertEquals(
    (await call(base + '/messages?dir=f&from=' + since, B)).body.chunk,
    [],
  );
  assertEquals((await call(base + '/joined_members', B)).status, 403);
  const joined = await call(
    base + '/joined_members',
    A,
    undefined,
    'GET',
    'r0',
  );
  assertEquals(
    Object.keys(joined.body.joined as Json).sort(),
    [a.user_id, c.user_id].sort(),
  );
  const context = await call(
    base + '/context/' + encodeURIComponent(pivot) + '?limit=10',
    B,
  );
  assertEquals(context.status, 200);
  assert(!bodies(context.body.events_after).includes('M3. after A left'));
});

test('context: split, zero/default limit, filter not on pivot, state at last event, v12 id and redaction rendering', async () => {
  const a = await registerTestUser('context-a', 'pw');
  const A = a.access_token;
  const id = await create(A);
  const base = path(id);
  const ids = [];
  for (let i = 1; i <= 7; i++) ids.push(await send(id, A, 'Message ' + i));
  const q = base + '/context/' + encodeURIComponent(ids[3]);
  const res = await call(q + '?limit=4', A);
  assertEquals(bodies(res.body.events_before), ['Message 3', 'Message 2']);
  assertEquals(bodies(res.body.events_after), ['Message 5', 'Message 6']);
  const zero = await call(q + '?limit=0', A);
  assertEquals(zero.body.events_before, []);
  assertEquals(zero.body.events_after, []);
  const filtered = await call(
    q + '?filter=' + encodeURIComponent('{"types":["m.room.member"]}'),
    A,
  );
  assertEquals((filtered.body.event as Json).type, 'm.room.message');
  for (
    const e of [
      ...filtered.body.events_before as Json[],
      ...filtered.body.events_after as Json[],
      ...filtered.body.state as Json[],
    ]
  ) assertEquals(e.type, 'm.room.member');
  await call(base + '/state/m.room.name', A, { name: 'N1' }, 'PUT');
  const anchor = await send(id, A, 'm1');
  await send(id, A, 'm2');
  await call(base + '/state/m.room.name', A, { name: 'N2' }, 'PUT');
  await send(id, A, 'm3');
  for (const [limit, name] of [[0, 'N1'], [4, 'N2']] as const) {
    const ctx = await call(
      base + '/context/' + encodeURIComponent(anchor) + '?limit=' + limit,
      A,
    );
    assertEquals(
      ((ctx.body.state as Json[]).find((e) => e.type === 'm.room.name')!
        .content as Json).name,
      name,
    );
  }
  assertEquals(
    (await call(base + '/context/$missing', A)).body.errcode,
    'M_NOT_FOUND',
  );
  const redact = await call(
    base + '/redact/' + encodeURIComponent(anchor) + '/r',
    A,
    { reason: 'test' },
    'PUT',
  );
  const event = await call(base + '/event/' + encodeURIComponent(anchor), A);
  assertEquals(event.body.content, {});
  assertEquals(
    ((event.body.unsigned as Json).redacted_because as Json).event_id,
    redact.body.event_id,
  );
  const v12 = await create(A, { room_version: '12' });
  const createFull = await call(
    path(v12) + '/state/m.room.create?format=event',
    A,
  );
  const ctx = await call(
    path(v12) + '/context/' +
      encodeURIComponent(createFull.body.event_id as string) + '?limit=0',
    A,
  );
  assertEquals((ctx.body.event as Json).room_id, v12);
});

test('G6 HTTP: grounded history visibility and context use the event state, never the current world-readable state', async () => {
  const a = await registerTestUser('g6-reader', 'pw');
  const A = a.access_token;
  const fr = await makeFakeRoom({ roomId: '!g6:remote.test' });
  await fr.addEvent({
    type: 'm.room.history_visibility',
    state_key: '',
    content: { history_visibility: 'joined' },
  });
  const secret = await fr.addEvent({
    type: 'm.room.message',
    content: { msgtype: 'm.text', body: 'secret-before-join' },
  });
  const fetcher = fakeFetcher({
    makeJoin: (user) => fr.makeJoinAnswer(user),
    sendJoin: (pdu) => fr.acceptSendJoin(pdu),
    backfill: (from, limit) => fr.backfillPdus(from, limit),
  }).fetcher;
  const keys = fakeKeyResolver(fr.server);
  const joined = await joinRemote(theApp().store, {
    roomId: fr.roomId,
    user: a.user_id,
    via: [fr.server.name],
    signer: theApp().tenant.signer(),
    deps: { keys, fetcher, self: a.home_server },
  });
  const room = await openRoom(theApp().store, fr.roomId);
  const joinPdu = await room.tx(async (tx) =>
    JSON.parse((await tx.events.get(joined.eventId))!.pdu)
  );
  const fill = await backfill(room, {
    from: joinPdu.prev_events,
    limit: 100,
    via: fr.server.name,
  }, { keys, fetcher });
  assertEquals(fill.outcome, 'complete');
  const position = await room.tx((tx) =>
    tx.segments.positionOf(String(secret.event_id))
  );
  assert(position !== null);
  const kind = await room.tx((tx) => tx.segments.get(position.segment));
  assertEquals(kind!.kind, 'history');
  const changed = await fr.addEvent({
    type: 'm.room.history_visibility',
    state_key: '',
    content: { history_visibility: 'world_readable' },
  });
  const ingested = await ingestRemote(room, [changed], fr.server.name, {
    keys,
    fetcher,
    self: a.home_server,
    limits: { waitMs: 0, limit: 10, budgetMs: 8000 },
    ungroundedMs: 0,
  });
  assertEquals(ingested[0].outcome, 'accepted');
  const base = path(fr.roomId);
  assertEquals(
    (await call(base + '/state/m.room.history_visibility', A)).body,
    { history_visibility: 'world_readable' },
  );
  for (const route of ['event/', 'context/']) {
    const denied = await call(
      base + '/' + route + encodeURIComponent(String(secret.event_id)),
      A,
    );
    assertEquals([denied.status, denied.body.errcode], [404, 'M_NOT_FOUND']);
  }
  const page = await call(base + '/messages?dir=b&limit=100', A);
  assert(!bodies(page.body.chunk).includes('secret-before-join'));
  const after = await call(
    base + '/messages?dir=f&from=' + formatCursor(position),
    A,
  );
  assertEquals(after.status, 200);
});

test('shared HTTP history remains readable after departure, including imported unpositioned joins', async () => {
  const a = await registerTestUser('shared-history-reader', 'pw');
  const b = await registerTestUser('shared-snapshot-reader', 'pw');
  const fr = await makeFakeRoom({ roomId: '!shared-history:remote.test' });
  const old = await fr.addEvent({
    type: 'm.room.message',
    content: { msgtype: 'm.text', body: 'shared-before-join' },
  });
  const imported = await fr.addEvent({
    type: 'm.room.member',
    state_key: b.user_id,
    sender: b.user_id,
    content: { membership: 'join' },
  });
  const fetcher = fakeFetcher({
    makeJoin: (user) => fr.makeJoinAnswer(user),
    sendJoin: (pdu) => fr.acceptSendJoin(pdu),
    backfill: (from, limit) => fr.backfillPdus(from, limit),
  }).fetcher;
  const keys = fakeKeyResolver(fr.server);
  const joined = await joinRemote(theApp().store, {
    roomId: fr.roomId,
    user: a.user_id,
    via: [fr.server.name],
    signer: theApp().tenant.signer(),
    deps: { keys, fetcher, self: a.home_server },
  });
  const room = await openRoom(theApp().store, fr.roomId);
  assertEquals(
    await room.tx((tx) => tx.segments.positionOf(String(imported.event_id))),
    null,
  );
  const joinPdu = await room.tx(async (tx) =>
    JSON.parse((await tx.events.get(joined.eventId))!.pdu)
  );
  assertEquals(
    (await backfill(room, {
      from: joinPdu.prev_events,
      limit: 100,
      via: fr.server.name,
    }, { keys, fetcher })).outcome,
    'complete',
  );
  const index = await theApp().server.query(
    'SELECT seq FROM event_index WHERE event = ?',
    [String(old.event_id)],
  );
  assertEquals(index[0].seq, null);
  for (const token of [a.access_token, b.access_token]) {
    for (const route of ['event/', 'context/']) {
      assertEquals(
        (await call(
          path(fr.roomId) + '/' + route +
            encodeURIComponent(String(old.event_id)),
          token,
        )).status,
        200,
      );
    }
  }
  await call(path(fr.roomId) + '/leave', a.access_token, {}, 'POST');
  assertEquals(
    (await call(
      path(fr.roomId) + '/event/' + encodeURIComponent(String(old.event_id)),
      a.access_token,
    )).status,
    200,
  );
});
