// Whole-body retry must re-read the winning snapshot, not repeat COMMIT.
import { assert, assertEquals, assertRejects, assertThrows } from '@std/assert';
import { type Conn, Db, StoreConflictError } from '#engine/store/db.ts';
import { StoreError, Turso } from '#engine/store/ffi.ts';

Deno.test('store conflicts: two forced snapshots both commit without a lost update', async () => {
  const dir = await Deno.makeTempDir();
  const ffi = new Turso('./.native/libturso_ffi.so');
  const db = await Db.open(ffi, dir + '/data.db', 65536);
  try {
    await db.exec(
      'CREATE TABLE counter(id INTEGER PRIMARY KEY, value INTEGER)',
    );
    await db.execute('INSERT INTO counter VALUES(1,0)');
    let ready = 0;
    const both = Promise.withResolvers<void>();
    const calls = [0, 0];
    const results = await Promise.allSettled(
      [0, 1].map((writer) =>
        db.tx(async (tx) => {
          const first = ++calls[writer] === 1;
          const value = Number(
            (await tx.query('SELECT value FROM counter'))[0].value,
          );
          if (first) {
            if (++ready === 2) both.resolve();
            await both.promise;
          }
          await tx.execute('UPDATE counter SET value = ? WHERE id = 1', [
            value + 1,
          ]);
          return value + 1;
        })
      ),
    );
    assertEquals(
      results.map((r) => r.status),
      ['fulfilled', 'fulfilled'],
      JSON.stringify(results.map((r) =>
        r.status === 'rejected'
          ? {
            message: String(r.reason),
            code: r.reason.code,
            lastError: r.reason.lastError,
          }
          : r.value
      )),
    );
    assertEquals(await db.query('SELECT value FROM counter'), [{ value: 2 }]);
    assert(calls[0] + calls[1] > 2, 'the losing body must run again');
    assert(db.conflictStats().conflicts > 0);
    assertEquals(db.conflictStats().exhausted, 0);
    assertEquals(db.gate.stats().active, 0);
  } finally {
    await db.close();
    ffi.close();
    await Deno.remove(dir, { recursive: true });
  }
});

async function withDb(fn: (db: Db, ffi: Turso) => Promise<void>) {
  const dir = await Deno.makeTempDir();
  const ffi = new Turso('./.native/libturso_ffi.so');
  const db = await Db.open(ffi, dir + '/data.db', 65536);
  try {
    await db.exec(
      'CREATE TABLE counter(id INTEGER PRIMARY KEY, value INTEGER)',
    );
    await db.execute('INSERT INTO counter VALUES(1,0)');
    await fn(db, ffi);
  } finally {
    await db.close();
    ffi.close();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test('store conflicts: only exact native conflicts retry; other body errors roll back once', async () => {
  await withDb(async (db) => {
    for (
      const failure of [
        new Error('busy'),
        new StoreError(19, 'Write-write conflict', 'constraint'),
        new StoreError(1, 'busy SQL conflict', 'Error("busy SQL conflict")'),
      ]
    ) {
      let calls = 0;
      const error = await assertRejects(() =>
        db.tx(async (tx) => {
          calls++;
          await tx.execute('UPDATE counter SET value = value + 1');
          throw failure;
        })
      );
      assertEquals(error, failure);
      assertEquals(calls, 1);
      assertEquals(await db.query('SELECT value FROM counter'), [{ value: 0 }]);
    }
    assertEquals(db.conflictStats().retries, 0);
    assertEquals(db.gate.stats().active, 0);
  });
});

Deno.test('store conflicts: busy begin and snapshot commit replay safely on released connections', async () => {
  await withDb(async (db, ffi) => {
    const begin = ffi.begin.bind(ffi), commit = ffi.commit.bind(ffi);
    let begins = 0, commits = 0;
    const connections: Conn[] = [];
    ffi.begin = (handle, mode) => {
      if (++begins === 1) {
        return Promise.reject(new StoreError(5, 'busy', 'Busy'));
      }
      return begin(handle, mode);
    };
    ffi.commit = (handle) => {
      if (++commits === 1) {
        return Promise.reject(new StoreError(517, 'snapshot', 'BusySnapshot'));
      }
      return commit(handle);
    };
    try {
      assertEquals(
        await db.tx(async (tx) => {
          connections.push(tx);
          const value = Number(
            (await tx.query('SELECT value FROM counter'))[0].value,
          );
          await tx.execute('UPDATE counter SET value = ?', [value + 1]);
          return value + 1;
        }),
        1,
      );
    } finally {
      ffi.begin = begin;
      ffi.commit = commit;
    }
    assertEquals([begins, commits, connections.length], [3, 2, 2]);
    for (const tx of connections) {
      assertThrows(() => tx.query('SELECT 1'), Error, 'released');
    }
    assertEquals(await db.query('SELECT value FROM counter'), [{ value: 1 }]);
    assertEquals(db.conflictStats().retries, 2);
    assertEquals(db.gate.stats().active, 0);
  });
});

Deno.test('store conflicts: exhaustion is typed and bounded; rollback failure never retries', async () => {
  await withDb(async (db, ffi) => {
    const commit = ffi.commit.bind(ffi), rollback = ffi.rollback.bind(ffi);
    const failure = new StoreError(
      1,
      'Write-write conflict',
      'Error("Write-write conflict")',
    );
    const connections: Conn[] = [];
    ffi.commit = () => Promise.reject(failure);
    try {
      const error = await assertRejects(
        () =>
          db.tx(async (tx) => {
            connections.push(tx);
            await tx.execute('UPDATE counter SET value = value + 1');
          }),
        StoreConflictError,
        db.path,
      );
      assertEquals(error.path, db.path);
      assertEquals(error.attempts, 20);
      assertEquals(error.cause, failure);
      assertEquals(connections.length, 20);
      assertEquals(db.conflictStats().retries, 19);
      assertEquals(db.conflictStats().exhausted, 1);
      for (const tx of connections) {
        assertThrows(() => tx.query('SELECT 1'), Error, 'released');
      }
      ffi.commit = commit;
      assertEquals(await db.query('SELECT value FROM counter'), [{ value: 0 }]);
      const before = db.conflictStats();
      const brokenRollback = new Error('rollback failed');
      ffi.commit = () => Promise.reject(failure);
      ffi.rollback = () => Promise.reject(brokenRollback);
      const aggregate = await assertRejects(() =>
        db.tx(async (tx) => {
          await tx.execute('UPDATE counter SET value = value + 1');
        }), AggregateError);
      assertEquals(aggregate.errors, [failure, brokenRollback]);
      assertEquals(db.conflictStats(), before);
    } finally {
      ffi.commit = commit;
      ffi.rollback = rollback;
    }
    assertEquals(db.gate.stats().active, 0);
    assertEquals(await db.query('SELECT value FROM counter'), [{ value: 0 }]);
    await db.execute('UPDATE counter SET value = 2');
    assertEquals(await db.query('SELECT value FROM counter'), [{ value: 2 }]);
  });
});

Deno.test('store conflicts: a post-commit gate failure never replays the body', async () => {
  await withDb(async (db) => {
    const leave = db.gate.leave.bind(db.gate);
    let calls = 0;
    const failure = new StoreError(5, 'maintenance busy', 'Busy');
    db.gate.leave = async (committed) => {
      await leave(committed);
      throw failure;
    };
    try {
      assertEquals(
        await assertRejects(() =>
          db.tx(async (tx) => {
            calls++;
            await tx.execute('UPDATE counter SET value = value + 1');
          })
        ),
        failure,
      );
    } finally {
      db.gate.leave = leave;
    }
    assertEquals(calls, 1);
    assertEquals(await db.query('SELECT value FROM counter'), [{ value: 1 }]);
    assertEquals(db.conflictStats().retries, 0);
    assertEquals(db.gate.stats().active, 0);
  });
});
