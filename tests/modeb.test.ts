import { assertEquals } from '@std/assert';
import {
  createRoom,
  dbNameFor,
  lookupRoom,
} from '../api/engine/room.ts';
import { ingestEvent } from '../api/engine/ingest.ts';
import { messages } from '../api/engine/timeline.ts';
import { SERVER_DB, withDb } from '../api/engine/db.ts';

const ROOM = '!t3:localhost';

async function cleanup() {
  const dbName = await dbNameFor(ROOM);
  await withDb(SERVER_DB, async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${dbName};`);
    await c.query('DELETE FROM room_directory WHERE room_id = $1;', [ROOM]);
    await c.query('DELETE FROM event_index WHERE room_id = $1;', [ROOM]);
  });
}

Deno.test('mode B: wire event id is $+commit_hash; messages carry wire ids', async () => {
  await cleanup();
  await createRoom(ROOM, 'test.communico.dolt.v1', '@dev:localhost');
  const room = (await lookupRoom(ROOM))!;
  const dbName = room.dbName;

  // create event's wire id = the only event_index row so far
  let prevWire: string = await withDb(SERVER_DB, async (c) => {
    const r = await c.query(
      'SELECT event_id FROM event_index WHERE room_id = $1;',
      [ROOM],
    );
    return String(r.rows[0].event_id);
  });

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

  // every event_index row: event_id == '$' + commit_hash
  const rows = await withDb(SERVER_DB, async (c) => {
    const r = await c.query(
      'SELECT event_id, commit_hash FROM event_index WHERE room_id = $1;',
      [ROOM],
    );
    // deno-lint-ignore no-explicit-any
    return r.rows as any[];
  });
  assertEquals(rows.length, 3);
  for (const row of rows) {
    assertEquals(String(row.event_id), '$' + String(row.commit_hash));
  }

  // messages returns them with the wire ids (newest-first)
  // deno-lint-ignore no-explicit-any
  const chunk = (await messages(dbName, ROOM)) as any[];
  assertEquals(chunk.length, 3);
  assertEquals(chunk[0].event_id, wireIds[2]);
  assertEquals(chunk[1].event_id, wireIds[1]);
  assertEquals(chunk[2].event_id, wireIds[0]);
  // and the wire ids are '$'+commit shape
  for (const e of chunk) {
    assertEquals(e.event_id, '$' + e.event_id.slice(1));
  }
});
