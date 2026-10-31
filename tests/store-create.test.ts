// tests/store-create.test.ts — safe creation publishes verified schemas and
// preserves interrupted/failed publication for the next startup sweep.
import { assertEquals, assertRejects } from '@std/assert';
import {
  createDatabase,
  type CreateOptions,
  integrityCheck,
  sweep,
} from '#engine/store/create.ts';
import { Db } from '#engine/store/db.ts';
import { Turso } from '#engine/store/ffi.ts';
import { databaseFiles } from '#engine/store/layout.ts';

function options(): CreateOptions {
  return {
    checkpointlogbytes: 65536,
    schema: async (db) => {
      await db.exec('CREATE TABLE example(id INTEGER PRIMARY KEY, value TEXT)');
      await db.execute('INSERT INTO example VALUES(1,?)', ['created']);
    },
    verify: async (db) => {
      assertEquals(await db.query('SELECT * FROM example'), [{
        id: 1,
        value: 'created',
      }]);
    },
  };
}

Deno.test('store create: schema, reopen, integrity and startup sweep', async () => {
  const parent = await Deno.makeTempDir();
  const ffi = new Turso('./.native/libturso_ffi.so');
  try {
    const directory = await createDatabase(ffi, parent, 'example', options());
    const db = await Db.open(ffi, databaseFiles(directory).database, 65536);
    try {
      await integrityCheck(db);
      await options().verify(db);
    } finally {
      await db.close();
    }
    await Deno.mkdir(parent + '/x.new');
    await Deno.writeTextFile(parent + '/x.new/partial', 'unpublished');
    assertEquals(await sweep(parent), [parent + '/x.new']);
    assertEquals((await Deno.stat(directory)).isDirectory, true);
    await assertRejects(
      () => createDatabase(ffi, parent, 'example', options()),
      Deno.errors.AlreadyExists,
    );
  } finally {
    ffi.close();
    await Deno.remove(parent, { recursive: true });
  }
});

Deno.test('store create: interruption before rename leaves only .new and sweep removes it', async () => {
  const parent = await Deno.makeTempDir();
  const ffi = new Turso('./.native/libturso_ffi.so');
  try {
    await assertRejects(
      () =>
        createDatabase(ffi, parent, 'interrupted', {
          ...options(),
          beforeRename: () =>
            Promise.reject(new Error('interrupted before rename')),
        }),
      Error,
      'interrupted before rename',
    );
    await assertRejects(
      () => Deno.stat(parent + '/interrupted'),
      Deno.errors.NotFound,
    );
    assertEquals(
      (await Deno.stat(parent + '/interrupted.new')).isDirectory,
      true,
    );
    assertEquals(await sweep(parent), [parent + '/interrupted.new']);
  } finally {
    ffi.close();
    await Deno.remove(parent, { recursive: true });
  }
});

Deno.test('store create: failed rename and failed schema verification preserve the unpublished directory', async () => {
  const parent = await Deno.makeTempDir();
  const ffi = new Turso('./.native/libturso_ffi.so');
  try {
    await assertRejects(() =>
      createDatabase(ffi, parent, 'occupied', {
        ...options(),
        beforeRename: async (_temporary, final) => {
          await Deno.mkdir(final);
          await Deno.writeTextFile(final + '/preserve', 'existing contents');
        },
      })
    );
    assertEquals(
      await Deno.readTextFile(parent + '/occupied/preserve'),
      'existing contents',
    );
    assertEquals((await Deno.stat(parent + '/occupied.new')).isDirectory, true);
    await assertRejects(
      () =>
        createDatabase(ffi, parent, 'bad-schema', {
          ...options(),
          verify: () => Promise.reject(new Error('schema mismatch')),
        }),
      Error,
      'schema mismatch',
    );
    await assertRejects(
      () => Deno.stat(parent + '/bad-schema'),
      Deno.errors.NotFound,
    );
    assertEquals(
      (await sweep(parent)).sort(),
      [parent + '/bad-schema.new', parent + '/occupied.new'].sort(),
    );
  } finally {
    ffi.close();
    await Deno.remove(parent, { recursive: true });
  }
});
