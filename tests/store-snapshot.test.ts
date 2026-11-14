import { assert, assertEquals, assertRejects } from '@std/assert';
import { openStore, type Store } from '#engine/store/index.ts';
import { type Database, Db } from '#engine/store/db.ts';
import { Turso } from '#engine/store/ffi.ts';
import { integrityCheck } from '#engine/store/create.ts';

type SnapshotStore = Store & {
  snapshot(path: string): Promise<{
    files: { path: string; kind: string; id: string | null }[];
    pauseMs: number;
  }>;
};

function latch() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => release = resolve);
  return { wait, release };
}

async function fixture() {
  const root = await Deno.makeTempDir({ prefix: "store's-snapshot-" });
  const schema = {
    version: 1,
    apply: (db: Database) =>
      db.exec(
        'CREATE TABLE source(n INTEGER PRIMARY KEY, completed INTEGER NOT NULL)',
      ),
  };
  const store = await openStore({
    dir: root + '/live',
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 100000000,
    maxopenfiles: 2,
    idleseconds: 3600,
  }, {
    schemas: { server: schema, tenant: schema, room: schema },
  }) as SnapshotStore;
  return { root, store };
}

Deno.test('store snapshot: one cut preserves cross-file preparation, completion and projection order', async () => {
  const { root, store } = await fixture();
  const tenant = await store.tenant('cut.test', { create: true });
  const room = await store.room('!cut:cut.test', { create: true });
  const server = await store.server();
  const ready = latch();
  let running = true;
  let traffic: Promise<void> | undefined;
  const ffi = new Turso('./.native/libturso_ffi.so');
  try {
    await store.room('!inactive:cut.test', { create: true });
    await store.tenant('inactive.test', { create: true });
    await Deno.mkdir(root + '/live/rooms/interrupted.new');
    traffic = (async () => {
      for (let n = 1; running && n <= 180; n++) {
        await tenant.execute('INSERT INTO source VALUES(?,0)', [n]);
        await room.execute('INSERT INTO source VALUES(?,1)', [n]);
        await tenant.execute('UPDATE source SET completed=1 WHERE n=?', [n]);
        await server.execute('INSERT INTO source VALUES(?,1)', [n]);
        if (n === 10) ready.release();
      }
    })();
    await ready.wait;
    const cut = await store.snapshot(root + '/snapshot');
    running = false;
    await traffic;
    assert(cut.pauseMs > 0);
    assertEquals(cut.files.length, 5);
    const contents = new Map<string | null, number[]>();
    let completed: number[] = [];
    for (const file of cut.files) {
      const copy = await Db.open(
        ffi,
        root + '/snapshot/' + file.path,
        100000000,
      );
      try {
        await integrityCheck(copy);
        const rows = await copy.query(
          'SELECT n,completed FROM source ORDER BY n',
        );
        contents.set(file.id, rows.map((row) => Number(row.n)));
        if (file.id === 'cut.test') {
          completed = rows.filter((row) => row.completed === 1).map((row) =>
            Number(row.n)
          );
        }
      } finally {
        await copy.close();
      }
    }
    const prepared = new Set(contents.get('cut.test'));
    const events = new Set(contents.get('!cut:cut.test'));
    for (const n of events) {
      assert(prepared.has(n), 'event without tenant preparation');
    }
    for (const n of completed) {
      assert(events.has(n), 'completed receipt without event');
    }
    for (const n of contents.get(null)!) {
      assert(events.has(n), 'projection ahead of room');
    }
    assert(events.size >= 10);
    assertEquals((await store.rooms()).sort(), [
      '!cut:cut.test',
      '!inactive:cut.test',
    ]);
  } finally {
    running = false;
    await traffic;
    ffi.close();
    await store.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('store snapshot: lifecycle, held lease and ordinary transactions cannot bypass the cut', async () => {
  const { root, store } = await fixture();
  const room = await store.room('!existing:test', { create: true });
  const lease = await store.leaseRoom('!existing:test');
  const paused = latch(), resume = latch();
  const vacuum = Db.prototype.vacuumInto;
  let cutting = false;
  Db.prototype.vacuumInto = async function (path) {
    if (!cutting && this.path.startsWith(root + '/live/')) {
      cutting = true;
      paused.release();
      await resume.wait;
    }
    return await vacuum.call(this, path);
  };
  const actions: Promise<unknown>[] = [];
  let snapshot: ReturnType<SnapshotStore['snapshot']> | undefined;
  try {
    snapshot = store.snapshot(root + '/snapshot');
    await paused.wait;
    const completed: string[] = [];
    const launch = (name: string, fn: () => Promise<unknown>) => {
      const action = fn().then(() => completed.push(name));
      actions.push(action);
    };
    launch('lease', () => lease.db.execute('INSERT INTO source VALUES(1,1)'));
    launch('logical', () => room.execute('INSERT INTO source VALUES(2,1)'));
    launch('tenant', () => store.tenant('new.test', { create: true }));
    launch('room', () => store.room('!new:test', { create: true }));
    launch('retire', () => store.retireRoom('!existing:test'));
    await Promise.resolve();
    assertEquals(completed, []);
    resume.release();
    const cut = await snapshot;
    assertEquals(
      cut.files.map((file) => file.id).sort(),
      [null, '!existing:test'].sort(),
    );
    // Retirement may fence the waiting logical capability, but must not let
    // any queued operation execute inside the captured common cut.
    const results = await Promise.allSettled(actions);
    assertEquals(
      results.filter((result) => result.status === 'fulfilled').length >= 4,
      true,
    );
    const ffi = new Turso('./.native/libturso_ffi.so');
    const roomFile = cut.files.find((file) => file.kind === 'rooms')!;
    const copy = await Db.open(
      ffi,
      root + '/snapshot/' + roomFile.path,
      100000000,
    );
    try {
      await integrityCheck(copy);
      assertEquals(await copy.query('SELECT * FROM source'), []);
    } finally {
      await copy.close();
      ffi.close();
    }
  } finally {
    resume.release();
    await snapshot;
    await Promise.allSettled(actions);
    Db.prototype.vacuumInto = vacuum;
    await lease.release();
    await store.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('store snapshot: occupied destination leaves original bytes and live store writable', async () => {
  const { root, store } = await fixture();
  try {
    await Deno.mkdir(root + '/occupied');
    await Deno.writeTextFile(root + '/occupied/preserve', 'keep');
    await assertRejects(() => store.snapshot(root + '/occupied'));
    assertEquals(await Deno.readTextFile(root + '/occupied/preserve'), 'keep');
    const server = await store.server();
    await server.execute('INSERT INTO source VALUES(1,1)');
    assertEquals(await server.query('SELECT n FROM source'), [{ n: 1 }]);
  } finally {
    await store.close();
    await Deno.remove(root, { recursive: true });
  }
});
