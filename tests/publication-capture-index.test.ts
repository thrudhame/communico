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
    const setup = [
      "INSERT INTO counters VALUES('notifications',10000)",
      "INSERT INTO notifications VALUES(10000,'test','@sender','$earlier','!selected',1,'main','[]',1,0,NULL,0)",
      "INSERT INTO notification_history VALUES(10000,'@sender','!selected',1,NULL)",
      "INSERT INTO notification_counts VALUES('@sender','!selected','main',1,1)",
      "INSERT INTO notification_counts VALUES('@recipient','!selected','thread',7,3)",
    ];
    for (const sql of setup) await db.execute(sql);
    const scans: string[] = [];
    await db.tx(async (tx) => {
      const query = tx.query.bind(tx);
      const execute = tx.execute.bind(tx);
      const measured = new Proxy(tx, {
        get(target, key) {
          if (key === 'query' || key === 'execute') {
            return async (...args: Parameters<Conn['query']>) => {
              const [sql, values = []] = args;
              if (key === 'execute' || sql.includes('json_each')) {
                const plans = await query('EXPLAIN QUERY PLAN ' + sql, values);
                captures.push({
                  sql,
                  values,
                  plan: plans.map((row) => String(row.detail)),
                });
                for (const { detail } of plans) {
                  const line = String(detail);
                  if (/SCAN (?!json_each\b|deltas\b)/.test(line)) {
                    scans.push(line);
                  }
                  if (line.includes('ephemeral_')) scans.push(line);
                }
              }
              return key === 'execute'
                ? await execute(sql, values)
                : await query(sql, values);
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
          publication: {
            sender: '@sender',
            decisions: [{
              tenant: 'test',
              user: '@recipient',
              ruleRevision: 0,
              ignoreRevision: 0,
              decision: {
                ruleId: 'notify',
                kind: 'underride',
                notify: true,
                highlight: true,
                actions: ['notify'],
                tweaks: {},
              },
            }],
          },
        },
        {
          room: '!second',
          event: '$next',
          pos: 1,
          publication: { sender: '@sender', decisions: [] },
        },
      ]);
      assert(apply !== null);
      await apply([2, 3], 1000);
    });
    assert(captures.some((c) => c.sql.includes('UPDATE notification_counts')));
    // The native work-count companion consumes the real captured statements,
    // not copied SQL. Its small/large fixtures differ only in unrelated facts.
    const output = Deno.env.get('PUBLICATION_WORK_OUTPUT');
    if (output) {
      const schema = await db.query(
        "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__turso_%' ORDER BY type DESC,name",
      );
      await Deno.writeTextFile(
        output,
        JSON.stringify({
          schema: schema.map((r) => r.sql),
          setup,
          queries: captures,
        }),
      );
    }
    assertEquals(scans, []);
    assertEquals(
      await db.query(
        'SELECT user,thread,unread,highlight FROM notification_counts ORDER BY user,thread',
      ),
      [
        { user: '@recipient', thread: 'main', unread: 1, highlight: 1 },
        { user: '@recipient', thread: 'thread', unread: 7, highlight: 3 },
        { user: '@sender', thread: 'main', unread: 0, highlight: 0 },
      ],
    );
    assertEquals(
      (await db.query('SELECT COUNT(*) AS n FROM event_index'))[0].n,
      0,
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
