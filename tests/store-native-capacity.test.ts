import { Capacity } from '#engine/store/capacity.ts';
import { Db } from '#engine/store/db.ts';
import { StoreError, Turso } from '#engine/store/ffi.ts';
import { StoragePressureError } from '#engine/store/pressure.ts';
import { assert, assertEquals, assertRejects } from '@std/assert';

const MiB = 1024 * 1024;

async function fixture(
  test: (db: Db, ffi: Turso, capacity: Capacity) => Promise<void>,
) {
  const root = await Deno.makeTempDir();
  const ffi = new Turso('./.native/libturso_ffi.so');
  const capacity = new Capacity([root], 64 * MiB);
  let db: Db | undefined;
  try {
    db = await Db.open(ffi, `${root}/data.db`, MiB, undefined, capacity);
    await db.exec('CREATE TABLE records(n INTEGER PRIMARY KEY)');
    await test(db, ffi, capacity);
  } finally {
    await db?.close();
    ffi.close();
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test('managed SQL: actual reads require no write admission', async () => {
  await fixture(async (db, _, capacity) => {
    const deny = new StoragePressureError();
    capacity.tryReserveNative = () => Promise.reject(deny);
    assertEquals(
      await db.query(
        "/* DELETE FROM records; */ SELECT 'UPDATE; INSERT' AS value; -- REPLACE",
      ),
      [{ value: 'UPDATE; INSERT' }],
    );
    assertEquals(
      await db.query(
        `WITH "update"(n) AS (SELECT 7), next AS (SELECT n FROM "update") SELECT n FROM next`,
      ),
      [{ n: 7 }],
    );
    assertEquals((await db.query('PRAGMA table_info("records")'))[0].name, 'n');
    assertEquals(
      (await db.query('PRAGMA integrity_check'))[0].integrity_check,
      'ok',
    );
    for (
      const sql of [
        'INSERT INTO records VALUES (1) RETURNING n',
        'WITH x(n) AS (SELECT 2) INSERT INTO records SELECT n FROM x RETURNING n',
        'PRAGMA mvcc_checkpoint_threshold(1)',
        'PRAGMA user_version=1',
        'SELECT 1; DELETE FROM records',
      ]
    ) {
      await assertRejects(() => db.query(sql), StoragePressureError);
    }
    assertEquals(await db.query('SELECT COUNT(*) AS n FROM records'), [{
      n: 0,
    }]);
  });
});

Deno.test('managed SQL: native full uses the existing attempt limit', async () => {
  await fixture(async (db, ffi, capacity) => {
    const full = new StoreError(13, 'database is full', 'DatabaseFull');
    let attempts = 0;
    let reclaims = 0;
    ffi.execute = () => Promise.reject(full);
    capacity.reclaimAfterFull = () => Promise.resolve(++reclaims <= 25);
    await assertRejects(
      () =>
        db.tx(async (conn) => {
          attempts++;
          await conn.execute('INSERT INTO records VALUES (1)');
        }),
      StoragePressureError,
    );
    assertEquals(attempts, 20);
    assertEquals(reclaims, 19);
    assertEquals((await capacity.status()).filesystems[0].reservedBytes, 0);
  });
});

for (const phase of ['admission', 'query', 'execute', 'exec'] as const) {
  Deno.test(`managed SQL: rejected body drains pending ${phase} before rollback`, async () => {
    await fixture(async (db, ffi, capacity) => {
      const unblock = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      const rollback = ffi.rollback.bind(ffi);
      let rolledBack = false;
      ffi.rollback = (handle) => {
        rolledBack = true;
        return rollback(handle);
      };
      const pause = async () => {
        entered.resolve();
        await unblock.promise;
      };
      const tryReserve = capacity.tryReserveNative.bind(capacity);
      const query = ffi.query.bind(ffi);
      const execute = ffi.execute.bind(ffi);
      const exec = ffi.exec.bind(ffi);
      if (phase === 'admission') {
        capacity.tryReserveNative = async (...args) => {
          await pause();
          return await tryReserve(...args);
        };
      } else if (phase === 'query') {
        ffi.query = async (...args) => {
          await pause();
          return await query(...args);
        };
      } else if (phase === 'execute') {
        ffi.execute = async (...args) => {
          await pause();
          return await execute(...args);
        };
      } else {
        ffi.exec = async (...args) => {
          await pause();
          return await exec(...args);
        };
      }
      let issued: Promise<unknown> | undefined;
      const body = db.tx(async (conn) => {
        const sql = 'INSERT INTO records VALUES (1)';
        issued = (phase === 'query'
          ? conn.query('SELECT n FROM records')
          : phase === 'exec'
          ? conn.exec(sql)
          : conn.execute(sql)).catch(() =>
            undefined
          );
        await entered.promise;
        throw new Error('body failed');
      });
      const rejected = assertRejects(() => body, Error, 'body failed');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([entered.promise, rejected]);
        await new Promise<void>((resolve) => timer = setTimeout(resolve, 0));
        assert(!rolledBack, `${phase} still owns the connection`);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        unblock.resolve();
        await rejected;
        await issued;
      }
      assert(rolledBack);
      assertEquals(await db.query('SELECT n FROM records'), []);
      assertEquals((await capacity.status()).filesystems[0].reservedBytes, 0);
    });
  });
}

Deno.test('managed native open: clean existing file does not book bootstrap space', async () => {
  await fixture(async (db, ffi) => {
    await db.execute('INSERT INTO records VALUES (7)');
    await db.close();
    const root = db.path.slice(0, -'/data.db'.length);
    const noRoom = new Capacity([root], 0);
    const opened = await Db.open(ffi, db.path, MiB, undefined, noRoom);
    try {
      assertEquals(await opened.query('SELECT n FROM records'), [{ n: 7 }]);
    } finally {
      await opened.close();
    }
    await Deno.remove(`${db.path}-wal`);
    await assertRejects(
      () => Db.open(ffi, db.path, MiB, undefined, noRoom),
      StoragePressureError,
    );
    await assertRejects(
      () => Deno.stat(`${db.path}-wal`),
      Deno.errors.NotFound,
    );
    const recovered = await Db.open(
      ffi,
      db.path,
      MiB,
      undefined,
      new Capacity([root], 64 * MiB),
    );
    try {
      assertEquals(await recovered.query('SELECT n FROM records'), [{ n: 7 }]);
    } finally {
      await recovered.close();
    }
  });
});
