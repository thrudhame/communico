// doltgres federation-serve-history: real routes over room-core state refs.
import { assert, assertEquals } from '@std/assert';
import { theApp } from '#engine/app.ts';
import { serverName, setConfigForTests } from '#engine/config.ts';
import { eventIdFor } from '#engine/eventid.ts';
import { createRoom } from '#engine/room/create.ts';
import { sendLocal } from '#engine/room/ingest.ts';
import { openRoom, type Room } from '#engine/room/index.ts';
import { ban, join as localJoin } from '#engine/room/membership.ts';
import { toWire } from '#engine/federation/pdu.ts';
import { httpSuite } from './http-app.ts';
import {
  fedCaller,
  type Json,
  remoteServer,
  signTemplate,
} from './http-federation.ts';
import type { TestServer } from './federation/doc-helper.ts';

const { matrix, test } = httpSuite('HTTP federation history');
let remote: TestServer;
let call: ReturnType<typeof fedCaller>;
const creator = () => '@dev:' + serverName();
const prefix = '/_matrix/federation/v1/';
const enc = encodeURIComponent;

async function setup(visibility = 'shared') {
  const created = await createRoom(theApp().store, {
    creator: creator(),
    preset: 'public_chat',
    initial_state: [{
      type: 'm.room.history_visibility',
      content: { history_visibility: visibility },
    }],
  }, theApp().tenant.signer());
  return await openRoom(theApp().store, created.roomId);
}

async function say(room: Room, body: string) {
  return (await sendLocal(room, {
    type: 'm.room.message',
    sender: creator(),
    content: { msgtype: 'm.text', body },
  }, theApp().tenant.signer())).eventId;
}

async function join(room: Room) {
  const user = '@rudy:' + remote.name;
  const template = await call(
    'GET',
    prefix + 'make_join/' + enc(room.id) + '/' + enc(user) + '?ver=11',
  );
  assertEquals(template.status, 200);
  const pdu = await signTemplate(template.body.event as Json, remote);
  const res = await call(
    'PUT',
    '/_matrix/federation/v2/send_join/' + enc(room.id) + '/' +
      enc(String(pdu.event_id)),
    toWire(pdu, '11'),
  );
  assertEquals(res.status, 200);
  return String(pdu.event_id);
}

test('state/ids/event/auth/backfill/missing preserve wire shape, boundaries, caps and order', async () => {
  remote = await remoteServer();
  call = fedCaller(matrix, remote);
  const room = await setup();
  const joined = await join(room);
  const m1 = await say(room, 'first');
  const m2 = await say(room, 'second');
  const ids = await call(
    'GET',
    prefix + 'state_ids/' + enc(room.id) + '?event_id=' + enc(m2),
  );
  assertEquals(ids.status, 200);
  assert((ids.body.auth_chain_ids as string[]).length >= 2);
  assert(!(ids.body.pdu_ids as string[]).includes(m1));
  const state = await call(
    'GET',
    prefix + 'state/' + enc(room.id) + '?event_id=' + enc(m2),
  );
  assertEquals(state.status, 200);
  const statePdus = state.body.pdus as Json[];
  assert(statePdus.length >= 2);
  for (const pdu of statePdus) {
    assert(!('event_id' in pdu));
    assert(!('unsigned' in pdu));
  }
  const event = await call('GET', prefix + 'event/' + enc(m1));
  assertEquals(event.status, 200);
  const pdus = event.body.pdus as Json[];
  assertEquals(pdus.length, 1);
  assertEquals((pdus[0].content as Json).body, 'first');
  assert(!('event_id' in pdus[0]));
  const auth = await call(
    'GET',
    prefix + 'event_auth/' + enc(room.id) + '/' + enc(m2),
  );
  assertEquals(auth.status, 200);
  assert((auth.body.auth_chain as Json[]).length >= 1);
  assert(
    (auth.body.auth_chain as Json[]).every((p) =>
      (p.content as Json).body !== 'first' &&
      (p.content as Json).body !== 'second'
    ),
  );
  const target = prefix + 'backfill/' + enc(room.id) + '?v=' + enc(m2);
  const back = await call('GET', target + '&limit=10');
  assertEquals(back.status, 200);
  const backPdus = back.body.pdus as Json[];
  assert(backPdus.length >= 2);
  assertEquals((backPdus[0].content as Json).body, 'second');
  assertEquals((backPdus[1].content as Json).body, 'first');
  assertEquals((await call('GET', target)).status, 400);
  setConfigForTests({ federation: { backfillmax: 1 } });
  try {
    assertEquals(
      ((await call('GET', target + '&limit=100')).body.pdus as Json[]).length,
      1,
    );
  } finally {
    setConfigForTests({});
  }
  const missingTarget = prefix + 'get_missing_events/' + enc(room.id);
  const missing = await call('POST', missingTarget, {
    earliest_events: [joined],
    latest_events: [m2],
    limit: 10,
    min_depth: 0,
  });
  assertEquals(missing.status, 200);
  const events = missing.body.events as Json[];
  assertEquals(events.length, 1);
  assertEquals((events[0].content as Json).body, 'first');
  const capped = await call('POST', missingTarget, {
    earliest_events: [],
    latest_events: [m2],
    limit: 1,
  });
  assertEquals((capped.body.events as Json[]).length, 1);
  assertEquals(
    ((capped.body.events as Json[])[0].content as Json).body,
    'first',
  );
});

test('joined/invited pre-join visibility redacts; shared/world-readable full; stranger 403', async () => {
  const stranger = fedCaller(matrix, await remoteServer('stranger.test'));
  for (const visibility of ['joined', 'invited', 'shared', 'world_readable']) {
    const room = await setup(visibility);
    const before = await say(room, 'before');
    await join(room);
    const after = await say(room, 'after');
    const pre = await call('GET', prefix + 'event/' + enc(before));
    assertEquals(pre.status, 200);
    assertEquals(
      ((pre.body.pdus as Json[])[0].content as Json).body,
      ['joined', 'invited'].includes(visibility) ? undefined : 'before',
    );
    const post = await call('GET', prefix + 'event/' + enc(after));
    assertEquals(((post.body.pdus as Json[])[0].content as Json).body, 'after');
    for (const op of ['backfill', 'get_missing_events']) {
      const response = op === 'backfill'
        ? await call(
          'GET',
          prefix + op + '/' + enc(room.id) + '?v=' + enc(after) + '&limit=20',
        )
        : await call('POST', prefix + op + '/' + enc(room.id), {
          earliest_events: [],
          latest_events: [after],
          limit: 20,
        });
      assertEquals(response.status, 200);
      const events = response
        .body[op === 'backfill' ? 'pdus' : 'events'] as Json[];
      const ids = await Promise.all(events.map((p) => eventIdFor(p, '11')));
      const pdu = events[ids.indexOf(before)];
      assert(pdu !== undefined);
      assertEquals(
        (pdu.content as Json).body,
        ['joined', 'invited'].includes(visibility) ? undefined : 'before',
      );
    }
    assertEquals(
      (await stranger('GET', prefix + 'event/' + enc(after))).status,
      403,
    );
  }
});

test('auth closure recurses, excludes seed and later unrelated state', async () => {
  const room = await setup();
  const joined = await join(room);
  const user = '@rudy:' + remote.name;
  let last = joined;
  for (const membership of ['leave', 'join']) {
    const op = membership === 'join' ? 'make_join/' : 'make_leave/';
    const mk = await call(
      'GET',
      prefix + op + enc(room.id) + '/' + enc(user) + '?ver=11',
    );
    assertEquals(mk.status, 200);
    const pdu = await signTemplate(mk.body.event as Json, remote);
    last = String(pdu.event_id);
    const sent = await call(
      'PUT',
      '/_matrix/federation/v2/send_' + membership + '/' + enc(room.id) + '/' +
        enc(last),
      toWire(pdu, '11'),
    );
    assertEquals(sent.status, 200);
  }
  const later = await sendLocal(room, {
    type: 'm.room.join_rules',
    state_key: '',
    sender: creator(),
    content: { join_rule: 'invite' },
  }, theApp().tenant.signer());
  const auth = await call(
    'GET',
    prefix + 'event_auth/' + enc(room.id) + '/' + enc(last),
  );
  assertEquals(auth.status, 200);
  const chain = auth.body.auth_chain as Json[];
  const returned = await Promise.all(chain.map((p) => eventIdFor(p, '11')));
  assert(returned.includes(joined));
  assert(!returned.includes(last));
  assert(!returned.includes(later.eventId));
  assertEquals(returned.length, new Set(returned).size);
  const expected = await room.tx((tx) => tx.events.authClosure([last], 100000));
  assertEquals(
    returned.sort(),
    expected.ids.filter((id) => id !== last).sort(),
  );
});

test('imported event state is served, none/pending is never replaced with current state', async () => {
  const room = await setup();
  await join(room);
  const imported = await say(room, 'imported');
  const none = await say(room, 'evidence');
  const pending = await say(room, 'pending');
  const later = await sendLocal(room, {
    type: 'm.room.name',
    state_key: '',
    sender: creator(),
    content: { name: 'later state must not leak into imported boundary' },
  }, theApp().tenant.signer());
  await room.tx(async (tx) => {
    const refs = await tx.state.eventReadState(imported);
    assert(refs !== null);
    await tx.materialize.setEventState(
      imported,
      refs.before.group,
      refs.after.group,
      'imported',
    );
    await tx.materialize.setEventState(none, null, null, 'none');
    for (
      const [id, grounding] of [[none, 'evidence'], [
        pending,
        'pending',
      ]] as const
    ) {
      await tx.events.setStatus(id, {
        standing: 'accepted',
        grounding,
        origin: remote.name,
        received_ts: Date.now(),
      });
    }
  });
  for (const op of ['state', 'state_ids']) {
    const target = prefix + op + '/' + enc(room.id) + '?event_id=';
    const stored = await call('GET', target + enc(imported));
    assertEquals(stored.status, 200);
    const ids = op === 'state_ids'
      ? stored.body.pdu_ids as string[]
      : await Promise.all(
        (stored.body.pdus as Json[]).map((p) => eventIdFor(p, '11')),
      );
    assert(!ids.includes(later.eventId));
    const absent = await call('GET', target + enc(none));
    assertEquals(absent.status, 404);
    assertEquals(absent.body.errcode, 'M_NOT_FOUND');
    assertEquals((await call('GET', target + enc(pending))).status, 404);
    assertEquals((await call('GET', target + enc('$unknown'))).status, 404);
  }
  const evidence = await call('GET', prefix + 'event/' + enc(none));
  assertEquals(evidence.status, 200);
  assertEquals((evidence.body.pdus as Json[])[0].content, {});
  assertEquals(
    (await call('GET', prefix + 'event/' + enc(pending))).status,
    404,
  );
});

test('standing: direct reads and auth have no exclusion; history includes referenced flagged ancestors', async () => {
  const room = await setup();
  await join(room);
  const signer = theApp().tenant.signer();
  const bob = '@bob:' + serverName();
  await localJoin(room, bob, signer);
  const base = await say(room, 'before ban');
  await ban(room, creator(), bob, signer);
  const soft = await sendLocal(room, {
    type: 'm.room.message',
    sender: bob,
    content: { body: 'delayed message' },
    prev_events: [base],
  }, signer);
  assertEquals(soft.standing, 'soft_failed');
  assertEquals(
    await room.tx((tx) => tx.segments.positionOf(soft.eventId)),
    null,
  );
  const rejected = await sendLocal(room, {
    type: 'm.room.message',
    sender: '@outsider:' + serverName(),
    content: { body: 'rejected message' },
    prev_events: [soft.eventId],
  }, signer);
  assertEquals(rejected.standing, 'rejected');
  const child = await sendLocal(room, {
    type: 'm.room.message',
    sender: creator(),
    content: { body: 'accepted descendant' },
    prev_events: [rejected.eventId],
  }, signer);
  assertEquals(child.standing, 'accepted');
  const idsOf = (pdus: Json[]) =>
    Promise.all(pdus.map((p) => eventIdFor(p, '11')));
  for (const id of [soft.eventId, rejected.eventId, child.eventId]) {
    assertEquals((await call('GET', prefix + 'event/' + enc(id))).status, 200);
    assertEquals(
      (await call('GET', prefix + 'event_auth/' + enc(room.id) + '/' + enc(id)))
        .status,
      200,
    );
  }
  const backfill = (id: string) =>
    call(
      'GET',
      prefix + 'backfill/' + enc(room.id) + '?v=' + enc(id) + '&limit=20',
    );
  const back = await backfill(child.eventId);
  assertEquals(back.status, 200);
  const backIds = await idsOf(back.body.pdus as Json[]);
  assertEquals(backIds.slice(0, 3), [
    child.eventId,
    rejected.eventId,
    soft.eventId,
  ]);
  const missing = await call(
    'POST',
    prefix + 'get_missing_events/' + enc(room.id),
    {
      earliest_events: [base],
      latest_events: [child.eventId],
      limit: 20,
    },
  );
  assertEquals(missing.status, 200);
  assertEquals(await idsOf(missing.body.events as Json[]), [
    soft.eventId,
    rejected.eventId,
  ]);
  // A soft-failed seed is not itself referenced by the request.
  const seed = await backfill(soft.eventId);
  assertEquals(seed.status, 200);
  assert(!(await idsOf(seed.body.pdus as Json[])).includes(soft.eventId));
  // The same id can also be a seed and referenced by another requested root.
  const multi = await call(
    'GET',
    prefix + 'backfill/' + enc(room.id) + '?v=' + enc(soft.eventId) + '&v=' +
      enc(child.eventId) + '&limit=20',
  );
  assertEquals(multi.status, 200);
  assert((await idsOf(multi.body.pdus as Json[])).includes(soft.eventId));
});

test('pending content is excluded by every serving path and the shared send_join auth boundary', async () => {
  const room = await setup();
  await join(room);
  const tip = await say(room, 'tip');
  const pl = await room.tx(async (tx) => {
    const ref = await tx.state.eventStateBefore(tip);
    return (await tx.state.groupMap(ref!.group)).get('m.room.power_levels\0')!;
  });
  await room.tx((tx) =>
    tx.events.setStatus(pl, {
      standing: 'accepted',
      grounding: 'pending',
      origin: remote.name,
      received_ts: Date.now(),
    })
  );
  for (const op of ['state', 'state_ids']) {
    const result = await call(
      'GET',
      prefix + op + '/' + enc(room.id) + '?event_id=' + enc(tip),
    );
    assertEquals(result.status, 404);
    assertEquals(result.body.errcode, 'M_NOT_FOUND');
  }
  const user = '@second:' + remote.name;
  const template = await call(
    'GET',
    prefix + 'make_join/' + enc(room.id) + '/' + enc(user) + '?ver=11',
  );
  assertEquals(template.status, 200);
  const pdu = await signTemplate(template.body.event as Json, remote);
  const sent = await call(
    'PUT',
    '/_matrix/federation/v2/send_join/' + enc(room.id) + '/' +
      enc(String(pdu.event_id)),
    toWire(pdu, '11'),
  );
  assertEquals(sent.status, 200);
  for (const field of ['state', 'auth_chain']) {
    const ids = await Promise.all(
      (sent.body[field] as Json[]).map((p) => eventIdFor(p, '11')),
    );
    assert(!ids.includes(pl), field + ' leaked pending PDU');
  }
  const auth = await call(
    'GET',
    prefix + 'event_auth/' + enc(room.id) + '/' + enc(tip),
  );
  assertEquals(auth.status, 200);
  assert(
    !(await Promise.all(
      (auth.body.auth_chain as Json[]).map((p) => eventIdFor(p, '11')),
    )).includes(pl),
  );
});

test('state and recursive auth chains retain rejected and soft-failed auth events', async () => {
  const room = await setup();
  await join(room);
  const tip = await say(room, 'auth standing');
  const flagged = await room.tx(async (tx) => {
    const ref = await tx.state.eventStateBefore(tip);
    const state = await tx.state.groupMap(ref!.group);
    const ids = [
      state.get('m.room.power_levels\0')!,
      state.get('m.room.member\0' + creator())!,
    ];
    for (const [i, id] of ids.entries()) {
      await tx.events.setStatus(id, {
        standing: i === 0 ? 'soft_failed' : 'rejected',
        grounding: 'grounded',
        origin: remote.name,
        received_ts: Date.now(),
      });
    }
    return ids;
  });
  const result = await call(
    'GET',
    prefix + 'event_auth/' + enc(room.id) + '/' + enc(tip),
  );
  assertEquals(result.status, 200);
  const authIds = await Promise.all(
    (result.body.auth_chain as Json[]).map((p) => eventIdFor(p, '11')),
  );
  for (const id of flagged) assert(authIds.includes(id));
  for (const op of ['state', 'state_ids']) {
    const response = await call(
      'GET',
      prefix + op + '/' + enc(room.id) + '?event_id=' + enc(tip),
    );
    assertEquals(response.status, 200);
    const stateIds = op === 'state_ids'
      ? response.body.pdu_ids as string[]
      : await Promise.all(
        (response.body.pdus as Json[]).map((p) => eventIdFor(p, '11')),
      );
    const chainIds = op === 'state_ids'
      ? response.body.auth_chain_ids as string[]
      : await Promise.all(
        (response.body.auth_chain as Json[]).map((p) => eventIdFor(p, '11')),
      );
    for (const id of flagged) {
      assert(stateIds.includes(id));
      assert(chainIds.includes(id));
    }
  }
});

test('missing events use topology rather than hostile depth, and cap a branching frontier', async () => {
  const room = await setup();
  const boundary = await join(room);
  const parent = await say(room, 'higher depth parent');
  const template = await call(
    'GET',
    prefix + 'make_leave/' + enc(room.id) + '/' + enc('@rudy:' + remote.name),
  );
  assertEquals(template.status, 200);
  const child = await signTemplate({
    type: 'm.room.message',
    room_id: room.id,
    sender: '@rudy:' + remote.name,
    content: { body: 'lower depth child' },
    prev_events: [parent],
    auth_events: (template.body.event as Json).auth_events,
    depth: 1,
  }, remote);
  const received = await call('PUT', prefix + 'send/depth-order', {
    origin: remote.name,
    origin_server_ts: Date.now(),
    pdus: [toWire(child, '11')],
  });
  assertEquals(received.status, 200);
  assertEquals((received.body.pdus as Json)[String(child.event_id)], {});
  const tip = await say(room, 'after low depth child');
  const result = await call(
    'POST',
    prefix + 'get_missing_events/' + enc(room.id),
    {
      earliest_events: [boundary],
      latest_events: [tip],
      limit: 20,
    },
  );
  assertEquals(result.status, 200);
  const ids = await Promise.all(
    (result.body.events as Json[]).map((p) => eventIdFor(p, '11')),
  );
  assertEquals(ids, [parent, String(child.event_id)]);
  const forks: string[] = [];
  for (let i = 0; i < 3; i++) {
    const fork = await sendLocal(room, {
      type: 'm.room.message',
      sender: creator(),
      content: { body: 'fork ' + i },
      prev_events: [tip],
    }, theApp().tenant.signer());
    assertEquals(fork.standing, 'accepted');
    forks.push(fork.eventId);
  }
  const merge = await say(room, 'merge');
  const capped = await call(
    'POST',
    prefix + 'get_missing_events/' + enc(room.id),
    {
      earliest_events: [tip],
      latest_events: [merge],
      limit: 1,
    },
  );
  assertEquals(capped.status, 200);
  assertEquals((capped.body.events as Json[]).length, 1);
  assert(
    forks.includes(await eventIdFor((capped.body.events as Json[])[0], '11')),
  );
  const overlap = await call(
    'POST',
    prefix + 'get_missing_events/' + enc(room.id),
    { earliest_events: [merge], latest_events: [merge], limit: 1 },
  );
  assertEquals(overlap.status, 200);
  assertEquals((overlap.body.events as Json[]).length, 1);
  assert(
    forks.includes(await eventIdFor((overlap.body.events as Json[])[0], '11')),
  );
});
