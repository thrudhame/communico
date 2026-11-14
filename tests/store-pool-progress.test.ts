import { assert, assertEquals, assertRejects } from '@std/assert';
import { Db } from '#engine/store/db.ts';
import { Turso } from '#engine/store/ffi.ts';
import { keyFor } from '#engine/store/layout.ts';
import { Pool } from '#engine/store/pool.ts';

function latch() {
  let release!: () => void;
  return {
    wait: new Promise<void>((resolve) => release = resolve),
    release: () => release(),
  };
}

async function fixture(maxopenfiles = 8) {
  const root = await Deno.makeTempDir({ prefix: 'pool-progress-' });
  const ffi = new Turso('./.native/libturso_ffi.so');
  const pool = new Pool(ffi, root, {
    checkpointlogbytes: 65536,
    maxopenfiles,
    idleseconds: 3600,
  });
  for (const id of ['!active:test', '!slow:test']) {
    const lease = await pool.acquire('rooms', id, { create: true });
    await lease.release();
  }
  return { root, ffi, pool };
}

async function progress(pool: Pool) {
  const lease = await pool.acquire('rooms', '!active:test');
  try {
    await lease.db.query('SELECT value FROM id');
  } finally {
    await lease.release();
  }
}

async function assertProgress(task: Promise<unknown>) {
  let completed = false;
  const observed = task.then(() => completed = true);
  await Promise.race([
    observed,
    new Promise((resolve) => setTimeout(resolve, 500)),
  ]);
  assert(
    completed,
    'unrelated acquire/query/release waited behind native work in the pool queue',
  );
}

Deno.test('store pool progress: initializing another file holds no metadata queue', async () => {
  const { root, ffi, pool } = await fixture();
  const entered = latch(), resume = latch();
  let initialization: Promise<unknown> | undefined,
    probe: Promise<unknown> | undefined;
  try {
    initialization = pool.initialize('rooms', '!creating:test', async (db) => {
      await db.query('SELECT value FROM id');
      entered.release();
      await resume.wait;
    });
    await entered.wait;
    probe = progress(pool);
    await assertProgress(probe);
  } finally {
    resume.release();
    await initialization;
    await probe;
    await pool.close();
    ffi.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('store pool progress: inactive ordinary open holds no metadata queue', async () => {
  const { root, ffi, pool } = await fixture(1);
  // Make active newest, so the other file must reopen from disk.
  await progress(pool);
  const path = '/rooms/' + await keyFor('!slow:test') + '/data.db';
  const original = Db.open;
  const entered = latch(), resume = latch();
  let opening: Promise<unknown> | undefined,
    probe: Promise<unknown> | undefined;
  Db.open = async (...args) => {
    if (args[1].endsWith(path)) {
      entered.release();
      await resume.wait;
    }
    return await original.apply(Db, args);
  };
  try {
    opening = pool.acquire('rooms', '!slow:test').then((lease) =>
      lease.release()
    );
    await entered.wait;
    probe = progress(pool);
    await assertProgress(probe);
  } finally {
    resume.release();
    await opening;
    await probe;
    Db.open = original;
    await pool.close();
    ffi.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('store pool progress: identity listing waits outside metadata admission', async () => {
  const { root, ffi, pool } = await fixture();
  const path = '/rooms/' + await keyFor('!slow:test') + '/data.db';
  const original = Db.prototype.query;
  const entered = latch(), resume = latch();
  let listing: Promise<unknown> | undefined,
    probe: Promise<unknown> | undefined;
  Db.prototype.query = async function (sql, values) {
    if (this.path.endsWith(path) && sql === 'SELECT value FROM id') {
      entered.release();
      await resume.wait;
    }
    return await original.call(this, sql, values);
  };
  try {
    listing = pool.list('rooms');
    await entered.wait;
    probe = progress(pool);
    await assertProgress(probe);
  } finally {
    resume.release();
    await listing;
    await probe;
    Db.prototype.query = original;
    await pool.close();
    ffi.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('store pool progress: detached eviction close does not hold the metadata queue', async () => {
  const { root, ffi, pool } = await fixture(1);
  const original = Db.prototype.close;
  const path = '/rooms/' + await keyFor('!slow:test') + '/data.db';
  const entered = latch(), resume = latch();
  let evicting: Promise<unknown> | undefined,
    probe: Promise<unknown> | undefined;
  Db.prototype.close = async function () {
    if (this.path.endsWith(path)) {
      entered.release();
      await resume.wait;
    }
    return await original.call(this);
  };
  try {
    evicting = progress(pool);
    await entered.wait;
    probe = progress(pool);
    await assertProgress(probe);
  } finally {
    resume.release();
    await evicting;
    await probe;
    Db.prototype.close = original;
    await pool.close();
    ffi.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('store pool progress: shutdown drains an accepted complete listing', async () => {
  const { root, ffi, pool } = await fixture();
  const original = Db.prototype.query;
  const entered = latch(), resume = latch();
  let first = true;
  Db.prototype.query = async function (sql, values) {
    if (first && sql === 'SELECT value FROM id') {
      first = false;
      entered.release();
      await resume.wait;
    }
    return await original.call(this, sql, values);
  };
  let listing: Promise<string[]> | undefined,
    closing: Promise<void> | undefined;
  try {
    listing = pool.list('rooms');
    await entered.wait;
    closing = pool.close();
    resume.release();
    assertEquals((await listing).sort(), ['!active:test', '!slow:test']);
    await closing;
  } finally {
    resume.release();
    await Promise.allSettled([listing, closing]);
    Db.prototype.query = original;
    await pool.close();
    ffi.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('store pool progress: failed detached close cannot authorize physical removal', async () => {
  const { root, ffi, pool } = await fixture();
  const original = Db.prototype.close;
  const path = '/rooms/' + await keyFor('!slow:test') + '/data.db';
  let injected = false;
  Db.prototype.close = async function () {
    await original.call(this);
    if (!injected && this.path.endsWith(path)) {
      injected = true;
      throw new Error('injected uncertain close');
    }
  };
  try {
    await assertRejects(() => pool.remove('rooms', '!slow:test'), Error);
    assert(
      (await Deno.stat(root + path)).isFile,
      'failed close unlinked retained source bytes',
    );
  } finally {
    Db.prototype.close = original;
    await pool.close().catch(() => undefined);
    ffi.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('store pool progress: idle eviction cannot replace a reserved file operation', async () => {
  const { root, ffi, pool } = await fixture();
  const path = root + '/rooms/' + await keyFor('!slow:test');
  const key = 'rooms:' + await keyFor('!slow:test');
  const state = pool as unknown as {
    entries: Map<string, { lastUsed: number }>;
    fileWork: Map<string, Promise<unknown>>;
    idleSweep(): void;
  };
  const original = Deno.lstat;
  const entered = latch(), resume = latch();
  Deno.lstat = async (target) => {
    if (target === path) {
      entered.release();
      await resume.wait;
    }
    return await original(target);
  };
  let initializing: Promise<unknown> | undefined;
  try {
    initializing = pool.initialize('rooms', '!slow:test', async () => {});
    // Attach the rejection handler before releasing the existing-file check.
    const rejected = assertRejects(
      () => initializing!,
      Deno.errors.AlreadyExists,
    );
    await entered.wait;
    const reservation = state.fileWork.get(key);
    assert(reservation);
    state.entries.get(key)!.lastUsed = 0;
    state.idleSweep();
    // Queue a metadata operation behind the sweep, not a wall-clock sleep.
    await pool.isRetired('rooms', '!slow:test');
    assert(state.fileWork.get(key) === reservation);
    assert(state.entries.has(key), 'idle sweep evicted a reserved incarnation');
    resume.release();
    await rejected;
    assertEquals(state.fileWork.has(key), false);
  } finally {
    resume.release();
    await initializing?.catch(() => undefined);
    Deno.lstat = original;
    await pool.close();
    ffi.close();
    await Deno.remove(root, { recursive: true });
  }
});

for (const owner of ['snapshot', 'listing', 'validation', 'rejected-open']) {
  Deno.test(`store pool progress: ${owner} close uncertainty fences every subsequent lifetime`, async () => {
    const { root, ffi, pool: seed } = await fixture();
    const id = '!slow:test';
    const key = await keyFor(id);
    const path = root + '/rooms/' + key + '/data.db';
    if (owner === 'validation') {
      const lease = await seed.acquire('rooms', id);
      await lease.db.execute(
        "UPDATE meta SET v = '1' WHERE k = 'schema_version'",
      );
      await lease.release();
    }
    await seed.close();
    const pool = new Pool(ffi, root, {
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 3600,
    });
    const originalClose = Db.prototype.close, originalOpen = Db.open;
    const entered = latch(), resume = latch();
    const failure = new Error('injected ' + owner + ' uncertain close');
    let injected = false;
    Db.prototype.close = async function () {
      await originalClose.call(this);
      if (!injected && this.path === path) {
        injected = true;
        throw failure;
      }
    };
    let opening: Promise<unknown> | undefined;
    try {
      if (owner === 'snapshot') {
        const snapshot = await pool.retainSnapshot('rooms', key);
        assert(snapshot);
        await assertRejects(() => snapshot.release(), Error, failure.message);
      } else if (owner === 'listing') {
        await assertRejects(() => pool.list('rooms'), Error, failure.message);
      } else if (owner === 'validation') {
        await assertRejects(
          () => pool.acquire('rooms', id),
          Error,
          failure.message,
        );
      } else {
        Db.open = async (...args) => {
          const db = await originalOpen.apply(Db, args);
          if (args[1] === path) {
            entered.release();
            await resume.wait;
          }
          return db;
        };
        opening = pool.acquire('rooms', id);
        const rejected = assertRejects(() => opening!, Error, failure.message);
        await entered.wait;
        await pool.retire('rooms', id);
        resume.release();
        await rejected;
      }
      assert(injected, 'the failed close path must actually execute');
      await assertRejects(
        async () => {
          const lease = await pool.acquire('rooms', id);
          await lease.release();
        },
        Error,
        failure.message,
      );
      await assertRejects(
        async () => {
          const snapshot = await pool.retainSnapshot('rooms', key);
          await snapshot?.release();
        },
        Error,
        failure.message,
      );
      await assertRejects(() => pool.list('rooms'), Error, failure.message);
      await assertRejects(
        () => pool.remove('rooms', id),
        Error,
        failure.message,
      );
      assert(
        (await Deno.stat(path)).isFile,
        'uncertain native lifetime must retain bytes',
      );
      await assertRejects(
        () => pool.close(),
        AggregateError,
        'file close failed',
      );
    } finally {
      resume.release();
      await opening?.catch(() => undefined);
      Db.open = originalOpen;
      Db.prototype.close = originalClose;
      await pool.close().catch(() => undefined);
      ffi.close();
      await Deno.remove(root, { recursive: true });
    }
  });
}
