import { assertEquals } from '@std/assert';
import { serverSchema } from '#engine/server/schema.ts';
import { openStore } from '#engine/store/index.ts';
import { historicalServerSchema } from './fixtures/server-schema-history.ts';

Deno.test('historical server fixture seeds fixed v35 without borrowing later schema objects', async () => {
  const root = await Deno.makeTempDir({ prefix: 'server-schema-history-' });
  const settings = (name: string) => ({
    dir: root + '/' + name,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  });
  const old = await openStore(settings('historical'), {
    schemas: { server: historicalServerSchema(35) },
  });
  const current = await openStore(settings('current'), {
    schemas: { server: serverSchema },
  });
  try {
    const database = await old.server();
    assertEquals(
      await database.query("SELECT v FROM meta WHERE k='schema_version'"),
      [{ v: '35' }],
    );
    assertEquals(
      await database.query(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='feed_event'",
      ),
      [],
    );
    // Reconstructing the full chain must agree with the independent current
    // apply owner, rather than accidentally omitting a base-table change.
    await old.close();
    const upgraded = await openStore(settings('historical'), {
      schemas: { server: serverSchema },
    });
    try {
      const sql =
        "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '__turso%' ORDER BY type,name";
      assertEquals(
        await (await upgraded.server()).query(sql),
        await (await current.server()).query(sql),
      );
    } finally {
      await upgraded.close();
    }
  } finally {
    await old.close();
    await current.close();
    await Deno.remove(root, { recursive: true });
  }
});
