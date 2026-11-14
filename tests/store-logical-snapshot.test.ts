import { assert, assertEquals, assertRejects } from '@std/assert';
import { Db } from '#engine/store/db.ts';
import { Turso } from '#engine/store/ffi.ts';
import { integrityCheck } from '#engine/store/create.ts';

type Reader = {
  export(destination: string): Promise<void>;
  release(): Promise<void>;
};
type SnapshotDb = Db & { readSnapshot(): Promise<Reader> };

async function fixture() {
  const root = await Deno.makeTempDir({ prefix: "logical's-cut-" });
  const ffi = new Turso('./.native/libturso_ffi.so');
  const db = await Db.open(ffi, root + '/data.db', 65536) as SnapshotDb;
  await db.exec(
    'CREATE TABLE entries(id TEXT PRIMARY KEY, body TEXT, bytes BLOB, n REAL, absent TEXT);' +
      'CREATE INDEX entries_body ON entries(body);' +
      'CREATE TABLE meta(k TEXT PRIMARY KEY,v TEXT);' +
      "INSERT INTO meta VALUES('schema_version','28')",
  );
  return { root, ffi, db };
}

Deno.test('logical snapshot: held cut defers checkpoints without blocking threshold writers', async () => {
  const { root, ffi, db } = await fixture();
  let reader: Reader | undefined;
  let writer: Promise<unknown> | undefined;
  try {
    await db.execute(
      'INSERT INTO entries(rowid,id,body,bytes,n) VALUES(-7,?,?,?,?)',
      [
        'before',
        'held',
        new Uint8Array([0, 255]),
        1.25,
      ],
    );
    reader = await db.readSnapshot();
    const barriers = db.gate.stats().barriers;
    let completed = false;
    writer = (async () => {
      for (let n = 0; n < 4; n++) {
        await db.execute('INSERT INTO entries(id,body) VALUES(?,?)', [
          'after-' + n,
          'x'.repeat(70000),
        ]);
      }
      completed = true;
    })();
    await Promise.race([
      writer,
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
    assert(completed, 'threshold-crossing writer stalled behind backup reader');
    assertEquals(db.gate.stats().barriers, barriers);
    assertEquals(db.gate.stats().active, 0);
    await Deno.mkdir(root + '/out');
    await reader.export(root + '/out/data.db');
    await reader.release();
    reader = undefined;
    await db.query('SELECT id FROM entries');
    assert(
      db.gate.stats().completed > barriers,
      'catch-up checkpoint never ran',
    );
    await Deno.mkdir(root + '/independent');
    await Deno.copyFile(root + '/out/data.db', root + '/independent/data.db');
    const copy = await Db.open(ffi, root + '/independent/data.db', 65536);
    try {
      await integrityCheck(copy);
      assertEquals(await copy.query('SELECT rowid,* FROM entries'), [{
        rowid: -7,
        id: 'before',
        body: 'held',
        bytes: new Uint8Array([0, 255]),
        n: 1.25,
        absent: null,
      }]);
      assertEquals(await copy.query('SELECT * FROM meta'), [{
        k: 'schema_version',
        v: '28',
      }]);
      assertEquals(
        (await copy.query(
          "SELECT name FROM sqlite_schema WHERE name='entries_body'",
        ))[0].name,
        'entries_body',
      );
      assertEquals(
        (await Deno.stat(root + '/out/data.db')).mode! & 0o777,
        0o600,
      );
    } finally {
      await copy.close();
    }
  } finally {
    await reader?.release();
    await writer;
    await db.close();
    ffi.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('logical snapshot: keyset pages preserve sparse negative and positive rowids', async () => {
  const { root, ffi, db } = await fixture();
  let reader: Reader | undefined;
  try {
    await db.tx(async (tx) => {
      for (let n = -140; n < 140; n++) {
        await tx.execute('INSERT INTO entries(rowid,id,body) VALUES(?,?,?)', [
          n * 3,
          String(n),
          'quoted\0text',
        ]);
      }
    });
    reader = await db.readSnapshot();
    await Deno.mkdir(root + '/out');
    await reader.export(root + '/out/data.db');
    await reader.release();
    reader = undefined;
    const copy = await Db.open(ffi, root + '/out/data.db', 65536);
    try {
      await integrityCheck(copy);
      assertEquals(
        await copy.query('SELECT rowid,* FROM entries ORDER BY rowid'),
        await db.query('SELECT rowid,* FROM entries ORDER BY rowid'),
      );
    } finally {
      await copy.close();
    }
  } finally {
    await reader?.release();
    await db.close();
    ffi.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('logical snapshot: failed export and pin unwind all source maintenance ownership', async () => {
  const { root, ffi, db } = await fixture();
  let reader: Reader | undefined;
  try {
    reader = await db.readSnapshot();
    await Deno.writeTextFile(root + '/occupied', 'keep');
    await assertRejects(() => reader!.export(root + '/occupied'));
    assertEquals(await Deno.readTextFile(root + '/occupied'), 'keep');
    await reader.release();
    await reader.release();
    await assertRejects(() => reader!.export(root + '/after-release'));
    reader = undefined;
    const query = ffi.query;
    ffi.query = () => Promise.reject(new Error('injected pin failure'));
    await assertRejects(() => db.readSnapshot(), Error, 'injected pin failure');
    ffi.query = query;
    await db.execute('INSERT INTO entries(id,body) VALUES(?,?)', [
      'after',
      'x'.repeat(70000),
    ]);
    assertEquals(db.gate.stats().active, 0);
    assertEquals(db.gate.stats().closed, false);
    assert(db.gate.stats().completed > 0);
  } finally {
    await reader?.release();
    await db.close();
    ffi.close();
    await Deno.remove(root, { recursive: true });
  }
});
