import { assert, assertEquals, assertRejects } from '@std/assert';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { deviceIdentity } from '#engine/tenant/txns.ts';
import { config } from '#engine/config.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { publishSlidingResponse } from '#engine/sliding-sync/delivery.ts';
import type { PositionLease } from '#engine/tenant/sliding-sync.ts';

type Json = Record<string, unknown>;
async function fixture() {
  const dir = await Deno.makeTempDir({ prefix: 'sliding-delivery-' });
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { tenant: tenantSchema } });
  const tenant = await openTenant(store, 'delivery.test', { create: true });
  await tenant.tx(async (tx) => {
    for (const lp of ['alice', 'bob']) {
      await tx.users.insert(lp, lp);
      await tx.devices.upsert('PHONE', lp, null);
    }
  });
  const sender = await deviceIdentity(tenant, 'alice', 'PHONE');
  const device = await deviceIdentity(tenant, 'bob', 'PHONE');
  let serial = 0;
  const send = (n: number) => {
    const id = String(++serial);
    return tenant.tx((tx) =>
      tx.toDevice.send(
        sender,
        tenant.serverName,
        'm.test',
        id,
        id,
        [
          { user: '@bob:delivery.test', id: device.deviceId, content: { n } },
        ],
        config().e2ee,
        { enabled: true, maxBytes: 1048576 },
      )
    );
  };
  const begin = (name: string, pos: string | null = null) =>
    tenant.tx((tx) => tx.slidingSync.begin(device, name, pos));
  const publish = (
    lease: PositionLease,
    since: string | null = null,
    state: Json = {},
    signal?: AbortSignal,
  ) =>
    publishSlidingResponse({
      tenant,
      device,
      lease,
      state,
      response: { extensions: { e2ee: { marker: true } } },
      toDevice: { enabled: true, limit: 1, since },
      signal,
    });
  return {
    tenant,
    device,
    send,
    begin,
    publish,
    close: async () => {
      await store.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}
const page = (response: Json) =>
  (response.extensions as Json).to_device as {
    next_batch: string;
    events: Json[];
  };
const numbers = (response: Json) =>
  page(response).events.map((e) => (e.content as Json).n);

Deno.test('sliding delivery: rendered response, scoped inbox page and successor commit publish atomically', async () => {
  const f = await fixture();
  try {
    await f.send(1);
    await f.send(2);
    const roomList = await f.begin('room-list');
    const roomResponse = await publishSlidingResponse({
      tenant: f.tenant,
      device: f.device,
      lease: roomList,
      state: { cut: 1 },
      response: { lists: {}, extensions: {} },
    });
    assertEquals((roomResponse.extensions as Json).to_device, undefined);
    const encryption = await f.begin('encryption');
    const first = await f.publish(encryption);
    assertEquals(numbers(first), [1]);
    assertEquals((first.extensions as Json).e2ee, { marker: true });
    const retained = await f.tenant.tx((tx) =>
      tx.slidingSync.begin(f.device, 'encryption', String(first.pos))
    );
    const forged = await f.publish(retained, String(roomResponse.pos));
    assertEquals(
      numbers(forged),
      [1],
      'room-list positions have no inbox deletion authority',
    );
    const input = await f.begin('encryption', String(forged.pos));
    const second = await f.publish(input, page(forged).next_batch, { cut: 2 });
    assertEquals(numbers(second), [2]);
    const deliveredState = await f.begin('encryption', String(second.pos));
    assertEquals(deliveredState.state, { cut: 2 });
    const empty = await f.publish(deliveredState, page(second).next_batch);
    assertEquals(numbers(empty), []);
    assertEquals(
      await f.tenant.tx((tx) => tx.toDevice.pending(f.device)),
      false,
    );
  } finally {
    await f.close();
  }
});

Deno.test('sliding delivery: stale, oversized and aborted publishers cannot consume a received page or issue a successor', async () => {
  const f = await fixture();
  try {
    await f.send(1);
    await f.send(2);
    const first = await f.publish(await f.begin('encryption'));
    const stale = await f.begin('encryption', String(first.pos));
    const current = await f.begin('encryption', String(first.pos));
    await assertRejects(
      () => f.publish(stale, page(first).next_batch),
      MatrixError,
      'M_UNKNOWN_POS',
    );
    // The rejected ack/delivery transaction rolled back, including the inbox.
    const replay = await f.publish(current);
    assertEquals(numbers(replay), [1]);
    const tooLarge = await f.begin('encryption', String(replay.pos));
    await assertRejects(
      () =>
        f.publish(tooLarge, page(replay).next_batch, {
          data: 'x'.repeat(config().slidingsync.maxsnapshotbytes + 1),
        }),
      MatrixError,
      'M_UNKNOWN_POS',
    );
    const afterOversize = await f.publish(
      await f.begin('encryption', String(replay.pos)),
    );
    assertEquals(numbers(afterOversize), [1]);
    const controller = new AbortController();
    const lease = await f.begin('encryption', String(afterOversize.pos));
    const original = f.tenant.tx;
    f.tenant.tx = (fn) =>
      original((tx) =>
        fn({
          ...tx,
          toDevice: {
            ...tx.toDevice,
            deliverSliding: async (...args) => {
              const result = await tx.toDevice.deliverSliding(...args);
              controller.abort();
              return result;
            },
          },
        })
      );
    try {
      await assertRejects(
        () =>
          f.publish(
            lease,
            page(afterOversize).next_batch,
            {},
            controller.signal,
          ),
        DOMException,
        'aborted',
      );
    } finally {
      f.tenant.tx = original;
    }
    const survived = await f.publish(
      await f.begin('encryption', String(afterOversize.pos)),
    );
    assertEquals(numbers(survived), [1]);
    const ack = await f.publish(
      await f.begin('encryption', String(survived.pos)),
      page(survived).next_batch,
    );
    assertEquals(numbers(ack), [2]);
    assert(await f.tenant.tx((tx) => tx.toDevice.pending(f.device)));
  } finally {
    await f.close();
  }
});
