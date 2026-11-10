import { assertEquals, assertRejects } from '@std/assert';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import {
  deactivateUser,
  registerUser,
  setDisplayName,
} from '#engine/tenant/users.ts';
import { getPublicProfile, setProfileField } from '#engine/tenant/profiles.ts';

Deno.test('profiles persist, enforce atomic whole-profile UTF8 bounds and clear on deactivation', async () => {
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
    let tenant = await openTenant(store, 'profiles.test', { create: true });
    await registerUser(tenant, { localpart: 'alice', password: 'pw' });
    await setDisplayName(tenant, 'alice', null);
    // {"org.example.value":""} is 24 bytes; the exact boundary is rejected.
    const key = 'org.example.value';
    const overhead =
      new TextEncoder().encode(JSON.stringify({ [key]: '' })).length;
    await setProfileField(tenant, 'alice', key, 'x'.repeat(65535 - overhead));
    await assertRejects(() =>
      setProfileField(tenant, 'alice', key, 'x'.repeat(65536 - overhead))
    );
    await assertRejects(() => setDisplayName(tenant, 'alice', 'new'));
    assertEquals(
      (await getPublicProfile(tenant, 'alice'))?.displayname,
      undefined,
    );
    await setProfileField(tenant, 'alice', key, null);
    await tenant.tx((tx) => tx.users.setAvatarUrl('alice', 'internal avatar'));
    await tenant.tx((tx) => tx.users.setAvatarUrl('alice', null));
    assertEquals(
      (await getPublicProfile(tenant, 'alice'))?.avatar_url,
      undefined,
    );
    await setProfileField(tenant, 'alice', 'avatar_url', 'LemurLover');
    await setProfileField(tenant, 'alice', 'm.tz', 'Unknown/NotAnIANAZone');
    await setProfileField(
      tenant,
      'alice',
      'org.example.unicode',
      '\u00e9'.repeat(32000),
    );
    await assertRejects(() =>
      setProfileField(tenant, 'alice', key, '\u00e9'.repeat(1000))
    );
    await store.close();
    store = await openStore(settings, { schemas: { tenant: tenantSchema } });
    tenant = await openTenant(store, 'profiles.test');
    assertEquals((await getPublicProfile(tenant, 'alice'))?.[key], null);
    assertEquals(
      (await getPublicProfile(tenant, 'alice'))?.avatar_url,
      'LemurLover',
    );
    assertEquals(
      (await getPublicProfile(tenant, 'alice'))?.['m.tz'],
      'Unknown/NotAnIANAZone',
    );
    await deactivateUser(tenant, 'alice');
    assertEquals(await getPublicProfile(tenant, 'alice'), {});
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('tenant v15 migrates custom profile storage preserving legacy profile and identity', async () => {
  const dir = await Deno.makeTempDir();
  const settings = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  let store = await openStore(settings, {
    schemas: {
      tenant: {
        version: 15,
        apply: async (db) => {
          await tenantSchema.apply(db);
          await db.exec('DROP TABLE profile_fields');
          await db.exec('DROP TABLE erased_users');
        },
      },
    },
  });
  try {
    const old = await store.tenant('profiles.test', { create: true });
    await old.execute(
      "INSERT INTO users(localpart,display_name) VALUES('alice','Alice')",
    );
    await store.close();
    store = await openStore(settings, { schemas: { tenant: tenantSchema } });
    const tenant = await openTenant(store, 'profiles.test', { create: true });
    assertEquals(await getPublicProfile(tenant, 'alice'), {
      displayname: 'Alice',
    });
    await setProfileField(tenant, 'alice', 'org.example.key', { kept: true });
    assertEquals(
      (await getPublicProfile(tenant, 'alice'))?.['org.example.key'],
      { kept: true },
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
