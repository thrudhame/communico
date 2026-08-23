import { assertEquals } from '@std/assert';
import { createRoom, lookupRoom } from '../api/engine/room.ts';
import { ingestEvent } from '../api/engine/ingest.ts';
import { messages } from '../api/engine/timeline.ts';
import { SERVER_DB, withDb } from '../api/engine/db.ts';
import { latestExtremityEventId, resetRoom } from './util.ts';

const ROOM = '!t3:localhost';

Deno.test('mode B: wire event id is $+commit_hash; messages carry wire ids', async () => {
  await resetRoom(ROOM);
  const { createEventId } = await createRoom(
    ROOM,
    'test.communico.dolt.v1',
    '@dev:localhost',
  );
  const room = (await lookupRoom(ROOM))!;
  const dbName = room.dbName;

  // chain off the current extremity (the member event)
  let prevWire = await latestExtremityEventId(ROOM);

  // ingest 2 chained messages
  const wireIds = [prevWire];
  for (const body of ['b1', 'b2']) {
    const r = await ingestEvent(ROOM, {
      type: 'm.room.message',
      sender: '@dev:localhost',
      content: { body, msgtype: 'm.text' },
      prev_events: [prevWire],
      origin_ts: Date.now(),
    });
    // every returned event_id equals '$' + its commit hash
    assertEquals(r.event_id, '$' + r.commit_hash);
    wireIds.push(r.event_id);
    prevWire = r.event_id;
  }

  // every event_index row: event_id == '$' + commit_hash (4 rows:
  // create + member + 2 messages)
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
    assertEquals(String(row.event_id), '$' + String(row.commit_hash));
  }

  // messages returns them with the wire ids (newest-first):
  // msg2, msg1, member, create
  // deno-lint-ignore no-explicit-any
  const chunk = (await messages(dbName, ROOM)) as any[];
  assertEquals(chunk.length, 4);
  assertEquals(chunk[0].event_id, wireIds[2]);
  assertEquals(chunk[1].event_id, wireIds[1]);
  assertEquals(chunk[2].event_id, wireIds[0]);
  assertEquals(chunk[3].event_id, createEventId);
  for (const e of chunk) {
    assertEquals(e.event_id, '$' + e.event_id.slice(1));
  }
});
