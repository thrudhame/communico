import { assert, assertEquals, assertRejects } from '@std/assert';
import {
  createRoom,
  dbNameFor,
  extremities,
  lookupRoom,
} from '../api/engine/room.ts';
import { ingestEvent } from '../api/engine/ingest.ts';
import { SERVER_DB, withDb } from '../api/engine/db.ts';

const ROOM = '!t4:localhost';

async function cleanup() {
  const dbName = await dbNameFor(ROOM);
  await withDb(SERVER_DB, async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${dbName};`);
    await c.query('DELETE FROM room_directory WHERE room_id = $1;', [ROOM]);
    await c.query('DELETE FROM event_index WHERE room_id = $1;', [ROOM]);
  });
}

Deno.test('>2 prev_events: clean rejection (D1), no commit, branches intact', async () => {
  await cleanup();
  await createRoom(ROOM, '10', '@dev:localhost');
  const room = (await lookupRoom(ROOM))!;
  const dbName = room.dbName;

  const createId: string = await withDb(SERVER_DB, async (c) => {
    const r = await c.query(
      'SELECT event_id FROM event_index WHERE room_id = $1;',
      [ROOM],
    );
    return String(r.rows[0].event_id);
  });

  // E1, E2, E3 all with prev_events = [create]; keepPrevBranches on the
  // first two keeps `create`'s branch alive for the next; E3 (normal)
  // consumes it -> exactly three extremities: x<E1>, x<E2>, x<E3>
  const ids: string[] = [];
  for (const [i, keep] of [[0, true], [1, true], [2, false]] as const) {
    const r = await ingestEvent(ROOM, {
      type: 'm.room.message',
      sender: '@dev:localhost',
      content: { body: `E${i + 1}`, msgtype: 'm.text' },
      prev_events: [createId],
      origin_ts: 1000 + i,
    }, { keepPrevBranches: keep });
    ids.push(r.event_id);
  }

  const xb = await extremities(dbName);
  assertEquals(xb.length, 3, 'three extremity branches');

  // commit count across all branches before the attempt
  const totalCommits = () =>
    withDb(dbName, async (c) => {
      const branches = await c.query('SELECT name FROM dolt.branches;');
      const seen = new Set<string>();
      // deno-lint-ignore no-explicit-any
      for (const b of branches.rows as any[]) {
        const log = await c.query(
          `SELECT commit_hash FROM dolt_log('${String(b.name)}');`,
        );
        // deno-lint-ignore no-explicit-any
        for (const row of log.rows as any[]) seen.add(String(row.commit_hash));
      }
      return seen.size;
    });
  const before = await totalCommits();

  // the probe: 3 prevs must be rejected
  const err = await assertRejects(
    () =>
      ingestEvent(ROOM, {
        type: 'm.room.message',
        sender: '@dev:localhost',
        content: { body: 'too many prevs', msgtype: 'm.text' },
        prev_events: ids,
        origin_ts: 2000,
      }),
    Error,
  );
  assert(
    err.message.startsWith('M_TOO_MANY_PREV_EVENTS'),
    `unexpected error message: ${err.message}`,
  );

  // no new commit appeared; extremity set unchanged
  const after = await totalCommits();
  assertEquals(after, before, 'dolt.log count must be unchanged');
  const xb2 = await extremities(dbName);
  assertEquals(xb2.sort(), xb.sort(), 'same three extremity branches');
});
