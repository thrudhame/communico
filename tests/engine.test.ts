import { assertEquals } from '@std/assert';
import { createRoom, extremities, lookupRoom } from '../api/engine/room.ts';
import { ingestEvent } from '../api/engine/ingest.ts';
import { messages } from '../api/engine/timeline.ts';
import { SERVER_DB, withDb } from '../api/engine/db.ts';
import { latestExtremityEventId, resetRoom } from './util.ts';

const ROOM = '!t1:localhost';

Deno.test('engine invariant: commit = event', async () => {
  await resetRoom(ROOM);
  const { createEventId, memberEventId } = await createRoom(
    ROOM,
    '10',
    '@dev:localhost',
  );
  const room = (await lookupRoom(ROOM))!;
  const dbName = room.dbName;

  // first message chains off the CURRENT extremity (the member event)
  let prev = await latestExtremityEventId(ROOM);
  assertEquals(prev, memberEventId);

  // 3 chained message events
  const ids: string[] = [];
  for (const body of ['m1', 'm2', 'm3']) {
    const r = await ingestEvent(ROOM, {
      type: 'm.room.message',
      sender: '@dev:localhost',
      content: { body, msgtype: 'm.text' },
      prev_events: [prev],
      origin_ts: Date.now(),
    });
    ids.push(r.event_id);
    prev = r.event_id;
  }

  // commit count: 2 implicit init commits (baseline recorded in
  // RESULTS.md) + schema genesis + create + member + 3 messages = 8
  await withDb(dbName, async (c) => {
    const xb = await c.query(
      "SELECT name FROM dolt.branches WHERE name LIKE 'x%';",
    );
    assertEquals(xb.rows.length, 1, 'exactly ONE x* extremity branch');
    await c.query(`SELECT DOLT_CHECKOUT('${xb.rows[0].name}');`);
    const cnt = await c.query('SELECT count(*) AS c FROM dolt.log;');
    assertEquals(Number(cnt.rows[0].c), 8);
  });

  // each event commit diffs exactly 1 added events row (5 event commits:
  // create, member, 3 messages)
  const commits: string[] = await withDb(SERVER_DB, async (c) => {
    const r = await c.query(
      'SELECT commit_hash FROM event_index WHERE room_id = $1;',
      [ROOM],
    );
    // deno-lint-ignore no-explicit-any
    return r.rows.map((row: any) => String(row.commit_hash));
  });
  assertEquals(commits.length, 5);
  await withDb(dbName, async (c) => {
    for (const h of commits) {
      const d = await c.query(
        `SELECT * FROM dolt_diff('${h}~', '${h}', 'events');`,
      );
      assertEquals(
        d.rows.length,
        1,
        `diff of ${h} must touch exactly 1 events row`,
      );
      assertEquals(d.rows[0].diff_type, 'added');
    }
  });

  // messages newest-first: msg3, msg2, msg1, member, create
  // deno-lint-ignore no-explicit-any
  const chunk = (await messages(dbName, ROOM)) as any[];
  assertEquals(chunk.length, 5);
  assertEquals(chunk[0].event_id, ids[2]);
  assertEquals(chunk[1].event_id, ids[1]);
  assertEquals(chunk[2].event_id, ids[0]);
  assertEquals(chunk[3].event_id, memberEventId);
  assertEquals(chunk[4].event_id, createEventId);

  // single extremity
  const xb = await extremities(dbName, ROOM);
  assertEquals(xb.length, 1);
});
