import { assert, assertEquals } from '@std/assert';
import {
  listReports,
  resolveReport,
  storeReport,
} from '#engine/server/reports.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openStore } from '#engine/store/index.ts';
import { SERVER_V13 } from '#tests/fixtures/server-v13.ts';

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
