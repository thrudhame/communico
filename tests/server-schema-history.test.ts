import { assertEquals } from '@std/assert';
import { serverSchema } from '#engine/server/schema.ts';
import { openStore } from '#engine/store/index.ts';
import { historicalServerSchema } from './fixtures/server-schema-history.ts';

Deno.test('room upgrade intent migration crosses v54 to v55 before current-schema equivalence', async () => {
  const root = await Deno.makeTempDir({ prefix: 'upgrade-schema-' });
  const settings = (name: string) => ({
    dir: root + '/' + name,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  });
  let old = await openStore(settings('old'), {
    schemas: { server: historicalServerSchema(54) },
  });
  const fresh = await openStore(settings('fresh'), {
    schemas: { server: serverSchema },
  });
  try {
    assertEquals(
      await (await old.server()).query(
        "SELECT name FROM sqlite_master WHERE name='room_upgrades'",
      ),
      [],
    );
    await old.close();
    // Pin the historical boundary separately: later append-only migrations must
    // not change what the room-upgrade migration installed at v55.
    old = await openStore(settings('old'), {
      schemas: {
        server: {
          ...historicalServerSchema(55),
          migrations: serverSchema.migrations,
        },
      },
    });
    assertEquals(
      await (await old.server()).query(
        "SELECT v FROM meta WHERE k='schema_version'",
      ),
      [{ v: '55' }],
    );
    assertEquals(
      await (await old.server()).query('SELECT * FROM room_upgrades'),
      [],
    );
    await old.close();
    old = await openStore(settings('old'), {
      schemas: { server: serverSchema },
    });
    const sql =
      "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '__turso%' ORDER BY type,name";
    assertEquals(
      await (await old.server()).query(sql),
      await (await fresh.server()).query(sql),
    );
    assertEquals(
      await (await old.server()).query('SELECT * FROM room_upgrades'),
      [],
    );
    assertEquals(
      await (await old.server()).query(
        "SELECT v FROM meta WHERE k='schema_version'",
      ),
      [{ v: String(serverSchema.version) }],
    );
  } finally {
    await old.close();
    await fresh.close();
    await Deno.remove(root, { recursive: true });
  }
});

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

Deno.test('outbound invite attempt migration appends to v48 with fresh-schema equivalence', async () => {
  const root = await Deno.makeTempDir();
  const settings = (name: string) => ({
    dir: root + '/' + name,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  });
  let old = await openStore(settings('old'), {
    schemas: { server: historicalServerSchema(48) },
  });
  const fresh = await openStore(settings('fresh'), {
    schemas: { server: serverSchema },
  });
  try {
    assertEquals(
      await (await old.server()).query(
        "SELECT name FROM sqlite_master WHERE name='federation_invite_attempts'",
      ),
      [],
    );
    await old.close();
    old = await openStore(settings('old'), {
      schemas: { server: serverSchema },
    });
    const sql =
      "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '__turso%' ORDER BY type,name";
    assertEquals(
      await (await old.server()).query(sql),
      await (await fresh.server()).query(sql),
    );
    assertEquals(
      await (await old.server()).query(
        'SELECT * FROM federation_invite_attempts',
      ),
      [],
    );
  } finally {
    await old.close();
    await fresh.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('inbound membership receipt migration appends to v49 without invented receipts', async () => {
  const root = await Deno.makeTempDir();
  const settings = (name: string) => ({
    dir: root + '/' + name,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  });
  let old = await openStore(settings('old'), {
    schemas: { server: historicalServerSchema(49) },
  });
  const fresh = await openStore(settings('fresh'), {
    schemas: { server: serverSchema },
  });
  try {
    assertEquals(
      await (await old.server()).query(
        "SELECT name FROM sqlite_master WHERE name='membership_operations'",
      ),
      [],
    );
    await old.close();
    old = await openStore(settings('old'), {
      schemas: { server: serverSchema },
    });
    const sql =
      "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '__turso%' ORDER BY type,name";
    assertEquals(
      await (await old.server()).query(sql),
      await (await fresh.server()).query(sql),
    );
    assertEquals(
      await (await old.server()).query('SELECT * FROM membership_operations'),
      [],
    );
  } finally {
    await old.close();
    await fresh.close();
    await Deno.remove(root, { recursive: true });
  }
});
