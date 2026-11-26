import { assert, assertEquals, assertRejects } from '@std/assert';
import {
  captureCompletionCut,
  validateCompletion,
} from '#engine/room/completion.ts';
import { roomSchema } from '#engine/room/index.ts';
import { eventStateRefs } from '#engine/room/state.ts';
import { Conn } from '#engine/store/db.ts';
import { openStore } from '#engine/store/index.ts';

const legacyHead = 'SELECT COALESCE(MAX(pos),0) AS head FROM changes';
const legacyRefs = `SELECT s.event, s.before_group, s.after_group, s.provenance
  FROM json_each(?) AS i JOIN event_state s ON s.event = i.value`;

async function seed(conn: Conn, count: number) {
  if (count === 0) return;
  await conn.execute(
    `INSERT INTO events(id,pdu,type,sender,depth,origin_ts)
    SELECT '$' || value,'{}','m.room.message','@sender:test',value,value
    FROM json_each(?)`,
    [JSON.stringify(Array.from({ length: count }, (_, n) => n + 1))],
  );
  await conn.execute(
    "INSERT INTO state_groups VALUES(1,NULL,0,'root'),(2,1,1,'fork'),(3,NULL,0,'reset')",
  );
  await conn.execute(`INSERT INTO event_state
    SELECT id,CASE WHEN depth=3 THEN NULL WHEN depth=2 THEN 3 ELSE 1 END,
      CASE WHEN depth=3 THEN NULL WHEN depth=2 THEN 3 WHEN depth=4 THEN 2 ELSE 1 END,
      CASE WHEN depth=3 THEN 'none' WHEN depth=2 THEN 'imported' ELSE 'dag' END FROM events`);
  await conn.execute(`INSERT INTO event_status
    SELECT id, CASE WHEN depth=3 THEN 'rejected' ELSE 'accepted' END,
      CASE WHEN depth=3 THEN 'pending' ELSE 'grounded' END, NULL, depth FROM events`);
  if (count >= 4) {
    await conn.execute(
      "INSERT INTO prev_edges VALUES('$2','$1',0),('$4','$1',0),('$3','$2',0)",
    );
  }
  // Leave holes in the change positions and no applied change for rejection.
  await conn.execute(
    "INSERT INTO changes SELECT depth*2,'event',id,'{}' FROM events WHERE depth!=3",
  );
  await conn.execute(
    "INSERT INTO completion_receipts VALUES('$1',2,'accepted')",
  );
}

Deno.test('room completion head and event refs match their old cuts without walking room history', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'room-query-work-' });
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 4120000,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { room: roomSchema } });
  const observed: { size: number; backward: boolean; seek: boolean }[] = [];
  try {
    for (const size of [0, 1, 8, 256]) {
      const id = `!query-work-${size}:test`;
      const db = await store.room(id, { create: true });
      await db.tx((conn) => seed(conn, size));
      await db.tx(async (conn) => {
        const native = conn.query.bind(conn);
        const [old] = await native(legacyHead);
        const ids = ['$4', '$2', '$missing', '$3', '$1', '$2'];
        const legacy = await native(legacyRefs, [JSON.stringify(ids)]);
        let backward = false;
        let seek = false;
        let heads = 0;
        let refs = 0;
        conn.query = async (sql, values) => {
          if (sql.includes('completion_state.*')) {
            heads++;
            const ops = await native('EXPLAIN ' + sql, values);
            backward = ops.some((row) => row.opcode === 'Last');
          } else if (sql.includes('SELECT s.event, s.before_group')) {
            refs++;
            const plan = await native('EXPLAIN QUERY PLAN ' + sql, values);
            seek = plan.some((row) =>
              /SEARCH s USING INDEX .*\(event=\?\)/.test(String(row.detail))
            );
          }
          return await native(sql, values);
        };
        const cut = await captureCompletionCut(conn, id);
        assertEquals(cut.through, Number(old.head));
        assertEquals(cut.through, 2 * size);
        if (size > 0) {
          await validateCompletion(conn, { ...cut, eventId: '$1', through: 2 });
        }
        await assertRejects(
          () => validateCompletion(conn, { ...cut, eventId: '$missing' }),
          Error,
          'E_COMPLETION_TARGET',
        );
        assertEquals(await eventStateRefs(conn, []), new Map());
        const result = await eventStateRefs(conn, ids);
        const expected = new Map(legacy.map((row) => {
          const ref = (group: unknown) =>
            group === null
              ? null
              : { group: Number(group), provenance: row.provenance };
          return [row.event, {
            before: ref(row.before_group),
            after: ref(row.after_group),
          }];
        }));
        assertEquals(result, expected);
        assertEquals(result.size, Math.min(size, 4));
        assertEquals(refs, 1);
        assertEquals(heads, size === 0 ? 2 : 3);
        observed.push({ size, backward, seek });
      });
    }
    console.log('room query plans', JSON.stringify(observed));
    assert(
      observed.every((x) => x.backward && x.seek),
      'both room readers must seek instead of scanning room history',
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
