import { assert, assertEquals } from '@std/assert';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { deviceIdentity } from '#engine/tenant/txns.ts';
import { purgeRestoredKeyPools, validateUpload } from '#engine/tenant/e2ee.ts';
import { config } from '#engine/config.ts';
import { e2eeExtension } from '#engine/sliding-sync/extensions.ts';

for (const state of ['fresh', 'claimed', 'restored'] as const) {
  Deno.test(
    'key status: explicit empty pools survive ' + state + ' and reopen',
    async () => {
      const dir = await Deno.makeTempDir({ prefix: 'key-status-' });
      const settings = {
        dir,
        library: './.native/libturso_ffi.so',
        checkpointlogbytes: 65536,
        maxopenfiles: 8,
        idleseconds: 300,
      };
      const schemas = { tenant: tenantSchema, server: serverSchema };
      let store = await openStore(settings, { schemas });
      try {
        let tenant = await openTenant(store, 'status.test', { create: true });
        await tenant.tx(async (tx) => {
          await tx.users.insert('alice', 'Alice');
          await tx.devices.upsert('PHONE', 'alice', null);
        });
        const device = await deviceIdentity(tenant, 'alice', 'PHONE');
        if (state !== 'fresh') {
          await tenant.tx((tx) =>
            tx.e2ee.upload(
              device,
              validateUpload(
                {
                  one_time_keys: {
                    'signed_curve25519:once': { key: 'once', signatures: {} },
                  },
                  fallback_keys: {
                    'signed_curve25519:fallback': {
                      key: 'fallback',
                      signatures: {},
                      fallback: true,
                    },
                  },
                },
                '@alice:status.test',
                'PHONE',
                config().e2ee,
              ),
            )
          );
          if (state === 'claimed') {
            await tenant.tx((tx) =>
              tx.e2ee.claim('alice', 'PHONE', 'signed_curve25519')
            );
            await tenant.tx((tx) =>
              tx.e2ee.claim('alice', 'PHONE', 'signed_curve25519')
            );
          } else {
            await (await store.tenant('status.test')).tx(purgeRestoredKeyPools);
          }
        }
        for (const reopen of [false, true]) {
          if (reopen) {
            await store.close();
            store = await openStore(settings, { schemas });
            tenant = await openTenant(store, 'status.test');
          }
          const status = await tenant.tx((tx) => tx.e2ee.status(device));
          assertEquals(status.counts, { signed_curve25519: 0 });
          assertEquals(status.unused, []);
          const extension = await e2eeExtension({
            enabled: true,
            server: await store.server(),
            tenant,
            device,
            since: null,
            through: 0,
          });
          assert(extension);
          assertEquals(extension.response.device_one_time_keys_count, {
            signed_curve25519: 0,
          });
          assertEquals(extension.response.device_unused_fallback_key_types, []);
        }
      } finally {
        await store.close();
        await Deno.remove(dir, { recursive: true });
      }
    },
  );
}
