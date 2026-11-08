import { assertEquals } from '@std/assert';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { config } from '#engine/config.ts';
import { signingUpload } from '#engine/e2ee-signing.ts';
import { canonicalJson } from '#engine/canonical.ts';
import { validateUpload } from '#engine/tenant/e2ee.ts';
import type { Json } from '#engine/tenant/e2ee.ts';
import {
  b64encodeStd,
  exportPublicKeyRaw,
  generateSigningKeypair,
  signJson,
} from '#engine/signing-primitives.js';

Deno.test('signature overlays: real v10 upgrade and reopen retain verified public material', async () => {
  const dir = await Deno.makeTempDir();
  const options = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  let store = await openStore(options, {
    schemas: {
      tenant: {
        version: 10,
        apply: async (db) => {
          await tenantSchema.apply(db);
          await db.exec(
            'DROP TABLE backup_sessions; DROP TABLE backup_versions; DROP TABLE key_signatures',
          );
        },
      },
    },
  });
  const user = '@alice:a.test';
  const pair = await generateSigningKeypair() as CryptoKeyPair;
  const pub = b64encodeStd(await exportPublicKeyRaw(pair.publicKey));
  const master = {
    user_id: user,
    usage: ['master'],
    keys: { ['ed25519:' + pub]: pub },
  };
  try {
    let tenant = await openTenant(store, 'a.test', { create: true });
    await tenant.tx((tx) => tx.users.insert('alice', 'Alice'));
    const db = await store.tenant('a.test');
    await db.tx((conn) =>
      conn.execute('INSERT INTO cross_signing_keys VALUES(?,?,?,?,?)', [
        'alice',
        'master',
        'ed25519:' + pub,
        canonicalJson(master),
        1,
      ])
    );
    const identity = tenant.publicB64;
    await store.close();
    store = await openStore(options, { schemas: { tenant: tenantSchema } });
    tenant = await openTenant(store, 'a.test');
    assertEquals(tenant.publicB64, identity);
    const devicePair = await generateSigningKeypair() as CryptoKeyPair;
    const devicePub = b64encodeStd(
      await exportPublicKeyRaw(devicePair.publicKey),
    );
    await tenant.tx((tx) => tx.devices.upsert('D', 'alice', null));
    const current = await tenant.tx((tx) => tx.devices.byId('D', 'alice'));
    await tenant.tx((tx) =>
      tx.e2ee.upload(
        { localpart: 'alice', deviceId: 'D', generation: current!.generation },
        validateUpload(
          {
            device_keys: {
              user_id: user,
              device_id: 'D',
              keys: { 'ed25519:D': devicePub },
              algorithms: [],
              signatures: {},
            },
          },
          user,
          'D',
          config().e2ee,
        ),
      )
    );
    const signed = structuredClone(master);
    await signJson(signed, user, 'ed25519:D', devicePair.privateKey);
    assertEquals(
      await tenant.tx((tx) =>
        tx.keySignatures.upload('alice', user, [{
          user,
          id: pub,
          json: signed,
        }])
      ),
      { failures: {} },
    );
    const expected = await tenant.tx((tx) =>
      tx.crossSigning.views('alice', user, '')
    );
    await store.close();
    store = await openStore(options, { schemas: { tenant: tenantSchema } });
    tenant = await openTenant(store, 'a.test');
    assertEquals(
      await tenant.tx((tx) => tx.crossSigning.views('alice', user, '')),
      expected,
    );
    assertEquals(
      await tenant.tx((tx) => tx.crossSigning.state('alice')),
      signingUpload({ master_key: master }, user, config().e2ee),
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('remote private overlays survive reopen and remain bound to the learned target revision', async () => {
  const dir = await Deno.makeTempDir();
  const options = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  let store = await openStore(options, { schemas: { tenant: tenantSchema } });
  const user = '@alice:a.test', remote = '@bob:b.test';
  const make = async (owner: string, usage: string) => {
    const pair = await generateSigningKeypair() as CryptoKeyPair;
    const pub = b64encodeStd(await exportPublicKeyRaw(pair.publicKey));
    return {
      pair,
      pub,
      json: {
        user_id: owner,
        usage: [usage],
        keys: { ['ed25519:' + pub]: pub },
      } as Json,
    };
  };
  try {
    let tenant = await openTenant(store, 'a.test', { create: true });
    await tenant.tx((tx) => tx.users.insert('alice', 'Alice'));
    const master = await make(user, 'master'),
      secret = await make(user, 'user_signing');
    await signJson(
      secret.json,
      user,
      'ed25519:' + master.pub,
      master.pair.privateKey,
    );
    await tenant.tx((tx) =>
      tx.crossSigning.upload(
        'alice',
        user,
        signingUpload(
          { master_key: master.json, user_signing_key: secret.json },
          user,
          config().e2ee,
        ),
        '{}',
        false,
      )
    );
    const target = await make(remote, 'master');
    const signed = structuredClone(target.json);
    await signJson(
      signed,
      user,
      'ed25519:' + secret.pub,
      secret.pair.privateKey,
    );
    const signers = await tenant.tx((tx) => tx.keySignatures.basis('alice'));
    const upload = [{
      user: remote,
      id: target.pub,
      json: signed,
      remote: { json: target.json, revision: 7, signers },
    }];
    assertEquals(
      await tenant.tx((tx) => tx.keySignatures.upload('alice', user, upload)),
      { failures: {} },
    );
    const db = await store.tenant('a.test');
    const log = await db.query('SELECT * FROM e2ee_changes');
    assertEquals(
      await tenant.tx((tx) => tx.keySignatures.upload('alice', user, upload)),
      { failures: {} },
    );
    assertEquals(await db.query('SELECT * FROM e2ee_changes'), log);
    await store.close();
    store = await openStore(options, { schemas: { tenant: tenantSchema } });
    tenant = await openTenant(store, 'a.test');
    assertEquals(
      await tenant.tx((tx) =>
        tx.keySignatures.remoteView(target.json, remote, target.pub, user, 7)
      ),
      signed,
    );
    for (
      const [requester, revision] of [[user, 8], ['@charlie:a.test', 7], [
        '',
        7,
      ]] as [string, number][]
    ) {
      assertEquals(
        (await tenant.tx((tx) =>
          tx.keySignatures.remoteView(
            target.json,
            remote,
            target.pub,
            requester,
            revision,
          )
        )).signatures,
        {},
      );
    }
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
