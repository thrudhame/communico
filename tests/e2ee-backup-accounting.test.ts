import { assert, assertEquals, assertRejects } from '@std/assert';
import { config, setConfigForTests } from '#engine/config.ts';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import {
  backupKeys,
  backupVersion,
  clearBackup,
} from '#engine/tenant/key-backup.ts';
import { TENANT_V17 } from '#tests/fixtures/tenant-versions.ts';

const metadata = { algorithm: 'opaque', auth_data: {} };
const key = {
  first_message_index: 10,
  forwarded_count: 1,
  is_verified: false,
  session_data: { ciphertext: 'opaque' },
};
const encoded = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length;

async function fixture(
  run: (store: Awaited<ReturnType<typeof openStore>>) => Promise<void>,
) {
  const dir = await Deno.makeTempDir();
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { tenant: tenantSchema } });
  const original = { ...config().e2ee };
  try {
    await run(store);
  } finally {
    setConfigForTests({ e2ee: original });
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test('backup accounting: PUT cost depends on uploaded entries, not retained sessions', () =>
  fixture(async (store) => {
    await openTenant(store, 'accounting.test', { create: true });
    const db = await store.tenant('accounting.test');
    const limits = config().e2ee;
    await db.tx(async (conn) => {
      await backupVersion(conn, 'a', 'post', undefined, metadata, limits);
      const sessions = Object.fromEntries(
        Array.from({ length: 1000 }, (_, i) => ['s' + i, key]),
      );
      await backupKeys(
        conn,
        'a',
        'put',
        '1',
        'room',
        undefined,
        { sessions },
        limits,
      );
    });
    await db.tx(async (conn) => {
      const query = conn.query.bind(conn);
      let rows = 0;
      const started = performance.now();
      conn.query = async (...args) => {
        const result = await query(...args);
        rows += result.length;
        return result;
      };
      try {
        await backupKeys(conn, 'a', 'put', '1', 'room', 's0', key, limits);
      } finally {
        conn.query = query;
      }
      console.log(
        JSON.stringify({
          retainedSessions: 1000,
          noOpRowsRead: rows,
          elapsedMs: performance.now() - started,
        }),
      );
      assert(rows < 10, `single-entry no-op hydrated ${rows} rows`);
    });
  }));

Deno.test('backup accounting: exact escaped UTF8 totals survive replacements, all deletion scopes, rollback and cross-version caps', () =>
  fixture(async (store) => {
    const tenant = await openTenant(store, 'accounting.test', { create: true });
    const db = await store.tenant('accounting.test');
    const room = 'r"\\\n\u0000\u00e9\ud83d\ude00';
    const session = 's"\\\n\u0000\u00e9\ud83d\ude00';
    await tenant.tx((tx) =>
      tx.keyBackup.version('a', 'post', undefined, metadata)
    );
    const verify = async () => {
      const restored = await tenant.tx((tx) =>
        tx.keyBackup.keys('a', 'get', '1')
      );
      const [totals] = await db.query(
        'SELECT session_count,restore_bytes FROM backup_versions WHERE localpart=? AND version_no=1',
        ['a'],
      );
      const count = Object.values(
        restored.rooms as Record<string, { sessions: object }>,
      ).reduce((n, r) => n + Object.keys(r.sessions).length, 0);
      assertEquals(totals, {
        session_count: count,
        restore_bytes: encoded(restored),
      });
      return { restored, size: encoded(restored) };
    };
    await verify();
    await tenant.tx((tx) =>
      tx.keyBackup.keys('a', 'put', '1', room, session, key)
    );
    await tenant.tx((tx) =>
      tx.keyBackup.keys('a', 'put', '1', room, 'second', key)
    );
    await tenant.tx((tx) =>
      tx.keyBackup.keys('a', 'put', '1', 'other', session, key)
    );
    await verify();
    const replacement = {
      ...key,
      first_message_index: 9,
      session_data: { ciphertext: 'x'.repeat(200) },
    };
    await tenant.tx((tx) =>
      tx.keyBackup.keys('a', 'put', '1', room, session, replacement)
    );
    const before = await verify();
    setConfigForTests({ e2ee: { maxbackupbytes: before.size } });
    await tenant.tx((tx) =>
      tx.keyBackup.keys('a', 'put', '1', room, session, replacement)
    );
    await assertRejects(() =>
      tenant.tx((tx) =>
        tx.keyBackup.keys('a', 'put', '1', room, 'overflow', key)
      )
    );
    assertEquals(await verify(), before);
    await db.exec(
      "CREATE TRIGGER fail_accounting BEFORE UPDATE ON backup_versions BEGIN SELECT RAISE(ABORT,'test rollback'); END",
    );
    await assertRejects(() =>
      tenant.tx((tx) => tx.keyBackup.keys('a', 'delete', '1', room, session))
    );
    await db.exec('DROP TRIGGER fail_accounting');
    assertEquals(await verify(), before);
    await tenant.tx((tx) =>
      tx.keyBackup.keys('a', 'put', '1', room, session, {
        ...key,
        first_message_index: 8,
      })
    );
    await verify();
    await tenant.tx((tx) =>
      tx.keyBackup.keys('a', 'delete', '1', room, 'second')
    );
    await verify();
    await tenant.tx((tx) =>
      tx.keyBackup.keys('a', 'delete', '1', 'other', session)
    );
    await verify();
    await tenant.tx((tx) =>
      tx.keyBackup.keys('a', 'put', '1', room, 'second', key)
    );
    await tenant.tx((tx) => tx.keyBackup.keys('a', 'delete', '1', room));
    await verify();
    setConfigForTests({
      e2ee: { maxbackupbytes: 10000, maxbackupsessions: 1 },
    });
    await tenant.tx((tx) =>
      tx.keyBackup.keys('a', 'put', '1', room, session, key)
    );
    await tenant.tx((tx) =>
      tx.keyBackup.version('a', 'post', undefined, metadata)
    );
    await assertRejects(() =>
      tenant.tx((tx) => tx.keyBackup.keys('a', 'put', '2', room, session, key))
    );
    await tenant.tx((tx) => tx.keyBackup.version('a', 'delete', '1'));
    await tenant.tx((tx) =>
      tx.keyBackup.keys('a', 'put', '2', room, session, key)
    );
    await tenant.tx((tx) => tx.keyBackup.keys('a', 'delete', '2'));
    assertEquals(await db.query('SELECT * FROM backup_rooms'), []);
    await tenant.tx((tx) =>
      tx.keyBackup.keys('a', 'put', '2', room, session, key)
    );
    await db.tx((conn) => clearBackup(conn, 'a'));
    assertEquals(await db.query('SELECT * FROM backup_rooms'), []);
    assertEquals(
      await db.query('SELECT session_count,restore_bytes FROM backup_versions'),
      [{ session_count: 0, restore_bytes: encoded({ rooms: {} }) }, {
        session_count: 0,
        restore_bytes: encoded({ rooms: {} }),
      }],
    );
  }));

Deno.test('backup accounting: genuine v17 migration and restart preserve ciphertext, etag and exact totals', async () => {
  const dir = await Deno.makeTempDir();
  const options = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  let store = await openStore(options, {
    schemas: {
      tenant: { version: 17, apply: (conn) => conn.exec(TENANT_V17) },
    },
  });
  const rooms = {
    'r"\u00e9': { sessions: { 's\\\n': key, other: key } },
    other: {
      sessions: {
        s: key,
        ...Object.fromEntries(
          Array.from({ length: 260 }, (_, i) => ['page' + i, key]),
        ),
      },
    },
  };
  try {
    const tenant = await openTenant(store, 'migration.test', { create: true });
    const identity = tenant.publicB64;
    const db = await store.tenant('migration.test');
    await db.tx(async (conn) => {
      await conn.execute('INSERT INTO backup_versions VALUES(?,?,?,?,?,?)', [
        'a',
        1,
        'opaque',
        '{}',
        7,
        0,
      ]);
      for (const [r, value] of Object.entries(rooms)) {
        for (const [s, data] of Object.entries(value.sessions)) {
          await conn.execute('INSERT INTO backup_sessions VALUES(?,?,?,?,?)', [
            'a',
            1,
            r,
            s,
            JSON.stringify(data),
          ]);
        }
      }
    });
    for (let i = 0; i < 2; i++) {
      await store.close();
      store = await openStore(options, { schemas: { tenant: tenantSchema } });
      const reopened = await openTenant(store, 'migration.test');
      assertEquals(reopened.publicB64, identity);
      assertEquals(
        await reopened.tx((tx) => tx.keyBackup.keys('a', 'get', '1')),
        { rooms },
      );
      assertEquals(
        (await reopened.tx((tx) => tx.keyBackup.version('a', 'get'))).etag,
        '7',
      );
      const db = await store.tenant('migration.test');
      assertEquals(
        await db.query(
          'SELECT session_count,restore_bytes FROM backup_versions',
        ),
        [{ session_count: 263, restore_bytes: encoded({ rooms }) }],
      );
    }
    await (await openTenant(store, 'migration.test')).tx((tx) =>
      tx.keyBackup.keys('a', 'put', '1', 'other', 's', {
        ...key,
        first_message_index: 1,
      })
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
