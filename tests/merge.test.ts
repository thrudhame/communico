import { assert, assertEquals } from '@std/assert';
import {
  createRoom,
  extremities,
  lookupRoom,
} from '../api/engine/room.ts';
import { ingestEvent } from '../api/engine/ingest.ts';
import { messages, stateNow } from '../api/engine/timeline.ts';
import { withDb } from '../api/engine/db.ts';
import { resetRoom } from './util.ts';

const ROOM = '!t2:localhost';


Deno.test('fork/merge: 2-prev event lands a 2-parent commit, latest-wins state', async () => {
  await resetRoom(ROOM);
  const { memberEventId } = await createRoom(ROOM, '10', '@dev:localhost');
  const room = (await lookupRoom(ROOM))!;
  const dbName = room.dbName;

  // E1 (message) on top of the current extremity (the member event)
  const e1 = await ingestEvent(ROOM, {
    type: 'm.room.message',
    sender: '@dev:localhost',
    content: { body: 'E1', msgtype: 'm.text' },
    prev_events: [memberEventId],
    origin_ts: 500,
  });

  // fork: E2a (topic cats, ts 1000) and E2b (topic dogs, ts 2000), both
  // with prev_events [E1]. keepPrevBranches on E2a keeps E1's branch
  // alive so E2b can reference it (TEST HOOK, recorded in RESULTS.md).
  const e2a = await ingestEvent(ROOM, {
    type: 'm.room.topic',
    state_key: '',
    sender: '@dev:localhost',
    content: { topic: 'cats' },
    prev_events: [e1.event_id],
    origin_ts: 1000,
  }, { keepPrevBranches: true });
  const e2b = await ingestEvent(ROOM, {
    type: 'm.room.topic',
    state_key: '',
    sender: '@dev:localhost',
    content: { topic: 'dogs' },
    prev_events: [e1.event_id],
    origin_ts: 2000,
  });

  // 2 extremities
  const xb = await extremities(dbName);
  assertEquals(xb.length, 2, 'two x* extremity branches after the fork');

  // E3 merges the fork
  const e3 = await ingestEvent(ROOM, {
    type: 'm.room.message',
    sender: '@dev:localhost',
    content: { body: 'E3', msgtype: 'm.text' },
    prev_events: [e2a.event_id, e2b.event_id],
    origin_ts: 3000,
  });

  // E3's commit has exactly 2 parents (scalar-subquery form — planner bug)
  await withDb(dbName, async (c) => {
    const anc = await c.query(
      `SELECT parent_hash FROM dolt.commit_ancestors
       WHERE commit_hash = $1;`,
      [e3.commit_hash],
    );
    // deno-lint-ignore no-explicit-any
    const parents = new Set(anc.rows.map((r: any) => String(r.parent_hash)));
    assertEquals(parents.size, 2, 'E3 commit must have exactly 2 parents');
  });

  // latest-wins: E2b (ts 2000) beats E2a (ts 1000) -> topic = dogs
  // deno-lint-ignore no-explicit-any
  const st = (await stateNow(dbName)) as any[];
  const topic = st.find((r) => r.type === 'm.room.topic');
  assert(topic, 'state must contain m.room.topic');
  assertEquals(topic.event_id, e2b.event_id);
  assertEquals(topic.content.topic, 'dogs');

  // single extremity after the merge
  const xb2 = await extremities(dbName);
  assertEquals(xb2.length, 1, 'one x* extremity after the merge');

  // causal order in /messages (newest-first): E3 first, then E2a/E2b,
  // then E1, then create
  // deno-lint-ignore no-explicit-any
  const chunk = (await messages(dbName, ROOM)) as any[];
  const pos = (id: string) => chunk.findIndex((e) => e.event_id === id);
  assert(pos(e3.event_id) !== -1 && pos(e2a.event_id) !== -1 &&
    pos(e2b.event_id) !== -1 && pos(e1.event_id) !== -1);
  assert(
    pos(e3.event_id) < pos(e2a.event_id) &&
      pos(e3.event_id) < pos(e2b.event_id),
    'E3 (merge) must come before its prevs in newest-first order',
  );
  assert(
    pos(e2a.event_id) < pos(e1.event_id) &&
      pos(e2b.event_id) < pos(e1.event_id),
    'E2a/E2b must come before E1 in newest-first order',
  );
});
