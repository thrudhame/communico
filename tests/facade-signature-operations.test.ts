import { assert, assertEquals, assertRejects } from '@std/assert';
import { createHash } from 'node:crypto';
import { canonicalJson } from '#engine/canonical.ts';
import { config } from '#engine/config.ts';
import { signingUpload } from '#engine/e2ee-signing.ts';
import {
  b64encodeStd,
  exportPublicKeyRaw,
  generateSigningKeypair,
  signJson,
} from '#engine/signing-primitives.js';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { activateTenantAuthority } from '#engine/tenant/session-authority.ts';
import { upsertDevice } from '#engine/tenant/devices.ts';
import { deviceIdentity } from '#engine/tenant/txns.ts';
import { validateUpload } from '#engine/tenant/e2ee.ts';
import {
  captureSessionAuthority,
  installSessionAuthority,
} from '#engine/tenant/session-authority.ts';
import { deleteDevices } from '#engine/tenant/devices.ts';
import { captureDeviceOperations } from '#engine/tenant/device-source.ts';
import {
  importDeviceOperation,
  publicDeviceKeys,
} from '#engine/tenant/device-operations.ts';
import { ownerSigningViews } from '#engine/tenant/cross-signing.ts';
import {
  captureSigningOperations,
  importSigningOperation,
} from '#engine/tenant/signing-operations.ts';
import {
  captureSignatureOperations,
  importSignatureOperation,
  type SignatureOperation,
} from '#engine/tenant/signature-operations.ts';
import { historicalTenantSchema } from '#tests/fixtures/tenant-schema-history.ts';
import { signatureView } from '#engine/tenant/signature-view.ts';

const user = '@alice:logical.test';

Deno.test('F2 signature upload commits portable exact signer and target intent with the verified overlay', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'facade-signature-owner-' });
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { tenant: tenantSchema } });
  try {
    const tenant = await openTenant(store, 'logical.test', { create: true });
    const db = await store.tenant('logical.test');
    await tenant.tx((tx) => tx.users.insert('alice', 'Alice'));
    await db.tx((conn) =>
      activateTenantAuthority(conn, {
        node: 'home',
        incarnation: 'home-store',
        homeIncarnation: 'home-store',
        edgeNode: 'edge',
        edgeIncarnation: 'edge-store',
      })
    );
    await upsertDevice(tenant, 'alice', 'LAN');
    const device = await deviceIdentity(tenant, 'alice', 'LAN');
    const pair = await generateSigningKeypair() as CryptoKeyPair;
    const pub = b64encodeStd(await exportPublicKeyRaw(pair.publicKey));
    await tenant.tx((tx) =>
      tx.e2ee.upload(
        device,
        validateUpload(
          {
            device_keys: {
              user_id: user,
              device_id: 'LAN',
              algorithms: [],
              keys: { 'ed25519:LAN': pub },
              signatures: {},
            },
          },
          user,
          'LAN',
          config().e2ee,
        ),
      )
    );
    const masterPair = await generateSigningKeypair() as CryptoKeyPair;
    const masterPub = b64encodeStd(
      await exportPublicKeyRaw(masterPair.publicKey),
    );
    const master = {
      user_id: user,
      usage: ['master'],
      keys: { ['ed25519:' + masterPub]: masterPub },
    };
    await tenant.tx((tx) =>
      tx.crossSigning.upload(
        'alice',
        user,
        signingUpload({ master_key: master }, user, config().e2ee),
        '{}',
        false,
      )
    );
    const signed = structuredClone(master);
    await signJson(signed, user, 'ed25519:LAN', pair.privateKey);
    assertEquals(
      await tenant.tx((tx) =>
        tx.keySignatures.upload('alice', user, [{
          user,
          id: masterPub,
          json: signed,
        }])
      ),
      { failures: {} },
    );
    const payload = JSON.parse(
      String(
        (await db.query(
          'SELECT payload FROM e2ee_changes ORDER BY pos DESC LIMIT 1',
        ))[0].payload,
      ),
    );
    assert(
      payload.signatureOperation,
      'verified overlay must commit portable semantic export intent',
    );
    assertEquals(payload.signatureOperation.source, 'home');
    assertEquals(payload.signatureOperation.incarnation, 'home-store');
    assertEquals(payload.signatureOperation.localpart, 'alice');
    assertEquals(payload.signatureOperation.target.user, user);
    assertEquals(payload.signatureOperation.target.id, masterPub);
    assertEquals(
      canonicalJson(payload.signatureOperation).includes('privateKey'),
      false,
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

async function makeFixture(node: 'home' | 'edge') {
  const dir = await Deno.makeTempDir({ prefix: 'portable-signature-' });
  const options = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  let store = await openStore(options, { schemas: { tenant: tenantSchema } });
  let tenant = await openTenant(store, 'logical.test', { create: true });
  await tenant.tx((tx) => tx.users.insert('alice', 'Alice'));
  let db = await store.tenant('logical.test');
  await db.tx((conn) =>
    activateTenantAuthority(conn, {
      node,
      incarnation: node + '-store',
      homeIncarnation: 'home-store',
      edgeNode: 'edge',
      edgeIncarnation: 'edge-store',
    })
  );
  return {
    get db() {
      return db;
    },
    get tenant() {
      return tenant;
    },
    async reopen() {
      await store.close();
      store = await openStore(options, { schemas: { tenant: tenantSchema } });
      tenant = await openTenant(store, 'logical.test');
      db = await store.tenant('logical.test');
    },
    async close() {
      await store.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}
async function key(usage: string, owner = user) {
  const pair = await generateSigningKeypair() as CryptoKeyPair;
  const pub = b64encodeStd(await exportPublicKeyRaw(pair.publicKey));
  return {
    pair,
    pub,
    json: { user_id: owner, usage: [usage], keys: { ['ed25519:' + pub]: pub } },
  };
}
const expected = {
  source: 'home',
  incarnation: 'home-store',
  localpart: 'alice',
};

Deno.test('F2 foreign-owner device signatures publish overlays without acquiring device ownership', async () => {
  const home = await makeFixture('home'), edge = await makeFixture('edge');
  try {
    const devicePair = await generateSigningKeypair() as CryptoKeyPair;
    const devicePub = b64encodeStd(
      await exportPublicKeyRaw(devicePair.publicKey),
    );
    const deviceJson = {
      user_id: user,
      device_id: 'LAN',
      algorithms: [],
      keys: { 'ed25519:LAN': devicePub },
      signatures: {},
    };
    await upsertDevice(home.tenant, 'alice', 'LAN');
    const initial = await deviceIdentity(home.tenant, 'alice', 'LAN');
    await home.tenant.tx((tx) =>
      tx.e2ee.upload(
        initial,
        validateUpload({ device_keys: deviceJson }, user, 'LAN', config().e2ee),
      )
    );
    const master = await key('master'), self = await key('self_signing');
    await signJson(
      self.json,
      user,
      'ed25519:' + master.pub,
      master.pair.privateKey,
    );
    await home.tenant.tx((tx) =>
      tx.crossSigning.upload(
        'alice',
        user,
        signingUpload(
          { master_key: master.json, self_signing_key: self.json },
          user,
          config().e2ee,
        ),
        '{}',
        false,
      )
    );
    const transfer = async () => {
      const facts = await home.db.tx((conn) =>
        captureSessionAuthority(conn, 'alice')
      );
      await edge.db.tx((conn) => installSessionAuthority(conn, 'alice', facts));
      for (
        const op of await home.db.tx((conn) =>
          captureDeviceOperations(conn, 'alice')
        )
      ) await edge.db.tx((conn) => importDeviceOperation(conn, op, expected));
      for (
        const op of await home.db.tx((conn) =>
          captureSigningOperations(conn, 'alice')
        )
      ) await edge.db.tx((conn) => importSigningOperation(conn, op, expected));
    };
    await transfer();
    const signed = structuredClone(deviceJson);
    await signJson(signed, user, 'ed25519:' + self.pub, self.pair.privateKey);
    const beforeRollback = await edge.db.query('SELECT * FROM e2ee_changes');
    await assertRejects(
      () =>
        edge.tenant.tx(async (tx) => {
          assertEquals(
            await tx.keySignatures.upload('alice', user, [{
              user,
              id: 'LAN',
              json: signed,
            }]),
            { failures: {} },
          );
          throw new Error('injected foreign publication rollback');
        }),
      Error,
      'injected foreign publication rollback',
    );
    for (const table of ['key_signatures', 'signature_operations']) {
      assertEquals(await edge.db.query('SELECT * FROM ' + table), []);
    }
    assertEquals(
      await edge.db.query('SELECT * FROM e2ee_changes'),
      beforeRollback,
    );
    assertEquals(
      await edge.tenant.tx((tx) =>
        tx.keySignatures.upload('alice', user, [{
          user,
          id: 'LAN',
          json: signed,
        }])
      ),
      { failures: {} },
    );
    const [overlay] = await edge.db.tx((conn) =>
      captureSignatureOperations(conn, 'alice')
    );
    assert(overlay);
    assertEquals(overlay.source, 'edge');
    const [news] = await edge.db.query(
      'SELECT * FROM e2ee_changes ORDER BY pos DESC LIMIT 1',
    );
    const payload = JSON.parse(String(news.payload));
    assertEquals(
      payload.operation,
      undefined,
      'a signature is not foreign base-device authorship',
    );
    assertEquals(payload.signatureOperation, overlay);
    assertEquals(
      payload.keys.signatures[user]['ed25519:' + self.pub],
      (signed.signatures as Record<string, Record<string, string>>)[user][
        'ed25519:' + self.pub
      ],
    );
    assertEquals(
      await edge.db.tx((conn) => captureDeviceOperations(conn, 'alice')),
      [],
    );
    for (
      const table of [
        'devices',
        'device_keys',
        'one_time_keys',
        'fallback_keys',
      ]
    ) assertEquals(await edge.db.query('SELECT * FROM ' + table), []);
    // Direct owner facts are deliberately not an enrolled public baseline.
    await assertRejects(
      () =>
        edge.tenant.tx((tx) =>
          tx.e2ee.query('alice', ['LAN'], user, user, config().e2ee.maxkeys)
        ),
      Error,
      'key bootstrap unavailable',
    );
    const query = () =>
      edge.db.tx(async (conn) => {
        const result: Record<string, Record<string, unknown>> = {};
        for (const row of (await publicDeviceKeys(conn, 'alice'))!) {
          if (row.device_id !== 'LAN') continue;
          const keys = await signatureView(
            conn,
            JSON.parse(row.key_json),
            user,
            row.device_id,
            user,
          );
          result[row.device_id] = { ...keys, unsigned: {} };
        }
        return result;
      });
    const expectedView = { ...payload.keys, unsigned: {} };
    assertEquals((await query()).LAN, expectedView);
    const beforeRetry = await edge.db.query('SELECT * FROM e2ee_changes');
    assertEquals(
      await edge.tenant.tx((tx) =>
        tx.keySignatures.upload('alice', user, [{
          user,
          id: 'LAN',
          json: signed,
        }])
      ),
      { failures: {} },
    );
    const invalidSignature = structuredClone(signed) as Record<string, unknown>;
    invalidSignature.signatures = {
      [user]: { ['ed25519:' + self.pub]: 'A'.repeat(86) },
    };
    const refused = await edge.tenant.tx((tx) =>
      tx.keySignatures.upload('alice', user, [{
        user,
        id: 'LAN',
        json: invalidSignature,
      }])
    );
    assert((refused.failures as Record<string, unknown>)[user]);
    assertEquals(
      await edge.db.query('SELECT * FROM e2ee_changes'),
      beforeRetry,
    );
    await home.db.tx((conn) =>
      importSignatureOperation(conn, overlay, {
        source: 'edge',
        incarnation: 'edge-store',
        localpart: 'alice',
      })
    );
    assertEquals(
      await home.tenant.tx((tx) =>
        tx.e2ee.query('alice', ['LAN'], user, user, config().e2ee.maxkeys)
      ),
      await query(),
    );
    await edge.reopen();
    assertEquals((await query()).LAN, expectedView);
    // An immutable old overlay cannot attach to a replacement incarnation even
    // if the owner deliberately uploads the same public key material again.
    await deleteDevices(home.tenant, 'alice', ['LAN']);
    await upsertDevice(home.tenant, 'alice', 'LAN');
    const replacement = await deviceIdentity(home.tenant, 'alice', 'LAN');
    await home.tenant.tx((tx) =>
      tx.e2ee.upload(
        replacement,
        validateUpload({ device_keys: deviceJson }, user, 'LAN', config().e2ee),
      )
    );
    await transfer();
    assertEquals(
      ((await query()).LAN as Record<string, unknown>).signatures,
      {},
    );
  } finally {
    await home.close();
    await edge.close();
  }
});
async function setup() {
  const home = await makeFixture('home'), edge = await makeFixture('edge');
  await upsertDevice(home.tenant, 'alice', 'LAN');
  await deleteDevices(home.tenant, 'alice', ['LAN']);
  await upsertDevice(home.tenant, 'alice', 'LAN');
  const device = await deviceIdentity(home.tenant, 'alice', 'LAN');
  const pair = await generateSigningKeypair() as CryptoKeyPair;
  const pub = b64encodeStd(await exportPublicKeyRaw(pair.publicKey));
  await home.tenant.tx((tx) =>
    tx.e2ee.upload(
      device,
      validateUpload(
        {
          device_keys: {
            user_id: user,
            device_id: 'LAN',
            algorithms: [],
            keys: { 'ed25519:LAN': pub },
            signatures: {},
          },
        },
        user,
        'LAN',
        config().e2ee,
      ),
    )
  );
  const master = await key('master');
  await home.tenant.tx((tx) =>
    tx.crossSigning.upload(
      'alice',
      user,
      signingUpload({ master_key: master.json }, user, config().e2ee),
      '{}',
      false,
    )
  );
  const signed = structuredClone(master.json);
  await signJson(signed, user, 'ed25519:LAN', pair.privateKey);
  assertEquals(
    await home.tenant.tx((tx) =>
      tx.keySignatures.upload('alice', user, [{
        user,
        id: master.pub,
        json: signed,
      }])
    ),
    { failures: {} },
  );
  const [operation] = await home.db.tx((conn) =>
    captureSignatureOperations(conn, 'alice')
  );
  const dependencies = async () => {
    const facts = await home.db.tx((conn) =>
      captureSessionAuthority(conn, 'alice')
    );
    await edge.db.tx((conn) => installSessionAuthority(conn, 'alice', facts));
    for (
      const operation of await home.db.tx((conn) =>
        captureDeviceOperations(conn, 'alice')
      )
    ) {
      await edge.db.tx((conn) =>
        importDeviceOperation(conn, operation, expected)
      );
    }
    for (
      const operation of await home.db.tx((conn) =>
        captureSigningOperations(conn, 'alice')
      )
    ) {
      await edge.db.tx((conn) =>
        importSigningOperation(conn, operation, expected)
      );
    }
  };
  return {
    home,
    edge,
    pair,
    master,
    signed,
    operation,
    dependencies,
    async close() {
      await home.close();
      await edge.close();
    },
  };
}

Deno.test('F2 portable signature facts survive dependency reordering, duplicates and reopen without copying a signer device generation', async () => {
  const f = await setup();
  try {
    await f.edge.db.tx((conn) =>
      importSignatureOperation(conn, f.operation, expected)
    );
    assertEquals(
      await f.edge.db.tx((conn) => ownerSigningViews(conn, 'alice', user, '')),
      {},
    );
    await f.dependencies();
    assertEquals(await f.edge.db.query('SELECT * FROM devices'), []);
    assertEquals(
      (await deviceIdentity(f.home.tenant, 'alice', 'LAN')).generation,
      2,
    );
    const view = await f.edge.db.tx((conn) =>
      ownerSigningViews(conn, 'alice', user, '')
    );
    assertEquals(view.master_keys, f.signed);
    const changes = await f.edge.db.query('SELECT * FROM e2ee_changes');
    await f.edge.db.tx((conn) =>
      importSignatureOperation(conn, f.operation, expected)
    );
    assertEquals(await f.edge.db.query('SELECT * FROM e2ee_changes'), changes);
    assertEquals(
      await f.edge.db.tx((conn) => captureSignatureOperations(conn, 'alice')),
      [],
    );
    await f.edge.reopen();
    assertEquals(
      await f.edge.db.tx((conn) => ownerSigningViews(conn, 'alice', user, '')),
      view,
    );
  } finally {
    await f.close();
  }
});

Deno.test('F2 portable signatures cannot survive a signer incarnation deletion/recreation or a home target replacement', async () => {
  const f = await setup();
  try {
    await f.dependencies();
    await f.edge.db.tx((conn) =>
      importSignatureOperation(conn, f.operation, expected)
    );
    assertEquals(
      (await f.edge.db.tx((conn) => ownerSigningViews(conn, 'alice', user, '')))
        .master_keys,
      f.signed,
    );
    await deleteDevices(f.home.tenant, 'alice', ['LAN']);
    await f.dependencies();
    assertEquals(
      (await f.edge.db.tx((conn) => ownerSigningViews(conn, 'alice', user, '')))
        .master_keys,
      { ...f.master.json, signatures: {} },
    );
    await upsertDevice(f.home.tenant, 'alice', 'LAN');
    const device = await deviceIdentity(f.home.tenant, 'alice', 'LAN');
    const pub = b64encodeStd(await exportPublicKeyRaw(f.pair.publicKey));
    await f.home.tenant.tx((tx) =>
      tx.e2ee.upload(
        device,
        validateUpload(
          {
            device_keys: {
              user_id: user,
              device_id: 'LAN',
              algorithms: [],
              keys: { 'ed25519:LAN': pub },
              signatures: {},
            },
          },
          user,
          'LAN',
          config().e2ee,
        ),
      )
    );
    await f.dependencies();
    assertEquals(
      (await f.edge.db.tx((conn) => ownerSigningViews(conn, 'alice', user, '')))
        .master_keys,
      { ...f.master.json, signatures: {} },
    );
    assertEquals(
      await f.edge.db.tx((conn) =>
        signatureView(conn, f.signed, user, f.master.pub, user)
      ),
      { ...f.master.json, signatures: {} },
      'an embedded signature must not revive after same-key signer recreation',
    );
    const next = await key('master');
    const old = await f.home.tenant.tx((tx) => tx.crossSigning.state('alice'));
    await f.home.tenant.tx((tx) =>
      tx.crossSigning.upload(
        'alice',
        user,
        signingUpload({ master_key: next.json }, user, config().e2ee),
        canonicalJson(old),
        true,
      )
    );
    await f.dependencies();
    await f.edge.db.tx((conn) =>
      importSignatureOperation(conn, f.operation, expected)
    );
    assertEquals(
      (await f.edge.db.tx((conn) => ownerSigningViews(conn, 'alice', user, '')))
        .master_keys,
      { ...next.json, signatures: {} },
    );
  } finally {
    await f.close();
  }
});

Deno.test('F2 embedded key admission retains original overlay bases once, never rebinds an old body on export or reopen', async () => {
  const f = await setup();
  try {
    const old = await f.home.tenant.tx((tx) => tx.crossSigning.state('alice'));
    await f.home.tenant.tx((tx) =>
      tx.crossSigning.upload(
        'alice',
        user,
        signingUpload({ master_key: f.signed }, user, config().e2ee),
        canonicalJson(old),
        true,
      )
    );
    const operations = await f.home.db.tx((conn) =>
      captureSignatureOperations(conn, 'alice')
    );
    assertEquals(operations.length, 2);
    await f.dependencies();
    for (const operation of operations) {
      await f.edge.db.tx((conn) =>
        importSignatureOperation(conn, operation, expected)
      );
    }
    assertEquals(
      (await f.edge.db.tx((conn) => ownerSigningViews(conn, 'alice', user, '')))
        .master_keys,
      f.signed,
    );
    await deleteDevices(f.home.tenant, 'alice', ['LAN']);
    await upsertDevice(f.home.tenant, 'alice', 'LAN');
    const device = await deviceIdentity(f.home.tenant, 'alice', 'LAN');
    const pub = b64encodeStd(await exportPublicKeyRaw(f.pair.publicKey));
    await f.home.tenant.tx((tx) =>
      tx.e2ee.upload(
        device,
        validateUpload(
          {
            device_keys: {
              user_id: user,
              device_id: 'LAN',
              algorithms: [],
              keys: { 'ed25519:LAN': pub },
              signatures: {},
            },
          },
          user,
          'LAN',
          config().e2ee,
        ),
      )
    );
    const subordinate = await key('self_signing');
    await signJson(
      subordinate.json,
      user,
      'ed25519:' + f.master.pub,
      f.master.pair.privateKey,
    );
    const current = await f.home.tenant.tx((tx) =>
      tx.crossSigning.state('alice')
    );
    await f.home.tenant.tx((tx) =>
      tx.crossSigning.upload(
        'alice',
        user,
        signingUpload(
          { self_signing_key: subordinate.json },
          user,
          config().e2ee,
        ),
        canonicalJson(current),
        true,
      )
    );
    await f.dependencies();
    assertEquals(
      await f.home.db.tx((conn) => captureSignatureOperations(conn, 'alice')),
      operations,
    );
    for (const owner of [f.home, f.edge]) {
      await owner.reopen();
      assertEquals(
        await owner.db.tx((conn) =>
          signatureView(conn, f.signed, user, f.master.pub, user)
        ),
        { ...f.master.json, signatures: {} },
      );
    }
  } finally {
    await f.close();
  }
});

Deno.test('F2 portable self-signing and private cross-user overlays keep exact material and disclosure across independent cache counters', async () => {
  const f = await setup();
  try {
    const self = await key('self_signing'), secret = await key('user_signing');
    for (const subordinate of [self, secret]) {
      await signJson(
        subordinate.json,
        user,
        'ed25519:' + f.master.pub,
        f.master.pair.privateKey,
      );
    }
    const basis = await f.home.tenant.tx((tx) =>
      tx.crossSigning.state('alice')
    );
    await f.home.tenant.tx((tx) =>
      tx.crossSigning.upload(
        'alice',
        user,
        signingUpload(
          { self_signing_key: self.json, user_signing_key: secret.json },
          user,
          config().e2ee,
        ),
        canonicalJson(basis),
        true,
      )
    );
    await f.dependencies();
    const [{ key_json }] = await f.home.db.query(
      "SELECT key_json FROM device_keys WHERE device_id='LAN'",
    );
    const device = JSON.parse(String(key_json));
    const signedDevice = structuredClone(device);
    await signJson(
      signedDevice,
      user,
      'ed25519:' + self.pub,
      self.pair.privateKey,
    );
    assertEquals(
      await f.home.tenant.tx((tx) =>
        tx.keySignatures.upload('alice', user, [{
          user,
          id: 'LAN',
          json: signedDevice,
        }])
      ),
      { failures: {} },
    );
    const captured = await f.home.db.tx((conn) =>
      captureDeviceOperations(conn, 'alice')
    );
    assertEquals(
      captured.at(-1)!.value!.keys,
      device,
      'source device material must not absorb mutable overlays',
    );
    const remote = await key('master', '@bob:stock.test');
    const signedRemote = structuredClone(remote.json);
    await signJson(
      signedRemote,
      user,
      'ed25519:' + secret.pub,
      secret.pair.privateKey,
    );
    const signers = await f.home.tenant.tx((tx) =>
      tx.keySignatures.basis('alice')
    );
    assertEquals(
      await f.home.tenant.tx((tx) =>
        tx.keySignatures.upload('alice', user, [{
          user: '@bob:stock.test',
          id: remote.pub,
          json: signedRemote,
          remote: { json: remote.json, revision: 7, signers },
        }])
      ),
      { failures: {} },
    );
    const operations = await f.home.db.tx((conn) =>
      captureSignatureOperations(conn, 'alice')
    );
    assertEquals(operations.length, 3);
    for (const operation of [...operations].reverse()) {
      await f.edge.db.tx((conn) =>
        importSignatureOperation(conn, operation, expected)
      );
    }
    assertEquals(
      await f.edge.db.tx((conn) =>
        signatureView(conn, device, user, 'LAN', user)
      ),
      signedDevice,
    );
    assertEquals(
      await f.edge.tenant.tx((tx) =>
        tx.keySignatures.remoteView(
          remote.json,
          '@bob:stock.test',
          remote.pub,
          user,
          900,
        )
      ),
      signedRemote,
    );
    for (const requester of ['', '@charlie:logical.test']) {
      assertEquals(
        (await f.edge.tenant.tx((tx) =>
          tx.keySignatures.remoteView(
            remote.json,
            '@bob:stock.test',
            remote.pub,
            requester,
            900,
          )
        )).signatures,
        {},
      );
    }
    const altered = { ...remote.json, extra: 'different material' };
    assertEquals(
      (await f.edge.tenant.tx((tx) =>
        tx.keySignatures.remoteView(
          altered,
          '@bob:stock.test',
          remote.pub,
          user,
          900,
        )
      )).signatures,
      {},
    );
    await f.edge.reopen();
    assertEquals(
      await f.edge.tenant.tx((tx) =>
        tx.keySignatures.remoteView(
          remote.json,
          '@bob:stock.test',
          remote.pub,
          user,
          901,
        )
      ),
      signedRemote,
    );
    const replacement = await key('self_signing');
    await signJson(
      replacement.json,
      user,
      'ed25519:' + f.master.pub,
      f.master.pair.privateKey,
    );
    const current = await f.home.tenant.tx((tx) =>
      tx.crossSigning.state('alice')
    );
    await f.home.tenant.tx((tx) =>
      tx.crossSigning.upload(
        'alice',
        user,
        signingUpload(
          { self_signing_key: replacement.json },
          user,
          config().e2ee,
        ),
        canonicalJson(current),
        true,
      )
    );
    await f.dependencies();
    assertEquals(
      await f.edge.db.tx((conn) =>
        signatureView(conn, signedDevice, user, 'LAN', user)
      ),
      device,
      'an embedded old overlay cannot bypass signer rotation',
    );
  } finally {
    await f.close();
  }
});

function rehash(operation: SignatureOperation): SignatureOperation {
  const { payloadHash: _hash, ...body } = operation;
  return {
    ...body,
    payloadHash: createHash('sha256').update(canonicalJson(body)).digest('hex'),
  };
}
Deno.test('F2 signature owner refuses malformed, forged, wrong-source and substituted operations and rolls back exact intent', async () => {
  const f = await setup();
  try {
    for (
      const operation of [
        { ...f.operation, payloadHash: '0'.repeat(64) },
        rehash({ ...f.operation, source: 'edge' }),
        rehash({ ...f.operation, incarnation: 'old-home' }),
        rehash({ ...f.operation, localpart: 'bob' }),
        rehash({ ...f.operation, signers: [] }),
        rehash({
          ...f.operation,
          signers: [f.operation.signers[0], f.operation.signers[0]],
        }),
        rehash({
          ...f.operation,
          signers: [{ ...f.operation.signers[0], signature: 'A'.repeat(86) }],
        }),
        rehash({
          ...f.operation,
          target: {
            ...f.operation.target,
            json: { ...f.master.json, unsigned: { leak: true } },
          },
        }),
      ]
    ) {
      await assertRejects(() =>
        f.edge.db.tx((conn) =>
          importSignatureOperation(conn, operation, expected)
        )
      );
    }
    assertEquals(
      await f.edge.db.query('SELECT * FROM signature_operations'),
      [],
    );
    await assertRejects(
      () =>
        f.edge.db.tx(async (conn) => {
          await importSignatureOperation(conn, f.operation, expected);
          throw new Error('abort overlay');
        }),
      Error,
      'abort overlay',
    );
    assertEquals(
      await f.edge.db.query('SELECT * FROM signature_operations'),
      [],
    );
    await f.edge.db.tx((conn) =>
      importSignatureOperation(conn, f.operation, expected)
    );
    await assertRejects(
      () =>
        f.edge.db.tx((conn) =>
          importSignatureOperation(
            conn,
            rehash({
              ...f.operation,
              target: { ...f.operation.target, material: 'substitution' },
            }),
            expected,
          )
        ),
      Error,
      'signature operation collision',
    );
    assertEquals(
      (await f.edge.db.query('SELECT * FROM signature_operations')).length,
      1,
    );
  } finally {
    await f.close();
  }
});

Deno.test('F2 signature operations append migration31 and fresh/upgrade retain the same protected owner schema', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'signature-upgrade-' });
  const options = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  let store = await openStore(options, {
    schemas: { tenant: historicalTenantSchema(33) },
  });
  try {
    const old = await openTenant(store, 'logical.test', { create: true });
    const identity = old.publicB64;
    await store.close();
    store = await openStore(options, { schemas: { tenant: tenantSchema } });
    const upgraded = await openTenant(store, 'logical.test');
    assertEquals(upgraded.publicB64, identity);
    await openTenant(store, 'fresh.test', { create: true });
    const sql =
      "SELECT name,sql FROM sqlite_master WHERE name LIKE 'signature_operations%' ORDER BY name";
    assertEquals(
      await (await store.tenant('logical.test')).query(sql),
      await (await store.tenant('fresh.test')).query(sql),
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
