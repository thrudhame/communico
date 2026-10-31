// tests/store-gate.test.ts — real concurrent commits and reader drain. Conflicts
// are returned to the caller; only this workload explicitly retries its writes.
import { assert, assertEquals, assertRejects } from '@std/assert';
import { Db } from '#engine/store/db.ts';
import { StoreError, Turso } from '#engine/store/ffi.ts';
import { Gate } from '#engine/store/gate.ts';
import { databaseFiles } from '#engine/store/layout.ts';

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

Deno.test('store gate: a missing expected log fails loudly after commit', async () => {
  const dir = await Deno.makeTempDir();
  const gate = new Gate(
    databaseFiles(dir).database,
    65536,
    () => Promise.resolve([]),
  );
  try {
    await gate.enter();
    await assertRejects(
      () => gate.leave(true),
      StoreError,
      'expected MVCC logical log missing',
    );
    assertEquals(gate.stats().active, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('store gate: eight concurrent writers, 16000 rows and bounded logical log', async () => {
  const dir = await Deno.makeTempDir();
  const ffi = new Turso('./.native/libturso_ffi.so');
  const files = databaseFiles(dir);
  const db = await Db.open(ffi, files.database, 65536);
  let measured = 0;
  let conflicts = 0;
  db.gate.addEventListener('open', () => {
    if (db.gate.stats().completed > measured) {
      assert(Deno.statSync(files.log).size < 65536);
      measured++;
    }
  });
  try {
    await db.exec('CREATE TABLE rows_test(id INTEGER PRIMARY KEY, body TEXT)');
    const initialLogBytes = (await Deno.stat(files.log)).size;
    await db.execute('INSERT INTO rows_test VALUES(-1, ?)', [
      'probe'.repeat(50),
    ]);
    assert(
      (await Deno.stat(files.log)).size > initialLogBytes,
      'expected logical log must grow after a write',
    );
    await db.execute('DELETE FROM rows_test WHERE id = -1');
    await Promise.all(Array.from({ length: 8 }, async (_, writer) => {
      for (let row = 0; row < 2000; row++) {
        const deadline = performance.now() + 30000;
        for (;;) {
          try {
            await db.execute('INSERT INTO rows_test VALUES(?,?)', [
              writer * 2000 + row,
              'x'.repeat(128),
            ]);
            break;
          } catch (error) {
            if (
              !(error instanceof StoreError) || !error.busy ||
              performance.now() > deadline
            ) throw error;
            conflicts++;
            await delay(1);
          }
        }
      }
    }));
    assertEquals(
      await db.query(
        'SELECT count(*) AS n, min(id) AS lo, max(id) AS hi FROM rows_test',
      ),
      [{ n: 16000, lo: 0, hi: 15999 }],
    );
    const stats = db.gate.stats();
    assert(stats.barriers > 0);
    assertEquals(stats.completed, stats.barriers);
    assertEquals(stats.completed, measured);
    assertEquals(stats.active, 0);
    assertEquals(stats.closed, false);
    assertEquals(stats.exhausted, 0);
    assert(stats.pauseMs > 0);
    console.log(JSON.stringify({ ...stats, callerConflicts: conflicts }));
  } finally {
    await db.close();
    ffi.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('store gate: long reader delays checkpoint and new readers wait without deadlock', async () => {
  const dir = await Deno.makeTempDir();
  const ffi = new Turso('./.native/libturso_ffi.so');
  const db = await Db.open(ffi, databaseFiles(dir).database, 65536);
  let release!: () => void;
  let ready!: () => void;
  const held = new Promise<void>((resolve) => release = resolve);
  const started = new Promise<void>((resolve) => ready = resolve);
  try {
    await db.exec('CREATE TABLE rows_test(id INTEGER PRIMARY KEY, body TEXT)');
    const reader = db.tx(async (tx) => {
      await tx.query('SELECT * FROM rows_test');
      ready();
      await held;
    });
    await started;
    let committed = false;
    const writer = db.execute('INSERT INTO rows_test VALUES(1,?)', [
      'y'.repeat(70000),
    ])
      .then(() => committed = true);
    const deadline = performance.now() + 5000;
    while (!db.gate.stats().closed && performance.now() < deadline) {
      await delay(1);
    }
    assert(db.gate.stats().closed);
    assertEquals(db.gate.stats().active, 1);
    assertEquals(db.gate.stats().checkpointing, false);
    assertEquals(committed, false);
    let admitted = false;
    const next = db.query('SELECT count(*) AS n FROM rows_test').then(
      (rows) => {
        admitted = true;
        assertEquals(rows, [{ n: 1 }]);
      },
    );
    await delay(20);
    assertEquals(admitted, false);
    release();
    await Promise.all([reader, writer, next]);
    assertEquals(db.gate.stats().active, 0);
    assertEquals(db.gate.stats().completed, 1);
  } finally {
    release?.();
    await db.close();
    ffi.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('store gate: checkpoint busy codes and errors retry, then reopen admission', async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(databaseFiles(dir).log, 'threshold');
  let attempts = 0;
  const gate = new Gate(databaseFiles(dir).database, 1, (started) => {
    started();
    attempts++;
    if (attempts === 1) {
      return Promise.reject(new StoreError(5, 'busy', 'Busy'));
    }
    if (attempts === 2) return Promise.resolve([{ busy: 1 }]);
    return Promise.resolve([{ busy: 0 }]);
  });
  try {
    await gate.enter();
    await gate.leave(true);
    assertEquals(attempts, 3);
    assertEquals(gate.stats().retries, 2);
    assertEquals(gate.stats().completed, 1);
    assertEquals(gate.stats().closed, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
