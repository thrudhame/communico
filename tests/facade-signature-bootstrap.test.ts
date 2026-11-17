import { assert, assertEquals, assertRejects } from '@std/assert';
import { ownerSigningViews } from '#engine/tenant/cross-signing.ts';
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
import { captureSigningOperations } from '#engine/tenant/signing-operations.ts';
import { captureSignatureOperations } from '#engine/tenant/signature-operations.ts';
import { importSignatureOperation } from '#engine/tenant/signature-operations.ts';
import {
  captureSessionAuthority,
  installSessionAuthority,
} from '#engine/tenant/session-authority.ts';
import { captureDeviceOperations } from '#engine/tenant/device-source.ts';
import { importDeviceOperation } from '#engine/tenant/device-operations.ts';
import { importSigningOperation } from '#engine/tenant/signing-operations.ts';
import { legacySignatures } from '#engine/tenant/signature-bootstrap.ts';
import { canonicalJson } from '#engine/canonical.ts';
import { deleteDevices } from '#engine/tenant/devices.ts';

for (const embedded of [false, true]) {
  Deno.test(
    'F2 activation retains original pre-enrollment signature bases: ' +
      (embedded
        ? 'embedded body, delayed export after recreation'
        : 'verified overlay, reordered delivery'),
    async () => {
      const dir = await Deno.makeTempDir({ prefix: 'signature-bootstrap-' });
      const store = await openStore({
        dir,
        library: './.native/libturso_ffi.so',
        checkpointlogbytes: 65536,
        maxopenfiles: 8,
        idleseconds: 300,
      }, { schemas: { tenant: tenantSchema } });
      try {
        const tenant = await openTenant(store, 'logical.test', {
          create: true,
        });
        const db = await store.tenant('logical.test');
        const user = '@alice:logical.test';
        await tenant.tx((tx) => tx.users.insert('alice', 'Alice'));
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
        assertEquals(
          (await tenant.tx((tx) => tx.crossSigning.views('alice', user, '')))
            .master_keys,
          signed,
        );
        const [original] = await db.query('SELECT * FROM key_signatures');
        for (
          const field of [
            'signer_basis',
            'target_material',
            'signature',
          ] as const
        ) {
          await db.tx((conn) =>
            conn.execute('UPDATE key_signatures SET ' + field + '=?', [
              field === 'signature' ? 'A'.repeat(86) : 'stale-basis',
            ])
          );
          assertEquals(
            await db.tx(legacySignatures),
            [],
            field + ' cannot acquire a new global basis',
          );
          await db.tx((conn) =>
            conn.execute('UPDATE key_signatures SET ' + field + '=?', [
              original[field],
            ])
          );
        }
        await assertRejects(
          () =>
            db.tx(async (conn) => {
              await activateTenantAuthority(conn, {
                node: 'home',
                incarnation: 'home-store',
                homeIncarnation: 'home-store',
                edgeNode: 'edge',
                edgeIncarnation: 'edge-store',
              });
              throw new Error('injected activation rollback');
            }),
          Error,
          'injected activation rollback',
        );
        assertEquals(await db.query('SELECT * FROM tenant_authority'), []);
        assertEquals(await db.query('SELECT * FROM signature_operations'), []);
        assertEquals(await db.query('SELECT * FROM key_signatures'), [
          original,
        ]);
        if (embedded) {
          const state = await tenant.tx((tx) => tx.crossSigning.state('alice'));
          await tenant.tx((tx) =>
            tx.crossSigning.upload(
              'alice',
              user,
              signingUpload({ master_key: signed }, user, config().e2ee),
              canonicalJson(state),
              true,
            )
          );
        }
        await db.tx((conn) =>
          activateTenantAuthority(conn, {
            node: 'home',
            incarnation: 'home-store',
            homeIncarnation: 'home-store',
            edgeNode: 'edge',
            edgeIncarnation: 'edge-store',
          })
        );
        const operations = await db.tx((conn) =>
          captureSignatureOperations(conn, 'alice')
        );
        assert(
          operations.length,
          'activation must not hide a verified pre-enrollment signature',
        );
        assertEquals(
          (await tenant.tx((tx) => tx.crossSigning.views('alice', user, '')))
            .master_keys,
          signed,
        );
        await db.tx((conn) =>
          activateTenantAuthority(conn, {
            node: 'home',
            incarnation: 'home-store',
            homeIncarnation: 'home-store',
            edgeNode: 'edge',
            edgeIncarnation: 'edge-store',
          })
        );
        assertEquals(
          await db.tx((conn) => captureSignatureOperations(conn, 'alice')),
          operations,
        );
        const visible = embedded ? { ...master, signatures: {} } : signed;
        if (embedded) {
          await deleteDevices(tenant, 'alice', ['LAN']);
          await upsertDevice(tenant, 'alice', 'LAN');
          const replacement = await deviceIdentity(tenant, 'alice', 'LAN');
          await tenant.tx((tx) =>
            tx.e2ee.upload(
              replacement,
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
        }
        // First source export is intentionally AFTER recreation in the embedded
        // case. It may publish retained intent, never grant a new signer basis.
        await db.tx((conn) => captureSigningOperations(conn, 'alice'));
        assertEquals(
          await db.tx((conn) => captureSignatureOperations(conn, 'alice')),
          operations,
        );
        assertEquals(
          (await tenant.tx((tx) => tx.crossSigning.views('alice', user, '')))
            .master_keys,
          visible,
        );
        const options = {
          dir: dir + '/edge',
          library: './.native/libturso_ffi.so',
          checkpointlogbytes: 65536,
          maxopenfiles: 8,
          idleseconds: 300,
        };
        let edge = await openStore(options, {
          schemas: { tenant: tenantSchema },
        });
        try {
          let replica = await openTenant(edge, 'logical.test', {
            create: true,
          });
          let edb = await edge.tenant('logical.test');
          await replica.tx((tx) => tx.users.insert('alice', 'Alice'));
          await edb.tx((conn) =>
            activateTenantAuthority(conn, {
              node: 'edge',
              incarnation: 'edge-store',
              homeIncarnation: 'home-store',
              edgeNode: 'edge',
              edgeIncarnation: 'edge-store',
            })
          );
          const expected = {
            source: 'home',
            incarnation: 'home-store',
            localpart: 'alice',
          };
          // Original signature fact may arrive before both public dependencies.
          for (const op of operations) {
            await edb.tx((conn) =>
              importSignatureOperation(conn, op, expected)
            );
          }
          const authority = await db.tx((conn) =>
            captureSessionAuthority(conn, 'alice')
          );
          await edb.tx((conn) =>
            installSessionAuthority(conn, 'alice', authority)
          );
          for (
            const op of await db.tx((conn) =>
              captureDeviceOperations(conn, 'alice')
            )
          ) await edb.tx((conn) => importDeviceOperation(conn, op, expected));
          for (
            const op of await db.tx((conn) =>
              captureSigningOperations(conn, 'alice')
            )
          ) await edb.tx((conn) => importSigningOperation(conn, op, expected));
          assertEquals(
            (await edb.tx((conn) => ownerSigningViews(conn, 'alice', user, '')))
              .master_keys,
            visible,
          );
          await edge.close();
          edge = await openStore(options, {
            schemas: { tenant: tenantSchema },
          });
          replica = await openTenant(edge, 'logical.test');
          edb = await edge.tenant('logical.test');
          assertEquals(
            (await edb.tx((conn) => ownerSigningViews(conn, 'alice', user, '')))
              .master_keys,
            visible,
          );
          assertEquals(
            await edb.tx((conn) => captureSignatureOperations(conn, 'alice')),
            [],
          );
          assertEquals(await edb.query('SELECT * FROM devices'), []);
        } finally {
          await edge.close();
        }
      } finally {
        await store.close();
        await Deno.remove(dir, { recursive: true });
      }
    },
  );
}
