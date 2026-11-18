import { assert, assertEquals } from '@std/assert';
import { captureIndependentPushes } from '#engine/server/notifications.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openStore } from '#engine/store/index.ts';
import type { Conn } from '#engine/store/db.ts';
import { hasPublicationEvents } from '#engine/server/publication-rows.ts';

Deno.test('publication captures: only input keys drive retained-fact access', async () => {
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
    const captures: {
      sql: string;
      values: readonly unknown[];
      plan: string[];
    }[] = [];
    await db.tx(async (tx) => {
      const query = tx.query.bind(tx);
      const measured = new Proxy(tx, {
        get(target, key) {
          if (key === 'query') {
            return async (...args: Parameters<Conn['query']>) => {
              const [sql, values = []] = args;
              if (sql.includes('json_each')) {
                const plans = await query('EXPLAIN QUERY PLAN ' + sql, values);
                captures.push({
                  sql,
                  values,
                  plan: plans.map((row) => String(row.detail)),
                });
                for (const { detail } of plans) {
                  const line = String(detail);
                  assert(!/SCAN (?!json_each\b)/.test(line), line);
                  assert(!line.includes('ephemeral_'), line);
                }
              }
              return await query(sql, values);
            };
          }
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      assertEquals(
        await hasPublicationEvents(measured, ['$new', '$next']),
        false,
      );
      const apply = await captureIndependentPushes(measured, [
        {
          room: '!selected',
          event: '$new',
          pos: 1,
          publication: { sender: '@sender', decisions: [] },
        },
        {
          room: '!second',
          event: '$next',
          pos: 1,
          publication: { sender: '@sender', decisions: [] },
        },
      ]);
      assert(apply !== null);
    });
    assert(captures.length >= 4);
    // The native work-count companion consumes the real captured statements,
    // not copied SQL. Its small/large fixtures differ only in unrelated facts.
    const output = Deno.env.get('PUBLICATION_WORK_OUTPUT');
    if (output) {
      const schema = await db.query(
        "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__turso_%' ORDER BY type DESC,name",
      );
      await Deno.writeTextFile(
        output,
        JSON.stringify({ schema: schema.map((r) => r.sql), queries: captures }),
      );
    }
    assertEquals(
      (await db.query('SELECT COUNT(*) AS n FROM event_index'))[0].n,
      0,
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
