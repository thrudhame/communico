import {
  assertEquals,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from '@std/assert';
import { PendingContacts } from '#engine/federation/pending-contacts.ts';
import {
  addPeer,
  listPending,
  recordPending,
} from '#engine/federation/peers.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { Db } from '#engine/store/db.ts';
import { Turso } from '#engine/store/ffi.ts';
import { drainResources } from '#engine/lifetime.ts';
import { setConfigForTests } from '#engine/config.ts';
import { closeApp, openApp } from '#engine/app.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => resolve = done);
  return { promise, resolve };
}

async function withDb(
  fn: (db: Db, ffi: Turso) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const ffi = new Turso('./.native/libturso_ffi.so');
  const db = await Db.open(ffi, dir + '/data.db', 65536);
  try {
    await serverSchema.apply(db);
    await fn(db, ffi);
  } finally {
    await drainResources([
      () => db.close(),
      () => ffi.close(),
      () => Deno.remove(dir, { recursive: true }),
    ]);
  }
}

Deno.test('contact diagnostics: one write per flush, exact queued count, independent keys and owned close', async () => {
  await withDb(async (db, ffi) => {
    await recordPending(db, 'held.test', 'inbound', false, '/unverified');
    await recordPending(db, 'free.test', 'inbound', true, '/seed');
    const before = db.conflictStats();
    const held = deferred();
    const entered = deferred();
    const free = deferred();
    const execute = ffi.execute.bind(ffi);
    const commit = ffi.commit.bind(ffi);
    const freeHandles = new Set<number>();
    const writes: number[] = [];
    ffi.execute = async (...args: Parameters<typeof ffi.execute>) => {
      if (args[1].startsWith('UPDATE federation_pending ')) {
        if (args[2]?.[4] === 'held.test') {
          writes.push(Number(args[2][1]));
          if (writes.length === 1) {
            entered.resolve();
            await held.promise;
          }
        } else if (args[2]?.[4] === 'free.test') freeHandles.add(args[0]);
      }
      return await execute(...args);
    };
    ffi.commit = async (handle) => {
      await commit(handle);
      if (freeHandles.delete(handle)) free.resolve();
    };
    const contacts = new PendingContacts(db);
    try {
      contacts.record('held.test', 'inbound', '/first');
      await entered.promise;
      for (let i = 1; i < 32; i++) {
        contacts.record('held.test', 'inbound', '/' + i);
      }
      contacts.record('free.test', 'inbound', '/free');
      await free.promise;
      assertEquals(
        writes,
        [1],
        'same-key contributions wait for their owned flush',
      );
      assertEquals(
        (await listPending(db)).find((row) => row.name === 'free.test')?.count,
        2,
      );
      const closed = contacts.close();
      assertThrows(
        () => contacts.record('late.test', 'inbound', '/late'),
        Error,
        'closing',
      );
      held.resolve();
      await closed;
      const row = (await listPending(db)).find((row) =>
        row.name === 'held.test'
      )!;
      assertEquals(row.count, 33);
      assertEquals(row.verified, true);
      assertEquals(row.detail, '/31');
      assertEquals(
        writes,
        [1, 31],
        'one mutation per flush, not one per contact',
      );
      assertEquals(db.conflictStats().conflicts - before.conflicts, 0);
    } finally {
      held.resolve();
      await contacts.close();
    }
  });
});

Deno.test('contact diagnostics: key kinds and stores are independent; expired and disabled coalescing retain semantics', async () => {
  await withDb(async (db) => {
    const contacts = new PendingContacts(db);
    try {
      await recordPending(db, 'same.test', 'inbound', false, '/old');
      await db.execute('UPDATE federation_pending SET last_ms=0');
      for (let i = 0; i < 32; i++) {
        contacts.record('same.test', 'inbound', '/new');
      }
      contacts.record('same.test', 'disagreement', '/keys');
      await contacts.drain();
      const rows = await listPending(db);
      assertEquals(rows.find((row) => row.kind === 'inbound')?.count, 32);
      assertEquals(rows.find((row) => row.kind === 'inbound')?.verified, true);
      assertEquals(rows.find((row) => row.kind === 'disagreement')?.count, 1);
      await withDb(async (other) => {
        const independent = new PendingContacts(other);
        independent.record('same.test', 'inbound', '/other');
        await independent.close();
        assertEquals((await listPending(other))[0].count, 1);
        assertEquals(
          (await listPending(db)).find((row) => row.kind === 'inbound')?.count,
          32,
        );
      });
      setConfigForTests({ federation: { keyfailminutes: 0 } });
      contacts.record('same.test', 'inbound', '/disabled');
      contacts.record('same.test', 'inbound', '/last');
      await contacts.drain();
      const row = (await listPending(db)).find((row) =>
        row.kind === 'inbound'
      )!;
      assertEquals(row.count, 1);
      assertEquals(row.detail, '/last');
    } finally {
      setConfigForTests({});
      await contacts.close();
    }
  });
});

Deno.test('contact diagnostics: persistence failures are observed by drain and shutdown, not detached', async () => {
  await withDb(async (db) => {
    const fault = new Error('door log unavailable');
    const failures: unknown[] = [];
    const contacts = new PendingContacts({
      path: db.path,
      tx: () => Promise.reject(fault),
      query: db.query.bind(db),
      execute: db.execute.bind(db),
      exec: db.exec.bind(db),
    }, (error) => failures.push(error));
    contacts.record('failed.test', 'inbound', '/first');
    assertStrictEquals(await assertRejects(() => contacts.drain()), fault);
    contacts.record('failed.test', 'inbound', '/second');
    assertStrictEquals(await assertRejects(() => contacts.close()), fault);
    assertEquals(failures, [fault]);
    assertEquals(await listPending(db), []);
  });
});

Deno.test('contact diagnostics: a completed roster approval supersedes a queued knock', async () => {
  await withDb(async (db) => {
    const held = deferred();
    const contacts = new PendingContacts({
      path: db.path,
      tx: async (fn, options) => {
        await held.promise;
        return await db.tx(fn, options);
      },
      query: db.query.bind(db),
      execute: db.execute.bind(db),
      exec: db.exec.bind(db),
    });
    try {
      contacts.record('approved.test', 'inbound', '/queued');
      await addPeer(db, {
        name: 'approved.test',
        host: null,
        port: null,
        trust: 'ca',
        addedBy: 'approval',
      });
      held.resolve();
      await contacts.drain();
      assertEquals(await listPending(db), []);
    } finally {
      held.resolve();
      await contacts.close();
    }
  });
});

Deno.test('contact diagnostics: application shutdown drains accepted contacts before closing storage', async () => {
  const dir = await Deno.makeTempDir();
  const options = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  try {
    const app = await openApp(options);
    for (let i = 0; i < 32; i++) {
      app.federationContacts.record('shutdown.test', 'inbound', '/shutdown');
    }
    await closeApp();
    const reopened = await openApp(options);
    const rows = await listPending(reopened.server);
    assertEquals(rows.find((row) => row.name === 'shutdown.test')?.count, 32);
  } finally {
    await drainResources([
      () => closeApp(),
      () => Deno.remove(dir, { recursive: true }),
    ]);
  }
});
