import { assertEquals, assertRejects } from '@std/assert';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import {
  changePassword,
  loginUser,
  registerUser,
} from '#engine/tenant/users.ts';
import {
  consumeRefreshToken,
  hashToken,
  lookupToken,
  revokeAllTokens,
} from '#engine/tenant/auth.ts';
import { deleteDevices } from '#engine/tenant/devices.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { config } from '#engine/config.ts';
import { validateUpload } from '#engine/tenant/e2ee.ts';
import { deviceIdentity } from '#engine/tenant/txns.ts';
import { localClaim } from '#engine/e2ee.ts';
import { historicalTenantSchema } from './fixtures/tenant-schema-history.ts';
import {
  activateTenantAuthority,
  assertDeviceOwner,
  captureSessionAuthority,
  installSessionAuthority,
  requireSessionAuthority,
} from '#engine/tenant/session-authority.ts';

async function fixture() {
  const dir = await Deno.makeTempDir({ prefix: 'session-authority-' });
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { tenant: tenantSchema } });
  const common = {
    homeIncarnation: 'home-store',
    edgeNode: 'edge',
    edgeIncarnation: 'edge-store',
  };
  async function node(name: string, incarnation: string) {
    const tenant = await openTenant(store, name + '.test', { create: true });
    await registerUser(tenant, {
      localpart: 'alice',
      password: 'pw',
      accessToken: null,
    });
    const db = await store.tenant(name + '.test');
    await db.tx((conn) =>
      activateTenantAuthority(conn, { ...common, node: name, incarnation })
    );
    const guarded = await openTenant(store, name + '.test', {
      ingress: {
        async check(conn, intent) {
          if (intent.kind === 'session') {
            await requireSessionAuthority(conn, intent.hash, intent.refresh);
          }
          if (intent.kind === 'device') {
            await assertDeviceOwner(conn, intent.localpart, intent.deviceId);
          }
        },
      },
    });
    const login = (deviceId: string) =>
      loginUser(guarded, {
        localpart: 'alice',
        password: 'pw',
        deviceId,
        refresh: true,
      });
    const capture = () =>
      db.tx((conn) => captureSessionAuthority(conn, 'alice'));
    const install = (view: Awaited<ReturnType<typeof capture>>) =>
      db.tx((conn) => installSessionAuthority(conn, 'alice', view));
    return { tenant: guarded, db, login, capture, install };
  }
  const home = await node('home', 'home-store'),
    edge = await node('edge', 'edge-store');
  return {
    dir,
    store,
    home,
    edge,
    async close() {
      await store.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test('session authority: first ingress owns supplied IDs and foreign recovery cannot confirm or rotate', async () => {
  const f = await fixture();
  try {
    const session = await f.home.login('supplied-byte-for-byte');
    await f.edge.install(await f.home.capture());
    await assertRejects(
      () => f.edge.login('supplied-byte-for-byte'),
      MatrixError,
      'operation owner unavailable',
    );
    await assertRejects(
      () => lookupToken(f.edge.tenant, session.accessToken),
      MatrixError,
      'operation owner unavailable',
    );
    await assertRejects(
      () => consumeRefreshToken(f.edge.tenant, session.refreshToken!),
      MatrixError,
      'operation owner unavailable',
    );
    assertEquals(await f.edge.db.query('SELECT * FROM access_tokens'), []);
    assertEquals(
      (await lookupToken(f.home.tenant, session.accessToken))?.device_id,
      'supplied-byte-for-byte',
    );
  } finally {
    await f.close();
  }
});

Deno.test('F2: whole-device pools refuse a live foreign owner before exhaustion and direct mutation', async () => {
  const f = await fixture();
  try {
    await f.home.login('HOME');
    await f.edge.install(await f.home.capture());
    const device = await deviceIdentity(f.home.tenant, 'alice', 'HOME');
    const input = validateUpload(
      {
        one_time_keys: { 'curve25519:once': 'once' },
      },
      '@alice:home.test',
      'HOME',
      config().e2ee,
    );
    await f.home.tenant.tx((tx) => tx.e2ee.upload(device, input));
    await assertRejects(
      () =>
        f.edge.tenant.tx((tx) => tx.e2ee.claim('alice', 'HOME', 'curve25519')),
      MatrixError,
      'operation owner unavailable',
    );
    await assertRejects(
      () => f.edge.tenant.tx((tx) => tx.e2ee.upload(device, input)),
      MatrixError,
      'operation owner unavailable',
    );
    assertEquals(await f.edge.db.query('SELECT * FROM one_time_keys'), []);
    assertEquals(
      await f.home.tenant.tx((tx) =>
        tx.e2ee.claim('alice', 'HOME', 'curve25519')
      ),
      { 'curve25519:once': 'once' },
    );
    await deleteDevices(f.home.tenant, 'alice', ['HOME']);
    await f.edge.install(await f.home.capture());
    assertEquals(
      await f.edge.tenant.tx((tx) =>
        tx.e2ee.claim('alice', 'HOME', 'curve25519')
      ),
      null,
    );
  } finally {
    await f.close();
  }
});

Deno.test('F2: C-S returns available keys with a truthful owner failure while S2S rolls back incomplete claims', async () => {
  const f = await fixture();
  try {
    await f.home.login('HOME');
    await f.edge.install(await f.home.capture());
    await f.edge.login('EDGE');
    const device = await deviceIdentity(f.edge.tenant, 'alice', 'EDGE');
    await f.edge.tenant.tx((tx) =>
      tx.e2ee.upload(
        device,
        validateUpload(
          {
            one_time_keys: {
              'curve25519:first': 'first',
              'curve25519:second': 'second',
            },
          },
          '@alice:edge.test',
          'EDGE',
          config().e2ee,
        ),
      )
    );
    const request: import('#engine/e2ee.ts').Claim = [[
      '@alice:edge.test',
      { EDGE: 'curve25519', HOME: 'curve25519' },
    ]];
    assertEquals(await localClaim(f.edge.tenant, request, config().e2ee, {}), {
      one_time_keys: {
        '@alice:edge.test': { EDGE: { 'curve25519:first': 'first' } },
      },
      failures: {
        'edge.test': { errcode: 'M_UNAVAILABLE', error: 'keys unavailable' },
      },
    });
    await assertRejects(
      () => localClaim(f.edge.tenant, request, config().e2ee),
      MatrixError,
      'operation owner unavailable',
    );
    assertEquals(
      await f.edge.tenant.tx((tx) =>
        tx.e2ee.claim('alice', 'EDGE', 'curve25519')
      ),
      { 'curve25519:second': 'second' },
      'the rejected S2S answer must not consume its available prefix',
    );
  } finally {
    await f.close();
  }
});

Deno.test('password logout revokes imported sessions and devices but preserves the caller refresh window', async () => {
  const f = await fixture();
  try {
    const caller = await f.home.login('caller');
    const other = await f.home.login('other-home');
    const foreign = await f.edge.login('foreign');
    const foreignView = await f.edge.capture();
    await f.home.install(foreignView);
    await changePassword(f.home.tenant, 'alice', 'new-pw', {
      keepToken: caller.accessToken,
      logoutDevices: true,
    });
    await f.edge.install(await f.home.capture());
    for (
      const [node, session] of [[f.home, other], [f.edge, foreign]] as const
    ) {
      await assertRejects(
        () => lookupToken(node.tenant, session.accessToken),
        MatrixError,
        'session authority revoked',
      );
      await assertRejects(
        () => consumeRefreshToken(node.tenant, session.refreshToken!),
        MatrixError,
        'session authority revoked',
      );
    }
    assertEquals(
      await f.edge.tenant.tx((tx) => tx.devices.ofUser('alice')),
      [],
    );
    await f.edge.install(foreignView);
    await assertRejects(
      () => lookupToken(f.edge.tenant, foreign.accessToken),
      MatrixError,
      'session authority revoked',
    );
    assertEquals(
      (await lookupToken(f.home.tenant, caller.accessToken))?.device_id,
      'caller',
    );
    const next = await consumeRefreshToken(f.home.tenant, caller.refreshToken!);
    // Changing the password does not destroy the pending issuer retry window.
    await changePassword(f.home.tenant, 'alice', 'newer-pw', {
      keepToken: next.accessToken,
      logoutDevices: true,
    });
    const retry = await consumeRefreshToken(
      f.home.tenant,
      caller.refreshToken!,
    );
    assertEquals(
      (await lookupToken(f.home.tenant, retry.accessToken))?.device_id,
      'caller',
    );
    const after = await consumeRefreshToken(f.home.tenant, retry.refreshToken);
    assertEquals(
      (await lookupToken(f.home.tenant, after.accessToken))?.device_id,
      'caller',
    );
  } finally {
    await f.close();
  }
});

Deno.test('session authority: incarnation counters, barriers and digest recovery survive cold reopen', async () => {
  const f = await fixture();
  try {
    const first = await f.edge.login('cold');
    const original = await f.edge.capture();
    await f.home.install(original);
    await revokeAllTokens(f.home.tenant, 'alice');
    await f.edge.install(await f.home.capture());
    const next = await f.edge.login('next');
    const before = await f.edge.capture();
    await f.store.close();
    const reopened = await openStore({
      dir: f.dir,
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 300,
    }, { schemas: { tenant: tenantSchema } });
    try {
      // Built-in owner gates must survive without a custom HTTP/ingress wrapper.
      const tenant = await openTenant(reopened, 'edge.test');
      const db = await reopened.tenant('edge.test');
      assertEquals(
        await db.tx((conn) => captureSessionAuthority(conn, 'alice')),
        before,
      );
      await assertRejects(
        () => lookupToken(tenant, first.accessToken),
        MatrixError,
        'session authority revoked',
      );
      assertEquals(
        (await lookupToken(tenant, next.accessToken))?.device_id,
        'next',
      );
      await deleteDevices(tenant, 'alice', ['next']);
      const recreated = await loginUser(tenant, {
        localpart: 'alice',
        password: 'pw',
        deviceId: 'next',
        refresh: false,
      });
      const after = await db.tx((conn) =>
        captureSessionAuthority(conn, 'alice')
      );
      const creations = after.facts.filter((fact) =>
        fact.node === 'edge' && fact.kind === 'device'
      );
      assertEquals(new Set(creations.map((fact) => fact.id)).size, 3);
      assertEquals(
        (await lookupToken(tenant, recreated.accessToken))?.device_id,
        'next',
      );
      await assertRejects(
        () => lookupToken(tenant, next.accessToken),
        MatrixError,
        'session authority revoked',
      );
    } finally {
      await reopened.close();
    }
  } finally {
    await f.close();
  }
});

Deno.test('session authority: tenant23 upgrade preserves existing sessions and activation assigns only home pre-enrollment devices', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'session-upgrade-' });
  const options = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  let store = await openStore(options, {
    schemas: { tenant: historicalTenantSchema(23) },
  });
  try {
    const db = await store.tenant('home.test', { create: true });
    await openTenant(store, 'home.test', { create: true });
    await db.execute("INSERT INTO users(localpart) VALUES('alice')");
    await db.execute("INSERT INTO devices VALUES('legacy','alice',7,'kept')");
    await db.execute(
      "INSERT INTO access_tokens(token,localpart,device_id,generation,expires_ms) VALUES(?,'alice','legacy',7,NULL)",
      [await hashToken('original')],
    );
    await store.close();
    store = await openStore(options, { schemas: { tenant: tenantSchema } });
    const tenant = await openTenant(store, 'home.test');
    const upgraded = await store.tenant('home.test');
    await upgraded.tx((conn) =>
      activateTenantAuthority(conn, {
        node: 'home',
        incarnation: 'h',
        homeIncarnation: 'h',
        edgeNode: 'edge',
        edgeIncarnation: 'e',
      })
    );
    assertEquals((await lookupToken(tenant, 'original'))?.generation, 7);
    assertEquals(
      (await upgraded.tx((conn) => captureSessionAuthority(conn, 'alice')))
        .facts[0].node,
      'home',
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('session authority: concurrent same-ID creation converges home-wins with edge soft logout in either delivery order', async () => {
  const f = await fixture();
  try {
    const hs = await f.home.login('collision'),
      es = await f.edge.login('collision');
    const h = await f.home.capture(), e = await f.edge.capture();
    await f.home.install(e);
    await f.edge.install(h);
    await f.edge.install(e);
    await f.home.install(h);
    const error = await assertRejects(
      () => lookupToken(f.edge.tenant, es.accessToken),
      MatrixError,
      'session authority revoked',
    );
    assertEquals(error.responseBody().soft_logout, true);
    assertEquals(
      (await lookupToken(f.home.tenant, hs.accessToken))?.device_id,
      'collision',
    );
    assertEquals(
      (await f.home.capture()).facts,
      (await f.edge.capture()).facts,
    );
    assertEquals(
      await f.edge.tenant.tx((tx) => tx.devices.byId('collision', 'alice')),
      null,
    );
  } finally {
    await f.close();
  }
});

Deno.test('session authority: logout-all invalidates concurrent offline login and later observed login survives replay', async () => {
  const f = await fixture();
  try {
    const old = await f.edge.login('edge-device');
    await revokeAllTokens(f.home.tenant, 'alice');
    const concurrent = await f.edge.login('concurrent');
    const before = await f.edge.capture(), barrier = await f.home.capture();
    await f.edge.install(barrier);
    for (const token of [old.accessToken, concurrent.accessToken]) {
      await assertRejects(
        () => lookupToken(f.edge.tenant, token),
        MatrixError,
        'session authority revoked',
      );
    }
    const fresh = await f.edge.login('fresh');
    await f.edge.install(before);
    await f.edge.install(barrier);
    assertEquals(
      (await lookupToken(f.edge.tenant, fresh.accessToken))?.device_id,
      'fresh',
    );
    await assertRejects(
      () => consumeRefreshToken(f.edge.tenant, concurrent.refreshToken!),
      MatrixError,
      'session authority revoked',
    );
  } finally {
    await f.close();
  }
});

Deno.test('session authority: cross-ingress delete fences the captured incarnation without reviving on old snapshot', async () => {
  const f = await fixture();
  try {
    const first = await f.edge.login('device');
    const original = await f.edge.capture();
    await f.home.install(original);
    await deleteDevices(f.home.tenant, 'alice', ['device']);
    await f.edge.install(await f.home.capture());
    await assertRejects(
      () => lookupToken(f.edge.tenant, first.accessToken),
      MatrixError,
      'session authority revoked',
    );
    const second = await f.edge.login('device');
    await f.edge.install(original);
    await assertRejects(
      () => lookupToken(f.edge.tenant, first.accessToken),
      MatrixError,
      'session authority revoked',
    );
    assertEquals(
      (await lookupToken(f.edge.tenant, second.accessToken))?.device_id,
      'device',
    );
    assertEquals(
      (await f.edge.capture()).facts.filter((fact) => fact.kind === 'device')
        .length,
      2,
    );
  } finally {
    await f.close();
  }
});

Deno.test('session authority: refresh recovery retains digest-only predecessor candidate state and rejects changed facts', async () => {
  const f = await fixture();
  try {
    const first = await f.edge.login('refresh');
    const next = await consumeRefreshToken(f.edge.tenant, first.refreshToken!);
    const view = await f.edge.capture();
    const hash = await hashToken(first.refreshToken!);
    assertEquals(
      view.sessions.find((row) => row.hash === hash)?.nextHash,
      await hashToken(next.refreshToken),
    );
    assertEquals(JSON.stringify(view).includes(next.accessToken), false);
    await f.home.install(view);
    await assertRejects(
      () =>
        f.home.install({
          ...view,
          facts: view.facts.map((fact, index) =>
            index === 0 ? { ...fact, deviceId: 'substituted' } : fact
          ),
        }),
      MatrixError,
      'authority fact collision',
    );
    assertEquals(await f.home.db.query('SELECT * FROM refresh_tokens'), []);
  } finally {
    await f.close();
  }
});
