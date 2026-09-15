import { assert, assertEquals, assertMatch, assertRejects } from '@std/assert';
import { createRoom, extremities, lookupRoom } from '#engine/room.ts';
import { author, ingestEvent } from '#engine/ingest.ts';
import { reresolveFromDag } from '#engine/adopt.ts';
import { stateNow } from '#engine/timeline.ts';
import { serverDb, withDb } from '#engine/db.ts';
import { latestExtremityEventId, resetRoom } from './util.ts';

const ROOM = '!policy:localhost';
const ID_SHAPE = /^\$[A-Za-z0-9_-]{43}$/;

// Genesis sequence (create -> join -> PL -> join_rules) passes the v11
// rulebook.
Deno.test('policy: v11 genesis sequence passes the rulebook', async () => {
  await resetRoom(ROOM);
  const { createEventId, memberEventId } = await createRoom(
    ROOM,
    '11',
    '@dev:localhost',
  );
  assertMatch(createEventId, ID_SHAPE);
  assertMatch(memberEventId, ID_SHAPE);

  // genesis shape: create (no creator, room_version 11), join, PL, join_rules
  const room = (await lookupRoom(ROOM))!;
  const pdus = await withDb(room.dbName, async (c) => {
    const b = await c.query(
      `SELECT name FROM dolt.branches WHERE name LIKE 'x%' ORDER BY latest_commit_date DESC, name ASC LIMIT 1;`,
    );
    // deno-lint-ignore no-explicit-any
    const branch = String((b.rows as any[])[0].name);
    const h = await c.query(`SELECT HASHOF('${branch}') AS h;`);
    const hash = String(h.rows[0].h);
    const r = await c.query(
      `SELECT canonical_json FROM events AS OF '${hash}';`,
    );
    // deno-lint-ignore no-explicit-any
    return (r.rows as any[]).map((row) =>
      typeof row.canonical_json === 'string'
        ? JSON.parse(row.canonical_json)
        : row.canonical_json
    );
  });
  const byType = (t: string) => pdus.filter((p) => p.type === t);
  assertEquals(byType('m.room.create').length, 1);
  const create = byType('m.room.create')[0];
  assertEquals(create.content, { room_version: '11' });
  assert(!('creator' in create.content), 'v11 create has no creator');
  assertEquals(create.depth, 1, 'genesis depth is 1');
  assertEquals(create.auth_events, []);
  assertEquals(byType('m.room.member').length, 1);
  const pl = byType('m.room.power_levels')[0];
  assertEquals(pl.content.users, { '@dev:localhost': 100 });
  assertEquals(pl.content.state_default, 50);
  assertEquals(byType('m.room.join_rules')[0].content, {
    join_rule: 'invite',
  });
  // every genesis event is signed by the server key, depth-linked, id-shaped
  for (const p of pdus) {
    assertMatch(p.event_id, ID_SHAPE);
    assert(
      p.signatures && Object.keys(p.signatures).length > 0,
      'genesis events are signed',
    );
  }
  // depths chain 1..4
  const depths = [...pdus].sort((a, b) => a.depth - b.depth).map((p) =>
    p.depth
  );
  assertEquals(depths, [1, 2, 3, 4]);
});

// A member forging ts=2^53 is refused (canonical int range) — the seizure
// that owned any state key forever under latest-wins.
Deno.test('policy: ts=2^53 seize is refused', async () => {
  await resetRoom(ROOM);
  await createRoom(ROOM, '11', '@dev:localhost');
  const prev = await latestExtremityEventId(ROOM);
  const err = await assertRejects(() =>
    author(ROOM, {
      type: 'm.room.topic',
      state_key: '',
      sender: '@dev:localhost',
      content: { topic: 'seized' },
      prev_events: [prev],
      origin_server_ts: 2 ** 53,
    }), Error);
  assert(
    String(err).includes('M_BAD_EVENT') ||
      String(err).includes('out-of-range'),
    `unexpected error: ${String(err)}`,
  );
  // nothing landed: extremity still the pre-seize tip
  assertEquals(await latestExtremityEventId(ROOM), prev);
});

// A non-member's write is state-rejected (and stays out of state).
Deno.test('policy: non-member write is state-rejected', async () => {
  await resetRoom(ROOM);
  await createRoom(ROOM, '11', '@dev:localhost');
  const prev = await latestExtremityEventId(ROOM);
  const pdu = await author(ROOM, {
    type: 'm.room.message',
    sender: '@mallory:localhost',
    content: { body: 'intruder', msgtype: 'm.text' },
    prev_events: [prev],
    origin_server_ts: 1000,
  });
  const err = await assertRejects(() => ingestEvent(ROOM, pdu), Error);
  assert(
    String(err).includes('M_STATE_REJECT'),
    `unexpected error: ${String(err)}`,
  );
  // rejected: in the DAG (indexed, flagged) but never in state
  await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT rejected FROM event_index WHERE event_id = $1;',
      [pdu.event_id],
    );
    assertEquals(r.rows.length, 1);
    assertEquals(r.rows[0].rejected, true);
  });
  // deno-lint-ignore no-explicit-any
  const st = (await stateNow((await lookupRoom(ROOM))!.dbName)) as any[];
  assert(
    !st.some((r) => r.event_id === pdu.event_id),
    'rejected event must never enter state',
  );
});

// Concurrent power-level edits now RESOLVE (M3): the S4 orderings pick the
// winner — both edits are by the same sender (equal power), so the
// reverse-topological power ordering ties and origin_server_ts breaks it
// (earlier first); the later edit applies last and wins the key. The heal
// then converges to one extremity.
Deno.test('policy: concurrent PL edits resolve; the heal succeeds; one extremity', async () => {
  await resetRoom(ROOM);
  await createRoom(ROOM, '11', '@dev:localhost');
  const base = await latestExtremityEventId(ROOM);

  const pla = await author(ROOM, {
    type: 'm.room.power_levels',
    state_key: '',
    sender: '@dev:localhost',
    content: { users: { '@dev:localhost': 100 }, state_default: 0 },
    prev_events: [base],
    origin_server_ts: 1000,
  });
  const ra = await ingestEvent(ROOM, pla, { keepPrevBranches: true });
  void ra;
  const plb = await author(ROOM, {
    type: 'm.room.power_levels',
    state_key: '',
    sender: '@dev:localhost',
    content: { users: { '@dev:localhost': 100 }, state_default: 100 },
    prev_events: [base],
    // S4 70-71: equal power -> the earlier origin_server_ts orders first,
    // so this LATER edit legitimately applies last and wins (not a
    // latest-wins guess — a specified tie-break).
    origin_server_ts: 9999999999999,
  });
  await ingestEvent(ROOM, plb);

  const room = (await lookupRoom(ROOM))!;
  const xb = await extremities(room.dbName, ROOM);
  assertEquals(xb.length, 2, 'fork stands: two extremities');

  // the heal RESOLVES (the refusing stub is gone): one extremity after
  const heal = await ingestEvent(
    ROOM,
    await author(ROOM, {
      type: 'm.room.message',
      sender: '@dev:localhost',
      content: { body: 'heal', msgtype: 'm.text' },
      prev_events: [pla.event_id!, plb.event_id!],
      origin_server_ts: 3000,
    }),
  );
  void heal;
  const xb2 = await extremities(room.dbName, ROOM);
  assertEquals(xb2.length, 1, 'the fork healed to one extremity');

  // the resolved winner is the spec-determined one: PLB (later ts, applied
  // last) — state_default 100
  // deno-lint-ignore no-explicit-any
  const st = (await stateNow(room.dbName)) as any[];
  const plRow = st.find((r) => r.type === 'm.room.power_levels');
  assertEquals(plRow?.content?.state_default, 100);
  // the oracle agrees: incremental state == reresolveFromDag
  const before = await stateNow(room.dbName);
  await reresolveFromDag(ROOM);
  assertEquals(await stateNow(room.dbName), before);
});

// A forged conflict-free `state` row is dropped by re-resolution (the DAG
// is the authority; state without a validated event behind it cannot
// survive).
Deno.test('policy: forged adoption state is dropped', async () => {
  await resetRoom(ROOM);
  await createRoom(ROOM, '11', '@dev:localhost');
  const room = (await lookupRoom(ROOM))!;
  // forge: a state row with no event behind it (simulates a peer image's
  // forged conflict-free map)
  await withDb(room.dbName, async (c) => {
    const b = await c.query(
      `SELECT name FROM dolt.branches WHERE name LIKE 'x%' ORDER BY latest_commit_date DESC LIMIT 1;`,
    );
    await c.query(`SELECT DOLT_CHECKOUT('${String(b.rows[0].name)}');`);
    await c.query(
      `INSERT INTO state (type, state_key, event_id, content) VALUES ('m.room.topic', '', '$forged', '{"topic":"forged"}');`,
    );
    await c.query(`SELECT DOLT_COMMIT('-Am', 'forged state row');`);
  });
  const res = await reresolveFromDag(ROOM);
  assertEquals(res.eventCount, 4, 'genesis has 4 events');
  // deno-lint-ignore no-explicit-any
  const st = (await stateNow(room.dbName)) as any[];
  assert(
    !st.some((r) => r.event_id === '$forged'),
    'forged row must be dropped by re-resolution',
  );
  assert(st.some((r) => r.type === 'm.room.create'), 'real state survives');
});
