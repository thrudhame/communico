import { assert, assertEquals, assertRejects } from '@std/assert';
import { openStore } from '#engine/store/index.ts';
import type { Conn } from '#engine/store/db.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import {
  changePassword,
  deactivateUser,
  hashPassword,
  loginUser,
  registerUser,
  verifyUserPassword,
} from '#engine/tenant/users.ts';
import {
  consumeRefreshToken,
  hashToken,
  lookupToken,
  revokeAllTokens,
  revokeToken,
} from '#engine/tenant/auth.ts';
import {
  deleteDevices,
  getDevice,
  upsertDevice,
} from '#engine/tenant/devices.ts';
import {
  deviceIdentity,
  lookupTransaction,
  recordTransaction,
} from '#engine/tenant/txns.ts';
import { TENANT_V3 } from '#tests/fixtures/tenant-v3.ts';

const config = (dir: string) => ({
  dir,
  library: './.native/libturso_ffi.so',
  checkpointlogbytes: 65536,
  maxopenfiles: 8,
  idleseconds: 300,
});

Deno.test('E0: v3 tenant upgrade preserves identity, credentials, refresh retries and receipts', async () => {
  const dir = await Deno.makeTempDir();
  const oldSchema = {
    version: 3,
    apply: (db: { exec(sql: string): Promise<void> }) => db.exec(TENANT_V3),
  };
  let store = await openStore(config(dir), { schemas: { tenant: oldSchema } });
  try {
    const old = await openTenant(store, 'a.test', { create: true });
    const identity = [old.publicB64, old.nativeName, old.keyId];
    const hash = await hashToken('legacy-access');
    const refresh = await hashToken('legacy-refresh');
    const db = await store.tenant('a.test');
    const endpoint = {
      kind: 'send' as const,
      roomId: '!r:a.test',
      eventType: 'm.room.message',
    };
    await db.tx(async (conn) => {
      await conn.execute('INSERT INTO users(localpart) VALUES(?)', ['alice']);
      await conn.execute(
        'INSERT INTO credentials(localpart,kind,hash) VALUES(?,?,?)',
        ['alice', 'argon2id', hashPassword('pw')],
      );
      await conn.exec(
        "INSERT INTO devices VALUES('PHONE','alice','Legacy'); INSERT INTO counters VALUES('account_data',7)",
      );
      await conn.execute('INSERT INTO access_tokens VALUES(?,?,?,NULL)', [
        hash,
        'alice',
        'PHONE',
      ]);
      await conn.execute('INSERT INTO refresh_tokens VALUES(?,?,?,?,NULL)', [
        refresh,
        'alice',
        'PHONE',
        hash,
      ]);
      await conn.execute(
        'INSERT INTO transactions(device_id,endpoint,room_id,txn_id,event_id) VALUES(?,?,?,?,?)',
        [
          'PHONE',
          JSON.stringify(['send', endpoint.roomId, endpoint.eventType]),
          endpoint.roomId,
          'retry',
          '$original',
        ],
      );
      await conn.exec(
        "INSERT INTO transactions VALUES('GONE','old','!r:a.test','orphan','$old',NULL,1); INSERT INTO account_data VALUES('alice','','custom','{\"kept\":true}',7)",
      );
    });
    await store.close();
    store = await openStore(config(dir), { schemas: { tenant: tenantSchema } });
    const tenant = await openTenant(store, 'a.test');
    assertEquals([tenant.publicB64, tenant.nativeName, tenant.keyId], identity);
    assert(await verifyUserPassword(tenant, 'alice', 'pw'));
    assertEquals((await lookupToken(tenant, 'legacy-access'))?.generation, 1);
    const device = await deviceIdentity(tenant, 'alice', 'PHONE');
    assertEquals(
      await lookupTransaction(tenant, device, endpoint, 'retry'),
      '$original',
    );
    const rotated = await consumeRefreshToken(tenant, 'legacy-refresh');
    assertEquals(
      (await lookupToken(tenant, rotated.accessToken))?.generation,
      1,
    );
    assertEquals(
      await (await store.tenant('a.test')).query(
        'SELECT content,seq FROM account_data',
      ),
      [{ content: '{"kept":true}', seq: 7 }],
    );
    assertEquals(
      (await (await store.tenant('a.test')).query(
        'SELECT * FROM transactions_v3',
      )).length,
      2,
    );
    await deleteDevices(tenant, 'alice', ['PHONE']);
    await upsertDevice(tenant, 'alice', 'PHONE');
    assert(
      (await deviceIdentity(tenant, 'alice', 'PHONE')).generation >
        device.generation,
    );
    assertEquals(
      await lookupTransaction(
        tenant,
        await deviceIdentity(tenant, 'alice', 'PHONE'),
        endpoint,
        'retry',
      ),
      null,
    );
    await store.close();
    store = await openStore(config(dir), { schemas: { tenant: tenantSchema } });
    await openTenant(store, 'a.test');
    const upgraded = await store.tenant('a.test');
    await upgraded.execute("UPDATE meta SET v='999' WHERE k='schema_version'");
    await store.close();
    store = await openStore(config(dir), { schemas: { tenant: tenantSchema } });
    await assertRejects(
      () => openTenant(store, 'a.test'),
      Error,
      'schema version mismatch',
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

for (
  const action of ['delete', 'logout-all', 'password', 'deactivate'] as const
) {
  Deno.test(
    'E0: ' + action + ' is user-scoped and invalidates the device generation',
    async () => {
      const dir = await Deno.makeTempDir();
      const store = await openStore(config(dir), {
        schemas: { tenant: tenantSchema },
      });
      try {
        const tenant = await openTenant(store, 'a.test', { create: true });
        const a = await registerUser(tenant, {
          localpart: 'alice',
          password: 'pw',
          deviceId: 'PHONE',
        });
        const b = await registerUser(tenant, {
          localpart: 'bob',
          password: 'pw',
          deviceId: 'PHONE',
        });
        const device = await deviceIdentity(tenant, 'alice', 'PHONE');
        const endpoint = {
          kind: 'send' as const,
          roomId: '!r:a.test',
          eventType: 'm.room.message',
        };
        await recordTransaction(tenant, device, endpoint, 'same', '$alice');
        await recordTransaction(
          tenant,
          await deviceIdentity(tenant, 'bob', 'PHONE'),
          endpoint,
          'same',
          '$bob',
        );
        if (action === 'delete') {
          await deleteDevices(tenant, 'alice', ['PHONE']);
        }
        if (action === 'logout-all') await revokeAllTokens(tenant, 'alice');
        if (action === 'password') {
          await changePassword(tenant, 'alice', 'new', { logoutDevices: true });
        }
        if (action === 'deactivate') await deactivateUser(tenant, 'alice');
        assertEquals(await lookupToken(tenant, a.access_token!), null);
        assertEquals(
          (await lookupToken(tenant, b.access_token!))?.user_id,
          b.user_id,
        );
        assertEquals(
          await lookupTransaction(
            tenant,
            await deviceIdentity(tenant, 'bob', 'PHONE'),
            endpoint,
            'same',
          ),
          '$bob',
        );
        await upsertDevice(tenant, 'alice', 'PHONE');
        const replacement = await deviceIdentity(tenant, 'alice', 'PHONE');
        assert(replacement.generation > device.generation);
        assertEquals(
          await lookupTransaction(tenant, replacement, endpoint, 'same'),
          null,
        );
        await assertRejects(() =>
          recordTransaction(tenant, device, endpoint, 'late', '$stale')
        );
      } finally {
        await store.close();
        await Deno.remove(dir, { recursive: true });
      }
    },
  );
}

Deno.test('E0: identical device IDs belong independently to two users', async () => {
  const dir = await Deno.makeTempDir();
  const store = await openStore(config(dir), {
    schemas: { tenant: tenantSchema },
  });
  try {
    const tenant = await openTenant(store, 'a.test', { create: true });
    const a = await registerUser(tenant, {
      localpart: 'alice',
      password: 'pw',
      deviceId: 'PHONE',
    });
    const b = await registerUser(tenant, {
      localpart: 'bob',
      password: 'pw',
      deviceId: 'PHONE',
    });
    const again = await loginUser(tenant, {
      localpart: 'alice',
      password: 'pw',
      deviceId: 'PHONE',
      refresh: true,
    });
    assertEquals(
      (await lookupToken(tenant, b.access_token!))?.user_id,
      b.user_id,
    );
    assertEquals(await lookupToken(tenant, a.access_token!), null);
    await revokeToken(tenant, again.accessToken);
    assertEquals(await getDevice(tenant, 'alice', 'PHONE'), null);
    assert(await getDevice(tenant, 'bob', 'PHONE'));
    assertEquals(
      (await lookupToken(tenant, b.access_token!))?.user_id,
      b.user_id,
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('E0: supported schema steps migrate atomically and preserve server data', async () => {
  const dir = await Deno.makeTempDir();
  const old = {
    version: 1,
    apply: (db: { exec(sql: string): Promise<void> }) =>
      db.exec('CREATE TABLE kept(n INTEGER); INSERT INTO kept VALUES(42)'),
  };
  let store = await openStore(config(dir), { schemas: { server: old } });
  await store.close();
  const next = {
    ...old,
    version: 3,
    migrations: {
      1: (conn: Conn) => conn.exec('ALTER TABLE kept ADD COLUMN label TEXT'),
      2: (conn: Conn) => conn.exec("UPDATE kept SET label = 'preserved'"),
    },
  };
  try {
    store = await openStore(config(dir), { schemas: { server: next } });
    assertEquals(await (await store.server()).query('SELECT * FROM kept'), [{
      n: 42,
      label: 'preserved',
    }]);
    await store.close();
    const broken = {
      ...next,
      version: 5,
      migrations: {
        3: (conn: Conn) =>
          conn.exec('ALTER TABLE kept ADD COLUMN rolled_back TEXT'),
        4: () => Promise.reject(new Error('injected migration failure')),
      },
    };
    await assertRejects(
      () => openStore(config(dir), { schemas: { server: broken } }),
      Error,
      'injected migration failure',
    );
    store = await openStore(config(dir), { schemas: { server: next } });
    assertEquals(await (await store.server()).query('SELECT * FROM kept'), [{
      n: 42,
      label: 'preserved',
    }]);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
