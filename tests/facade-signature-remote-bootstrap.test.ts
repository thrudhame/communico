import { assertEquals, assertRejects } from '@std/assert';
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
import { captureSignatureOperations } from '#engine/tenant/signature-operations.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { withTenantAuthorityActivation } from '#engine/facade/ownership.ts';
import { withRemoteSigningState } from '#engine/server/remote-devices.ts';
import { RemoteSignatureCutMissing } from '#engine/tenant/signature-bootstrap.ts';

for (const current of [0, 7, 8]) {
  Deno.test(`F2 activation preserves remote overlay visibility at the current cache cut ${current}`, async () => {
    const dir = await Deno.makeTempDir({
      prefix: 'remote-signature-bootstrap-',
    });
    const store = await openStore({
      dir,
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 300,
    }, { schemas: { tenant: tenantSchema, server: serverSchema } });
    try {
      const tenant = await openTenant(store, 'logical.test', { create: true });
      const db = await store.tenant('logical.test');
      const server = await store.server();
      const user = '@alice:logical.test', remote = '@bob:stock.test';
      await tenant.tx((tx) => tx.users.insert('alice', 'Alice'));
      const masterPair = await generateSigningKeypair() as CryptoKeyPair;
      const masterPub = b64encodeStd(
        await exportPublicKeyRaw(masterPair.publicKey),
      );
      const master = {
        user_id: user,
        usage: ['master'],
        keys: { ['ed25519:' + masterPub]: masterPub },
      };
      const signerPair = await generateSigningKeypair() as CryptoKeyPair;
      const signerPub = b64encodeStd(
        await exportPublicKeyRaw(signerPair.publicKey),
      );
      const signer = {
        user_id: user,
        usage: ['user_signing'],
        keys: { ['ed25519:' + signerPub]: signerPub },
      };
      await signJson(
        signer,
        user,
        'ed25519:' + masterPub,
        masterPair.privateKey,
      );
      await tenant.tx((tx) =>
        tx.crossSigning.upload(
          'alice',
          user,
          signingUpload(
            { master_key: master, user_signing_key: signer },
            user,
            config().e2ee,
          ),
          '{}',
          false,
        )
      );
      const targetPair = await generateSigningKeypair() as CryptoKeyPair;
      const targetPub = b64encodeStd(
        await exportPublicKeyRaw(targetPair.publicKey),
      );
      const target = {
        user_id: remote,
        usage: ['master'],
        keys: { ['ed25519:' + targetPub]: targetPub },
      };
      const signed = structuredClone(target);
      await signJson(
        signed,
        user,
        'ed25519:' + signerPub,
        signerPair.privateKey,
      );
      const signers = await tenant.tx((tx) => tx.keySignatures.basis('alice'));
      assertEquals(
        await tenant.tx((tx) =>
          tx.keySignatures.upload('alice', user, [{
            user: remote,
            id: targetPub,
            json: signed,
            remote: { json: target, revision: 7, signers },
          }])
        ),
        { failures: {} },
      );
      const before = await tenant.tx((tx) =>
        tx.keySignatures.remoteView(target, remote, targetPub, user, current)
      );
      assertEquals(
        before.signatures,
        current === 7
          ? (signed as typeof signed & { signatures: unknown }).signatures
          : {},
      );
      if (current) {
        await server.execute('INSERT INTO remote_signing_keys VALUES(?,?,?)', [
          remote,
          current,
          JSON.stringify({ master_key: target }),
        ]);
      }
      await assertRejects(() =>
        db.tx((conn) =>
          activateTenantAuthority(conn, {
            node: 'home',
            incarnation: 'home-store',
            homeIncarnation: 'home-store',
            edgeNode: 'edge',
            edgeIncarnation: 'edge-store',
          })
        ), RemoteSignatureCutMissing);
      assertEquals(
        await db.query('SELECT * FROM tenant_authority'),
        [],
        'activation without a pinned current cut rolls back before authority changes',
      );
      let activate!: () => void, acquired!: () => void;
      const release = new Promise<void>((resolve) => {
        activate = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        acquired = resolve;
      });
      const activation = withTenantAuthorityActivation(
        server,
        db,
        async (conn, cuts) => {
          acquired();
          await release;
          await activateTenantAuthority(conn, {
            node: 'home',
            incarnation: 'home-store',
            homeIncarnation: 'home-store',
            edgeNode: 'edge',
            edgeIncarnation: 'edge-store',
          }, cuts);
        },
      );
      await entered;
      let advanced = false;
      const update = withRemoteSigningState(server, remote, async () => {
        advanced = true;
        await server.execute(
          'UPDATE remote_signing_keys SET revision=revision+1 WHERE user_id=?',
          [remote],
        );
      });
      try {
        await Promise.resolve();
        assertEquals(
          advanced,
          false,
          'the remote revision cannot change across activation',
        );
      } finally {
        activate();
        await activation;
        await update;
      }
      const after = await tenant.tx((tx) =>
        tx.keySignatures.remoteView(target, remote, targetPub, user, current)
      );
      assertEquals(
        after,
        before,
        'activation cannot give a hidden legacy row new authority',
      );
      const operations = await db.tx((conn) =>
        captureSignatureOperations(conn, 'alice')
      );
      assertEquals(operations.length, current === 7 ? 1 : 0);
      assertEquals(
        (await db.query('SELECT signature FROM key_signatures')).length,
        1,
        'ineligible historical evidence is retained, never deleted',
      );
      await withTenantAuthorityActivation(
        server,
        db,
        (conn, cuts) =>
          activateTenantAuthority(conn, {
            node: 'home',
            incarnation: 'home-store',
            homeIncarnation: 'home-store',
            edgeNode: 'edge',
            edgeIncarnation: 'edge-store',
          }, cuts),
      );
      assertEquals(
        await db.tx((conn) => captureSignatureOperations(conn, 'alice')),
        operations,
      );
    } finally {
      await store.close();
      await Deno.remove(dir, { recursive: true });
    }
  });
}
