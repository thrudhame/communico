import { assertEquals, assertRejects } from '@std/assert';
import { MatrixError } from '#engine/matrix-error.ts';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import {
  consumeRefreshToken,
  hashToken,
  issueRefreshToken,
  lookupToken,
} from '#engine/tenant/auth.ts';
import {
  loginUser,
  registerUser,
  verifyUserPassword,
} from '#engine/tenant/users.ts';
import { updateDeviceName } from '#engine/tenant/devices.ts';

async function fixture() {
  const dir = await Deno.makeTempDir({ prefix: 'tenant-ingress-' });
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { tenant: tenantSchema } });
  const tenant = await openTenant(store, 'ingress.test', { create: true });
  const registered = await registerUser(tenant, {
    localpart: 'alice',
    password: 'pw',
    deviceId: 'existing',
  });
  const guarded = await openTenant(store, 'ingress.test', {
    ingress: {
      check(_conn, intent) {
        if (intent.kind === 'session' || intent.kind === 'device') {
          return Promise.reject(
            new MatrixError(
              503,
              'M_UNAVAILABLE',
              'operation owner unavailable at this ingress',
            ),
          );
        }
        return Promise.reject(
          new MatrixError(
            503,
            'M_UNAVAILABLE',
            'authentication snapshot unavailable',
          ),
        );
      },
    },
  });
  return {
    tenant,
    guarded,
    registered,
    db: await store.tenant('ingress.test'),
    async close() {
      await store.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test('ingress authority refuses candidate GET before closing the issuer refresh retry window', async () => {
  const f = await fixture();
  try {
    const refresh = await issueRefreshToken(
      f.tenant,
      'alice',
      'existing',
      f.registered.access_token!,
    );
    const next = await consumeRefreshToken(f.tenant, refresh);
    await assertRejects(
      () => lookupToken(f.guarded, next.accessToken),
      MatrixError,
      'operation owner unavailable',
    );
    const hash = await hashToken(refresh);
    assertEquals(
      (await f.tenant.tx((tx) => tx.refresh.byHash(hash)))?.next_token !== null,
      true,
    );
  } finally {
    await f.close();
  }
});

Deno.test('ingress authority refuses rotation before any issuer chain mutation', async () => {
  const f = await fixture();
  try {
    const refresh = await issueRefreshToken(
      f.tenant,
      'alice',
      'existing',
      f.registered.access_token!,
    );
    const before = await f.db.query('SELECT * FROM refresh_tokens');
    await assertRejects(
      () => consumeRefreshToken(f.guarded, refresh),
      MatrixError,
      'operation owner unavailable',
    );
    assertEquals(await f.db.query('SELECT * FROM refresh_tokens'), before);
    assertEquals(
      (await lookupToken(f.tenant, f.registered.access_token!))?.device_id,
      'existing',
    );
  } finally {
    await f.close();
  }
});

Deno.test('ingress authority is shared by login and password verification without creating a device', async () => {
  const f = await fixture();
  try {
    await assertRejects(
      () =>
        loginUser(f.guarded, {
          localpart: 'alice',
          password: 'pw',
          deviceId: 'new-device',
          refresh: true,
        }),
      MatrixError,
      'authentication snapshot unavailable',
    );
    await assertRejects(
      () => verifyUserPassword(f.guarded, 'alice', 'pw'),
      MatrixError,
      'authentication snapshot unavailable',
    );
    assertEquals(
      await f.tenant.tx((tx) => tx.devices.byId('new-device', 'alice')),
      null,
    );
  } finally {
    await f.close();
  }
});

Deno.test('ingress authority protects direct device owners, not only HTTP middleware', async () => {
  const f = await fixture();
  try {
    await assertRejects(
      () => updateDeviceName(f.guarded, 'alice', 'existing', 'foreign rename'),
      MatrixError,
      'operation owner unavailable',
    );
    await assertRejects(
      () =>
        f.guarded.tx((tx) => tx.devices.upsert('new-device', 'alice', null)),
      MatrixError,
      'operation owner unavailable',
    );
    assertEquals(
      (await f.tenant.tx((tx) => tx.devices.byId('existing', 'alice')))
        ?.display_name,
      'alice',
    );
    assertEquals(
      await f.tenant.tx((tx) => tx.devices.byId('new-device', 'alice')),
      null,
    );
  } finally {
    await f.close();
  }
});
