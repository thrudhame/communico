import { assertEquals, assertMatch, assertNotEquals } from '@std/assert';
import { createRoom, lookupRoom } from '../api/engine/room.ts';
import { ingestEvent } from '../api/engine/ingest.ts';
import { eventIdFor } from '../api/engine/eventid.ts';
import { messages } from '../api/engine/timeline.ts';
import { SERVER_DB, withDb } from '../api/engine/db.ts';
import { latestExtremityEventId, resetRoom } from './util.ts';

const ROOM = '!t3:localhost';
const ID_SHAPE = /^\$[A-Za-z0-9_-]{43}$/;

Deno.test('unified identity: content-hash event ids for every room version', async () => {
  await resetRoom(ROOM);
  const { createEventId } = await createRoom(
    ROOM,
    'test.communico.dolt.v1',
    '@dev:localhost',
  );
  const room = (await lookupRoom(ROOM))!;
  const dbName = room.dbName;

  // room_version is hat-facing metadata only: even the legacy native-mode
  // version string gets content-hash ids now (design §4.1.1)
  assertMatch(createEventId, ID_SHAPE);

  // chain off the current extremity (the member event)
  let prev = await latestExtremityEventId(ROOM);

  // ingest 2 chained messages
  const ids = [prev];
  for (const body of ['b1', 'b2']) {
    const r = await ingestEvent(ROOM, {
      type: 'm.room.message',
      sender: '@dev:localhost',
      content: { body, msgtype: 'm.text' },
      prev_events: [prev],
      origin_ts: Date.now(),
    });
    assertMatch(r.event_id, ID_SHAPE);
    // the event id is content-derived — NOT the commit hash (per-store receipt)
    assertNotEquals(r.event_id, '$' + r.commit_hash);
    ids.push(r.event_id);
    prev = r.event_id;
  }

  // every event_index row maps content-hash id <-> commit hash (4 rows:
  // create + member + 2 messages), ids uniformly 43-char content hashes
  const rows = await withDb(SERVER_DB, async (c) => {
    const r = await c.query(
      'SELECT event_id, commit_hash FROM event_index WHERE room_id = $1;',
      [ROOM],
    );
    // deno-lint-ignore no-explicit-any
    return r.rows as any[];
  });
  assertEquals(rows.length, 4);
  for (const row of rows) {
    assertMatch(String(row.event_id), ID_SHAPE);
    assertNotEquals(String(row.event_id), '$' + String(row.commit_hash));
  }

  // ids are self-certifying: recomputing the content hash from the stored
  // PDU (minus event_id) reproduces the id
  const chunk = (await messages(dbName, ROOM)) as {
    event_id: string;
    [k: string]: unknown;
  }[];
  assertEquals(chunk.length, 4);
  for (const pdu of chunk) {
    assertEquals(await eventIdFor(pdu), pdu.event_id);
  }

  // messages returns them newest-first: msg2, msg1, member, create
  assertEquals(chunk[0].event_id, ids[2]);
  assertEquals(chunk[1].event_id, ids[1]);
  assertEquals(chunk[2].event_id, ids[0]);
  assertEquals(chunk[3].event_id, createEventId);
});
