import { assert, assertEquals, assertRejects } from '@std/assert';
import { config } from '#engine/config.ts';
import { encodeStreamToken } from '#engine/client/tokens.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { deleteDevices, upsertDevice } from '#engine/tenant/devices.ts';
import { deviceIdentity } from '#engine/tenant/txns.ts';
import { activateTenantAuthority } from '#engine/tenant/session-authority.ts';
import { captureToDeviceOperations } from '#engine/tenant/todevice-routing.ts';
import { historicalTenantSchema } from './fixtures/tenant-schema-history.ts';

Deno.test('routed to-device: an acknowledged same-server send retains the other owner selector without self-federation', async () => {
  const dir = await Deno.makeTempDir();
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { tenant: tenantSchema } });
  try {
    const tenant = await openTenant(store, 'routing.test', { create: true });
    await tenant.tx((tx) => tx.users.insert('alice', 'Alice'));
    await upsertDevice(tenant, 'alice', 'LAN');
    const db = await store.tenant(tenant.serverName);
    await db.tx((conn) =>
      activateTenantAuthority(conn, {
        node: 'home',
        incarnation: 'home-store',
        homeIncarnation: 'home-store',
        edgeNode: 'edge',
        edgeIncarnation: 'edge-store',
      })
    );
    const device = await deviceIdentity(tenant, 'alice', 'LAN');
    await tenant.tx((tx) =>
      tx.toDevice.send(
        device,
        tenant.serverName,
        'm.room_key_request',
        'retry-id',
        'source-id',
        [{
          user: '@alice:routing.test',
          id: '*',
          content: { request_id: 'request' },
        }],
        config().e2ee,
        { enabled: true, maxBytes: 1048576 },
      )
    );
    const operations = await db.tx((conn) =>
      captureToDeviceOperations(conn, 'alice')
    );
    const routed = operations.filter((operation) => operation.kind === 'route');
    assert(
      routed.some((operation) => operation.value.owner === 'edge'),
      '200 must retain the unavailable other registry selector',
    );
    assertEquals(
      await db.query('SELECT * FROM to_device_intents'),
      [],
      'same-logical-server delivery must use the semantic link, not S2S to itself',
    );
    const before = operations;
    await tenant.tx((tx) =>
      tx.toDevice.send(
        device,
        tenant.serverName,
        'm.room_key_request',
        'retry-id',
        'different-source',
        [{
          user: '@alice:routing.test',
          id: 'later-device',
          content: { changed: true },
        }],
        config().e2ee,
        { enabled: true, maxBytes: 1048576 },
      )
    );
    assertEquals(
      await db.tx((conn) => captureToDeviceOperations(conn, 'alice')),
      before,
      'client transaction replay must not recapture or replace selector targets',
    );
    await tenant.tx((tx) =>
      tx.toDevice.receive(
        'peer.test',
        'collision',
        '@peer:peer.test',
        'm.room_key',
        tenant.serverName,
        [{
          user: '@alice:routing.test',
          id: 'MISSING',
          content: { original: true },
        }],
        config().e2ee,
      )
    );
    await assertRejects(
      () =>
        tenant.tx((tx) =>
          tx.toDevice.receive(
            'peer.test',
            'collision',
            '@peer:peer.test',
            'm.room_key',
            tenant.serverName,
            [{
              user: '@alice:routing.test',
              id: 'LAN',
              content: { changed: true },
            }],
            config().e2ee,
          )
        ),
      MatrixError,
      'to-device operation identity changed',
    );
    for (let index = 0; index < 100; index++) {
      await tenant.tx((tx) =>
        tx.toDevice.send(
          device,
          tenant.serverName,
          'm.room_key_request',
          'page-' + index,
          'page-' + index,
          [{ user: '@alice:routing.test', id: '*', content: { index } }],
          config().e2ee,
          { enabled: true, maxBytes: 1048576 },
        )
      );
    }
    const delivered = await tenant.tx((tx) =>
      tx.toDevice.deliver(device, {
        eSeq: 0,
        pSeq: 0,
        tSeq: 0,
        rSeq: 0,
        aSeq: 0,
        dSeq: 0,
        mSeq: 0,
        kSeq: 0,
      }, config().e2ee)
    );
    assertEquals(delivered.events.length, 100);
    const redelivery = await tenant.tx((tx) =>
      tx.toDevice.deliver(device, {
        eSeq: 0,
        pSeq: 0,
        tSeq: 0,
        rSeq: 0,
        aSeq: 0,
        dSeq: 0,
        mSeq: 0,
        kSeq: 0,
      }, config().e2ee)
    );
    assertEquals(
      redelivery,
      delivered,
      'lost HTTP response redelivers the same unacknowledged page',
    );
    const targets = await db.query(
      'SELECT source_id FROM to_device_inbox WHERE msg_pos<=? ORDER BY msg_pos',
      [delivered.token.mSeq],
    );
    const saved = await db.tx((conn) =>
      captureToDeviceOperations(conn, 'alice')
    );
    await tenant.tx((tx) =>
      tx.toDevice.acknowledge(device, {
        ...delivered.token,
        mSeq: delivered.token.mSeq + 1,
      })
    );
    await tenant.tx((tx) =>
      tx.toDevice.acknowledgeSliding(
        device,
        'other',
        encodeStreamToken(delivered.token),
      )
    );
    assertEquals((await db.query('SELECT * FROM to_device_inbox')).length, 101);
    assertEquals(
      await db.tx((conn) => captureToDeviceOperations(conn, 'alice')),
      saved,
    );
    await assertRejects(
      () =>
        tenant.tx(async (tx) => {
          await tx.toDevice.acknowledge(device, delivered.token);
          throw new Error('rollback acknowledged prefix');
        }),
      Error,
      'rollback acknowledged prefix',
    );
    assertEquals((await db.query('SELECT * FROM to_device_inbox')).length, 101);
    assertEquals(
      await db.tx((conn) => captureToDeviceOperations(conn, 'alice')),
      saved,
    );
    await tenant.tx((tx) => tx.toDevice.acknowledge(device, delivered.token));
    assertEquals((await db.query('SELECT * FROM to_device_inbox')).length, 1);
    const acknowledged = await db.tx((conn) =>
      captureToDeviceOperations(conn, 'alice')
    );
    const ack = acknowledged.filter((operation) => operation.kind === 'ack');
    assertEquals(
      ack.length,
      100,
      'only the actually issued page becomes target ACK facts',
    );
    assertEquals(
      ack.flatMap((operation) => operation.value.targetIds).sort(),
      targets.map((row) => String(row.source_id)).sort(),
    );
    const remaining = await tenant.tx((tx) =>
      tx.toDevice.deliverSliding(device, 'right', 100, config().e2ee)
    );
    assertEquals(remaining.events.length, 1);
    await tenant.tx((tx) =>
      tx.toDevice.acknowledgeSliding(device, 'wrong', remaining.nextBatch)
    );
    assertEquals((await db.query('SELECT * FROM to_device_inbox')).length, 1);
    await tenant.tx((tx) =>
      tx.toDevice.acknowledgeSliding(device, 'right', remaining.nextBatch)
    );
    assertEquals(await db.query('SELECT * FROM to_device_inbox'), []);
    assertEquals(
      (await db.tx((conn) => captureToDeviceOperations(conn, 'alice')))
        .filter((operation) => operation.kind === 'ack').length,
      101,
    );
    const remote = () =>
      tenant.tx((tx) =>
        tx.toDevice.receive(
          'peer.test',
          'cancel-message',
          '@peer:peer.test',
          'm.room_key',
          tenant.serverName,
          [{
            user: '@alice:routing.test',
            id: '*',
            content: { retired: true },
          }],
          config().e2ee,
        )
      );
    await remote();
    const [retiring] = await db.query(
      "SELECT target_id,device_incarnation FROM to_device_targets WHERE state='pending'",
    );
    await deleteDevices(tenant, 'alice', ['LAN']);
    assertEquals(
      (await db.query('SELECT state FROM to_device_targets WHERE target_id=?', [
        retiring.target_id,
      ]))[0].state,
      'cancel',
    );
    const cancelled = (await db.tx((conn) =>
      captureToDeviceOperations(conn, 'alice')
    ))
      .filter((operation) => operation.kind === 'cancel');
    assertEquals(cancelled.flatMap((operation) => operation.value.targetIds), [
      retiring.target_id,
    ]);
    await upsertDevice(tenant, 'alice', 'LAN');
    await remote();
    assertEquals(
      await db.query('SELECT * FROM to_device_inbox'),
      [],
      'an old wildcard and its lost response cannot attach to the replacement incarnation',
    );
    assert(
      (await deviceIdentity(tenant, 'alice', 'LAN')).generation >
        device.generation,
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('routed to-device: tenant38 upgrade preserves legacy inbox and never manufactures routed targets or ACKs', async () => {
  const dir = await Deno.makeTempDir();
  const storage = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  let store = await openStore(storage, {
    schemas: { tenant: historicalTenantSchema(38) },
  });
  try {
    const tenant = await openTenant(store, 'upgrade-routing.test', {
      create: true,
    });
    await tenant.tx((tx) => tx.users.insert('alice', 'Alice'));
    await upsertDevice(tenant, 'alice', 'LAN');
    const device = await deviceIdentity(tenant, 'alice', 'LAN');
    // Seed the actual old inbox shape. Today's sender owns an admission ledger
    // which did not exist at v37; don't execute a future writer on old storage.
    await (await store.tenant(tenant.serverName)).execute(
      'INSERT INTO to_device_inbox VALUES(?,?,?,?,?,?)',
      [
        'alice',
        'LAN',
        device.generation,
        1,
        'legacy-source',
        JSON.stringify({
          sender: '@alice:upgrade-routing.test',
          type: 'm.room_key_request',
          content: { kept: true },
        }),
      ],
    );
    const before = await (await store.tenant(tenant.serverName)).query(
      'SELECT * FROM to_device_inbox',
    );
    await store.close();
    store = await openStore(storage, { schemas: { tenant: tenantSchema } });
    const upgraded = await store.tenant(tenant.serverName);
    assertEquals(await upgraded.query('SELECT * FROM to_device_inbox'), before);
    for (
      const table of [
        'to_device_operations',
        'to_device_routes',
        'to_device_targets',
      ]
    ) {
      assertEquals(await upgraded.query('SELECT * FROM ' + table), []);
    }
    const fresh = await store.tenant('fresh-routing.test', { create: true });
    const shape =
      "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name LIKE 'to_device_%' ORDER BY type,name";
    assertEquals(await upgraded.query(shape), await fresh.query(shape));
    assertEquals(
      (await upgraded.query("SELECT v FROM meta WHERE k='schema_version'"))[0]
        .v,
      String(tenantSchema.version),
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('routed to-device: tenant39 admission upgrade preserves original routed hashes and fresh shape', async () => {
  const dir = await Deno.makeTempDir();
  const storage = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  let store = await openStore(storage, {
    schemas: { tenant: historicalTenantSchema(39) },
  });
  try {
    const db = await store.tenant('admission-upgrade.test', { create: true });
    await db.execute('INSERT INTO to_device_admissions VALUES(?,?,?,?)', [
      'federation',
      'remote.test',
      'kept',
      'a'.repeat(64),
    ]);
    await store.close();
    store = await openStore(storage, { schemas: { tenant: tenantSchema } });
    const upgraded = await store.tenant('admission-upgrade.test');
    assertEquals(await upgraded.query('SELECT * FROM to_device_admissions'), [{
      kind: 'federation',
      origin: 'remote.test',
      message_id: 'kept',
      payload_hash: 'a'.repeat(64),
      policy: 'routed',
    }]);
    const fresh = await store.tenant('admission-fresh.test', { create: true });
    const shape =
      "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name LIKE 'to_device_%' ORDER BY type,name";
    assertEquals(await upgraded.query(shape), await fresh.query(shape));
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
