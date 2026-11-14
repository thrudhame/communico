// The snapshot primitive must use a store-owned autocommit connection, not tx.
import { assert, assertEquals, assertRejects } from '@std/assert';
import { Db } from '#engine/store/db.ts';
import { Turso } from '#engine/store/ffi.ts';
import { integrityCheck } from '#engine/store/create.ts';

type BackupDb = Db & {
  vacuumInto(path: string): Promise<void>;
};

async function fixture() {
  const root = await Deno.makeTempDir({ prefix: 'store-backup-' });
  const ffi = new Turso('./.native/libturso_ffi.so');
  const db = await Db.open(ffi, root + '/data.db', 100000000) as BackupDb;
  await db.exec(
    'CREATE TABLE entries(n INTEGER PRIMARY KEY, body TEXT NOT NULL); ' +
      'CREATE TABLE head(n INTEGER NOT NULL); INSERT INTO head VALUES(0)',
  );
  return { root, ffi, db };
}

async function append(db: Db, n: number, bytes = 256) {
  await db.tx(async (tx) => {
    await tx.execute('INSERT INTO entries VALUES(?,?)', [n, 'x'.repeat(bytes)]);
    await tx.execute('UPDATE head SET n=?', [n]);
  });
}

Deno.test('store backup: coherent MVCC prefix under concurrent writes and independent main-only reopen', async () => {
  const { root, ffi, db } = await fixture();
  try {
    for (let n = 1; n <= 60; n++) await append(db, n);
    assert((await Deno.stat(root + '/data.db-log')).size > 0);
    const output = root + "/snap's";
    await Deno.mkdir(output, { mode: 0o700 });
    let written = 60;
    let running = true;
    const traffic = (async () => {
      while (running && written < 180) await append(db, ++written);
    })();
    try {
      await db.vacuumInto(output + '/data.db');
    } finally {
      running = false;
      await traffic;
    }
    assertEquals((await Deno.stat(output + '/data.db')).mode! & 0o777, 0o600);
    await Deno.mkdir(root + '/independent');
    await Deno.copyFile(output + '/data.db', root + '/independent/data.db');
    const copy = await Db.open(ffi, root + '/independent/data.db', 100000000);
    try {
      await integrityCheck(copy);
      const head = Number((await copy.query('SELECT n FROM head'))[0].n);
      assert(head >= 60 && head <= written);
      assertEquals(
        await copy.query(
          'SELECT count(*) AS n,min(n) AS lo,max(n) AS hi FROM entries',
        ),
        [{ n: head, lo: 1, hi: head }],
      );
    } finally {
      await copy.close();
    }
  } finally {
    await db.close();
    ffi.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('store backup: failed destination preserves original bytes and releases maintenance admission', async () => {
  const { root, ffi, db } = await fixture();
  try {
    await Deno.writeTextFile(root + '/existing', 'keep existing');
    await assertRejects(() => db.vacuumInto(root + '/existing'));
    assertEquals(await Deno.readTextFile(root + '/existing'), 'keep existing');
    await assertRejects(() => db.vacuumInto(root + '/absent/data.db'));
    await append(db, 1);
    assertEquals(db.gate.stats().active, 0);
    assertEquals(db.gate.stats().closed, false);
    await integrityCheck(db);
  } finally {
    await db.close();
    ffi.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('store backup: close drains an admitted snapshot', async () => {
  const { root, ffi, db } = await fixture();
  try {
    const snapshot = db.vacuumInto(root + '/closed.db');
    const closed = db.close();
    await snapshot;
    await closed;
    assertEquals((await Deno.stat(root + '/closed.db')).isFile, true);
    await assertRejects(() => db.vacuumInto(root + '/after-close.db'));
  } finally {
    await db.close();
    ffi.close();
    await Deno.remove(root, { recursive: true });
  }
});
