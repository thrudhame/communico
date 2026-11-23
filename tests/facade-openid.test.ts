import { assert, assertEquals, assertRejects } from '@std/assert';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { activateTenantAuthority } from '#engine/tenant/session-authority.ts';
import { issueOpenIdToken, openIdUserInfo } from '#engine/tenant/openid.ts';
import { hashToken, lookupToken } from '#engine/tenant/auth.ts';
import { registerOperations } from '#engine/facade/registers.ts';
import { registerUser } from '#engine/tenant/users.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { createHash } from 'node:crypto';

async function fixture() {
  const dir = await Deno.makeTempDir({ prefix: 'facade-openid-' });
  const stores: Awaited<ReturnType<typeof openStore>>[] = [];
  const tenants: Awaited<ReturnType<typeof openTenant>>[] = [];
  for (const node of ['home', 'edge']) {
    const store = await openStore({
      dir: dir + '/' + node,
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 300,
    }, { schemas: { tenant: tenantSchema } });
    stores.push(store);
    const tenant = await openTenant(store, 'logical.test', { create: true });
    await registerUser(tenant, { localpart: 'alice', password: 'pw' });
    await (await store.tenant(tenant.serverName)).tx((conn) =>
      activateTenantAuthority(conn, {
        node,
        incarnation: node + '-store',
        homeIncarnation: 'home-store',
        edgeNode: 'edge',
        edgeIncarnation: 'edge-store',
      })
    );
    tenants.push(tenant);
  }
  return {
    home: tenants[0],
    edge: tenants[1],
    stores,
    async close() {
      for (const store of stores) await store.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test('facade OpenID: issue commits only the digest and immutable export intent', async () => {
  const f = await fixture();
  try {
    const now = Date.now();
    const issued = await issueOpenIdToken(f.home, 'alice', now);
    const hash = await hashToken(issued.access_token);
    const operations = await (await f.stores[0].tenant('logical.test')).tx((
      conn,
    ) => registerOperations(conn, JSON.stringify(['openid', 'alice', hash])));
    assertEquals(operations.length, 1, 'OpenID ACK has no durable export fact');
    assertEquals(JSON.parse(operations[0].payload), {
      hash,
      expires: now + issued.expires_in * 1000,
    });
    assert(!operations[0].payload.includes(issued.access_token));
    assertEquals(await lookupToken(f.home, issued.access_token), null);
  } finally {
    await f.close();
  }
});

Deno.test('facade OpenID: unreplicated other-issuer bearer is unavailable, never false unknown', async () => {
  const f = await fixture();
  try {
    for (const [issuer, receiver] of [[f.home, f.edge], [f.edge, f.home]]) {
      const issued = await issueOpenIdToken(issuer, 'alice');
      const error = await assertRejects(
        () => openIdUserInfo(receiver, issued.access_token),
        MatrixError,
      );
      assertEquals(error.status, 503);
      assertEquals(error.errcode, 'M_UNAVAILABLE');
    }
    const error = await assertRejects(
      () => openIdUserInfo(f.home, 'not-a-credential'),
      MatrixError,
    );
    assertEquals(error.errcode, 'M_UNKNOWN_TOKEN');
  } finally {
    await f.close();
  }
});

Deno.test('facade OpenID: immutable imports preserve expiry, purpose and deactivation across duplicate replay', async () => {
  const f = await fixture();
  try {
    const now = Date.now();
    const issued = await issueOpenIdToken(f.home, 'alice', now);
    const [original] = await f.home.tx((tx) => tx.openid.operations('alice'));
    await f.edge.tx((tx) => tx.openid.import(original));
    await f.edge.tx((tx) => tx.openid.import(original));
    assertEquals(await openIdUserInfo(f.edge, issued.access_token, now), {
      sub: '@alice:logical.test',
    });
    assertEquals(await lookupToken(f.edge, issued.access_token), null);
    const expired = await assertRejects(
      () =>
        openIdUserInfo(
          f.edge,
          issued.access_token,
          now + issued.expires_in * 1000,
        ),
      MatrixError,
    );
    assertEquals(expired.errcode, 'M_UNKNOWN_TOKEN');
    const payload = JSON.stringify({
      hash: await hashToken(issued.access_token),
      expires: now + 1,
    });
    for (
      const invalid of [
        {
          ...original,
          payload,
          payloadHash: createHash('sha256').update(
            JSON.stringify(JSON.parse(payload), ['expires', 'hash']),
          ).digest('hex'),
        },
        { ...original, source: 'other' },
        {
          ...original,
          sequence: 2,
          context: [{
            source: original.source,
            incarnation: original.incarnation,
            sequence: 1,
          }],
        },
      ]
    ) {
      await assertRejects(() => f.edge.tx((tx) => tx.openid.import(invalid)));
      assertEquals(await f.edge.tx((tx) => tx.openid.operations('alice')), [
        original,
      ]);
    }
    await f.edge.tx(async (tx) => {
      await tx.users.markDeactivated('alice');
      await tx.openid.clear('alice');
    });
    await f.edge.tx((tx) => tx.openid.import(original));
    const revoked = await assertRejects(
      () => openIdUserInfo(f.edge, issued.access_token, now),
      MatrixError,
    );
    assertEquals(revoked.errcode, 'M_UNKNOWN_TOKEN');
    const hash = await hashToken(issued.access_token);
    assertEquals(await f.edge.tx((tx) => tx.openid.user(hash, now)), null);
    assertEquals(await f.edge.tx((tx) => tx.openid.operations('alice')), [
      original,
    ]);
  } finally {
    await f.close();
  }
});

Deno.test('facade OpenID: failed credential insert rolls back the source fact', async () => {
  const f = await fixture();
  try {
    const db = await f.stores[0].tenant('logical.test');
    await db.exec(
      "CREATE TRIGGER refuse_openid BEFORE INSERT ON openid_tokens BEGIN SELECT RAISE(ABORT, 'fixture credential publication failure'); END",
    );
    await assertRejects(() => issueOpenIdToken(f.home, 'alice'));
    assertEquals(await db.query('SELECT * FROM openid_tokens'), []);
    assertEquals(await f.home.tx((tx) => tx.openid.operations('alice')), []);
  } finally {
    await f.close();
  }
});
