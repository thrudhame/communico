import { assert, assertEquals } from '@std/assert';
import { serverSchema } from '#engine/server/schema.ts';
import { openStore } from '#engine/store/index.ts';
import { historicalServerSchema } from './fixtures/server-schema-history.ts';

for (const mode of ['fresh', 'upgrade']) {
  Deno.test(
    'transaction pruning access path: ' + mode +
      ' excludes retained replay history',
    async () => {
      const dir = await Deno.makeTempDir();
      const settings = {
        dir,
        library: './.native/libturso_ffi.so',
        checkpointlogbytes: 65536,
        maxopenfiles: 8,
        idleseconds: 300,
      };
      if (mode === 'upgrade') {
        const old = await openStore(settings, {
          schemas: { server: historicalServerSchema(38) },
        });
        await (await old.server()).execute(
          "INSERT INTO federation_txns VALUES('old.test','retained',50,'{\"pdus\":{}}')",
        );
        await old.close();
      }
      const store = await openStore(settings, {
        schemas: { server: serverSchema },
      });
      try {
        const db = await store.server();
        await db.tx(async (tx) => {
          for (let i = 0; i < 64; i++) {
            await tx.execute('INSERT INTO federation_txns VALUES(?,?,?,?)', [
              'peer.test',
              String(i),
              100,
              '{"pdus":{}}',
            ]);
          }
          await tx.execute(
            "INSERT INTO federation_txns VALUES('expired.test','one',49,'{}')",
          );
          await tx.execute(
            "INSERT INTO federation_txns VALUES('edge.test','one',50,'{}')",
          );
        });
        const sql = 'DELETE FROM federation_txns WHERE received_ms < ?';
        const plan = await db.query('EXPLAIN QUERY PLAN ' + sql, [50]);
        assert(
          plan.some((row) =>
            String(row.detail).includes(
              'SEARCH federation_txns USING COVERING INDEX federation_txns_received',
            )
          ),
          JSON.stringify(plan),
        );
        assertEquals(await db.execute(sql, [50]), 1);
        assertEquals(await db.execute(sql, [50]), 0);
        assertEquals(
          await db.query(
            "SELECT txn_id FROM federation_txns WHERE origin='edge.test'",
          ),
          [{ txn_id: 'one' }],
        );
        assertEquals(
          (await db.query('SELECT COUNT(*) AS n FROM federation_txns'))[0].n,
          mode === 'upgrade' ? 66 : 65,
        );
      } finally {
        await store.close();
        await Deno.remove(dir, { recursive: true });
      }
    },
  );
}
