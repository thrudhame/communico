import { assert, assertEquals } from '@std/assert';
import { createRoom } from '#engine/room.ts';
import { author, ingestEvent } from '#engine/ingest.ts';
import { syncSince } from '#engine/syncfeed.ts';
import { SERVER_DB, withDb } from '#engine/db.ts';
import { latestExtremityEventId, resetRoom } from './util.ts';

const ROOM = '!t5:localhost';

async function maxSeq(): Promise<number> {
  return await withDb(SERVER_DB, async (c) => {
    const r = await c.query('SELECT MAX(seq) AS m FROM event_index;');
    return Number(r.rows[0].m);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.test('syncSince: initial, incremental, and long-poll', async () => {
  await resetRoom(ROOM);
  await createRoom(ROOM, '11', '@dev:localhost');

  let prev = await latestExtremityEventId(ROOM);
  for (const body of ['s1', 's2']) {
    const pdu = await author(ROOM, {
      type: 'm.room.message',
      sender: '@dev:localhost',
      content: { body, msgtype: 'm.text' },
      prev_events: [prev],
      origin_server_ts: Date.now(),
    });
    const r = await ingestEvent(ROOM, pdu);
    prev = r.event_id;
  }

  // 2. initial sync: create + member + PL + join_rules + 2 messages,
  // wire ids, seq order
  const initial = await syncSince(null, 0);
  const jr = initial.rooms.join[ROOM] as {
    timeline: { events: { event_id: string; type: string }[] };
    state: { events: unknown[] };
  };
  assert(jr, 'join map must contain the room');
  assertEquals(jr.timeline.events.length, 6);
  assertEquals(
    jr.timeline.events.map((e) => e.type),
    [
      'm.room.create',
      'm.room.member',
      'm.room.power_levels',
      'm.room.join_rules',
      'm.room.message',
      'm.room.message',
    ],
  );
  // event ids are the wire ids from event_index
  const idx = await withDb(SERVER_DB, async (c) => {
    const r = await c.query(
      'SELECT event_id FROM event_index WHERE room_id = $1 ORDER BY seq;',
      [ROOM],
    );
    // deno-lint-ignore no-explicit-any
    return r.rows.map((row: any) => String(row.event_id));
  });
  assertEquals(jr.timeline.events.map((e) => e.event_id), idx);
  // state events present on initial sync (create + member + PL + join_rules)
  assertEquals(jr.state.events.length, 4);
  const max = await maxSeq();
  assertEquals(initial.next_batch, 's' + max);

  // 3. incremental at max: join map still contains every room (nio
  //    self.rooms cache guarantee), but all their timelines are empty
  const empty = await syncSince(max, 0);
  for (const room of Object.values(empty.rooms.join)) {
    assertEquals((room as { timeline: { events: unknown[] } }).timeline.events.length, 0);
  }
  assertEquals(empty.next_batch, 's' + max);

  // 4. one more message -> exactly 1 event, correct wire id
  const pdu4 = await author(ROOM, {
    type: 'm.room.message',
    sender: '@dev:localhost',
    content: { body: 's3', msgtype: 'm.text' },
    prev_events: [prev],
    origin_server_ts: Date.now(),
  });
  const r4 = await ingestEvent(ROOM, pdu4);
  const inc = await syncSince(max, 0);
  const jinc = inc.rooms.join[ROOM] as {
    timeline: { events: { event_id: string }[] };
  };
  assertEquals(jinc.timeline.events.length, 1);
  assertEquals(jinc.timeline.events[0].event_id, r4.event_id);
  const max2 = await maxSeq();
  assertEquals(inc.next_batch, 's' + max2);

  // 5. long-poll: syncSince(max2, 5000) resolves early with the new event
  const t0 = performance.now();
  const pending = syncSince(max2, 5000);
  await sleep(1000);
  const pdu5 = await author(ROOM, {
    type: 'm.room.message',
    sender: '@dev:localhost',
    content: { body: 's4', msgtype: 'm.text' },
    prev_events: [r4.event_id],
    origin_server_ts: Date.now(),
  });
  const r5 = await ingestEvent(ROOM, pdu5);
  const lp = await pending;
  const elapsed = performance.now() - t0;
  assert(elapsed < 4000, `long-poll took ${elapsed}ms, expected < 4000`);
  const jlp = lp.rooms.join[ROOM] as {
    timeline: { events: { event_id: string }[] };
  };
  assertEquals(jlp.timeline.events.length, 1);
  assertEquals(jlp.timeline.events[0].event_id, r5.event_id);
});
