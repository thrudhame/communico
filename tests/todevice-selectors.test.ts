import { assertEquals } from '@std/assert';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { registerUser } from '#engine/tenant/users.ts';
import { deviceIdentity } from '#engine/tenant/txns.ts';
import { config } from '#engine/config.ts';
import type { Message } from '#engine/tenant/todevice.ts';

Deno.test('to-device: mixed wildcard selectors use the explicit-target path regardless of entry order', async (t) => {
  const dir = await Deno.makeTempDir();
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { tenant: tenantSchema } });
  try {
    const tenant = await openTenant(store, 'selectors.test', { create: true });
    await registerUser(tenant, {
      localpart: 'alice',
      password: 'pw',
      deviceId: 'PHONE',
    });
    await registerUser(tenant, {
      localpart: 'bob',
      password: 'pw',
      deviceId: 'PHONE',
    });
    await tenant.tx((tx) => tx.devices.upsert('OTHER', 'bob', null));
    const sender = await deviceIdentity(tenant, 'alice', 'PHONE');
    const user = '@bob:selectors.test';
    const wildcard: Message = { user, id: '*', content: { selected: 'all' } };
    const explicit: Message = {
      user,
      id: 'PHONE',
      content: { selected: 'phone' },
    };
    const limits = config().e2ee;
    let sequence = 0;
    for (const incoming of [false, true]) {
      for (const messages of [[wildcard, explicit], [explicit, wildcard]]) {
        await t.step(
          (incoming ? 'federation' : 'client') + ':' + messages[0].id,
          async () => {
            await (await store.tenant(tenant.serverName)).execute(
              'DELETE FROM to_device_inbox',
            );
            const source = 'selectors-' + ++sequence;
            await tenant.tx((tx) =>
              incoming
                ? tx.toDevice.receive(
                  'peer.test',
                  source,
                  '@peer:peer.test',
                  'm.test',
                  tenant.serverName,
                  messages,
                  limits,
                )
                : tx.toDevice.send(
                  sender,
                  tenant.serverName,
                  'm.test',
                  source,
                  source,
                  messages,
                  limits,
                  { enabled: true, maxBytes: 1048576 },
                )
            );
            const rows = await (await store.tenant(tenant.serverName)).query(
              'SELECT device_id,event_json FROM to_device_inbox ORDER BY device_id',
            );
            assertEquals(
              rows.map((row) => ({
                device: row.device_id,
                content: JSON.parse(String(row.event_json)).content,
              })),
              [
                { device: 'PHONE', content: { selected: 'phone' } },
              ],
            );
            await (await store.tenant(tenant.serverName)).execute(
              'DELETE FROM to_device_inbox',
            );
          },
        );
      }
    }
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
