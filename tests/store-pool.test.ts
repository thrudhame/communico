// tests/store-pool.test.ts — LRU eviction with reopen, pinned in-use files
// and idle close. Eviction must never break an active user of a file.
import { assert, assertEquals, assertRejects } from '@std/assert';
import { Turso } from '#engine/store/ffi.ts';
import { Pool } from '#engine/store/pool.ts';

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

Deno.test('store pool: LRU eviction over 20 room files, reopen preserves rows', async () => {
  const root = await Deno.makeTempDir();
  const ffi = new Turso('./.native/libturso_ffi.so');
  const pool = new Pool(ffi, root, {
    checkpointlogbytes: 65536,
    maxopenfiles: 4,
    idleseconds: 300,
  });
  try {
    for (let room = 0; room < 20; room++) {
      await pool.acquire('rooms', `!room${room}:test`, { create: true });
      assert(pool.size <= 4, `pool holds ${pool.size} files over the limit`);
    }
    assertEquals(pool.size, 4);
    // The sixteen least-recently-used files were evicted, not destroyed.
    const reopened = await pool.acquire('rooms', '!room0:test');
    assertEquals(await reopened.query('SELECT value FROM id'), [{
      value: '!room0:test',
    }]);
    await pool.close();
    ffi.close();
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('store pool: a file in use is never evicted', async () => {
  const root = await Deno.makeTempDir();
  const ffi = new Turso('./.native/libturso_ffi.so');
  const pool = new Pool(ffi, root, {
    checkpointlogbytes: 65536,
    maxopenfiles: 4,
    idleseconds: 300,
  });
  try {
    const pinned = await pool.acquire('rooms', '!pinned:test', {
      create: true,
    });
    let release!: () => void;
    let started!: () => void;
    const blocker = new Promise<void>((resolve) => release = resolve);
    const entered = new Promise<void>((resolve) => started = resolve);
    const held = pinned.tx(async (connection) => {
      await connection.query('SELECT value FROM id');
      started();
      await blocker;
    });
    await entered; // the pinned transaction is now in flight
    for (let room = 0; room < 6; room++) {
      await pool.acquire('rooms', `!other${room}:test`, { create: true });
    }
    assertEquals(await pinned.query('SELECT value FROM id'), [{
      value: '!pinned:test',
    }]);
    assertEquals(pool.size, 4); // pinned + the three newest others
    release();
    await held;
    await pool.close();
    ffi.close();
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('store pool: idle close evicts after idleseconds', async () => {
  const root = await Deno.makeTempDir();
  const ffi = new Turso('./.native/libturso_ffi.so');
  const pool = new Pool(ffi, root, {
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 1,
  });
  try {
    const first = await pool.acquire('tenants', '@tenant:test', {
      create: true,
    });
    assertEquals(pool.size, 1);
    await delay(2600);
    assertEquals(pool.size, 0);
    const second = await pool.acquire('tenants', '@tenant:test');
    assert(first !== second, 'idle close must reopen, not recycle');
    assertEquals(await second.query('SELECT value FROM id'), [{
      value: '@tenant:test',
    }]);
    await pool.close();
    ffi.close();
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('store pool: acquire without create rejects an absent file', async () => {
  const root = await Deno.makeTempDir();
  const ffi = new Turso('./.native/libturso_ffi.so');
  const pool = new Pool(ffi, root, {
    checkpointlogbytes: 65536,
    maxopenfiles: 4,
    idleseconds: 300,
  });
  try {
    await assertRejects(
      () => pool.acquire('rooms', '!absent:test'),
      Deno.errors.NotFound,
    );
    await pool.close();
    ffi.close();
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
