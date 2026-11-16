import { assertEquals, assertRejects } from '@std/assert';
import { MatrixError } from '#engine/matrix-error.ts';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import {
  captureAccountAuth,
  installAccountAuth,
  requireAccountAuth,
} from '#engine/tenant/account-auth.ts';
import { registerUser, verifyUserPassword } from '#engine/tenant/users.ts';
import { historicalTenantSchema } from './fixtures/tenant-schema-history.ts';
import { activateTenantAuthority } from '#engine/tenant/session-authority.ts';

const binding = {
  server: 'logical.test',
  pairing: 'paired-edge',
  grantRevision: 1,
  ownerRevision: 1,
};
const permissive = { allowstaleauth: true, authmaxstalehours: 0 };

Deno.test('account auth migration upgrades actual tenant22 to the same schema as fresh23 without changing credentials', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'auth-upgrade-' });
  const cfg = (name: string) => ({
    dir: dir + '/' + name,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  });
  const prior = historicalTenantSchema(22);
  let old = await openStore(cfg('old'), { schemas: { tenant: prior } });
  const fresh = await openStore(cfg('fresh'), {
    schemas: { tenant: tenantSchema },
  });
  try {
    const tenant = await openTenant(old, 'logical.test', { create: true });
    await registerUser(tenant, {
      localpart: 'alice',
      password: 'pw',
      accessToken: null,
    });
    const key = tenant.publicB64;
    await old.close();
    old = await openStore(cfg('old'), { schemas: { tenant: tenantSchema } });
    await openTenant(fresh, 'logical.test', { create: true });
    const sql =
      "SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name";
    assertEquals(
      await (await old.tenant('logical.test')).query(sql),
      await (await fresh.tenant('logical.test')).query(sql),
    );
    const upgraded = await openTenant(old, 'logical.test');
    assertEquals(upgraded.publicB64, key);
    assertEquals(await verifyUserPassword(upgraded, 'alice', 'pw'), true);
  } finally {
    await old.close();
    await fresh.close();
    await Deno.remove(dir, { recursive: true });
  }
});

async function fixture() {
  const dir = await Deno.makeTempDir({ prefix: 'account-auth-' });
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { tenant: tenantSchema } });
  const home = await openTenant(store, 'home.test', { create: true });
  await registerUser(home, {
    localpart: 'alice',
    password: 'pw',
    accessToken: null,
  });
  const edge = await openTenant(store, 'edge.test', { create: true });
  const hd = await store.tenant('home.test'),
    ed = await store.tenant('edge.test');
  const identity = {
    homeIncarnation: 'h',
    edgeNode: 'edge',
    edgeIncarnation: 'e',
  };
  await hd.tx((conn) =>
    activateTenantAuthority(conn, {
      ...identity,
      node: 'home',
      incarnation: 'h',
    })
  );
  await ed.tx((conn) =>
    activateTenantAuthority(conn, {
      ...identity,
      node: 'edge',
      incarnation: 'e',
    })
  );
  const capture = (credentials = true, now = 1000000) =>
    hd.tx((conn) =>
      captureAccountAuth(conn, binding, 'alice', credentials, now)
    );
  const require = (
    settings = permissive,
    reconciled = false,
    credentials = true,
    now = 1000001,
  ) =>
    ed.tx((conn) =>
      requireAccountAuth(
        conn,
        'alice',
        binding,
        settings,
        reconciled,
        credentials,
        now,
      )
    );
  return {
    dir,
    store,
    home,
    edge,
    hd,
    ed,
    capture,
    require,
    async close() {
      await store.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test('account auth snapshot installs a verifier for offline password verification without private identity or bearer tokens', async () => {
  const f = await fixture();
  try {
    const view = await f.capture();
    await f.ed.tx((conn) => installAccountAuth(conn, view));
    await f.require();
    assertEquals(await verifyUserPassword(f.edge, 'alice', 'pw'), true);
    assertEquals(await verifyUserPassword(f.edge, 'alice', 'bad'), false);
    assertEquals(
      Object.keys(view).sort(),
      [
        'capturedMs',
        'authority',
        'credentials',
        'deactivated',
        'grantRevision',
        'kind',
        'localpart',
        'ownerRevision',
        'pairing',
        'phc',
        'revision',
        'server',
        'sourceCut',
      ].sort(),
    );
    assertEquals(await f.ed.query('SELECT * FROM access_tokens'), []);
  } finally {
    await f.close();
  }
});

Deno.test('account auth verifier and its exact freshness cut survive a cold reopen', async () => {
  const f = await fixture();
  try {
    const view = await f.capture();
    await f.ed.tx((conn) => installAccountAuth(conn, view));
    await f.require();
    const cut = await f.ed.query('SELECT * FROM account_auth_snapshots');
    await f.store.close();
    const reopened = await openStore({
      dir: f.dir,
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 300,
    }, { schemas: { tenant: tenantSchema } });
    try {
      const tenant = await openTenant(reopened, 'edge.test');
      const db = await reopened.tenant('edge.test');
      assertEquals(await db.query('SELECT * FROM account_auth_snapshots'), cut);
      assertEquals(await verifyUserPassword(tenant, 'alice', 'pw'), true);
      await assertRejects(
        () =>
          db.tx((conn) =>
            requireAccountAuth(
              conn,
              'alice',
              binding,
              { allowstaleauth: true, authmaxstalehours: 1 },
              false,
              true,
              view.capturedMs + 3600001,
            )
          ),
        MatrixError,
      );
    } finally {
      await reopened.close();
    }
  } finally {
    await f.close();
  }
});

Deno.test('snapshot freshness is the signed source cut, never replay arrival; stale and strict modes are explicit', async () => {
  const f = await fixture();
  try {
    const view = await f.capture();
    await f.ed.tx((conn) => installAccountAuth(conn, view));
    await f.require();
    await assertRejects(
      () => f.require({ allowstaleauth: false, authmaxstalehours: 0 }),
      MatrixError,
      'authentication snapshot unavailable',
    );
    await f.require({ allowstaleauth: false, authmaxstalehours: 0 }, true);
    await assertRejects(
      () =>
        f.require(
          { allowstaleauth: true, authmaxstalehours: 1 },
          false,
          true,
          4600001,
        ),
      MatrixError,
    );
    await f.ed.tx((conn) => installAccountAuth(conn, view));
    await assertRejects(
      () =>
        f.require(
          { allowstaleauth: true, authmaxstalehours: 1 },
          false,
          true,
          4600001,
        ),
      MatrixError,
    );
    await f.require(permissive, false, true, 4600001);
    await assertRejects(
      () => f.require(permissive, false, true, 4600000),
      MatrixError,
    );
  } finally {
    await f.close();
  }
});

Deno.test('disabling verifier export removes the held verifier monotonically while session snapshot freshness remains usable', async () => {
  const f = await fixture();
  try {
    const first = await f.capture();
    await f.ed.tx((conn) => installAccountAuth(conn, first));
    const disabled = await f.capture(false, 1000002);
    assertEquals(disabled.revision, first.revision + 1);
    assertEquals(disabled.phc, null);
    await f.ed.tx((conn) => installAccountAuth(conn, disabled));
    await assertRejects(
      () => f.require(permissive, true, true, 1000003),
      MatrixError,
    );
    await f.require(permissive, false, false, 1000003);
    assertEquals(await verifyUserPassword(f.edge, 'alice', 'pw'), false);
    await assertRejects(
      () => f.ed.tx((conn) => installAccountAuth(conn, first)),
      MatrixError,
    );
  } finally {
    await f.close();
  }
});

Deno.test('credential revisions retain an intervening password change even when the old verifier is restored before export', async () => {
  const f = await fixture();
  try {
    const first = await f.capture();
    const phc = await f.home.tx((tx) => tx.credentials.hash('alice'));
    await f.home.tx((tx) => tx.credentials.clear('alice'));
    await f.home.tx((tx) => tx.credentials.set('alice', phc!));
    const next = await f.capture(true, 1000002);
    assertEquals(next.revision > first.revision, true);
  } finally {
    await f.close();
  }
});

Deno.test('deactivation cannot be undone by a later active snapshot and regressed home clocks cannot refresh authority', async () => {
  const f = await fixture();
  try {
    const first = await f.capture();
    await f.ed.tx((conn) =>
      installAccountAuth(conn, { ...first, deactivated: true, phc: null })
    );
    const later = await f.capture(true, 1000002);
    await f.ed.tx((conn) =>
      installAccountAuth(conn, { ...later, revision: first.revision + 1 })
    );
    assertEquals(
      (await f.edge.tx((tx) => tx.users.byLocalpart('alice')))?.deactivated,
      true,
    );
    assertEquals(await verifyUserPassword(f.edge, 'alice', 'pw'), false);
    await assertRejects(() => f.capture(true, 1000001), MatrixError);
  } finally {
    await f.close();
  }
});
