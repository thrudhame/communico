import { assertEquals, assertMatch, assertNotEquals } from '@std/assert';
import { createRoom, lookupRoom } from '#engine/room.ts';
import { author, ingestEvent } from '#engine/ingest.ts';
import { eventIdFor } from '#engine/eventid.ts';
import { pduById } from '#engine/timeline.ts';
import { serverDb, withDb } from '#engine/db.ts';
import { latestExtremityEventId, resetRoom } from './util.ts';

const ROOM = '!t3:localhost';
const ID_SHAPE = /^\$[A-Za-z0-9_-]{43}$/;

Deno.test('unified identity: content-hash event ids for every room version', async () => {
  await resetRoom(ROOM);
  const { createEventId } = await createRoom(ROOM, '@dev:localhost', {
    roomVersion: '11',
  });
  const room = (await lookupRoom(ROOM))!;
  const dbName = room.dbName;

  // room_version '11' gets content-hash ids (design §4.1.1)
  assertMatch(createEventId, ID_SHAPE);

  // chain off the current extremity (the join_rules event)
  let prev = await latestExtremityEventId(ROOM);

  // ingest 2 chained messages
  const ids = [prev];
  for (const body of ['b1', 'b2']) {
    const pdu = await author(ROOM, {
      type: 'm.room.message',
      sender: '@dev:localhost',
      content: { body, msgtype: 'm.text' },
      prev_events: [prev],
      origin_server_ts: Date.now(),
    });
    const r = await ingestEvent(ROOM, pdu);
    assertMatch(r.event_id, ID_SHAPE);
    // the event id is content-derived — NOT the commit hash (per-store receipt)
    assertNotEquals(r.event_id, '$' + r.commit_hash);
    ids.push(r.event_id);
    prev = r.event_id;
  }

  // every event_index row maps content-hash id <-> commit hash (8 rows:
  // 6 M4 genesis events + 2 messages), ids uniformly 43-char content
  // hashes
  const rows = await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT event_id, commit_hash FROM event_index WHERE room_id = $1;',
      [ROOM],
    );
    // deno-lint-ignore no-explicit-any
    return r.rows as any[];
  });
  assertEquals(rows.length, 8);
  for (const row of rows) {
    assertMatch(String(row.event_id), ID_SHAPE);
    assertNotEquals(String(row.event_id), '$' + String(row.commit_hash));
  }

  // ids are self-certifying: recomputing the content hash from the stored
  // PDU reproduces the id
  const chunk: { event_id: string; [k: string]: unknown }[] = [];
  {
    const idx = await withDb(serverDb(), async (c) => {
      const r = await c.query(
        'SELECT event_id, commit_hash FROM event_index WHERE room_id = $1 AND rejected = FALSE AND soft_failed = FALSE ORDER BY seq DESC;',
        [ROOM],
      );
      // deno-lint-ignore no-explicit-any
      return r.rows as any[];
    });
    for (const row of idx) {
      chunk.push(
        (await pduById(
          dbName,
          String(row.commit_hash),
          String(row.event_id),
        ))! as unknown as {
          event_id: string;
          [k: string]: unknown;
        },
      );
    }
  }
  assertEquals(chunk.length, 8);
  for (const pdu of chunk) {
    assertEquals(await eventIdFor(pdu, '11'), pdu.event_id);
  }

  // messages returns them newest-first: msg2, msg1, guest_access,
  // history_visibility, join_rules, PL, member, create
  assertEquals(chunk[0].event_id, ids[2]);
  assertEquals(chunk[1].event_id, ids[1]);
  assertEquals(chunk[2].event_id, ids[0]);
  assertEquals(chunk[7].event_id, createEventId);
});
