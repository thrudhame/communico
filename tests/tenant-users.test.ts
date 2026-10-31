// tests/tenant-users.test.ts — users, credentials, devices, profiles and
// deactivation (old tenant.test.ts "credentials", "localpart",
// "register/login/token lifecycle" and the engine-observable parts of
// account.test.ts A1/A2/A4/A6, against the tenant handle). HTTP-only
// assertions stay with stage 5.
import { assert, assertEquals, assertRejects, assertThrows } from '@std/assert';
import { MatrixError } from '#engine/matrix-error.ts';
import { openStore, type Store } from '#engine/store/index.ts';
import { openTenant, type Tenant, tenantSchema } from '#engine/tenant/index.ts';
import {
  changePassword,
  checkLocalpart,
  deactivateUser,
  getProfile,
  hashPassword,
  isDeactivated,
  registerUser,
  setAvatarUrl,
  setDisplayName,
  verifyPassword,
  verifyUserPassword,
} from '#engine/tenant/users.ts';
import {
  deleteDevices,
  getDevice,
  listDevices,
  updateDeviceName,
  upsertDevice,
} from '#engine/tenant/devices.ts';
import {
  issueToken,
  lookupToken,
  revokeAllTokens,
  revokeToken,
} from '#engine/tenant/auth.ts';

const PHC_RE = /^\$argon2id\$v=19\$m=19456,t=2,p=1\$[^$]+\$[^$]+$/;

const config = (dir: string) => ({
  dir,
  library: './.native/libturso_ffi.so',
  checkpointlogbytes: 65536,
  maxopenfiles: 8,
  idleseconds: 300,
});

async function withTenant(
  fn: (tenant: Tenant) => Promise<void>,
  serverName = 'a.test',
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const store = await openStore(config(dir), {
    schemas: { tenant: tenantSchema },
  });
  try {
    await fn(await openTenant(store, serverName, { create: true }));
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test('credentials: argon2id PHC shape, verify good/bad', () => {
  const phc = hashPassword('demo-password');
  assertEquals(PHC_RE.test(phc), true);
  assert(verifyPassword(phc, 'demo-password'));
  assert(!verifyPassword(phc, 'wrong'));
  assert(!verifyPassword('garbage', 'demo-password'));
});

Deno.test('localpart: downcase + spec grammar', () => {
  assertEquals(checkLocalpart('Alice'), 'alice');
  assertEquals(checkLocalpart('a=b_c.d-e/f+g'), 'a=b_c.d-e/f+g');
  assertThrows(() => checkLocalpart('al ice'), MatrixError);
  assertThrows(() => checkLocalpart('al!ce'), MatrixError);
  assertThrows(() => checkLocalpart(''), MatrixError);
});

Deno.test('register/login/token lifecycle', async () => {
  await withTenant(async (tenant) => {
    const reg = await registerUser(tenant, {
      localpart: 'F1User',
      password: 's3cret-pw',
    });
    assertEquals(reg.user_id, '@f1user:a.test');
    assertEquals(reg.home_server, 'a.test');
    assert(reg.access_token !== undefined && reg.access_token.length > 0);
    assert(reg.device_id.length > 0);

    // duplicate → M_USER_IN_USE
    const dup = await assertRejects(
      () => registerUser(tenant, { localpart: 'f1user', password: 'x' }),
      MatrixError,
    );
    assert(dup.message.includes('M_USER_IN_USE'));

    // password verify + token lookup
    assert(await verifyUserPassword(tenant, 'f1user', 's3cret-pw'));
    assert(!await verifyUserPassword(tenant, 'f1user', 'nope'));
    assert(!await verifyUserPassword(tenant, 'nosuchuser', 's3cret-pw'));
    const info = await lookupToken(tenant, reg.access_token);
    assertEquals(info?.user_id, '@f1user:a.test');
    assertEquals(info?.device_id, reg.device_id);

    // logout one token, then all (tokens live on separate devices, as
    // separate logins do — revoking one device leaves the other standing)
    const t2 = await issueToken(tenant, 'f1user', 'f1user-second-device');
    await revokeToken(tenant, t2);
    assertEquals(await lookupToken(tenant, t2), null);
    assert((await lookupToken(tenant, reg.access_token)) !== null);
  });
});

// The revoke-all half of the lifecycle (kept separate: it registers its
// own user).
Deno.test('revokeAllTokens ends every token of the user', async () => {
  await withTenant(async (tenant) => {
    const reg = await registerUser(tenant, {
      localpart: 'f2user',
      password: 'pw',
    });
    assert((await lookupToken(tenant, reg.access_token!)) !== null);
    await revokeAllTokens(tenant, 'f2user');
    assertEquals(await lookupToken(tenant, reg.access_token!), null);
  });
});

Deno.test('profile: get/set display name and avatar, old/new values, verbatim mxc', async () => {
  await withTenant(async (tenant) => {
    assertEquals(await getProfile(tenant, 'ghost'), null);
    await registerUser(tenant, { localpart: 'prof', password: 'pw' });
    assertEquals(await getProfile(tenant, 'prof'), { displayname: 'prof' });
    const name = await setDisplayName(tenant, 'prof', 'Professor');
    assertEquals(name, { oldValue: 'prof', newValue: 'Professor' });
    const avatar = await setAvatarUrl(
      tenant,
      'prof',
      'mxc://foreign.server/aAbB123_-',
    );
    assertEquals(avatar.oldValue, null);
    assertEquals(await getProfile(tenant, 'prof'), {
      displayname: 'Professor',
      avatar_url: 'mxc://foreign.server/aAbB123_-',
    });
    // Clearing both omits the keys.
    await setDisplayName(tenant, 'prof', null);
    await setAvatarUrl(tenant, 'prof', null);
    assertEquals(await getProfile(tenant, 'prof'), {});
  });
});

Deno.test('devices: upsert, get owned/not-owned, list, rename, delete cascades tokens', async () => {
  await withTenant(async (tenant) => {
    const reg = await registerUser(tenant, {
      localpart: 'dev',
      password: 'pw',
      deviceId: 'dev-one',
      displayName: 'First',
    });
    assertEquals(await getDevice(tenant, 'dev', 'dev-one'), {
      device_id: 'dev-one',
      display_name: 'First',
    });
    assertEquals(await getDevice(tenant, 'other', 'dev-one'), null);
    // login honoring a device id keeps it; no display name keeps the old one
    await upsertDevice(tenant, 'dev', 'dev-two');
    await upsertDevice(tenant, 'dev', 'dev-two', 'Second');
    assertEquals(await listDevices(tenant, 'dev'), [
      { device_id: 'dev-one', display_name: 'First' },
      { device_id: 'dev-two', display_name: 'Second' },
    ]);
    assertEquals(
      await updateDeviceName(tenant, 'dev', 'dev-two', 'Renamed'),
      true,
    );
    assertEquals(await updateDeviceName(tenant, 'dev', 'dev-nine', 'X'), false);
    // deleting the device kills its tokens; the other device stands
    const t2 = await issueToken(tenant, 'dev', 'dev-two');
    assert((await lookupToken(tenant, t2)) !== null);
    await deleteDevices(tenant, 'dev', ['dev-two']);
    assertEquals(await lookupToken(tenant, t2), null);
    assertEquals(await getDevice(tenant, 'dev', 'dev-two'), null);
    assertEquals(await getDevice(tenant, 'dev', 'dev-one'), {
      device_id: 'dev-one',
      display_name: 'First',
    });
    // the registration token (dev-one) still works
    assert((await lookupToken(tenant, reg.access_token!)) !== null);
  });
});

Deno.test('changePassword: old password dies, keepToken survives, logoutDevices honored', async () => {
  await withTenant(async (tenant) => {
    const reg = await registerUser(tenant, {
      localpart: 'pwuser',
      password: 'old-pw',
      deviceId: 'pw-one',
    });
    const other = await issueToken(tenant, 'pwuser', 'pw-two');
    await changePassword(tenant, 'pwuser', 'new-pw', {
      keepToken: reg.access_token,
      logoutDevices: true,
    });
    assert(!await verifyUserPassword(tenant, 'pwuser', 'old-pw'));
    assert(await verifyUserPassword(tenant, 'pwuser', 'new-pw'));
    assert((await lookupToken(tenant, reg.access_token!)) !== null);
    assertEquals(await lookupToken(tenant, other), null);
    assertEquals(await getDevice(tenant, 'pwuser', 'pw-two'), null);
    assert((await getDevice(tenant, 'pwuser', 'pw-one')) !== null);
    // logoutDevices false keeps the other tokens and devices
    const third = await issueToken(tenant, 'pwuser', 'pw-three');
    await changePassword(tenant, 'pwuser', 'newer-pw', {
      logoutDevices: false,
    });
    assert((await lookupToken(tenant, third)) !== null);
    assert(await verifyUserPassword(tenant, 'pwuser', 'newer-pw'));
  });
});

Deno.test('deactivate: tokens and devices go, profile cleared, flag set', async () => {
  await withTenant(async (tenant) => {
    const reg = await registerUser(tenant, {
      localpart: 'goner',
      password: 'pw',
    });
    await setAvatarUrl(tenant, 'goner', 'mxc://a.test/xyz');
    assertEquals(await isDeactivated(tenant, 'goner'), false);
    await deactivateUser(tenant, 'goner');
    assertEquals(await isDeactivated(tenant, 'goner'), true);
    assertEquals(await lookupToken(tenant, reg.access_token!), null);
    assertEquals(await listDevices(tenant, 'goner'), []);
    assertEquals(await getProfile(tenant, 'goner'), {});
  });
});

Deno.test('a multi-table write rolls back together on throw', async () => {
  await withTenant(async (tenant) => {
    await assertRejects(
      () =>
        tenant.tx(async (tx) => {
          await tx.users.insert('rollback', 'Rollback');
          await tx.credentials.set('rollback', hashPassword('pw'));
          throw new Error('simulated failure');
        }),
      Error,
      'simulated failure',
    );
    assertEquals(await getProfile(tenant, 'rollback'), null);
    assert(!await verifyUserPassword(tenant, 'rollback', 'pw'));
  });
});

Deno.test('two tenants in one store are fully isolated', async () => {
  const dir = await Deno.makeTempDir();
  const store: Store = await openStore(config(dir), {
    schemas: { tenant: tenantSchema },
  });
  try {
    const a = await openTenant(store, 'a.test', { create: true });
    const b = await openTenant(store, 'b.test', { create: true });
    assert(a.publicB64 !== b.publicB64);
    assert(a.nativeName !== b.nativeName);
    const regA = await registerUser(a, { localpart: 'same', password: 'pw-a' });
    const regB = await registerUser(b, { localpart: 'same', password: 'pw-b' });
    assertEquals(regA.user_id, '@same:a.test');
    assertEquals(regB.user_id, '@same:b.test');
    assertEquals(await lookupToken(b, regA.access_token!), null);
    assertEquals(await lookupToken(a, regB.access_token!), null);
    assert(await verifyUserPassword(a, 'same', 'pw-a'));
    assert(!await verifyUserPassword(a, 'same', 'pw-b'));
    assert(await verifyUserPassword(b, 'same', 'pw-b'));
    await setDisplayName(a, 'same', 'Only A');
    assertEquals(await getProfile(b, 'same'), { displayname: 'same' });
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
