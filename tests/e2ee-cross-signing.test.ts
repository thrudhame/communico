import { assert, assertEquals, assertRejects } from '@std/assert';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { projectTenant } from '#engine/server/project-tenant.ts';
import { reconcileDeviceRoom } from '#engine/server/e2ee.ts';
import { canonicalJson } from '#engine/canonical.ts';
import { type SigningUpload, signingUpload } from '#engine/e2ee-signing.ts';
import { config } from '#engine/config.ts';
import {
  b64encodeStd,
  exportPublicKeyRaw,
  generateSigningKeypair,
  signJson,
} from '#engine/signing-primitives.js';

async function masterFor(user: string): Promise<SigningUpload> {
  const pair = await generateSigningKeypair() as CryptoKeyPair;
  const pub = b64encodeStd(await exportPublicKeyRaw(pair.publicKey));
  return signingUpload(
    {
      master_key: {
        user_id: user,
        usage: ['master'],
        keys: { ['ed25519:' + pub]: pub },
      },
    },
    user,
    config().e2ee,
  );
}
const options = (dir: string) => ({
  dir,
  library: './.native/libturso_ffi.so',
  checkpointlogbytes: 65536,
  maxopenfiles: 8,
  idleseconds: 300,
});

Deno.test('cross-signing: concurrent first upload and stale UIA cannot replace newer keys', async () => {
  const dir = await Deno.makeTempDir();
  const store = await openStore(options(dir), {
    schemas: { tenant: tenantSchema },
  });
  try {
    const tenant = await openTenant(store, 'a.test', { create: true });
    await tenant.tx((tx) => tx.users.insert('a', 'A'));
    const first = await masterFor('@a:a.test'),
      second = await masterFor('@a:a.test'),
      third = await masterFor('@a:a.test');
    await tenant.tx((tx) =>
      tx.crossSigning.upload('a', '@a:a.test', first, '{}', false)
    );
    await assertRejects(() =>
      tenant.tx((tx) =>
        tx.crossSigning.upload('a', '@a:a.test', second, '{}', false)
      )
    );
    const oldBasis = canonicalJson(
      await tenant.tx((tx) => tx.crossSigning.state('a')),
    );
    await tenant.tx((tx) =>
      tx.crossSigning.upload('a', '@a:a.test', second, oldBasis, true)
    );
    await assertRejects(() =>
      tenant.tx((tx) =>
        tx.crossSigning.upload('a', '@a:a.test', third, oldBasis, true)
      )
    );
    assertEquals(await tenant.tx((tx) => tx.crossSigning.state('a')), second);
    const db = await store.tenant('a.test');
    const changes = await db.query('SELECT * FROM e2ee_changes');
    await tenant.tx((tx) =>
      tx.crossSigning.upload('a', '@a:a.test', second, '{}', false)
    );
    assertEquals(await db.query('SELECT * FROM e2ee_changes'), changes);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('cross-signing: v9 upgrade, restart and owner-only change replay preserve privacy', async () => {
  const dir = await Deno.makeTempDir();
  const previous = {
    version: 9,
    apply: async (db: Parameters<typeof tenantSchema.apply>[0]) => {
      await tenantSchema.apply(db);
      await db.exec(
        'DROP TABLE backup_sessions; DROP TABLE backup_versions; DROP TABLE key_signatures; DROP TABLE cross_signing_keys',
      );
    },
  };
  let store = await openStore(options(dir), {
    schemas: { tenant: previous, server: serverSchema },
  });
  try {
    let tenant = await openTenant(store, 'a.test', { create: true });
    const publicB64 = tenant.publicB64;
    await tenant.tx((tx) => tx.users.insert('a', 'A'));
    await store.close();
    store = await openStore(options(dir), {
      schemas: { tenant: tenantSchema, server: serverSchema },
    });
    tenant = await openTenant(store, 'a.test');
    assertEquals(tenant.publicB64, publicB64);
    const masterPair = await generateSigningKeypair() as CryptoKeyPair;
    const pub = b64encodeStd(await exportPublicKeyRaw(masterPair.publicKey)),
      id = 'ed25519:' + pub;
    const first = signingUpload(
      {
        master_key: {
          user_id: '@a:a.test',
          usage: ['master'],
          keys: { [id]: pub },
        },
      },
      '@a:a.test',
      config().e2ee,
    );
    await tenant.tx((tx) =>
      tx.crossSigning.upload('a', '@a:a.test', first, '{}', false)
    );
    await projectTenant(store, 'a.test');
    const server = await store.server();
    // A real historical peer relation permits public notices, never private ones.
    await server.tx((tx) =>
      reconcileDeviceRoom(
        tx,
        '!private:a.test',
        ['@peer:remote.test', '@a:a.test'],
        false,
        null,
        1,
        ['a.test'],
      )
    );
    const before = await server.query('SELECT * FROM device_notices');
    const beforeDelivery = await server.query('SELECT * FROM edu_outbox');
    const secretPair = await generateSigningKeypair() as CryptoKeyPair;
    const secret = b64encodeStd(await exportPublicKeyRaw(secretPair.publicKey));
    const secretJson = {
      user_id: '@a:a.test',
      usage: ['user_signing'],
      keys: { ['ed25519:' + secret]: secret },
    };
    await signJson(secretJson, '@a:a.test', id, masterPair.privateKey);
    const privateUpload = signingUpload(
      { user_signing_key: secretJson },
      '@a:a.test',
      config().e2ee,
    );
    await tenant.tx((tx) =>
      tx.crossSigning.upload(
        'a',
        '@a:a.test',
        privateUpload,
        canonicalJson(first),
        true,
      )
    );
    const expected = await tenant.tx((tx) => tx.crossSigning.state('a'));
    await store.close();
    store = await openStore(options(dir), {
      schemas: { tenant: tenantSchema, server: serverSchema },
    });
    tenant = await openTenant(store, 'a.test');
    await projectTenant(store, 'a.test');
    const reopened = await store.server();
    const notices = await reopened.query('SELECT * FROM device_notices');
    assertEquals(notices.length, before.length + 2);
    assert(
      notices.slice(before.length).every((n) => n.observer === '@a:a.test'),
    );
    assert(
      !JSON.stringify(await reopened.query('SELECT * FROM device_changes'))
        .includes(secret),
    );
    assertEquals(await tenant.tx((tx) => tx.crossSigning.state('a')), expected);
    assertEquals(
      await reopened.query('SELECT * FROM edu_outbox'),
      beforeDelivery,
    );
    assert(
      !JSON.stringify(await reopened.query('SELECT * FROM public_signing_keys'))
        .includes(secret),
    );
    await projectTenant(store, 'a.test');
    assertEquals(await reopened.query('SELECT * FROM device_notices'), notices);
    assertEquals(
      (await (await store.tenant('a.test')).query(
        "SELECT v FROM meta WHERE k='schema_version'",
      ))[0].v,
      '12',
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
