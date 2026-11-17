import { assert, assertEquals } from '@std/assert';
import { Db } from '#engine/store/db.ts';
import { Turso } from '#engine/store/ffi.ts';
import { openStore } from '#engine/store/index.ts';
import { keyFor } from '#engine/store/layout.ts';

function latch() {
  let release!: () => void;
  return {
    wait: new Promise<void>((resolve) => release = resolve),
    release: () => release(),
  };
}

async function fixture() {
  const root = await Deno.makeTempDir({ prefix: 'live-snapshot-' });
  const store = await openStore({
    dir: root + '/live',
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 1,
    idleseconds: 3600,
  });
  const server = await store.server();
  await server.exec('CREATE TABLE traffic(n INTEGER PRIMARY KEY,body TEXT)');
  return { root, store, server };
}

Deno.test('store live snapshot: portable cut does not invoke autocommit VACUUM', async () => {
  const { root, store } = await fixture();
  const vacuum = Turso.prototype.vacuumInto;
  Turso.prototype.vacuumInto = () =>
    Promise.reject(new Error('VACUUM forbidden in logical cut'));
  try {
    for (let n = 0; n < 4; n++) {
      await store.room('!inactive-' + n + ':test', { create: true });
    }
    const cut = await store.snapshot(root + '/out');
    assertEquals(cut.files.length, 5);
  } finally {
    Turso.prototype.vacuumInto = vacuum;
    await store.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('store live snapshot: inactive source opening holds neither writer admission nor pool metadata', async () => {
  const { root, store, server } = await fixture();
  const inactive = '!inactive:test';
  await store.room(inactive, { create: true });
  const active = await store.room('!active:test', { create: true });
  const inactivePath = '/rooms/' + await keyFor(inactive) + '/data.db';
  const open = Db.open;
  const entered = latch(), resume = latch();
  let intercepted = false;
  let preparationPaused = false;
  Db.open = async (...args) => {
    if (
      !intercepted && args[1].startsWith(root + '/live/') &&
      args[1].endsWith(inactivePath)
    ) {
      intercepted = true;
      preparationPaused = true;
      entered.release();
      await resume.wait;
      preparationPaused = false;
    }
    return await open.apply(Db, args);
  };
  let snapshot: ReturnType<typeof store.snapshot> | undefined;
  let writes: Promise<unknown> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    snapshot = store.snapshot(root + '/out');
    await entered.wait;
    const operations = Promise.all([
      server.execute('INSERT INTO traffic VALUES(1,?)', ['x'.repeat(70000)]),
      active.query('SELECT value FROM id'),
      store.room('!created-during-preparation:test', { create: true }),
    ]);
    writes = operations;
    // The contract is progress before preparation resumes, not native/IO
    // scheduling within 500ms. This guard only breaks a dependency deadlock.
    const [inserted, rows] = await Promise.race([
      operations,
      new Promise<never>((_, reject) => {
        watchdog = setTimeout(
          () => reject(new Error('snapshot preparation progress watchdog')),
          30000,
        );
      }),
    ]);
    assertEquals(inserted, 1);
    assertEquals(rows, [{ value: '!active:test' }]);
    assert(
      preparationPaused,
      'operations must complete while inactive preparation is still paused',
    );
    resume.release();
    const cut = await snapshot;
    assert(
      cut.files.some((file) => file.id === '!created-during-preparation:test'),
      'final fence did not revalidate and prepare the new source',
    );
  } finally {
    clearTimeout(watchdog);
    resume.release();
    await Promise.allSettled([writes, snapshot]);
    Db.open = open;
    await store.close();
    await Deno.remove(root, { recursive: true });
  }
});
