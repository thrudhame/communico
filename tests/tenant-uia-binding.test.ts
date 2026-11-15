import { assert, assertEquals, assertRejects } from '@std/assert';
import { createHash } from 'node:crypto';
import { canonicalJson } from '#engine/canonical.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import {
  changePassword,
  deactivateUser,
  registerUser,
} from '#engine/tenant/users.ts';
import {
  deleteDevices,
  getDevice,
  upsertDevice,
} from '#engine/tenant/devices.ts';
import { PASSWORD_FLOWS, requireUia } from '#engine/tenant/uia.ts';
import {
  consumeRefreshToken,
  issueRefreshToken,
  lookupToken,
} from '#engine/tenant/auth.ts';
import {
  activateTenantAuthority,
  recordLogoutBarrier,
} from '#engine/tenant/session-authority.ts';
import { historicalTenantSchema } from './fixtures/tenant-schema-history.ts';

const action = (name: string, parameters: unknown) => ({
  name,
  digest: createHash('sha256').update(canonicalJson(parameters)).digest('hex'),
});

async function fixture() {
  const dir = await Deno.makeTempDir({ prefix: 'uia-binding-' });
  const storeOptions = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  let store = await openStore(storeOptions, {
    schemas: { tenant: tenantSchema },
  });
  const tenant = await openTenant(store, 'uia.test', { create: true });
  const user = await registerUser(tenant, {
    localpart: 'alice',
    password: 'pw',
    deviceId: 'caller',
  });
  await registerUser(tenant, { localpart: 'bob', password: 'pw' });
  await upsertDevice(tenant, 'alice', 'target');
  const request = {
    caller: '@alice:uia.test',
    token: user.access_token!,
    action: action('delete-devices', ['target']),
    targets: ['target'],
    flows: PASSWORD_FLOWS,
    body: { devices: ['target'] } as Record<string, unknown>,
  };
  async function challenge() {
    const error = await assertRejects(
      () => requireUia(tenant, request),
      MatrixError,
    );
    return error.responseBody().session as string;
  }
  const complete = (session?: string) => ({
    ...request,
    body: {
      ...request.body,
      auth: {
        type: 'm.login.password',
        password: 'pw',
        ...(session ? { session } : {}),
      },
    } as Record<string, unknown>,
  });
  return {
    store,
    tenant,
    request,
    challenge,
    complete,
    async reopen() {
      await store.close();
      store = await openStore(storeOptions, {
        schemas: { tenant: tenantSchema },
      });
      return await openTenant(store, 'uia.test');
    },
    async close() {
      await store.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

for (
  const change of [
    'caller',
    'action',
    'parameters',
    'credential',
    'target',
  ] as const
) {
  Deno.test(`UIA binding refuses changed ${change} before completing a held password flow`, async () => {
    const f = await fixture();
    try {
      const session = await f.challenge();
      let request = f.complete(session);
      if (change === 'caller') {
        request = { ...request, caller: '@bob:uia.test', token: '' };
      }
      if (change === 'action') {
        request = { ...request, action: action('deactivate', false) };
      }
      if (change === 'parameters') request.body.devices = ['caller'];
      if (change === 'credential') {
        await changePassword(f.tenant, 'alice', 'pw', { logoutDevices: false });
      }
      if (change === 'target') {
        await deleteDevices(f.tenant, 'alice', ['target']);
        await upsertDevice(f.tenant, 'alice', 'target');
      }
      await assertRejects(() => requireUia(f.tenant, request), MatrixError);
      assert(await getDevice(f.tenant, 'alice', 'target'));
    } finally {
      await f.close();
    }
  });
}

Deno.test('UIA authorization fences replacement targets atomically at the deletion owner, not just challenge completion', async () => {
  const f = await fixture();
  try {
    await upsertDevice(f.tenant, 'alice', 'untouched');
    const request = f.complete();
    request.action = action('delete-devices', ['untouched', 'target']);
    request.targets = ['untouched', 'target'];
    request.body.devices = ['untouched', 'target'];
    const authorization = await requireUia(f.tenant, request);
    await deleteDevices(f.tenant, 'alice', ['target']);
    await upsertDevice(f.tenant, 'alice', 'target');
    await assertRejects(
      () =>
        deleteDevices(
          f.tenant,
          'alice',
          ['untouched', 'target'],
          authorization,
        ),
      MatrixError,
    );
    assert(await getDevice(f.tenant, 'alice', 'target'));
    assert(await getDevice(f.tenant, 'alice', 'untouched'));
  } finally {
    await f.close();
  }
});

Deno.test('UIA authorization is rechecked by account mutation owners after password or session revocation', async () => {
  const f = await fixture();
  try {
    const request = {
      ...f.complete(),
      action: action('deactivate', { erase: false }),
      targets: [],
    };
    const authorization = await requireUia(f.tenant, request);
    await changePassword(f.tenant, 'alice', 'pw', { logoutDevices: false });
    await assertRejects(
      () => deactivateUser(f.tenant, 'alice', undefined, authorization),
      MatrixError,
    );
    assertEquals(
      (await f.tenant.tx((tx) => tx.users.byLocalpart('alice')))?.deactivated,
      false,
    );
  } finally {
    await f.close();
  }
});

Deno.test('UIA checks ingress verifier availability before creating even an initial challenge', async () => {
  const f = await fixture();
  try {
    const guarded = await openTenant(f.store, 'uia.test', {
      ingress: {
        check() {
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
    const error = await assertRejects(
      () => requireUia(guarded, f.request),
      MatrixError,
    );
    assertEquals(error.status, 503);
    assertEquals(
      await (await f.store.tenant('uia.test')).query(
        'SELECT * FROM uia_sessions',
      ),
      [],
    );
  } finally {
    await f.close();
  }
});

Deno.test('UIA binds the node identity and retains only hashed action parameters, never submitted secrets', async () => {
  const f = await fixture();
  const other = await fixture();
  try {
    const request = {
      ...f.request,
      token: undefined,
      action: action('password', {
        password: 'new-secret',
        logoutDevices: false,
      }),
      body: { new_password: 'new-secret', logout_devices: false },
    };
    const error = await assertRejects(
      () => requireUia(f.tenant, request),
      MatrixError,
    );
    const session = error.responseBody().session as string;
    const db = await f.store.tenant('uia.test');
    const rows = await db.query('SELECT * FROM uia_sessions WHERE session=?', [
      session,
    ]);
    assertEquals(canonicalJson(rows).includes('new-secret'), false);
    assertEquals(canonicalJson(rows).includes(request.action.digest), false);
    const row = rows[0];
    const columns = Object.keys(row);
    await (await other.store.tenant('uia.test')).execute(
      `INSERT INTO uia_sessions(${columns.join(',')}) VALUES(${
        columns.map(() => '?').join(',')
      })`,
      Object.values(row),
    );
    const completion = {
      ...request,
      body: {
        ...request.body,
        auth: { session, type: 'm.login.password', password: 'pw' },
      },
    };
    await assertRejects(
      () => requireUia(other.tenant, completion),
      MatrixError,
    );
    await requireUia(f.tenant, completion);
  } finally {
    await f.close();
    await other.close();
  }
});

Deno.test('UIA survives a same-device refresh and cold restart without weakening the mutation fence', async () => {
  const f = await fixture();
  try {
    const session = await f.challenge();
    const refresh = await issueRefreshToken(
      f.tenant,
      'alice',
      'caller',
      f.request.token,
    );
    const next = await consumeRefreshToken(f.tenant, refresh);
    await lookupToken(f.tenant, next.accessToken);
    const tenant = await f.reopen();
    const authorization = await requireUia(tenant, {
      ...f.complete(session),
      token: next.accessToken,
    });
    await deleteDevices(tenant, 'alice', ['target'], authorization);
    assertEquals(await getDevice(tenant, 'alice', 'target'), null);
    assert(await getDevice(tenant, 'alice', 'caller'));
  } finally {
    await f.close();
  }
});

Deno.test('UIA refuses reconciled logout barriers at completion and at the owning mutation', async () => {
  const f = await fixture();
  try {
    const db = await f.store.tenant('uia.test');
    await db.tx((conn) =>
      activateTenantAuthority(conn, {
        node: 'home',
        incarnation: 'home-store',
        homeIncarnation: 'home-store',
        edgeNode: 'edge',
        edgeIncarnation: 'edge-store',
      })
    );
    const session = await f.challenge();
    const authorization = await requireUia(f.tenant, f.complete());
    await db.tx((conn) => recordLogoutBarrier(conn, 'alice'));
    await assertRejects(
      () => requireUia(f.tenant, f.complete(session)),
      MatrixError,
    );
    await assertRejects(
      () => deleteDevices(f.tenant, 'alice', ['target'], authorization),
      MatrixError,
    );
    assert(await getDevice(f.tenant, 'alice', 'target'));
  } finally {
    await f.close();
  }
});

Deno.test('tenant24 UIA sessions upgrade without granting unbound password authority', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'uia-upgrade-' });
  const options = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  let store = await openStore(options, {
    schemas: { tenant: historicalTenantSchema(24) },
  });
  try {
    const tenant = await openTenant(store, 'uia.test', { create: true });
    await registerUser(tenant, { localpart: 'alice', password: 'pw' });
    await (await store.tenant('uia.test')).execute(
      'INSERT INTO uia_sessions(session,flows,completed,created_ms) VALUES(?,?,?,?)',
      ['old', JSON.stringify(PASSWORD_FLOWS), '[]', Date.now()],
    );
    await store.close();
    store = await openStore(options, { schemas: { tenant: tenantSchema } });
    const upgraded = await openTenant(store, 'uia.test');
    assertEquals(
      (await (await store.tenant('uia.test')).query(
        'SELECT binding FROM uia_sessions WHERE session=?',
        ['old'],
      ))[0].binding,
      null,
    );
    await assertRejects(
      () =>
        requireUia(upgraded, {
          caller: '@alice:uia.test',
          action: action('deactivate', { erase: false }),
          flows: PASSWORD_FLOWS,
          body: {
            auth: { session: 'old', type: 'm.login.password', password: 'pw' },
          },
        }),
      MatrixError,
      'UIA action or authority changed',
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
