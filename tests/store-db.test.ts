// tests/store-db.test.ts — real MVCC files, native type/error round trips and
// transaction lifetime. Temporary databases follow the caller's disk TMPDIR.
import { assert, assertEquals, assertRejects, assertThrows } from '@std/assert';
import { Conn, Db } from '#engine/store/db.ts';
import { StoreError, Turso } from '#engine/store/ffi.ts';

Deno.test('store FFI: MVCC/FULL, values, checkpoint and explicit engine errors', async () => {
  const dir = await Deno.makeTempDir();
  const ffi = new Turso('./.native/libturso_ffi.so');
  const file = await ffi.open(dir + '/data.db');
  const connection = await ffi.connect(file);
  try {
    assertEquals(
      Object.values((await ffi.query(connection, 'PRAGMA journal_mode'))[0]),
      ['mvcc'],
    );
    assertEquals(
      Object.values((await ffi.query(connection, 'PRAGMA synchronous'))[0]),
      [2],
    );
    await ffi.exec(
      connection,
      'CREATE TABLE values_test(n INTEGER, r REAL, t TEXT, b BLOB, z TEXT); CREATE INDEX values_n ON values_test(n)',
    );
    assertEquals(
      await ffi.execute(
        connection,
        'INSERT INTO values_test VALUES(?,?,?,?,?)',
        [42, 1.5, 'hello\0world', new Uint8Array([0, 127, 255]), null],
      ),
      1,
    );
    assertEquals(
      await ffi.query(connection, 'SELECT * FROM values_test WHERE n = ?', [
        42,
      ]),
      [{
        n: 42,
        r: 1.5,
        t: 'hello\0world',
        b: new Uint8Array([0, 127, 255]),
        z: null,
      }],
    );
    const error = await assertRejects(
      () => ffi.query(connection, 'SELECT * FROM absent'),
      StoreError,
    );
    assert(error.message.includes('absent'));
    assert(error.lastError.includes('absent'));
    assert(error.code !== 0);
    assertThrows(() => ffi.close(), Error, 'in use');
    await assertRejects(
      () => ffi.closeFile(file),
      StoreError,
      'live connections',
    );
    assert((await ffi.checkpoint(connection, 'TRUNCATE')).length > 0);
  } finally {
    await ffi.closeConnection(connection);
    await ffi.closeFile(file);
    ffi.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('store Db: transaction commit, rollback, released Conn and canonical ownership', async () => {
  const dir = await Deno.makeTempDir();
  const ffi = new Turso('./.native/libturso_ffi.so');
  const db = await Db.open(ffi, dir + '/data.db');
  try {
    const same = await Db.open(ffi, dir + '/./data.db');
    assertEquals(same, db);
    await same.close();
    await db.exec('CREATE TABLE rows_test(id INTEGER PRIMARY KEY, value TEXT)');
    let retained: Conn | undefined;
    const result = await db.tx(async (tx) => {
      retained = tx;
      await tx.execute('INSERT INTO rows_test VALUES(?, ?)', [1, 'committed']);
      return 'result';
    });
    assertEquals(result, 'result');
    assertThrows(() => retained!.query('SELECT 1'), Error, 'released');
    await assertRejects(
      () =>
        db.tx(async (tx) => {
          await tx.execute('INSERT INTO rows_test VALUES(?, ?)', [
            2,
            'rolled back',
          ]);
          throw new Error('abort callback');
        }),
      Error,
      'abort callback',
    );
    assertEquals(await db.query('SELECT * FROM rows_test'), [{
      id: 1,
      value: 'committed',
    }]);
    const reads = await Promise.all(
      Array.from({ length: 24 }, () =>
        db.tx(async (tx) => {
          await new Promise((resolve) => setTimeout(resolve, 1));
          return await tx.query('SELECT count(*) AS n FROM rows_test');
        })),
    );
    assert(reads.every((rows) => rows[0].n === 1));
  } finally {
    await db.close();
    ffi.close();
    await Deno.remove(dir, { recursive: true });
  }
});
