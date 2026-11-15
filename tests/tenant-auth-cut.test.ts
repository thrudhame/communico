import { assertEquals, assertRejects } from '@std/assert';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import {
  deactivateUser,
  loginUser,
  registerUser,
  verifyUserPassword,
} from '#engine/tenant/users.ts';
import { lookupToken, revokeAllTokens } from '#engine/tenant/auth.ts';
import {
  activateTenantAuthority,
  captureSessionAuthority,
  installSessionAuthority,
} from '#engine/tenant/session-authority.ts';
import {
  captureAccountAuth,
  installAccountAuth,
  requireAccountAuth,
} from '#engine/tenant/account-auth.ts';
import { MatrixError } from '#engine/matrix-error.ts';

const binding = {
  server: 'logical.test',
  pairing: 'pair',
  grantRevision: 1,
  ownerRevision: 1,
};
async function fixture() {
  const dir = await Deno.makeTempDir({ prefix: 'auth-cut-' });
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { tenant: tenantSchema } });
  async function node(node: string, incarnation: string) {
    const tenant = await openTenant(store, node + '.test', { create: true });
    await registerUser(tenant, {
      localpart: 'alice',
      password: 'pw',
      accessToken: null,
    });
    const db = await store.tenant(node + '.test');
    await db.tx((conn) =>
      activateTenantAuthority(conn, {
        node,
        incarnation,
        homeIncarnation: 'h',
        edgeNode: 'edge',
        edgeIncarnation: 'e',
      })
    );
    const login = (deviceId: string) =>
      loginUser(tenant, {
        localpart: 'alice',
        password: 'pw',
        deviceId,
        refresh: false,
      });
    return { tenant, db, login };
  }
  const home = await node('home', 'h'), edge = await node('edge', 'e');
  const capture = (now: number) =>
    home.db.tx((conn) => captureAccountAuth(conn, binding, 'alice', true, now));
  return {
    home,
    edge,
    capture,
    async close() {
      await store.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test('auth freshness cut includes applied barriers before a concurrent offline session can authenticate', async () => {
  const f = await fixture();
  try {
    const old = await f.capture(1000);
    await f.edge.db.tx((conn) => installAccountAuth(conn, old));
    const concurrent = await f.edge.login('edge-only');
    await revokeAllTokens(f.home.tenant, 'alice');
    const next = await f.capture(2000);
    await f.edge.db.tx(async (conn) => {
      await installAccountAuth(conn, next);
      await requireAccountAuth(
        conn,
        'alice',
        binding,
        { allowstaleauth: true, authmaxstalehours: 1 },
        false,
        true,
        2001,
      );
    });
    await assertRejects(
      () => lookupToken(f.edge.tenant, concurrent.accessToken),
      MatrixError,
      'session authority revoked',
    );
    assertEquals(next.revision > old.revision, true);
    assertEquals(
      next.authority.facts.some((fact) => fact.kind === 'barrier'),
      true,
    );
    const fresh = await f.edge.login('fresh');
    assertEquals(
      (await lookupToken(f.edge.tenant, fresh.accessToken))?.device_id,
      'fresh',
    );
  } finally {
    await f.close();
  }
});

Deno.test('deactivation facts remove concurrent sessions and verifiers at either node without stale-snapshot resurrection', async () => {
  const f = await fixture();
  try {
    const old = await f.capture(1000);
    const session = await f.home.login('home-device');
    await deactivateUser(f.edge.tenant, 'alice');
    const removed = await f.edge.db.tx((conn) =>
      captureSessionAuthority(conn, 'alice')
    );
    await f.home.db.tx((conn) =>
      installSessionAuthority(conn, 'alice', removed)
    );
    await assertRejects(
      () => lookupToken(f.home.tenant, session.accessToken),
      MatrixError,
      'session authority revoked',
    );
    await assertRejects(
      () => f.home.login('new'),
      MatrixError,
      'M_USER_DEACTIVATED',
    );
    assertEquals(await verifyUserPassword(f.home.tenant, 'alice', 'pw'), false);
    await f.edge.db.tx((conn) => installAccountAuth(conn, old));
    assertEquals(await verifyUserPassword(f.edge.tenant, 'alice', 'pw'), false);
    assertEquals(
      await f.edge.tenant.tx((tx) => tx.users.byLocalpart('alice')).then((
        row,
      ) => row?.deactivated),
      true,
    );
  } finally {
    await f.close();
  }
});

Deno.test('erasing deactivation requires receiver-local privacy cuts and never imports foreign numeric cuts', async () => {
  const f = await fixture();
  try {
    await deactivateUser(f.home.tenant, 'alice', {
      '!r:logical.test': { changePos: 999, segment: 50, group: 100 },
    });
    const view = await f.capture(1000);
    await assertRejects(
      () => f.edge.db.tx((conn) => installAccountAuth(conn, view)),
      MatrixError,
      'authentication snapshot unavailable',
    );
    assertEquals(
      await f.edge.db.query('SELECT * FROM account_auth_snapshots'),
      [],
    );
    const local = { '!r:logical.test': { changePos: 7, segment: 2, group: 3 } };
    await f.edge.db.tx((conn) => installAccountAuth(conn, view, local));
    assertEquals(
      JSON.parse(
        String(
          (await f.edge.db.query('SELECT room_cuts FROM erased_users'))[0]
            .room_cuts,
        ),
      ),
      local,
    );
    assertEquals(await f.edge.db.query('SELECT * FROM credentials'), []);
    await f.edge.db.tx((conn) => installAccountAuth(conn, view));
    assertEquals(
      JSON.parse(
        String(
          (await f.edge.db.query('SELECT room_cuts FROM erased_users'))[0]
            .room_cuts,
        ),
      ),
      local,
    );
  } finally {
    await f.close();
  }
});
