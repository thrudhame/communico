import { assert, assertEquals, assertRejects } from '@std/assert';
import { advanceNotificationRead } from '#engine/server/notifications.ts';
import { serverSchema } from '#engine/server/schema.ts';
import type { Database } from '#engine/store/db.ts';
import { openStore } from '#engine/store/index.ts';
import { historicalServerSchema } from './fixtures/server-schema-history.ts';

async function seed(db: Database): Promise<void> {
  await db.tx(async (tx) => {
    for (let seq = 1; seq <= 68; seq++) {
      const thread = seq === 66 ? '$thread' : 'main';
      const withdrawn = seq === 68 ? 1 : 0;
      const read = seq <= 64 ? seq : null;
      await tx.execute(
        `INSERT INTO notifications VALUES(?,'test','@bob:test',?,'!room:test',?,?,'["notify"]',1,0,?,?)`,
        [seq, '$' + seq, seq, thread, read, withdrawn],
      );
      if (!withdrawn) {
        await tx.execute(
          "INSERT INTO notification_history VALUES(?,'@bob:test','!room:test',1,?)",
          [seq, read],
        );
      }
      await tx.execute(
        "INSERT INTO event_index(event,room,pos,standing,grounding,seq) VALUES(?,'!room:test',?,'accepted','grounded',?)",
        ['$' + seq, seq, seq],
      );
    }
    await tx.execute(
      "INSERT INTO notification_counts VALUES('@bob:test','!room:test','main',2,2)",
    );
    await tx.execute(
      "INSERT INTO notification_counts VALUES('@bob:test','!room:test','$thread',1,1)",
    );
    await tx.execute(
      "INSERT INTO event_index(event,room,pos,standing,grounding,seq) VALUES('$thread','!room:test',0,'accepted','grounded',0)",
    );
    await tx.execute(
      "INSERT INTO relations VALUES('$66','$thread','m.thread','!room:test',66)",
    );
  });
}

for (const mode of ['fresh', 'upgrade']) {
  for (const scope of ['', 'main', '$thread']) {
    Deno.test(`notification read access: ${mode} ${scope || 'unthreaded'} excludes retained read facts`, async () => {
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
          schemas: { server: historicalServerSchema(35) },
        });
        try {
          const db = await old.server();
          await seed(db);
          assertEquals(
            await db.query(
              "SELECT name FROM sqlite_master WHERE name='notifications_unread'",
            ),
            [],
          );
        } finally {
          await old.close();
        }
      }
      const store = await openStore(settings, {
        schemas: { server: serverSchema },
      });
      try {
        const db = await store.server();
        if (mode === 'fresh') await seed(db);
        const before = await db.query(
          'SELECT * FROM notifications ORDER BY seq',
        );
        const target = scope === '$thread' ? '$66' : '$68';
        const read = async (rollback: boolean) => {
          const plans: string[] = [];
          await db.tx(async (tx) => {
            const query = tx.query.bind(tx);
            const execute = tx.execute.bind(tx);
            tx.query = async (sql, values) => {
              if (
                sql.includes('FROM notifications') &&
                sql.includes('read_ms IS NULL')
              ) {
                plans.push(
                  ...(await query('EXPLAIN QUERY PLAN ' + sql, values)).map(
                    (row) => String(row.detail),
                  ),
                );
              }
              return await query(sql, values);
            };
            tx.execute = async (sql, values) => {
              if (
                sql.startsWith('UPDATE notifications ') &&
                sql.includes('read_ms IS NULL')
              ) {
                plans.push(
                  ...(await query('EXPLAIN QUERY PLAN ' + sql, values)).map(
                    (row) => String(row.detail),
                  ),
                );
              }
              return await execute(sql, values);
            };
            await advanceNotificationRead(
              tx,
              '@bob:test',
              '!room:test',
              scope,
              target,
              1000,
            );
            if (rollback) throw new Error('abort indexed read');
          });
          assertEquals(plans.length, 2);
          for (const plan of plans) {
            assert(plan.includes('INDEX notifications_unread'), plan);
          }
        };
        await assertRejects(() => read(true), Error, 'abort indexed read');
        assertEquals(
          await db.query('SELECT * FROM notifications ORDER BY seq'),
          before,
        );
        await read(false);
        const facts = await db.query(
          'SELECT seq,read_ms FROM notifications ORDER BY seq',
        );
        assertEquals(
          facts.slice(0, 64),
          before.slice(0, 64).map((row) => ({
            seq: row.seq,
            read_ms: row.read_ms,
          })),
        );
        assertEquals(facts.slice(64), [
          { seq: 65, read_ms: scope === '$thread' ? null : 1000 },
          { seq: 66, read_ms: scope === 'main' ? null : 1000 },
          { seq: 67, read_ms: scope === '$thread' ? null : 1000 },
          { seq: 68, read_ms: scope === '$thread' ? null : 1000 },
        ]);
        assertEquals(
          await db.query(
            'SELECT thread,unread,highlight FROM notification_counts ORDER BY thread',
          ),
          [
            {
              thread: '$thread',
              unread: scope === 'main' ? 1 : 0,
              highlight: scope === 'main' ? 1 : 0,
            },
            {
              thread: 'main',
              unread: scope === '$thread' ? 2 : 0,
              highlight: scope === '$thread' ? 2 : 0,
            },
          ],
        );
        // With no visible unread rows left, withdrawn unread facts still become
        // read. Empty visible counts never authorize skipping the fact mutation.
        await db.tx(async (tx) => {
          await tx.execute(
            'UPDATE notifications SET read_ms=NULL WHERE seq=68',
          );
          await advanceNotificationRead(
            tx,
            '@bob:test',
            '!room:test',
            'main',
            '$68',
            2000,
          );
        });
        assertEquals(
          await db.query('SELECT read_ms FROM notifications WHERE seq=68'),
          [{ read_ms: 2000 }],
        );
        assertEquals(
          await db.query("SELECT v FROM meta WHERE k='schema_version'"),
          [{ v: String(serverSchema.version) }],
        );
      } finally {
        await store.close();
        await Deno.remove(dir, { recursive: true });
      }
    });
  }
}
