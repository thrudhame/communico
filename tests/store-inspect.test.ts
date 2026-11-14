import { assertEquals, assertRejects } from '@std/assert';
import { join } from '@std/path';
import { openStore } from '#engine/store/index.ts';
import { inspectSnapshot } from '#engine/store/inspect.ts';
import { describePayload } from '#engine/backup/manifest.ts';
import { scan } from '#engine/backup/checks.ts';

Deno.test('captured store inspection: upgrades only private scratch, checks full ids, and releases capabilities', async () => {
  const root = await Deno.makeTempDir({ prefix: 'inspect-' });
  const options = {
    dir: join(root, 'live'),
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  const schema = {
    version: 1,
    apply: (db: import('#engine/store/db.ts').Database) =>
      db.exec(
        'CREATE TABLE entries(n INTEGER NOT NULL); INSERT INTO entries VALUES(7)',
      ),
  };
  const store = await openStore(options, { schemas: { tenant: schema } });
  try {
    await store.tenant('inspect.test', { create: true });
    const cut = await store.snapshot(join(root, 'cut'));
    const before = await Promise.all(
      cut.files.map((f) => describePayload(join(root, 'cut'), f.path)),
    );
    const newer = {
      ...schema,
      version: 2,
      migrations: {
        1: (conn: import('#engine/store/db.ts').Conn) =>
          conn.exec('ALTER TABLE entries ADD COLUMN label TEXT'),
      },
    };
    let retained: import('#engine/store/inspect.ts').CapturedStore | undefined;
    await inspectSnapshot(options, join(root, 'cut'), cut.files, root, {
      tenant: newer,
    }, async (snapshot) => {
      retained = snapshot;
      const file = snapshot.files.find((f) => f.kind === 'tenants')!;
      assertEquals(file.schemaVersion, 1);
      assertEquals(
        await snapshot.read(
          file,
          (db) => db.query('SELECT n,label FROM entries'),
        ),
        [{ n: 7, label: null }],
      );
    });
    await assertRejects(
      () => retained!.read(retained!.files[0], (db) => db.query('SELECT 1')),
      Error,
      'closed',
    );
    assertEquals(
      await Promise.all(
        cut.files.map((f) => describePayload(join(root, 'cut'), f.path)),
      ),
      before,
    );
    const bad = cut.files.map((f) =>
      f.kind === 'tenants' ? { ...f, id: 'wrong.test' } : f
    );
    await assertRejects(
      () =>
        inspectSnapshot(
          options,
          join(root, 'cut'),
          bad,
          root,
          {},
          async () => {},
        ),
      Error,
      'identity',
    );
    await assertRejects(
      () =>
        inspectSnapshot(
          options,
          join(root, 'cut'),
          cut.files,
          root,
          {},
          async () => {},
        ),
      Error,
      'schema version',
    );
    await assertRejects(
      () =>
        inspectSnapshot(options, join(root, 'cut'), cut.files, root, {
          tenant: newer,
        }, () => Promise.reject(new Error('caller audit failed'))),
      Error,
      'caller audit failed',
    );
    assertEquals(
      [...Deno.readDirSync(root)].filter((e) => e.name.startsWith('.inspect-')),
      [],
    );
  } finally {
    await store.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('captured store inspection: corrupt files refuse before callback; scans visit every batch', async () => {
  const root = await Deno.makeTempDir({ prefix: 'inspect-corrupt-' });
  const options = {
    dir: join(root, 'live'),
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  const schema = {
    version: 1,
    apply: async (db: import('#engine/store/db.ts').Database) => {
      await db.exec('CREATE TABLE entries(n INTEGER NOT NULL)');
      await db.tx(async (tx) => {
        for (let n = 0; n < 600; n++) {
          await tx.execute('INSERT INTO entries VALUES(?)', [n]);
        }
      });
    },
  };
  const store = await openStore(options, { schemas: { tenant: schema } });
  try {
    await store.tenant('scan.test', { create: true });
    const cut = await store.snapshot(join(root, 'cut'));
    await inspectSnapshot(options, join(root, 'cut'), cut.files, root, {
      tenant: schema,
    }, async (snapshot) => {
      const file = snapshot.files.find((f) => f.kind === 'tenants')!;
      await snapshot.read(file, async (db) => {
        let count = 0, total = 0;
        for await (const row of scan(db, 'entries', 'n')) {
          count++;
          total += Number(row.n);
        }
        assertEquals(count, 600);
        assertEquals(total, 599 * 600 / 2);
      });
    });
    await Deno.writeTextFile(
      join(root, 'cut', 'server', 'data.db'),
      'interrupted database',
    );
    let called = false;
    await assertRejects(() =>
      inspectSnapshot(options, join(root, 'cut'), cut.files, root, {
        tenant: schema,
      }, () => {
        called = true;
        return Promise.resolve();
      })
    );
    assertEquals(called, false);
    assertEquals(
      [...Deno.readDirSync(root)].filter((e) => e.name.startsWith('.inspect-')),
      [],
    );
  } finally {
    await store.close();
    await Deno.remove(root, { recursive: true });
  }
});
