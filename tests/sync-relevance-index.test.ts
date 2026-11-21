import { assertEquals } from '@std/assert';
import { relevantFeedChanged } from '#engine/server/read.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { visiblePrejoin } from '#engine/server/prejoin.ts';
import { openStore } from '#engine/store/index.ts';

Deno.test('sync relevance: seeks past the cut without walking retained feed history', async () => {
  const dir = await Deno.makeTempDir();
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { server: serverSchema } });
  try {
    const db = await store.server();
    const setup = [
      "INSERT INTO memberships VALUES('@alice','!joined','join','$join',1)",
      "INSERT INTO memberships VALUES('@alice','!left','leave','$leave',2)",
      "INSERT INTO memberships VALUES('@bob','!other','join','$bob',3)",
      "INSERT INTO feed VALUES(10,'!joined',1,'$old',1)",
      "INSERT INTO feed VALUES(20,'!left',1,'$left',1)",
      "INSERT INTO feed VALUES(90,'!other',1,'$unrelated',1)",
    ];
    for (const sql of setup) await db.execute(sql);
    const queries: {
      sql: string;
      values: readonly unknown[];
      plan: string[];
    }[] = [];
    const observed = {
      query: async (
        sql: string,
        values: readonly (string | number | null)[] = [],
      ) => {
        const plan = (await db.query('EXPLAIN QUERY PLAN ' + sql, values))
          .map((row) => String(row.detail));
        queries.push({ sql, values, plan });
        return await db.query(sql, values);
      },
    };
    // Capture the actual production statement with no newer relevant fact.
    assertEquals(await relevantFeedChanged(observed, '@alice', 20), false);
    const output = Deno.env.get('SYNC_RELEVANCE_WORK_OUTPUT');
    if (output) {
      const schema = await db.query(
        "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__turso_%' ORDER BY type DESC,name",
      );
      await Deno.writeTextFile(
        output,
        JSON.stringify({
          schema: schema.map((r) => r.sql),
          setup,
          queries,
        }),
      );
    }
    const prejoin = async (room: string, seq: number, status: string) => {
      await db.execute(
        `INSERT INTO prejoin_memberships(room_id,user_id,room_version,event_id,event_json,invite_room_state,origin,status,seq,received_ms,kind)
         VALUES(?,'@alice','10',?,'{}','[]','peer',?,?,0,'invite')`,
        [room, '$' + room, status, seq],
      );
    };
    await prejoin('!pending', 30, 'pending');
    await prejoin('!attempt', 100, 'attempting');
    await prejoin('!failed', 110, 'failed-attempt');
    await prejoin('!left', 2, 'pending'); // superseded by the room membership
    await prejoin('!departure', 40, 'rejected');
    await prejoin('!completed', 50, 'joined'); // retain the original predicate
    for (const user of ['@alice', '@bob', '@nobody']) {
      for (
        const since of [
          0,
          1,
          9,
          10,
          19,
          20,
          29,
          30,
          39,
          40,
          49,
          50,
          89,
          90,
          200,
        ]
      ) {
        const legacy = await db.query(
          `SELECT MAX(seq) AS m FROM (
           SELECT f.seq FROM feed f JOIN memberships m ON m.room=f.room WHERE m.user=?
           UNION ALL SELECT seq FROM prejoin_memberships p WHERE user_id=?
           AND status NOT IN ('attempting','failed-attempt') AND ${
            visiblePrejoin('p')
          })`,
          [user, user],
        );
        assertEquals(
          await relevantFeedChanged(db, user, since),
          Number(legacy[0].m ?? 0) > since,
          `${user} cut ${since}`,
        );
      }
    }
    // Every retained table access must be a keyed search. SCAN CONSTANT ROW is
    // harmless for a SELECT of EXISTS values, but not an indexed-history walk.
    assertEquals(
      queries.flatMap((q) => q.plan).filter((line) =>
        /\bSCAN\b/.test(line) && !line.includes('SCAN CONSTANT ROW')
      ),
      [],
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
