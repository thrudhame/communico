import { assert, assertEquals, assertRejects } from '@std/assert';
import { createRoom, extremities, lookupRoom } from '#engine/room.ts';
import { author, ingestEvent } from '#engine/ingest.ts';
import { withDb } from '#engine/db.ts';
import { latestExtremityEventId, resetRoom } from './util.ts';

const ROOM = '!t4:localhost';

Deno.test('>20 prev_events: clean rejection (v11 bound), no commit, branches intact', async () => {
  await resetRoom(ROOM);
  const { memberEventId } = await createRoom(ROOM, '11', '@dev:localhost');
  void memberEventId;
  const room = (await lookupRoom(ROOM))!;
  const dbName = room.dbName;

  // E1, E2, E3 all with prev_events = [latest extremity]; keepPrevBranches
  // on the first two keeps branches alive for the next -> exactly three
  // extremities: x<E1>, x<E2>, x<E3>
  const tip = await latestExtremityEventId(ROOM);
  const ids: string[] = [];
  for (const [i, keep] of [[0, true], [1, true], [2, false]] as const) {
    const r = await ingestEvent(
      ROOM,
      await author(ROOM, {
        type: 'm.room.message',
        sender: '@dev:localhost',
        content: { body: `E${i + 1}`, msgtype: 'm.text' },
        prev_events: [tip],
        origin_server_ts: 1000 + i,
      }),
      { keepPrevBranches: keep },
    );
    void r;
    // re-read the tip each round is wrong here — all three share [tip]
    ids.push(await latestExtremityEventId(ROOM));
  }

  const xb = await extremities(dbName, ROOM);
  assertEquals(xb.length, 3, 'three extremity branches');

  // commit census across all branches before the attempt
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

  // the probe: 21 prevs must be rejected (v11 allows at most 20)
  const many = [...ids, ...ids, ...ids, ...ids, ...ids, ...ids, ...ids].slice(
    0,
    21,
  );
  assertEquals(many.length, 21);
  const err = await assertRejects(
    () =>
      ingestEvent(ROOM, {
        type: 'm.room.message',
        room_id: ROOM,
        sender: '@dev:localhost',
        content: { body: 'too many prevs', msgtype: 'm.text' },
        prev_events: many,
        auth_events: [],
        depth: 99,
        origin_server_ts: 2000,
        hashes: { sha256: 'x' },
        signatures: {},
      }),
    Error,
  );
  assert(
    err.message.startsWith('M_TOO_MANY_PREV_EVENTS'),
    `unexpected error message: ${err.message}`,
  );

  // no new commit appeared; extremity set unchanged
  const after = await totalCommits();
  assertEquals(after, before, 'commit count must be unchanged');
  const xb2 = await extremities(dbName, ROOM);
  assertEquals(
    xb2.map((e) => e.branch).sort(),
    xb.map((e) => e.branch).sort(),
    'same three extremity branches',
  );
});

// A 3-prev message over three extremities chains 2-parent commits, keeps
// all 3 in prev_events, and converges to one extremity.
Deno.test('3-prev message: chained commits, full DAG, single extremity', async () => {
  await resetRoom(ROOM);
  await createRoom(ROOM, '11', '@dev:localhost');
  const room = (await lookupRoom(ROOM))!;
  const tip = await latestExtremityEventId(ROOM);
  const ids: string[] = [];
  for (const [i, keep] of [[0, true], [1, true], [2, false]] as const) {
    const r = await ingestEvent(
      ROOM,
      await author(ROOM, {
        type: 'm.room.message',
        sender: '@dev:localhost',
        content: { body: `C${i + 1}`, msgtype: 'm.text' },
        prev_events: [tip],
        origin_server_ts: 1000 + i,
      }),
      { keepPrevBranches: keep },
    );
    ids.push(r.event_id);
  }
  assertEquals((await extremities(room.dbName, ROOM)).length, 3);
  const heal = await ingestEvent(
    ROOM,
    await author(ROOM, {
      type: 'm.room.message',
      sender: '@dev:localhost',
      content: { body: 'converge', msgtype: 'm.text' },
      prev_events: ids,
      origin_server_ts: 2000,
    }),
  );
  // the event DAG keeps all 3 prevs (read on the heal's own branch —
  // a fresh connection lands on main, which never holds event rows)
  const { extremities: exts } = await import('#engine/room.ts');
  void exts;
  await withDb(room.dbName, async (c) => {
    const b = await c.query(
      `SELECT name FROM dolt.branches WHERE name LIKE 'x%' ORDER BY latest_commit_date DESC, name ASC LIMIT 1;`,
    );
    await c.query(
      `SELECT DOLT_CHECKOUT('${
        String((b.rows as { name: string }[])[0].name)
      }');`,
    );
    const r = await c.query(
      'SELECT prev_events FROM events WHERE event_id = $1;',
      [heal.event_id],
    );
    // jsonb arrives pre-parsed (array) via pg, TEXT-embedded via doltlite
    const pv = r.rows[0].prev_events;
    const arr = Array.isArray(pv) ? pv : JSON.parse(String(pv));
    assertEquals(arr.length, 3);
  });
  assertEquals(
    (await extremities(room.dbName, ROOM)).length,
    1,
    'one x* extremity after the chained merge',
  );
});
