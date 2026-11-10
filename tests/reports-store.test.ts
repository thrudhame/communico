import { assert, assertEquals } from '@std/assert';
import {
  listReports,
  resolveReport,
  storeReport,
} from '#engine/server/reports.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openStore } from '#engine/store/index.ts';
import { SERVER_V13 } from '#tests/fixtures/server-v13.ts';
import { config, setConfigForTests } from '#engine/config.ts';
import type { Database } from '#engine/store/db.ts';

Deno.test('reports survive v21 upgrade, reopen and concurrent resolution without changing room truth', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'reports-store-' });
  const config = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  let store: Awaited<ReturnType<typeof openStore>> | null = null;
  try {
    store = await openStore(config, {
      schemas: { server: { version: 13, apply: (db) => db.exec(SERVER_V13) } },
    });
    await (await store.server()).execute(
      "INSERT INTO counters VALUES('events',17)",
    );
    await store.close();
    store = await openStore(config, {
      schemas: { server: { ...serverSchema, version: 21 } },
    });
    assertEquals(
      await (await store.server()).query(
        "SELECT name FROM sqlite_master WHERE name='reports'",
      ),
      [],
    );
    await store.close();
    store = await openStore(config, { schemas: { server: serverSchema } });
    const db = await store.server();
    assertEquals(
      await db.query("SELECT value FROM counters WHERE name='events'"),
      [{ value: 17 }],
    );
    await storeReport(db, {
      kind: 'event',
      reporter: '@reporter:test',
      roomId: '!r:test',
      eventId: '$e',
      reason: '',
      score: 0,
    });
    const first = (await listReports(db)).reports[0];
    assertEquals(first.reason, '');
    assertEquals(first.score, 0);
    const resolved = await Promise.all([
      resolveReport(db, first.id, 'first operator'),
      resolveReport(db, first.id, 'second operator'),
    ]);
    assertEquals(resolved[0], resolved[1]);
    assertEquals(
      await db.query("SELECT value FROM counters WHERE name='events'"),
      [{ value: 17 }],
    );
    assertEquals(await store.rooms(), []);
    await store.close();
    store = await openStore(config, { schemas: { server: serverSchema } });
    const reopened = await listReports(await store.server(), {
      status: 'resolved',
    });
    assertEquals(reopened.reports, [resolved[0]]);
    assert(reopened.reports[0].receivedMs > 0);
  } finally {
    await store?.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('report pages select a byte-bounded prefix before hydrating bodies, without losing oversized rows', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'reports-pages-' });
  const previous = config().server;
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { server: serverSchema } });
  try {
    setConfigForTests({ server: { maxrequestbytes: 4096 } });
    const db = await store.server();
    // Escaping expands control bytes in JSON; UTF-8 and resolution count too.
    const reasons = [
      'a'.repeat(600),
      '\u0000'.repeat(800),
      '🙂'.repeat(1200),
      'last',
    ];
    for (const reason of reasons) {
      await storeReport(db, {
        kind: 'room',
        reporter: '@r:test',
        roomId: '!r:test',
        reason,
      });
    }
    await resolveReport(db, 4, '\u0001'.repeat(1000));
    let maxHydrated = 0;
    const observe = (rows: Awaited<ReturnType<Database['query']>>) => {
      if (rows.some((row) => Object.hasOwn(row, 'reason'))) {
        maxHydrated = Math.max(maxHydrated, rows.length);
      }
      return rows;
    };
    const measured: Database = {
      ...db,
      query: async (...args) => await observe(await db.query(...args)),
      tx: (fn, options) =>
        db.tx((tx) =>
          fn(
            new Proxy(tx, {
              get(target, key) {
                if (key === 'query') {
                  return async (...args: Parameters<Database['query']>) =>
                    await observe(await target.query(...args));
                }
                const value = Reflect.get(target, key);
                return typeof value === 'function' ? value.bind(target) : value;
              },
            }),
          ), options),
    };
    const seen: string[] = [];
    let from = 0;
    do {
      const page = await listReports(measured, { from, limit: 1000 });
      assert(page.reports.length > 0);
      const bytes =
        new TextEncoder().encode(JSON.stringify({ ok: true, result: page }))
          .length;
      assert(
        bytes <= 4096 || page.reports.length === 1,
        'only a singleton may exceed the byte target',
      );
      seen.push(...page.reports.map((row) => row.reason!));
      if (page.next === undefined) break;
      assert(page.next > from);
      from = page.next;
    } while (true);
    assertEquals(seen, reasons);
    assertEquals(
      maxHydrated,
      1,
      'never hydrate the unselected large rows or lookahead',
    );
    const resolved = await listReports(measured, { status: 'resolved' });
    assertEquals(resolved.reports[0].resolution, '\u0001'.repeat(1000));
  } finally {
    setConfigForTests({ server: previous });
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
