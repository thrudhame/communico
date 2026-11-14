import { assert, assertEquals, assertRejects } from '@std/assert';
import { type Database, Db } from '#engine/store/db.ts';
import { Turso } from '#engine/store/ffi.ts';
import { openStore } from '#engine/store/index.ts';
import { Admission } from '#engine/store/admission.ts';

function latch() {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { wait: promise, release: () => resolve() };
}

async function observed(task: Promise<unknown>, message: string) {
  let completed = false;
  await Promise.race([
    task.then(() => completed = true),
    new Promise((resolve) => setTimeout(resolve, 1000)),
  ]);
  assert(completed, message);
}

async function fixture() {
  const root = await Deno.makeTempDir({ prefix: 'snapshot-commit-' });
  const store = await openStore({
    dir: root + '/live',
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 2,
    idleseconds: 3600,
  });
  return { root, store };
}

Deno.test('store commit cut: staged writes and old readers do not delay the common cut', async () => {
  const { root, store } = await fixture();
  const databases = [
    await store.server(),
    await store.room('!ordinary:test', { create: true }),
    await store.tenant('inactive.test', { create: true }),
  ];
  const lease = await store.leaseRoom('!leased:test', { create: true });
  databases.push(lease.db);
  const resume = latch();
  const writes: Promise<unknown>[] = [], reads: Promise<unknown>[] = [];
  let snapshot: ReturnType<typeof store.snapshot> | undefined;
  try {
    for (const db of databases) {
      await db.exec(
        'CREATE TABLE traffic(n INTEGER PRIMARY KEY); INSERT INTO traffic VALUES(1)',
      );
      const writing = latch(), reading = latch();
      reads.push(db.tx(async (tx) => {
        assertEquals(await tx.query('SELECT n FROM traffic'), [{ n: 1 }]);
        reading.release();
        await resume.wait;
        assertEquals(await tx.query('SELECT n FROM traffic'), [{ n: 1 }]);
      }));
      await reading.wait;
      writes.push(db.tx(async (tx) => {
        await tx.execute('INSERT INTO traffic VALUES(2)');
        writing.release();
        await resume.wait;
      }));
      await writing.wait;
    }
    snapshot = store.snapshot(root + '/cut');
    await observed(
      snapshot,
      'common cut waited for transaction bodies instead of commits',
    );
    const cut = await snapshot;
    const ffi = new Turso('./.native/libturso_ffi.so');
    try {
      for (const file of cut.files) {
        const db = await Db.open(ffi, root + '/cut/' + file.path, 65536);
        try {
          assertEquals(await db.query('SELECT n FROM traffic'), [{ n: 1 }]);
        } finally {
          await db.close();
        }
      }
    } finally {
      ffi.close();
    }
    resume.release();
    await Promise.all([...writes, ...reads]);
    for (const db of databases) {
      assertEquals(await db.query('SELECT n FROM traffic ORDER BY n'), [{
        n: 1,
      }, { n: 2 }]);
    }
  } finally {
    resume.release();
    await Promise.allSettled([...writes, ...reads, snapshot]);
    await lease.release();
    await store.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('store commit cut: transaction bodies run during pinning but commits cannot cross it', async () => {
  const { root, store } = await fixture();
  const server = await store.server();
  await server.exec(
    'CREATE TABLE traffic(n INTEGER PRIMARY KEY); INSERT INTO traffic VALUES(1)',
  );
  const prepare = Db.prototype.prepareReadSnapshot;
  const pinned = latch(), resume = latch(), body = latch();
  Db.prototype.prepareReadSnapshot = async function () {
    const prepared = await prepare.call(this);
    if (this.path !== server.path) return prepared;
    return {
      ...prepared,
      pin: async () => {
        const reader = await prepared.pin();
        pinned.release();
        await resume.wait;
        return reader;
      },
    };
  };
  let snapshot: ReturnType<typeof store.snapshot> | undefined;
  let writing: Promise<unknown> | undefined;
  try {
    snapshot = store.snapshot(root + '/cut');
    await pinned.wait;
    let committed = false;
    writing = server.tx(async (tx) => {
      await tx.execute('INSERT INTO traffic VALUES(2)');
      body.release();
    }).then(() => committed = true);
    await observed(body.wait, 'common cut blocked transaction bodies');
    assertEquals(committed, false, 'native commit crossed the pin fence');
    resume.release();
    await Promise.all([snapshot, writing]);
    const ffi = new Turso('./.native/libturso_ffi.so');
    const db = await Db.open(ffi, root + '/cut/server/data.db', 65536);
    try {
      assertEquals(await db.query('SELECT n FROM traffic'), [{ n: 1 }]);
    } finally {
      await db.close();
      ffi.close();
    }
    assertEquals(await server.query('SELECT n FROM traffic ORDER BY n'), [{
      n: 1,
    }, { n: 2 }]);
  } finally {
    resume.release();
    await Promise.allSettled([snapshot, writing]);
    Db.prototype.prepareReadSnapshot = prepare;
    await store.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('store commit cut: unpublished initialization stays outside the cut and shutdown drains it', async () => {
  const { root, store } = await fixture();
  const staged = latch(), resume = latch();
  let creation: Promise<unknown> | undefined;
  let snapshot: ReturnType<typeof store.snapshot> | undefined;
  let closing: Promise<void> | undefined;
  try {
    creation = store.initializeRoom('!staged:test', async (db: Database) => {
      await db.exec(
        'CREATE TABLE traffic(n INTEGER PRIMARY KEY); INSERT INTO traffic VALUES(1)',
      );
      staged.release();
      await resume.wait;
    });
    await staged.wait;
    snapshot = store.snapshot(root + '/cut');
    await observed(snapshot, 'unpublished creation retained common admission');
    assertEquals((await snapshot).files.length, 1);
    let closed = false;
    closing = store.close().then(() => {
      closed = true;
    });
    await assertRejects(
      () => store.room('!new:test', { create: true }),
      Error,
      'closed',
    );
    assertEquals(closed, false);
    resume.release();
    await observed(
      Promise.all([creation, closing]),
      'shutdown fenced the publication it must drain',
    );
    const ffi = new Turso('./.native/libturso_ffi.so');
    try {
      const entries = [...Deno.readDirSync(root + '/live/rooms')].filter((e) =>
        !e.name.endsWith('.new')
      );
      assertEquals(entries.length, 1);
      const db = await Db.open(
        ffi,
        root + '/live/rooms/' + entries[0].name + '/data.db',
        65536,
      );
      try {
        assertEquals(await db.query('SELECT n FROM traffic'), [{ n: 1 }]);
      } finally {
        await db.close();
      }
    } finally {
      ffi.close();
    }
  } finally {
    resume.release();
    await Promise.allSettled([creation, snapshot, closing]);
    await store.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('store commit cut: uncommitted deferred DDL is excluded and can commit after shutdown starts', async () => {
  const { root, store } = await fixture();
  const room = await store.room('!schema:test', { create: true });
  const staged = latch(), resume = latch();
  let changing: Promise<unknown> | undefined;
  let snapshot: ReturnType<typeof store.snapshot> | undefined;
  let closing: Promise<void> | undefined;
  try {
    changing = room.tx(async (tx) => {
      await tx.exec(
        "CREATE TABLE next_schema(value TEXT); INSERT INTO next_schema VALUES('retained')",
      );
      staged.release();
      await resume.wait;
    }, { mode: 'deferred' });
    await staged.wait;
    snapshot = store.snapshot(root + '/cut');
    await observed(
      snapshot,
      'uncommitted DDL blocked logical snapshot acquisition',
    );
    const file = (await snapshot).files.find((file) =>
      file.id === '!schema:test'
    )!;
    const ffi = new Turso('./.native/libturso_ffi.so');
    try {
      const db = await Db.open(ffi, root + '/cut/' + file.path, 65536);
      try {
        assertEquals(
          await db.query(
            "SELECT name FROM sqlite_schema WHERE name='next_schema'",
          ),
          [],
        );
      } finally {
        await db.close();
      }
      closing = store.close();
      resume.release();
      await observed(
        Promise.all([changing, closing]),
        'shutdown blocked an accepted native commit',
      );
      const reopened = await Db.open(ffi, room.path, 65536);
      try {
        assertEquals(await reopened.query('SELECT value FROM next_schema'), [{
          value: 'retained',
        }]);
      } finally {
        await reopened.close();
      }
    } finally {
      ffi.close();
    }
  } finally {
    resume.release();
    await Promise.allSettled([changing, snapshot, closing]);
    await store.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('store commit cut: reopening a closing native owner retains its commit fence', async () => {
  const root = await Deno.makeTempDir({ prefix: 'reopen-fence-' });
  const ffi = new Turso('./.native/libturso_ffi.so');
  const admission = new Admission();
  const first = await Db.open(ffi, root + '/data.db', 65536, admission);
  await first.exec('CREATE TABLE traffic(n INTEGER PRIMARY KEY)');
  const closeFile = ffi.closeFile.bind(ffi);
  const closing = latch(),
    resumeClose = latch(),
    pinning = latch(),
    resumePin = latch(),
    staged = latch();
  ffi.closeFile = async (handle) => {
    closing.release();
    await resumeClose.wait;
    await closeFile(handle);
  };
  let next: Db | undefined;
  let boundary: Promise<unknown> | undefined,
    writing: Promise<unknown> | undefined;
  const closed = first.close();
  try {
    await closing.wait;
    const opening = Db.open(ffi, root + '/data.db', 65536, admission);
    resumeClose.release();
    next = await opening;
    await closed;
    boundary = admission.exclusive(async () => {
      pinning.release();
      await resumePin.wait;
    });
    await pinning.wait;
    let committed = false;
    writing = next.tx(async (tx) => {
      await tx.execute('INSERT INTO traffic VALUES(1)');
      staged.release();
    }).then(() => {
      committed = true;
    });
    await staged.wait;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assertEquals(committed, false, 'reopened owner dropped commit admission');
    resumePin.release();
    await writing;
  } finally {
    resumeClose.release();
    resumePin.release();
    await Promise.allSettled([closed, boundary, writing]);
    ffi.closeFile = closeFile;
    await next?.close();
    await first.close();
    ffi.close();
    await Deno.remove(root, { recursive: true });
  }
});
