import { assert, assertEquals, assertRejects } from '@std/assert';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { registerUser } from '#engine/tenant/users.ts';
import { deviceIdentity } from '#engine/tenant/txns.ts';
import { encodeStreamToken, type StreamToken } from '#engine/client/tokens.ts';
import { config } from '#engine/config.ts';
import { MatrixError } from '#engine/matrix-error.ts';

const token: StreamToken = {
  eSeq: 0,
  pSeq: 0,
  tSeq: 0,
  rSeq: 0,
  aSeq: 0,
  dSeq: 0,
  mSeq: 0,
  kSeq: 0,
};
type Json = Record<string, unknown>;

async function fixture() {
  const dir = await Deno.makeTempDir({ prefix: 'sliding-inbox-' });
  const options = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  let store = await openStore(options, { schemas: { tenant: tenantSchema } });
  let tenant = await openTenant(store, 'inbox.test', { create: true });
  await registerUser(tenant, {
    localpart: 'alice',
    password: 'pw',
    deviceId: 'A',
  });
  await registerUser(tenant, {
    localpart: 'bob',
    password: 'pw',
    deviceId: 'B',
  });
  await registerUser(tenant, {
    localpart: 'eve',
    password: 'pw',
    deviceId: 'B',
  });
  const alice = await deviceIdentity(tenant, 'alice', 'A');
  const bob = await deviceIdentity(tenant, 'bob', 'B');
  const eve = await deviceIdentity(tenant, 'eve', 'B');
  const roomList = await tenant.tx((tx) =>
    tx.slidingSync.begin(bob, 'room-list', null)
  );
  const encryption = await tenant.tx((tx) =>
    tx.slidingSync.begin(bob, 'encryption', null)
  );
  let serial = 0;
  const send = (n: number, padding = '') => {
    const txn = String(++serial);
    return tenant.tx((tx) =>
      tx.toDevice.send(
        alice,
        'inbox.test',
        'm.test',
        txn,
        txn,
        [{ user: '@bob:inbox.test', id: 'B', content: { n, padding } }],
        config().e2ee,
        { enabled: true, maxBytes: 1048576 },
      )
    );
  };
  const txApi = (tx: Parameters<Parameters<typeof tenant.tx>[0]>[0]) =>
    tx.toDevice;
  const deliver = (
    limit = 100,
    connection = encryption.connection,
    d = bob,
    limits = config().e2ee,
  ) =>
    tenant.tx((tx) => txApi(tx).deliverSliding(d, connection, limit, limits));
  const acknowledge = (
    since: string | null,
    connection = encryption.connection,
    d = bob,
  ) => tenant.tx((tx) => txApi(tx).acknowledgeSliding(d, connection, since));
  return {
    bob,
    eve,
    encryption,
    roomList,
    send,
    deliver,
    acknowledge,
    txApi,
    tenant: () => tenant,
    database: () => store.tenant('inbox.test'),
    reopen: async () => {
      await store.close();
      store = await openStore(options, { schemas: { tenant: tenantSchema } });
      tenant = await openTenant(store, 'inbox.test');
    },
    close: async () => {
      await store.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}
const numbers = (page: { events: Json[] }) =>
  page.events.map((event) => (event.content as Json).n);

Deno.test('sliding inbox: independent issued receipts, lost response, bounded tail and ordinary sync share one durable ack', async () => {
  const f = await fixture();
  try {
    for (const n of [1, 2, 3]) await f.send(n);
    const pos = await f.tenant().tx((tx) =>
      tx.slidingSync.commit(f.bob, f.roomList, { cut: 10000 })
    );
    const first = await f.deliver(1);
    assertEquals(numbers(first), [1]);
    assertEquals(numbers(await f.deliver(1)), [1], 'lost response must replay');
    for (
      const since of [
        pos,
        '999999999999999999999',
        encodeStreamToken({ ...token, mSeq: 1000 }),
      ]
    ) {
      await f.acknowledge(since);
      assertEquals(numbers(await f.deliver()), [1, 2, 3]);
    }
    await f.acknowledge(first.nextBatch, f.roomList.connection);
    await f.acknowledge(first.nextBatch, f.encryption.connection, f.eve);
    assertEquals(
      numbers(await f.deliver()),
      [1, 2, 3],
      'another connection/owner cannot consume this page',
    );
    await f.reopen();
    await f.acknowledge(first.nextBatch);
    assertEquals(numbers(await f.deliver()), [2, 3]);
    await f.acknowledge(first.nextBatch);
    assertEquals(
      numbers(await f.deliver()),
      [2, 3],
      'old acknowledgment stays monotone',
    );
    const ordinary = await f.tenant().tx((tx) =>
      tx.toDevice.deliver(f.bob, token, config().e2ee)
    );
    assertEquals(numbers(ordinary), [2, 3]);
    await f.tenant().tx((tx) => tx.toDevice.acknowledge(f.bob, ordinary.token));
    assertEquals(numbers(await f.deliver()), []);
    await f.send(4);
    await f.acknowledge(first.nextBatch);
    assertEquals(
      numbers(await f.deliver()),
      [4],
      'retired receipt cannot consume a newer message',
    );
  } finally {
    await f.close();
  }
});

Deno.test('sliding inbox: zero/count/byte pages never issue acknowledgment over unseen messages', async () => {
  const f = await fixture();
  try {
    for (const n of [1, 2, 3]) await f.send(n, 'x'.repeat(120));
    const empty = await f.deliver(0);
    assertEquals(numbers(empty), []);
    await f.acknowledge(empty.nextBatch);
    assertEquals(numbers(await f.deliver()), [1, 2, 3]);
    const limits = { ...config().e2ee, maxrequestbytes: 250 };
    const page = await f.deliver(100, f.encryption.connection, f.bob, limits);
    assertEquals(numbers(page), [1]);
    await f.acknowledge(page.nextBatch);
    assertEquals(numbers(await f.deliver()), [2, 3]);
    const tail = await f.deliver(1);
    await f.acknowledge(tail.nextBatch);
    assertEquals(numbers(await f.deliver()), [3]);
  } finally {
    await f.close();
  }
});

Deno.test('sliding inbox: receipt issuance rolls back with failed position commit and device replacement rejects old receipts', async () => {
  const f = await fixture();
  try {
    await f.send(1);
    const page = await f.deliver(1);
    await f.send(2);
    await f.tenant().tx((tx) =>
      tx.slidingSync.commit(f.bob, f.encryption, { cut: 1 })
    );
    let rolledBack: string | null = null;
    await assertRejects(
      () =>
        f.tenant().tx(async (tx) => {
          await f.txApi(tx).acknowledgeSliding(
            f.bob,
            f.encryption.connection,
            page.nextBatch,
          );
          const successor = await f.txApi(tx).deliverSliding(
            f.bob,
            f.encryption.connection,
            100,
            config().e2ee,
          );
          assertEquals(
            numbers(successor),
            [2],
            'rollback includes a nonempty successor page',
          );
          rolledBack = successor.nextBatch;
          await tx.slidingSync.commit(f.bob, f.encryption, { cut: 2 });
        }),
      MatrixError,
      'M_UNKNOWN_POS',
    );
    assert(rolledBack !== null);
    await f.acknowledge(rolledBack);
    assertEquals(
      numbers(await f.deliver()),
      [1, 2],
      'rollback cannot consume the original page',
    );
    await f.tenant().tx((tx) => tx.devices.delete('B', 'bob'));
    await f.tenant().tx((tx) => tx.devices.upsert('B', 'bob', null));
    const replacement = await deviceIdentity(f.tenant(), 'bob', 'B');
    await f.send(3);
    await f.acknowledge(page.nextBatch, f.encryption.connection, replacement);
    assertEquals(
      numbers(await f.deliver(100, f.encryption.connection, replacement)),
      [3],
    );
  } finally {
    await f.close();
  }
});

Deno.test('sliding inbox: 100-event cap and shared proof capacity retain unseen data when receipts are evicted', async () => {
  const f = await fixture();
  try {
    for (let n = 0; n < 101; n++) await f.send(n);
    const limits = { ...config().e2ee, maxkeys: 1 };
    const first = await f.deliver(1000, f.encryption.connection, f.bob, limits);
    assertEquals(numbers(first), Array.from({ length: 100 }, (_, n) => n));
    await f.deliver(100, f.encryption.connection, f.bob, limits);
    const latest = await f.deliver(100, f.encryption.connection, f.bob, limits);
    const proofs = await (await f.database()).query(
      'SELECT token_hash FROM sync_deliveries WHERE localpart=? AND device_id=? AND generation=?',
      [f.bob.localpart, f.bob.deviceId, f.bob.generation],
    );
    assertEquals(proofs.length, 1);
    await f.acknowledge(first.nextBatch);
    assertEquals(
      numbers(await f.deliver(1)),
      [0],
      'evicted receipt replays; it never acknowledges unseen data',
    );
    await f.acknowledge(latest.nextBatch);
    assertEquals(
      numbers(await f.deliver()),
      [100],
      'count-limited page cannot consume its tail',
    );
    for (const limit of [-1, 0.5, Infinity]) {
      await assertRejects(
        () => f.deliver(limit),
        MatrixError,
        'M_INVALID_PARAM',
      );
    }
  } finally {
    await f.close();
  }
});
