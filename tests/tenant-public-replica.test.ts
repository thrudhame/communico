import { assert, assertEquals, assertRejects } from '@std/assert';
import { canonicalJson } from '#engine/canonical.ts';
import { config } from '#engine/config.ts';
import { signingUpload } from '#engine/e2ee-signing.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { registerUser } from '#engine/tenant/users.ts';
import { validateUpload } from '#engine/tenant/e2ee.ts';
import { deviceIdentity } from '#engine/tenant/txns.ts';
import {
  b64encodeStd,
  exportPublicKeyRaw,
  generateSigningKeypair,
  signJson,
} from '#engine/signing-primitives.js';

async function fixture() {
  const dir = await Deno.makeTempDir({ prefix: 'public-user-replica-' });
  const open = (side: string) =>
    openStore({
      dir: dir + '/' + side,
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 300,
    }, { schemas: { tenant: tenantSchema } });
  const homeStore = await open('home');
  let edgeStore = await open('edge');
  const home = await openTenant(homeStore, 'logical.test', { create: true });
  let edge = await openTenant(edgeStore, 'logical.test', { create: true });
  const ownKey = edge.publicB64;
  const user = '@alice:logical.test';
  await registerUser(home, {
    localpart: 'alice',
    password: 'home-only-password',
    deviceId: 'PHONE',
  });
  await home.tx(async (tx) => {
    await tx.profiles.set('alice', 'displayname', 'Alice');
    await tx.profiles.set('alice', 'example.public', { hello: 'world' });
  });
  const device = await deviceIdentity(home, 'alice', 'PHONE');
  await home.tx((tx) =>
    tx.e2ee.upload(
      device,
      validateUpload(
        {
          device_keys: {
            user_id: user,
            device_id: 'PHONE',
            algorithms: [],
            keys: {},
            signatures: {},
          },
          one_time_keys: { 'curve25519:once': 'private-pool' },
          fallback_keys: { 'curve25519:fallback': 'private-fallback' },
        },
        user,
        'PHONE',
        config().e2ee,
      ),
    )
  );
  const pair = await generateSigningKeypair() as CryptoKeyPair;
  const pub = b64encodeStd(await exportPublicKeyRaw(pair.publicKey));
  const master = {
    user_id: user,
    usage: ['master'],
    keys: { ['ed25519:' + pub]: pub },
  };
  const secretPair = await generateSigningKeypair() as CryptoKeyPair;
  const secret = b64encodeStd(await exportPublicKeyRaw(secretPair.publicKey));
  const privateKey = {
    user_id: user,
    usage: ['user_signing'],
    keys: { ['ed25519:' + secret]: secret },
  };
  await signJson(privateKey, user, 'ed25519:' + pub, pair.privateKey);
  await home.tx((tx) =>
    tx.crossSigning.upload(
      'alice',
      user,
      signingUpload(
        { master_key: master, user_signing_key: privateKey },
        user,
        config().e2ee,
      ),
      '{}',
      false,
    )
  );
  return {
    home,
    user,
    secret,
    edge: () => edge,
    db: () => edgeStore.tenant('logical.test'),
    export: () =>
      home.tx((tx) => tx.publicReplica.export('alice', home.serverName)),
    install: (raw: unknown) =>
      edge.tx((tx) => tx.publicReplica.install(raw, edge.serverName)),
    async reopen() {
      await edgeStore.close();
      edgeStore = await open('edge');
      edge = await openTenant(edgeStore, 'logical.test');
      assertEquals(edge.publicB64, ownKey);
    },
    async close() {
      await homeStore.close();
      await edgeStore.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test('public user replica preserves coherent ordinary profile/device/signing reads without credentials, pools or private signing', async () => {
  const f = await fixture();
  try {
    const view = await f.export();
    const encoded = canonicalJson(view);
    assert(!encoded.includes(f.secret));
    assert(!encoded.includes('private-pool'));
    assert(!encoded.includes('private-fallback'));
    await f.install(view);
    await f.install(view);
    await f.reopen();
    const read = (tenant: typeof f.home) =>
      tenant.tx(async (tx) => ({
        profile: await tx.profiles.get('alice'),
        devices: await tx.e2ee.snapshot('alice', f.user, config().e2ee),
        keys: await tx.e2ee.query(
          'alice',
          [],
          '',
          f.user,
          config().e2ee.maxkeys,
        ),
        signing: await tx.crossSigning.views('alice', f.user, ''),
      }));
    assertEquals(await read(f.edge()), await read(f.home));
    for (
      const table of [
        'credentials',
        'devices',
        'access_tokens',
        'refresh_tokens',
        'one_time_keys',
        'fallback_keys',
        'cross_signing_keys',
        'to_device_inbox',
      ]
    ) {
      assertEquals(await (await f.db()).query('SELECT * FROM ' + table), []);
    }
    assertEquals(
      await f.edge().tx((tx) => tx.e2ee.claim('alice', 'PHONE', 'curve25519')),
      null,
    );
    assertEquals(
      await f.edge().tx((tx) =>
        tx.e2ee.query('alice', ['ABSENT'], '', f.user, config().e2ee.maxkeys)
      ),
      {},
    );
    await f.home.tx(async (tx) => {
      await tx.devices.rename('PHONE', 'alice', 'Renamed phone');
      await tx.profiles.set('alice', 'example.public', undefined);
      await tx.erasure.mark('alice', {
        '!room:logical.test': { changePos: 8, segment: 1, group: 2 },
      });
    });
    const next = await f.export();
    assert(next.cut > view.cut);
    await f.install(next);
    assertEquals(await read(f.edge()), await read(f.home));
    assertEquals(
      await f.edge().tx((tx) => tx.erasure.get('alice', '!room:logical.test')),
      { changePos: 8, segment: 1, group: 2 },
    );
    await assertRejects(() => f.install(view), MatrixError, 'regressing');
    await assertRejects(
      () =>
        f.install({ ...next, profile: { displayname: 'changed same cut' } }),
      MatrixError,
      'changed',
    );
    await assertRejects(
      () =>
        f.install({
          ...next,
          cut: next.cut + 1,
          signing: { user_signing_keys: {} },
        }),
      MatrixError,
      'invalid public device',
    );
    await assertRejects(
      () => f.install({ ...next, userId: '@alice:foreign.test' }),
      MatrixError,
      'identity',
    );
    await assertRejects(
      () =>
        f.edge().tx((tx) =>
          tx.publicReplica.export('alice', f.edge().serverName)
        ),
      MatrixError,
      'export authority',
    );
  } finally {
    await f.close();
  }
});

Deno.test('public profile and privacy mutations retain export intent and v20 upgrade permits only independent public users', async () => {
  const f = await fixture();
  try {
    let previous = (await f.export()).cut;
    for (
      const mutate of [
        () => f.home.tx((tx) => tx.users.setDisplayName('alice', 'New Alice')),
        () =>
          f.home.tx((tx) =>
            tx.users.setAvatarUrl('alice', 'mxc://logical.test/avatar')
          ),
        () => f.home.tx((tx) => tx.profiles.clear('alice')),
        () => f.home.tx((tx) => tx.users.markDeactivated('alice')),
      ]
    ) {
      await mutate();
      const next = await f.export();
      assert(next.cut > previous);
      previous = next.cut;
    }
    await (await f.db()).tx(async (conn) => {
      await conn.exec('DROP TABLE public_user_replicas');
      await conn.execute("UPDATE meta SET v='20' WHERE k='schema_version'");
    }, { mode: 'deferred' });
    await f.reopen();
    const view = await f.export();
    await f.install(view);
    assertEquals(
      (await f.edge().tx((tx) => tx.users.byLocalpart('alice')))?.deactivated,
      true,
    );
    await f.edge().tx((tx) => tx.users.insert('owned', 'Owned account'));
    await assertRejects(
      () =>
        f.install({
          ...view,
          userId: '@owned:logical.test',
          devices: {
            ...view.devices,
            user_id: '@owned:logical.test',
            devices: [],
          },
          signing: {},
        }),
      MatrixError,
      'owned account',
    );
  } finally {
    await f.close();
  }
});
