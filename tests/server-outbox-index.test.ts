import { assert, assertEquals } from '@std/assert';
import { serverSchema } from '#engine/server/schema.ts';
import { openStore } from '#engine/store/index.ts';
import { historicalServerSchema } from '#tests/fixtures/server-schema-history.ts';

// The sender's startup/projection scan. Its PDU arm must enumerate pending
// work, never every retained delivery outcome in destination-first order.
const discovery =
  "SELECT destination FROM outbox WHERE state='pending' UNION SELECT destination FROM edu_outbox WHERE state='pending' UNION SELECT destination FROM federation_batches";

for (const mode of ['fresh', 'upgrade']) {
  Deno.test(
    'pending destination access path: ' + mode +
      ' excludes retained sent history',
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
        const db = await old.server();
        await db.execute(
          "INSERT INTO outbox(room,pos,destination,event,state,added_ms) VALUES('!old:test',1,'archived.test','$old','sent',1)",
        );
        await old.close();
      }
      const store = await openStore(settings, {
        schemas: { server: serverSchema },
      });
      try {
        const db = await store.server();
        await db.tx(async (tx) => {
          for (let pos = 1; pos <= 64; pos++) {
            await tx.execute(
              "INSERT INTO outbox(room,pos,destination,event,state,added_ms) VALUES('!r:test',?,'sent.test',?,'sent',1)",
              [pos, '$' + pos],
            );
          }
          await tx.execute(
            "INSERT INTO outbox(room,pos,destination,event,state,added_ms) VALUES('!r:test',65,'pending.test','$pending','pending',1)",
          );
          await tx.execute(
            "INSERT INTO edu_outbox(source,destination,edu_type,payload,state,enqueue_pos) VALUES('edu','edu.test','m.test','{}','pending',1)",
          );
          await tx.execute(
            "INSERT INTO federation_batches VALUES('frozen.test','txn','bytes','[]','[]')",
          );
        });
        assertEquals(await db.query(discovery), [{ destination: 'edu.test' }, {
          destination: 'frozen.test',
        }, { destination: 'pending.test' }]);
        const plan = await db.query('EXPLAIN QUERY PLAN ' + discovery);
        assert(
          plan.some((r) =>
            String(r.detail).includes('outbox_pending_destination')
          ),
          JSON.stringify(plan),
        );
        await db.execute(
          "UPDATE outbox SET state='sent' WHERE destination='pending.test'",
        );
        await db.execute(
          "UPDATE outbox SET state='pending' WHERE destination='sent.test' AND pos=1",
        );
        assertEquals(await db.query(discovery), [{ destination: 'edu.test' }, {
          destination: 'frozen.test',
        }, { destination: 'sent.test' }]);
        assertEquals(
          (await db.query(
            "SELECT COUNT(*) AS n FROM outbox WHERE state='sent'",
          ))[0].n,
          mode === 'upgrade' ? 65 : 64,
        );
      } finally {
        await store.close();
        await Deno.remove(dir, { recursive: true });
      }
    },
  );
}
