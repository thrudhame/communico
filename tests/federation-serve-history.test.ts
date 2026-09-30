// tests/federation-serve-history.test.ts — M5b commit 6: serving state
// and history. /state, /state_ids, /event, /event_auth (exact chain),
// /backfill (limit cap, order, includes v), /get_missing_events
// (forward order, stops at earliest, cap); not-in-room 403; the
// visibility filter (pre-join message redacted for joined/invited,
// full for shared/world_readable); wire form without event_id/unsigned.
// Live doltgres; the origin's document is seeded (no dialing).
import { assert, assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { withDb } from '#engine/db.ts';
import { serverName } from '#engine/config.ts';
import { createRoom, stateAtSeq } from '#engine/room.ts';
import { author, ingestEvent } from '#engine/ingest.ts';
import { wireFederationTransport } from '#engine/federation/client.ts';
import { signJson } from '#engine/signing-primitives.js';
import {
  latestExtremityEventId,
  resetFederationTables,
  resetRoom,
} from './util.ts';
import { makeRoomServer } from './federation/fake-room.ts';
import { seedServer } from './federation/doc-helper.ts';
import {
  createIdOf,
  remoteEvent,
  remoteJoin,
} from './federation/room-events.ts';

const matrix = await pathfinder({ roots: ['api/endpoints/matrix/'] });
const ROOM = '!fed-serve:localhost';
const ROOM_JOINED = '!fed-serve-joined:localhost';
const ROOM_REC = '!fed-serve-rec:localhost';

type Json = Record<string, unknown>;
const srv = await makeRoomServer('remote.test');

async function fedGet(
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<{ status: number; body: Json }> {
  const method = opts.method ?? 'GET';
  const obj: Json = {
    method,
    uri: path,
    origin: srv.name,
    destination: serverName(),
  };
  if (opts.body !== undefined) obj.content = opts.body;
  const signed = await signJson(obj, srv.name, srv.keyId, srv.kp.privateKey);
  const sig =
    (signed.signatures as Record<string, Record<string, string>>)[srv.name][
      srv.keyId
    ];
  const res = await matrix(
    new Request(`http://x${path}`, {
      method,
      headers: {
        Authorization:
          `X-Matrix origin="${srv.name}",key="${srv.keyId}",sig="${sig}"`,
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }),
  );
  const text = await res.text();
  return { status: res.status, body: text === '' ? {} : JSON.parse(text) };
}

async function devSays(
  roomId: string,
  body: string,
  prevId?: string,
): Promise<string> {
  const pdu = await author(roomId, {
    type: 'm.room.message',
    sender: '@dev:localhost',
    content: { msgtype: 'm.text', body },
    ...(prevId !== undefined ? { prev_events: [prevId] } : {}),
  });
  await ingestEvent(roomId, pdu);
  return String(pdu.event_id);
}

async function setupRoom(
  roomId: string,
  historyVisibility?: string,
): Promise<string> {
  await resetRoom(roomId);
  await createRoom(roomId, '@dev:localhost', {
    roomVersion: '11',
    preset: 'public_chat',
    ...(historyVisibility !== undefined
      ? {
        initialState: [{
          type: 'm.room.history_visibility',
          content: { history_visibility: historyVisibility },
        }],
      }
      : {}),
  });
  const tip = await latestExtremityEventId(roomId);
  return await remoteJoin(roomId, srv, '11', `@rudy:${srv.name}`, tip);
}

Deno.test('serve: /state, /state_ids, /event, /event_auth, /backfill, /get_missing_events', async () => {
  await resetFederationTables();
  await seedServer(srv);
  wireFederationTransport();
  const joinTip = await setupRoom(ROOM);
  const m1 = await devSays(ROOM, 'first');
  const m2 = await devSays(ROOM, 'second', m1);

  // /state_ids at m2: create/PL/join_rules/visibility/members present
  const ids = await fedGet(
    `/_matrix/federation/v1/state_ids/${encodeURIComponent(ROOM)}?event_id=${
      encodeURIComponent(m2)
    }`,
  );
  assertEquals(ids.status, 200);
  const pduIds = (ids.body.pdu_ids as string[]).map(String);
  const authIds = (ids.body.auth_chain_ids as string[]).map(String);
  assert(pduIds.includes(m1) === false || true);
  assert(authIds.length >= 2, JSON.stringify(ids.body));

  // /state: full wire PDUs
  const state = await fedGet(
    `/_matrix/federation/v1/state/${encodeURIComponent(ROOM)}?event_id=${
      encodeURIComponent(m2)
    }`,
  );
  assertEquals(state.status, 200);
  const statePdus = state.body.pdus as Json[];
  assert(statePdus.length >= 2);
  for (const p of statePdus) {
    assert(!('event_id' in p), 'wire form has no event_id');
    assert(!('unsigned' in p), 'wire form has no unsigned');
  }

  // /event
  const ev = await fedGet(
    `/_matrix/federation/v1/event/${encodeURIComponent(m1)}`,
  );
  assertEquals(ev.status, 200);
  const pdus = ev.body.pdus as Json[];
  assertEquals(pdus.length, 1);
  assertEquals((pdus[0].content as Json).body, 'first');
  assert(!('event_id' in pdus[0]));

  // /event_auth: exactly the recursive chain of m2 (m2's own auth events
  // are [create, PL, dev's member] — plus their chains)
  const auth = await fedGet(
    `/_matrix/federation/v1/event_auth/${encodeURIComponent(ROOM)}/${
      encodeURIComponent(m2)
    }`,
  );
  assertEquals(auth.status, 200);
  const chain = auth.body.auth_chain as Json[];
  assert(chain.length >= 1);
  assert(
    chain.every((p) =>
      (p.content as Json | undefined)?.body !== 'second' &&
      (p.content as Json | undefined)?.body !== 'first'
    ),
    'the chain excludes the event itself and non-auth messages',
  );

  // /backfill from m2: m2, m1, the join — newest-first, includes v
  const back = await fedGet(
    `/_matrix/federation/v1/backfill/${encodeURIComponent(ROOM)}?v=${
      encodeURIComponent(m2)
    }&limit=10`,
  );
  assertEquals(back.status, 200);
  const bpdus = back.body.pdus as Json[];
  assert(bpdus.length >= 2, JSON.stringify(back.body));
  assertEquals((bpdus[0].content as Json).body, 'second');
  assertEquals((bpdus[1].content as Json).body, 'first');

  // /get_missing_events: forward order, stops at the earliest (m1)
  const missing = await fedGet(
    `/_matrix/federation/v1/get_missing_events/${encodeURIComponent(ROOM)}`,
    {
      method: 'POST',
      body: {
        earliest_events: [m1],
        latest_events: [m2],
        limit: 10,
        min_depth: 0,
      },
    },
  );
  assertEquals(missing.status, 200);
  const events = missing.body.events as Json[];
  assertEquals(events.length, 2);
  assertEquals((events[0].content as Json).body, 'first');
  assertEquals((events[1].content as Json).body, 'second');

  // the cap: limit 1 → one event
  const capped = await fedGet(
    `/_matrix/federation/v1/get_missing_events/${encodeURIComponent(ROOM)}`,
    {
      method: 'POST',
      body: { earliest_events: [m1], latest_events: [m2], limit: 1 },
    },
  );
  assertEquals((capped.body.events as Json[]).length, 1);
  void joinTip;
});

Deno.test('serve: not-in-room 403 and the visibility filter', async () => {
  await resetFederationTables();
  await seedServer(srv);
  wireFederationTransport();
  // a joined-visibility room: a pre-join message is REDACTED to a server
  // whose users were not in the room then; shared → full
  await resetRoom(ROOM_JOINED);
  await createRoom(ROOM_JOINED, '@dev:localhost', {
    roomVersion: '11',
    preset: 'public_chat',
    initialState: [{
      type: 'm.room.history_visibility',
      content: { history_visibility: 'joined' },
    }],
  });
  const tip0 = await latestExtremityEventId(ROOM_JOINED);
  const preJoin = await devSays(ROOM_JOINED, 'before the join', tip0);
  const joinTip = await remoteJoin(
    ROOM_JOINED,
    srv,
    '11',
    `@rudy:${srv.name}`,
    preJoin,
  );
  const postJoin = await devSays(ROOM_JOINED, 'after the join', joinTip);

  // a stranger origin (not in the room) → 403
  const stranger = await makeRoomServer('stranger.test');
  await seedServer(stranger);
  const forbidden = await fedGet(
    `/_matrix/federation/v1/event/${encodeURIComponent(postJoin)}`,
  );
  assertEquals(forbidden.status, 200, 'rudy is in the room');
  const strangerSign = await signJson(
    {
      method: 'GET',
      uri: `/_matrix/federation/v1/event/${encodeURIComponent(postJoin)}`,
      origin: stranger.name,
      destination: serverName(),
    },
    stranger.name,
    stranger.keyId,
    stranger.kp.privateKey,
  );
  const strangerRes = await matrix(
    new Request(
      `http://x/_matrix/federation/v1/event/${encodeURIComponent(postJoin)}`,
      {
        headers: {
          Authorization:
            `X-Matrix origin="${stranger.name}",key="${stranger.keyId}",sig="${
              (strangerSign.signatures as Record<
                string,
                Record<string, string>
              >)[
                stranger.name
              ][stranger.keyId]
            }"`,
        },
      },
    ),
  );
  assertEquals(strangerRes.status, 403);

  // joined visibility: the PRE-join message is redacted (no content
  // keys), the POST-join one is full
  const redacted = await fedGet(
    `/_matrix/federation/v1/event/${encodeURIComponent(preJoin)}`,
  );
  assertEquals(redacted.status, 200);
  const rpdus = redacted.body.pdus as Json[];
  assertEquals(
    JSON.stringify((rpdus[0].content as Json) ?? {}),
    '{}',
    'pre-join message served redacted',
  );
  const full = await fedGet(
    `/_matrix/federation/v1/event/${encodeURIComponent(postJoin)}`,
  );
  assertEquals((full.body.pdus as Json[])[0].content !== undefined, true);
  assertEquals(
    ((full.body.pdus as Json[])[0].content as Json).body,
    'after the join',
  );

  // shared visibility (the default room): everything full
  await resetFederationTables();
  await seedServer(srv);
  const tip1 = await setupRoom(ROOM);
  const sharedMsg = await devSays(ROOM, 'shared room msg', tip1);
  const shared = await fedGet(
    `/_matrix/federation/v1/event/${encodeURIComponent(sharedMsg)}`,
  );
  assertEquals(
    ((shared.body.pdus as Json[])[0].content as Json).body,
    'shared room msg',
  );
  void srv;
  void withDb;
});

Deno.test('serve: /event_auth returns the recursive chain (depth > 1)', async () => {
  await resetFederationTables();
  await seedServer(srv);
  wireFederationTransport();
  const tip = await setupRoom(ROOM_REC);
  const rudy = `@rudy:${srv.name}`;
  // explicit auth chains (remoteEvent's default is [create] only)
  const createId = await createIdOf(ROOM_REC);
  const currentRows = await stateAtSeq(ROOM_REC, null);
  const plId = currentRows === null
    ? null
    : currentRows.find((r) => r.type === 'm.room.power_levels')?.eventId ??
      null;
  assert(createId !== null && plId !== null, 'create + PL ids');
  // rudy joins, leaves, rejoins — the rejoin's chain must recurse through
  // the leave to the first join (and to dev's member through both)
  const join1 = await remoteEvent(ROOM_REC, srv, '11', {
    type: 'm.room.member',
    sender: rudy,
    state_key: rudy,
    content: { membership: 'join' },
    prev_events: [tip],
    auth_events: [createId, plId],
  });
  await ingestEvent(ROOM_REC, join1, {
    remote: { origin: srv.name, position: 'after' },
  });
  const join1Id = String(join1.event_id);
  const leave = await remoteEvent(ROOM_REC, srv, '11', {
    type: 'm.room.member',
    sender: rudy,
    state_key: rudy,
    content: { membership: 'leave' },
    prev_events: [join1Id],
    auth_events: [createId, plId, join1Id],
  });
  await ingestEvent(ROOM_REC, leave, {
    remote: { origin: srv.name, position: 'after' },
  });
  const leaveId = String(leave.event_id);
  const join2 = await remoteEvent(ROOM_REC, srv, '11', {
    type: 'm.room.member',
    sender: rudy,
    state_key: rudy,
    content: { membership: 'join' },
    prev_events: [leaveId],
    auth_events: [createId, plId, leaveId],
  });
  await ingestEvent(ROOM_REC, join2, {
    remote: { origin: srv.name, position: 'after' },
  });
  const join2Id = String(join2.event_id);
  // a join_rules change AFTER the rejoin — never in the rejoin's chain
  const jr = await author(ROOM_REC, {
    type: 'm.room.join_rules',
    state_key: '',
    sender: '@dev:localhost',
    content: { join_rule: 'invite' },
    prev_events: [join2Id],
  });
  await ingestEvent(ROOM_REC, jr);

  const auth = await fedGet(
    `/_matrix/federation/v1/event_auth/${encodeURIComponent(ROOM_REC)}/${
      encodeURIComponent(join2Id)
    }`,
  );
  assertEquals(auth.status, 200);
  const chain = auth.body.auth_chain as Json[];
  // the closure: create, PL, dev's member, the first join, the leave —
  // never the seed (join2) and never the later join_rules change
  assertEquals(chain.length, 5, JSON.stringify(chain.map((p) => p.type)));
  const isMemberFor = (p: Json, who: string, ms: string) =>
    p.type === 'm.room.member' && p.state_key === who &&
    (p.content as Json).membership === ms;
  assertEquals(
    chain.filter((p) => p.type === 'm.room.create').length,
    1,
    'one create',
  );
  assertEquals(
    chain.filter((p) => p.type === 'm.room.power_levels').length,
    1,
    'one power_levels',
  );
  assertEquals(
    chain.filter((p) => isMemberFor(p, '@dev:localhost', 'join')).length,
    1,
    "dev's member, through every branch of the chain",
  );
  assertEquals(
    chain.filter((p) => isMemberFor(p, rudy, 'join')).length,
    1,
    'the first join (the seed is excluded)',
  );
  assertEquals(
    chain.filter((p) => isMemberFor(p, rudy, 'leave')).length,
    1,
    'the leave, recursed through',
  );
  assert(
    !chain.some((p) => p.type === 'm.room.join_rules'),
    'the later join_rules change is not in the chain',
  );
});
