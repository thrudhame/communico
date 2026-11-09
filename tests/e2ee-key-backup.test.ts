import { assertEquals, assertRejects } from '@std/assert';
import { openStore } from '#engine/store/index.ts';
import { TENANT_V12 } from '#tests/fixtures/tenant-v12.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { config, setConfigForTests } from '#engine/config.ts';
import { deactivateUser } from '#engine/tenant/users.ts';

const metadata = {
  algorithm: 'm.megolm_backup.v1.curve25519-aes-sha2',
  auth_data: { signatures: {}, extension: [1.5, 'opaque'] },
};
const key = {
  first_message_index: 2,
  forwarded_count: 1,
  is_verified: true,
  session_data: { ciphertext: 'encrypted', extension: [1.5, null] },
};

Deno.test('backup: genuine v11 upgrade, restart, concurrent version cuts and atomic storage failure preserve opaque bytes', async () => {
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
      tenant: {
        version: 11,
        apply: async (conn) => {
          await conn.exec(TENANT_V12);
          await conn.exec(
            'DROP TABLE backup_sessions; DROP TABLE backup_versions',
          );
        },
      },
    },
  });
  try {
    let tenant = await openTenant(store, 'backup.test', { create: true });
    await tenant.tx(async (tx) => {
      await tx.users.insert('alice', 'Alice');
      await tx.devices.upsert('D', 'alice', 'Device');
    });
    const identity = tenant.publicB64;
    await store.close();
    store = await openStore(options, { schemas: { tenant: tenantSchema } });
    tenant = await openTenant(store, 'backup.test');
    assertEquals(tenant.publicB64, identity);
    assertEquals(
      (await tenant.tx((tx) => tx.devices.ofUser('alice'))).length,
      1,
    );
    await tenant.tx((tx) =>
      tx.keyBackup.version('alice', 'post', undefined, metadata)
    );
    await tenant.tx((tx) =>
      tx.keyBackup.keys('alice', 'put', '1', '!unknown:remote', 's', key)
    );
    const before = await tenant.tx((tx) =>
      tx.keyBackup.version('alice', 'get')
    );
    const db = await store.tenant('backup.test');
    await db.exec(
      "CREATE TRIGGER fail_backup BEFORE UPDATE ON backup_versions BEGIN SELECT RAISE(ABORT,'backup persistence failed'); END",
    );
    await assertRejects(() =>
      tenant.tx((tx) =>
        tx.keyBackup.keys(
          'alice',
          'put',
          '1',
          'other-room',
          'other-session',
          key,
        )
      )
    );
    assertEquals(
      await tenant.tx((tx) => tx.keyBackup.version('alice', 'get')),
      before,
    );
    assertEquals(
      await tenant.tx((tx) => tx.keyBackup.keys('alice', 'get', '1')),
      { rooms: { '!unknown:remote': { sessions: { s: key } } } },
    );
    await db.exec('DROP TRIGGER fail_backup');
    const create = tenant.tx((tx) =>
      tx.keyBackup.version('alice', 'post', undefined, metadata)
    );
    const upload = tenant.tx((tx) =>
      tx.keyBackup.keys('alice', 'put', '1', 'r', 's', key)
    );
    const results = await Promise.allSettled([create, upload]);
    assertEquals(results[0].status, 'fulfilled');
    if (results[1].status === 'rejected') {
      assertEquals(results[1].reason.errcode, 'M_WRONG_ROOM_KEYS_VERSION');
    }
    assertEquals(
      (await tenant.tx((tx) => tx.keyBackup.version('alice', 'get'))).version,
      '2',
    );
    await store.close();
    store = await openStore(options, { schemas: { tenant: tenantSchema } });
    tenant = await openTenant(store, 'backup.test');
    assertEquals(
      await tenant.tx((tx) =>
        tx.keyBackup.keys('alice', 'get', '1', '!unknown:remote', 's')
      ),
      key,
    );
    assertEquals(
      (await tenant.tx((tx) => tx.keyBackup.version('alice', 'get', '1')))
        .auth_data,
      metadata.auth_data,
    );
    await tenant.tx((tx) => tx.keyBackup.version('alice', 'delete', '2'));
    assertEquals(
      (await tenant.tx((tx) => tx.keyBackup.version('alice', 'get'))).version,
      '1',
    );
    await deactivateUser(tenant, 'alice');
    const reopened = await store.tenant('backup.test');
    assertEquals(await reopened.query('SELECT * FROM backup_sessions'), []);
    assertEquals(
      await reopened.query('SELECT * FROM backup_versions WHERE deleted=0'),
      [],
    );
    await assertRejects(() =>
      tenant.tx((tx) => tx.keyBackup.version('alice', 'get'))
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('backup: per-user stored-session/version budgets, no-op etag and bounded reads never truncate retained data', async () => {
  const dir = await Deno.makeTempDir();
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { tenant: tenantSchema } });
  const before = { ...config().e2ee };
  try {
    const tenant = await openTenant(store, 'backup.test', { create: true });
    setConfigForTests({ e2ee: { maxbackupsessions: 1, maxbackupversions: 1 } });
    await tenant.tx((tx) =>
      tx.keyBackup.version('a', 'post', undefined, metadata)
    );
    await assertRejects(() =>
      tenant.tx((tx) => tx.keyBackup.version('a', 'post', undefined, metadata))
    );
    await tenant.tx((tx) => tx.keyBackup.keys('a', 'put', '1', 'r', 's', key));
    const original = await tenant.tx((tx) => tx.keyBackup.version('a', 'get'));
    await assertRejects(() =>
      tenant.tx((tx) => tx.keyBackup.keys('a', 'put', '1', 'r', 't', key))
    );
    assertEquals(
      await tenant.tx((tx) => tx.keyBackup.version('a', 'get')),
      original,
    );
    await tenant.tx((tx) =>
      tx.keyBackup.keys('a', 'put', '1', 'r', 's', {
        ...key,
        session_data: { ciphertext: 'tie-keeps-old' },
      })
    );
    assertEquals(
      await tenant.tx((tx) => tx.keyBackup.keys('a', 'get', '1', 'r', 's')),
      key,
    );
    await tenant.tx((tx) =>
      tx.keyBackup.version('b', 'post', undefined, metadata)
    );
    await tenant.tx((tx) => tx.keyBackup.keys('b', 'put', '1', 'r', 's', key));
    setConfigForTests({ e2ee: { maxbackupbytes: 10 } });
    await assertRejects(() =>
      tenant.tx((tx) => tx.keyBackup.keys('a', 'get', '1', 'r', 's'))
    );
    setConfigForTests({ e2ee: before });
    assertEquals(
      await tenant.tx((tx) => tx.keyBackup.keys('a', 'get', '1', 'r', 's')),
      key,
    );
    await tenant.tx((tx) => tx.keyBackup.version('a', 'delete', '1'));
    assertEquals(
      await tenant.tx((tx) =>
        tx.keyBackup.version('a', 'post', undefined, metadata)
      ),
      { version: '2' },
    );
  } finally {
    setConfigForTests({ e2ee: before });
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
