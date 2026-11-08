// tests/store-schema.test.ts — R14: providers per database kind, the meta
// schema_version row, and refusal of a version mismatch or a missing meta.
import { assertEquals, assertRejects } from '@std/assert';
import {
  applySchema,
  checkSchema,
  EMPTY_SCHEMA,
  type SchemaProvider,
} from '#engine/store/create.ts';
import { Db } from '#engine/store/db.ts';
import { Turso } from '#engine/store/ffi.ts';
import { openStore } from '#engine/store/index.ts';

const config = (dir: string) => ({
  dir,
  library: './.native/libturso_ffi.so',
  checkpointlogbytes: 65536,
  maxopenfiles: 8,
  idleseconds: 300,
});

const versioned = (version: number): SchemaProvider => ({
  version,
  apply: async (db) => {
    await db.exec('CREATE TABLE marked(n INTEGER PRIMARY KEY, value TEXT)');
    await db.execute('INSERT INTO marked VALUES(1, ?)', ['applied']);
  },
});

Deno.test('store schema: defaults give an empty v0 room/tenant and a watermark server', async () => {
  const dir = await Deno.makeTempDir();
  try {
    const store = await openStore(config(dir));
    const server = await store.server();
    assertEquals(await server.query('SELECT k, v FROM meta'), [{
      k: 'schema_version',
      v: '0',
    }]);
    await server.query('SELECT source, position FROM watermarks');
    const room = await store.room('!r:test', { create: true });
    assertEquals(await room.query('SELECT k, v FROM meta'), [{
      k: 'schema_version',
      v: '0',
    }]);
    assertEquals(await room.query('SELECT value FROM id'), [{
      value: '!r:test',
    }]);
    await store.close();
    const again = await openStore(config(dir));
    await again.room('!r:test');
    await again.close();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('store schema: providers apply on create and survive reopen', async () => {
  const dir = await Deno.makeTempDir();
  const schemas = {
    room: versioned(3),
    tenant: versioned(1),
    server: versioned(2),
  };
  try {
    const store = await openStore(config(dir), { schemas });
    assertEquals(
      await (await store.room('!r:test', { create: true })).query(
        'SELECT k, v FROM meta',
      ),
      [{ k: 'schema_version', v: '3' }],
    );
    assertEquals(
      await (await store.tenant('@t:test', { create: true })).query(
        'SELECT * FROM marked',
      ),
      [{ n: 1, value: 'applied' }],
    );
    const server = await store.server();
    assertEquals(await server.query('SELECT k, v FROM meta'), [{
      k: 'schema_version',
      v: '2',
    }]);
    await server.query('SELECT source, position FROM watermarks');
    await server.query('SELECT * FROM marked');
    await store.close();
    const again = await openStore(config(dir), { schemas });
    assertEquals(
      await (await again.room('!r:test')).query('SELECT * FROM marked'),
      [{ n: 1, value: 'applied' }],
    );
    await again.close();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('store schema: a version mismatch refuses the open', async () => {
  const dir = await Deno.makeTempDir();
  try {
    const store = await openStore(config(dir), {
      schemas: { room: versioned(3) },
    });
    await store.room('!r:test', { create: true });
    await store.close();
    // A provider with a different version refuses the existing file.
    const mismatched = await openStore(config(dir), {
      schemas: { room: versioned(4) },
    });
    await assertRejects(
      () => mismatched.room('!r:test'),
      Error,
      'schema version mismatch',
    );
    await mismatched.close();
    // So does the empty placeholder against a versioned file.
    const empty = await openStore(config(dir));
    await assertRejects(
      () => empty.room('!r:test'),
      Error,
      'schema version mismatch',
    );
    await empty.close();
    // And a versioned server provider against the default server file.
    await assertRejects(
      () => openStore(config(dir), { schemas: { server: versioned(2) } }),
      Error,
      'schema version mismatch',
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('store schema: a missing meta table or row refuses; a bad version is rejected', async () => {
  const dir = await Deno.makeTempDir();
  const ffi = new Turso('./.native/libturso_ffi.so');
  try {
    const db = await Db.open(ffi, dir + '/data.db', 65536);
    try {
      await assertRejects(
        () => checkSchema(db, EMPTY_SCHEMA),
        Error,
        'no schema meta table',
      );
      await assertRejects(
        () => applySchema(db, { version: -1, apply: () => Promise.resolve() }),
        TypeError,
        'non-negative safe integer',
      );
      await applySchema(db, EMPTY_SCHEMA);
      await checkSchema(db, EMPTY_SCHEMA);
      await assertRejects(
        () => checkSchema(db, versioned(1)),
        Error,
        'schema version mismatch',
      );
      // A duplicate application would violate the version row's key.
      await assertRejects(() => applySchema(db, EMPTY_SCHEMA));
    } finally {
      await db.close();
    }
  } finally {
    ffi.close();
    await Deno.remove(dir, { recursive: true });
  }
});
