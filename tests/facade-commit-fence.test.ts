import { assertEquals, assertRejects } from '@std/assert';
import { Db } from '#engine/store/db.ts';
import { Turso } from '#engine/store/ffi.ts';
import { Admission } from '#engine/store/admission.ts';
import {
  changeSigningAuthority,
  signingFence,
} from '#engine/facade/signing-authority.ts';

async function fixture() {
  const dir = await Deno.makeTempDir();
  const ffi = new Turso('./.native/libturso_ffi.so');
  await Deno.mkdir(dir + '/authority');
  await Deno.mkdir(dir + '/room');
  const snapshot = new Admission();
  const authority = await Db.open(
    ffi,
    dir + '/authority/data.db',
    4120000,
    snapshot,
  );
  const room = await Db.open(ffi, dir + '/room/data.db', 4120000, snapshot);
  await authority.exec('CREATE TABLE authority(retired INTEGER)');
  await room.exec('CREATE TABLE effects(id INTEGER)');
  return {
    ffi,
    authority,
    room,
    snapshot,
    close: async () => {
      await room.close();
      await authority.close();
      ffi.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test('commit fence: callback completion is not native commit admission', async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  try {
    const options = {
      mode: 'concurrent' as const,
      admit: signingFence(f.authority),
    };
    const applying = f.room.tx(async (conn) => {
      options.admit();
      await conn.execute('INSERT INTO effects VALUES(1)');
      entered.resolve();
      await release.promise;
    }, options).then(() => null, (error) => error);
    await entered.promise;
    await changeSigningAuthority(f.authority, () => Promise.resolve());
    release.resolve();
    assertEquals((await applying) instanceof Error, true);
    assertEquals(await f.room.query('SELECT * FROM effects'), []);
  } finally {
    release.resolve();
    await f.close();
  }
});

Deno.test('commit fence: retirement drains native commits, not unrelated authorities', async () => {
  const f = await fixture();
  const other = await fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const commit = f.ffi.commit.bind(f.ffi);
  let hold = true;
  const order: string[] = [];
  f.ffi.commit = async (handle) => {
    if (hold) {
      hold = false;
      entered.resolve();
      await release.promise;
      await commit(handle);
      order.push('effect');
    } else await commit(handle);
  };
  try {
    const options = {
      mode: 'concurrent' as const,
      admit: signingFence(f.authority),
    };
    const applying = f.room.tx(
      (conn) => conn.execute('INSERT INTO effects VALUES(1)'),
      options,
    );
    await entered.promise;
    const retiring = changeSigningAuthority(
      f.authority,
      (conn) => conn.execute('INSERT INTO authority VALUES(1)'),
    )
      .then(() => {
        order.push('retired');
      });
    const unrelated = {
      mode: 'concurrent' as const,
      admit: signingFence(other.authority),
    };
    await other.room.tx(
      (conn) => conn.execute('INSERT INTO effects VALUES(2)'),
      unrelated,
    );
    assertEquals(await other.room.query('SELECT * FROM effects'), [{ id: 2 }]);
    assertEquals(await f.authority.query('SELECT * FROM authority'), []);
    assertEquals(order, []);
    release.resolve();
    await Promise.all([applying, retiring]);
    assertEquals(order, ['effect', 'retired']);
    assertEquals(await f.room.query('SELECT * FROM effects'), [{ id: 1 }]);
  } finally {
    release.resolve();
    f.ffi.commit = commit;
    await f.close();
    await other.close();
  }
});

Deno.test('commit fence: rooms sharing an authority retain shared native admission', async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const commit = f.ffi.commit.bind(f.ffi);
  let hold = true;
  f.ffi.commit = async (handle) => {
    if (hold) {
      hold = false;
      entered.resolve();
      await release.promise;
    }
    await commit(handle);
  };
  try {
    const options = {
      mode: 'concurrent' as const,
      admit: signingFence(f.authority),
    };
    const applying = f.room.tx(
      (conn) => conn.execute('INSERT INTO effects VALUES(1)'),
      options,
    );
    await entered.promise;
    await f.authority.tx(
      (conn) => conn.execute('INSERT INTO authority VALUES(2)'),
      options,
    );
    assertEquals(await f.authority.query('SELECT * FROM authority'), [{
      retired: 2,
    }]);
    release.resolve();
    await applying;
  } finally {
    release.resolve();
    f.ffi.commit = commit;
    await f.close();
  }
});

Deno.test('commit fence: snapshot admission precedes authority validation and writer permits', async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const body = Promise.withResolvers<void>();
  try {
    const options = {
      mode: 'concurrent' as const,
      admit: signingFence(f.authority),
    };
    const snapshot = f.snapshot.exclusive(async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const applying = f.room.tx(async (conn) => {
      await conn.execute('INSERT INTO effects VALUES(1)');
      body.resolve();
    }, options).then(() => null, (error) => error);
    await body.promise;
    const retiring = changeSigningAuthority(
      f.authority,
      (conn) => conn.execute('INSERT INTO authority VALUES(1)'),
    );
    release.resolve();
    await Promise.all([snapshot, retiring]);
    assertEquals((await applying) instanceof Error, true);
    assertEquals(await f.room.query('SELECT * FROM effects'), []);
    assertEquals(await f.authority.query('SELECT * FROM authority'), [{
      retired: 1,
    }]);
  } finally {
    release.resolve();
    await f.close();
  }
});

Deno.test('commit fence: native failure releases authority before retirement', async () => {
  const f = await fixture();
  const commit = f.ffi.commit.bind(f.ffi);
  f.ffi.commit = () => Promise.reject(new Error('native commit failed'));
  try {
    const options = {
      mode: 'concurrent' as const,
      admit: signingFence(f.authority),
    };
    await assertRejects(
      () =>
        f.room.tx(
          (conn) => conn.execute('INSERT INTO effects VALUES(1)'),
          options,
        ),
      Error,
      'native commit failed',
    );
    f.ffi.commit = commit;
    await changeSigningAuthority(
      f.authority,
      (conn) => conn.execute('INSERT INTO authority VALUES(1)'),
    );
    assertEquals(await f.room.query('SELECT * FROM effects'), []);
    assertEquals(await f.authority.query('SELECT * FROM authority'), [{
      retired: 1,
    }]);
  } finally {
    f.ffi.commit = commit;
    await f.close();
  }
});
