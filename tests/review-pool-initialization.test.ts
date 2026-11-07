// Initialization shares the pool's lifecycle owner with acquire and close.
import { assertEquals, assertRejects } from '@std/assert';
import { Turso } from '#engine/store/ffi.ts';
import { Pool } from '#engine/store/pool.ts';

function barrier() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => release = resolve);
  return { wait, release };
}

function fixture(root: string) {
  const ffi = new Turso('./.native/libturso_ffi.so');
  const pool = new Pool(ffi, root, {
    checkpointlogbytes: 65536,
    maxopenfiles: 1,
    idleseconds: 300,
  });
  return { ffi, pool };
}

Deno.test('review pool: same-id kinds and concurrent leases retain separate file truth', async () => {
  const root = await Deno.makeTempDir();
  const { ffi, pool } = fixture(root);
  const leases = await Promise.all([
    pool.acquire('rooms', 'same', { create: true }),
    pool.acquire('tenants', 'same', { create: true }),
    pool.acquire('rooms', 'same', { create: true }),
  ]);
  try {
    assertEquals(leases[0].db.path === leases[2].db.path, true);
    assertEquals(leases[0].db.path === leases[1].db.path, false);
    await leases[0].db.exec('CREATE TABLE truth(value TEXT)');
    await leases[0].db.execute('INSERT INTO truth VALUES(?)', ['room']);
    await leases[1].db.exec('CREATE TABLE truth(value TEXT)');
    await leases[1].db.execute('INSERT INTO truth VALUES(?)', ['tenant']);
    assertEquals(await leases[2].db.query('SELECT value FROM truth'), [{
      value: 'room',
    }]);
    assertEquals(await leases[1].db.query('SELECT value FROM truth'), [{
      value: 'tenant',
    }]);
    assertEquals(pool.size, 2, 'both leased kinds survive the one-file limit');
  } finally {
    for (const lease of leases) await lease.release();
    await pool.close();
    ffi.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('review pool: acquire waits for initialization and sees its completed data', async () => {
  const root = await Deno.makeTempDir();
  const { ffi, pool } = fixture(root);
  const entered = barrier();
  const finish = barrier();
  const initializing = pool.initialize('rooms', 'new', async (db) => {
    await db.exec('CREATE TABLE initialized(value TEXT)');
    entered.release();
    await finish.wait;
    await db.execute('INSERT INTO initialized VALUES(?)', ['complete']);
  });
  await entered.wait;
  const acquired = pool.acquire('rooms', 'new', { create: true });
  // Attach the rejection handler before advancing the initializer, so an
  // erroneous competing safe-create remains an observed result.
  const outcome = acquired.then(
    (lease) => ({ lease, error: null }),
    (error: unknown) => ({ lease: null, error }),
  );
  finish.release();
  try {
    await initializing;
    const result = await outcome;
    if (result.error) throw result.error;
    if (!result.lease) throw new Error('missing lease');
    try {
      assertEquals(
        await result.lease.db.query('SELECT value FROM initialized'),
        [
          { value: 'complete' },
        ],
      );
    } finally {
      await result.lease.release();
    }
  } finally {
    await pool.close();
    ffi.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('review pool: close drains an initializer before releasing native lifetime', async () => {
  const root = await Deno.makeTempDir();
  const { ffi, pool } = fixture(root);
  const entered = barrier();
  const finish = barrier();
  const initializing = pool.initialize('rooms', 'closing', async (db) => {
    entered.release();
    await finish.wait;
    await db.query('SELECT value FROM id');
  });
  await entered.wait;
  let closed = false;
  const closing = pool.close().then(() => closed = true);
  // A checkpoint in the task queue lets an incorrectly untracked close
  // finish, without making correctness depend on database I/O speed.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const premature = closed;
  finish.release();
  try {
    await initializing;
    await closing;
    assertEquals(
      premature,
      false,
      'close returned during staged initialization',
    );
    await assertRejects(
      () => pool.initialize('rooms', 'late', () => Promise.resolve()),
      Error,
      'pool is closed',
    );
  } finally {
    await closing;
    ffi.close();
    await Deno.remove(root, { recursive: true });
  }
});
