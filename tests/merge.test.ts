import { assertEquals } from '@std/assert';
import { createRoom, extremities, lookupRoom } from '#engine/room.ts';
import { author, ingestEvent } from '#engine/ingest.ts';
import { reresolveFromDag } from '#engine/adopt.ts';
import { stateNow } from '#engine/timeline.ts';
import { withDb } from '#engine/db.ts';
import { resetRoom } from './util.ts';

const ROOM = '!t2:localhost';

// M3: latest-wins is retired AND the refusal is gone — concurrent state
// edits RESOLVE to one topic via the S4 orderings (equal power -> earlier
// ts orders first, the later applies last and wins), the heal converges,
// and one extremity remains.
Deno.test('fork/heal: concurrent state edits resolve to one topic; heal converges; one extremity', async () => {
  await resetRoom(ROOM);
  const { memberEventId } = await createRoom(ROOM, '@dev:localhost', {
    roomVersion: '11',
  });
  void memberEventId;
  const room = (await lookupRoom(ROOM))!;
  const dbName = room.dbName;

  // base message on the current extremity
  const basePdu = await author(ROOM, {
    type: 'm.room.message',
    sender: '@dev:localhost',
    content: { body: 'E1', msgtype: 'm.text' },
    origin_server_ts: 500,
  });
  const e1 = await ingestEvent(ROOM, basePdu);

  // fork: E2a (topic cats) and E2b (topic dogs), both prev [E1].
  // keepPrevBranches on E2a keeps E1's branch alive for E2b (TEST HOOK).
  const e2a = await ingestEvent(
    ROOM,
    await author(ROOM, {
      type: 'm.room.topic',
      state_key: '',
      sender: '@dev:localhost',
      content: { topic: 'cats' },
      prev_events: [e1.event_id],
      origin_server_ts: 1000,
    }),
    { keepPrevBranches: true },
  );
  const e2b = await ingestEvent(
    ROOM,
    await author(ROOM, {
      type: 'm.room.topic',
      state_key: '',
      sender: '@dev:localhost',
      content: { topic: 'dogs' },
      prev_events: [e1.event_id],
      origin_server_ts: 2000,
    }),
  );

  // 2 extremities
  const xb = await extremities(dbName, ROOM);
  assertEquals(xb.length, 2, 'two x* extremity branches after the fork');

  // the heal RESOLVES: the S4 mainline ordering (equal mainline position,
  // ts ascending) puts E2b last — 'dogs' wins the key
  const heal = await ingestEvent(
    ROOM,
    await author(ROOM, {
      type: 'm.room.message',
      sender: '@dev:localhost',
      content: { body: 'E3', msgtype: 'm.text' },
      prev_events: [e2a.event_id, e2b.event_id],
      origin_server_ts: 3000,
    }),
  );
  void heal;

  // one extremity after the merge; the topic is the spec-determined winner
  const xb2 = await extremities(dbName, ROOM);
  assertEquals(xb2.length, 1, 'one x* extremity after the merge');
  // deno-lint-ignore no-explicit-any
  const st = (await stateNow(dbName)) as any[];
  const topicRow = st.find((r) => r.type === 'm.room.topic');
  assertEquals(topicRow?.content?.topic, 'dogs');
  // the oracle agrees: incremental state == reresolveFromDag
  const before = await stateNow(dbName);
  await reresolveFromDag(ROOM);
  assertEquals(await stateNow(dbName), before);
});

// Messages (non-state) over a forked pair still merge: no state key is
// contested, so resolution succeeds and the DAG converges.
Deno.test('fork/heal: uncontested message heal converges', async () => {
  await resetRoom(ROOM);
  await createRoom(ROOM, '@dev:localhost', { roomVersion: '11' });

  const basePdu = await author(ROOM, {
    type: 'm.room.message',
    sender: '@dev:localhost',
    content: { body: 'base', msgtype: 'm.text' },
    origin_server_ts: 500,
  });
  const base = await ingestEvent(ROOM, basePdu);

  const m1 = await ingestEvent(
    ROOM,
    await author(ROOM, {
      type: 'm.room.message',
      sender: '@dev:localhost',
      content: { body: 'side-a', msgtype: 'm.text' },
      prev_events: [base.event_id],
      origin_server_ts: 1000,
    }),
    { keepPrevBranches: true },
  );
  const m2 = await ingestEvent(
    ROOM,
    await author(ROOM, {
      type: 'm.room.message',
      sender: '@dev:localhost',
      content: { body: 'side-b', msgtype: 'm.text' },
      prev_events: [base.event_id],
      origin_server_ts: 2000,
    }),
  );
  const heal = await ingestEvent(
    ROOM,
    await author(ROOM, {
      type: 'm.room.message',
      sender: '@dev:localhost',
      content: { body: 'heal', msgtype: 'm.text' },
      prev_events: [m1.event_id, m2.event_id],
      origin_server_ts: 3000,
    }),
  );

  // E3's commit has exactly 2 parents (scalar-subquery form — planner bug)
  const room = (await lookupRoom(ROOM))!;
  await withDb(room.dbName, async (c) => {
    const anc = await c.query(
      `SELECT parent_hash FROM dolt.commit_ancestors
       WHERE commit_hash = $1;`,
      [heal.commit_hash],
    );
    // deno-lint-ignore no-explicit-any
    const parents = new Set(anc.rows.map((r: any) => String(r.parent_hash)));
    assertEquals(parents.size, 2, 'heal commit must have exactly 2 parents');
  });

  // single extremity after the merge
  const xb2 = await extremities(room.dbName, ROOM);
  assertEquals(xb2.length, 1, 'one x* extremity after the merge');
});
