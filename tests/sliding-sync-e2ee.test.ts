import { assert, assertEquals } from '@std/assert';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import {
  deviceStreamMax,
  nextDeviceSeq,
  publishDeviceChange,
  reconcileDeviceRoom,
} from '#engine/server/e2ee.ts';
import { deviceIdentity } from '#engine/tenant/txns.ts';
import { validateUpload } from '#engine/tenant/e2ee.ts';
import { config } from '#engine/config.ts';
import { e2eeExtension } from '#engine/sliding-sync/extensions.ts';

Deno.test('sliding e2ee: independent device cuts retain disabled-period changes and the existing all-room audience', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'sliding-e2ee-' });
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { tenant: tenantSchema, server: serverSchema } });
  try {
    const tenant = await openTenant(store, 'ext.test', { create: true });
    await tenant.tx(async (tx) => {
      await tx.users.insert('alice', 'Alice');
      await tx.devices.upsert('PHONE', 'alice', null);
    });
    const device = await deviceIdentity(tenant, 'alice', 'PHONE');
    const server = await store.server();
    const alice = '@alice:ext.test', bob = '@bob:remote.test';
    // Current communico policy tracks all shared rooms, not encryption only.
    await server.tx((tx) =>
      reconcileDeviceRoom(
        tx,
        '!shared:ext.test',
        [alice, bob],
        false,
        null,
        1,
        ['ext.test'],
      )
    );
    const baseline = await deviceStreamMax(server);
    await tenant.tx((tx) =>
      tx.e2ee.upload(
        device,
        validateUpload(
          {
            one_time_keys: { 'curve25519:once': 'once' },
            fallback_keys: { 'curve25519:fallback': 'fallback' },
          },
          alice,
          device.deviceId,
          config().e2ee,
        ),
      )
    );
    const capture = (
      since: number | null,
      through: number,
      previousPoolSeq?: number,
      enabled = true,
    ) =>
      e2eeExtension({
        enabled,
        server,
        tenant,
        device,
        since,
        through,
        previousPoolSeq,
      });
    const initial = await capture(null, baseline);
    assert(initial);
    assertEquals(initial.response.device_lists, { changed: [], left: [] });
    assertEquals(initial.response.device_one_time_keys_count, {
      curve25519: 1,
    });
    assertEquals(initial.response.device_unused_fallback_key_types, [
      'curve25519',
    ]);
    assertEquals(
      initial.relevant,
      false,
      'constant initial status alone cannot complete every poll',
    );
    const beforeChange = baseline;
    await server.tx(async (tx) => {
      await publishDeviceChange(tx, await nextDeviceSeq(tx), bob);
      await publishDeviceChange(
        tx,
        await nextDeviceSeq(tx),
        '@outside:remote.test',
      );
    });
    const changedCut = await deviceStreamMax(server);
    assertEquals(
      await capture(beforeChange, changedCut, initial.state.poolSeq, false),
      null,
    );
    const unchanged = await capture(
      beforeChange,
      beforeChange,
      initial.state.poolSeq,
    );
    assert(unchanged);
    assertEquals(unchanged.response.device_lists, { changed: [], left: [] });
    assertEquals(unchanged.relevant, false);
    // The caller retains its independent last enabled cut while disabled.
    const enabledLater = await capture(
      beforeChange,
      changedCut,
      initial.state.poolSeq,
    );
    assert(enabledLater);
    assertEquals(enabledLater.response.device_lists, {
      changed: [bob],
      left: [],
    });
    assert(enabledLater.relevant);
    const caughtUp = await capture(
      changedCut,
      changedCut,
      enabledLater.state.poolSeq,
    );
    assert(caughtUp);
    assertEquals(caughtUp.relevant, false);
    await tenant.tx((tx) => tx.e2ee.claim('alice', 'PHONE', 'curve25519'));
    const consumed = await capture(
      changedCut,
      changedCut,
      enabledLater.state.poolSeq,
    );
    assert(consumed);
    assertEquals(consumed.response.device_one_time_keys_count, {});
    assert(
      consumed.relevant,
      'a changed pool is relevant, an unchanged pool is not',
    );
    await tenant.tx((tx) => tx.e2ee.claim('alice', 'PHONE', 'curve25519'));
    const usedFallback = await capture(
      changedCut,
      changedCut,
      consumed.state.poolSeq,
    );
    assert(usedFallback);
    assertEquals(usedFallback.response.device_unused_fallback_key_types, []);
    assert(usedFallback.relevant);
    await server.tx((tx) =>
      reconcileDeviceRoom(tx, '!shared:ext.test', [alice], false, null, 2, [
        'ext.test',
      ])
    );
    const leftCut = await deviceStreamMax(server);
    const left = await capture(changedCut, leftCut, usedFallback.state.poolSeq);
    assert(left);
    assertEquals(left.response.device_lists, { changed: [], left: [bob] });
    assertEquals(left.state.deviceCut, leftCut);
    // A fresh no-pos encryption sync never fabricates old changed/left deltas.
    const fresh = await capture(null, leftCut);
    assert(fresh);
    assertEquals(fresh.response.device_lists, { changed: [], left: [] });
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
