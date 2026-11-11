import { assert, assertEquals, assertRejects, assertThrows } from '@std/assert';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { deactivateUser, registerUser } from '#engine/tenant/users.ts';
import { issueOpenIdToken, openIdUserInfo } from '#engine/tenant/openid.ts';
import { hashToken, lookupToken } from '#engine/tenant/auth.ts';
import { config, loadConfig } from '#engine/config.ts';
import { TENANT_V14 } from '#tests/fixtures/tenant-versions.ts';

Deno.test('OpenID hashes, exact expiry, tenant separation, reopen and deactivation', async () => {
  const dir = await Deno.makeTempDir();
  const settings = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  let store = await openStore(settings, { schemas: { tenant: tenantSchema } });
  try {
    let tenant = await openTenant(store, 'openid.test', { create: true });
    await registerUser(tenant, { localpart: 'alice', password: 'pw' });
    const now = Date.now();
    const issued = await issueOpenIdToken(tenant, 'alice', now);
    const hash = await hashToken(issued.access_token);
    const db = await store.tenant('openid.test');
    assertEquals(
      (await db.query('SELECT token_hash FROM openid_tokens')).map((row) =>
        row.token_hash
      ),
      [hash],
    );
    assert(hash !== issued.access_token);
    assertEquals(await lookupToken(tenant, issued.access_token), null);
    assertEquals(
      await openIdUserInfo(
        tenant,
        issued.access_token,
        now + issued.expires_in * 1000 - 1,
      ),
      { sub: '@alice:openid.test' },
    );
    await assertRejects(() =>
      openIdUserInfo(
        tenant,
        issued.access_token,
        now + issued.expires_in * 1000,
      )
    );
    const other = await openTenant(store, 'other.test', { create: true });
    await assertRejects(() => openIdUserInfo(other, issued.access_token, now));
    await store.close();
    store = await openStore(settings, { schemas: { tenant: tenantSchema } });
    tenant = await openTenant(store, 'openid.test');
    assertEquals(await openIdUserInfo(tenant, issued.access_token, now), {
      sub: '@alice:openid.test',
    });
    await deactivateUser(tenant, 'alice');
    await assertRejects(() => openIdUserInfo(tenant, issued.access_token, now));
    await assertRejects(() => issueOpenIdToken(tenant, 'alice', now));
    assertEquals(
      await (await store.tenant('openid.test')).query(
        'SELECT * FROM openid_tokens',
      ),
      [],
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('tenant v14 upgrades OpenID credentials without touching identity or access tokens', async () => {
  const dir = await Deno.makeTempDir();
  const settings = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  const previous = {
    version: 14,
    apply: async (db: Parameters<typeof tenantSchema.apply>[0]) => {
      await db.exec(TENANT_V14);
    },
  };
  let store = await openStore(settings, { schemas: { tenant: previous } });
  try {
    let tenant = await openTenant(store, 'upgrade.test', { create: true });
    const user = await registerUser(tenant, {
      localpart: 'alice',
      password: 'pw',
    });
    const before = JSON.stringify(
      await (await store.tenant('upgrade.test')).query('SELECT * FROM tenant'),
    );
    await store.close();
    store = await openStore(settings, { schemas: { tenant: tenantSchema } });
    tenant = await openTenant(store, 'upgrade.test');
    const db = await store.tenant('upgrade.test');
    assertEquals(
      JSON.stringify(await db.query('SELECT * FROM tenant')),
      before,
    );
    assertEquals(
      (await lookupToken(tenant, user.access_token!))?.user_id,
      user.user_id,
    );
    assertEquals(await db.query('SELECT * FROM openid_tokens'), []);
    const issued = await issueOpenIdToken(tenant, 'alice');
    assertEquals(await openIdUserInfo(tenant, issued.access_token), {
      sub: user.user_id,
    });
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('OpenID lifetime follows shipped defaults and rejects invalid admin overrides', () => {
  assertEquals(config().openid.tokenseconds, 3600);
  for (const value of ['0', '-1', '999999999999999']) {
    assertThrows(() =>
      loadConfig({
        defaultsPath: 'defaults/communico.toml',
        configPath: null,
        env: { COMMUNICO_OPENID_TOKENSECONDS: value },
      })
    );
  }
});
