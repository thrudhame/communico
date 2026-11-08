import { assert, assertEquals } from '@std/assert';
import { config, setConfigForTests } from '#engine/config.ts';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { reconcileDeviceRoom } from '#engine/server/e2ee.ts';
import { projectTenant } from '#engine/server/project-tenant.ts';
import { type Sender, startSender } from '#engine/federation/sender.ts';
import { resetCaCertsForTests } from '#engine/federation/client.ts';
import {
  type DeviceListService,
  deviceListService,
} from '#engine/federation/device-lists.ts';
import { eduState } from '#engine/federation/edus.ts';
import { cachedDeviceKeys } from '#engine/server/remote-devices.ts';
import { startFakeServer } from './federation/fake-server.ts';
import { roomSchema } from '#engine/room/schema.ts';
import { bobJoins, genesis } from './fixtures/genesis.ts';
import { project } from '#engine/server/project.ts';
import { sendLocal } from '#engine/room/ingest.ts';
import { installServerHooks } from '#engine/server/startup.ts';
import {
  enqueueEdu,
  freezeBatch,
  frozenBatch,
} from '#engine/server/delivery.ts';
import { deviceDelta } from '#engine/e2ee-remote.ts';

const options = (dir: string) => ({
  dir,
  library: './.native/libturso_ffi.so',
  checkpointlogbytes: 65536,
  maxopenfiles: 8,
  idleseconds: 300,
});
async function waitFor(predicate: () => Promise<boolean> | boolean) {
  const end = Date.now() + 7000;
  while (!await predicate()) {
    assert(Date.now() < end, 'subscription consumer timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

Deno.test('all-room subscriptions seed empty lists, freeze per-peer chains and recover initial remote keys without an EDU', async () => {
  const dir = await Deno.makeTempDir();
  const previous = config().federation;
  setConfigForTests({
    federation: {
      cacerts: ['tests/fixtures/tls/ca.crt'],
      backoffstartmillihours: 1,
    },
  });
  resetCaCertsForTests();
  let store = await openStore(options(dir), {
    schemas: { server: serverSchema, tenant: tenantSchema },
  });
  let tenant = await openTenant(store, 'local.test', { create: true });
  let sender: Sender | undefined, recovery: DeviceListService | undefined;
  const alice = '@alice:local.test';
  let bob = '', accept = false, snapshots = 0;
  const attempts: string[] = [], received: Record<string, unknown>[] = [];
  const fake = await startFakeServer({
    ourKeyDoc: () =>
      Promise.resolve({
        server_name: tenant.serverName,
        verify_keys: { [tenant.keyId]: { key: tenant.publicB64 } },
      }),
    handlers: (req) => {
      if (req.path.includes('/user/devices/')) {
        assert(req.verified);
        snapshots++;
        return Response.json({
          user_id: bob,
          stream_id: 900,
          devices: [{
            device_id: 'REMOTE',
            keys: {
              user_id: bob,
              device_id: 'REMOTE',
              algorithms: [],
              keys: { 'ed25519:REMOTE': 'origin' },
              signatures: {},
            },
          }],
        });
      }
      if (!req.path.includes('/send/')) return null;
      assert(req.verified);
      const raw = new TextDecoder().decode(req.body!);
      attempts.push(raw);
      if (accept) {
        const body = req.json() as {
          edus: { edu_type: string; content: Record<string, unknown> }[];
        };
        received.push(
          ...body.edus.filter((e) => e.edu_type === 'm.device_list_update').map(
            (e) => e.content,
          ),
        );
      }
      return Response.json({ pdus: {} }, { status: accept ? 200 : 503 });
    },
  });
  bob = '@bob:' + fake.name;
  try {
    await tenant.tx((tx) => tx.users.insert('alice', 'Alice'));
    let db = await store.server();
    await db.tx((tx) =>
      reconcileDeviceRoom(tx, '!plain:local', [alice, bob], false, null, 1, [
        'local.test',
      ])
    );
    recovery = deviceListService(db, tenant, eduState(db, 'local.test'));
    recovery.start();
    sender = startSender({ store, signer: tenant.signer() });
    await waitFor(() => attempts.length > 0);
    await waitFor(async () =>
      await cachedDeviceKeys(db, bob, [], alice) !== null
    );
    assertEquals(snapshots, 1);
    assertEquals((await cachedDeviceKeys(db, bob, [], alice))!.REMOTE, {
      user_id: bob,
      device_id: 'REMOTE',
      algorithms: [],
      keys: { 'ed25519:REMOTE': 'origin' },
      signatures: {},
      unsigned: {},
    });
    await sender.stop();
    sender = undefined;
    await recovery.stop();
    recovery = undefined;
    // New work cannot change the frozen failed reset, even over process restart.
    await tenant.tx((tx) => tx.devices.upsert('PHONE', 'alice', 'Before'));
    await projectTenant(store, 'local.test');
    await tenant.tx((tx) => tx.devices.upsert('PHONE', 'alice', 'After'));
    await projectTenant(store, 'local.test');
    await store.close();
    store = await openStore(options(dir), {
      schemas: { server: serverSchema, tenant: tenantSchema },
    });
    tenant = await openTenant(store, 'local.test');
    db = await store.server();
    accept = true;
    sender = startSender({ store, signer: tenant.signer() });
    await waitFor(() => received.length === 3);
    assertEquals(attempts[1], attempts[0]);
    assertEquals(received[0], {
      user_id: alice,
      device_id: '',
      deleted: true,
      stream_id: 0,
      prev_id: [],
    });
    assertEquals(deviceDelta(received[0], config().e2ee).id, '');
    assertEquals(
      received.slice(1).map((
        r,
      ) => [r.stream_id, r.prev_id, r.device_display_name]),
      [[1, [0], 'Before'], [2, [1], 'After']],
    );
    assertEquals(
      (await tenant.tx((tx) => tx.devices.ofUser('alice'))).map((d) =>
        d.device_id
      ),
      ['PHONE'],
    );
    // Second room and same-domain peer do not reset a live subscription.
    await db.tx((tx) =>
      reconcileDeviceRoom(
        tx,
        '!second:local',
        [alice, bob, '@carol:' + fake.name],
        false,
        null,
        1,
        ['local.test'],
      )
    );
    await db.tx((tx) =>
      reconcileDeviceRoom(tx, '!plain:local', [alice], false, null, 2, [
        'local.test',
      ])
    );
    await projectTenant(store, 'local.test');
    assertEquals(received.length, 3);
    await db.tx((tx) =>
      reconcileDeviceRoom(tx, '!second:local', [alice], false, null, 2, [
        'local.test',
      ])
    );
    await tenant.tx((tx) => tx.devices.upsert('PHONE', 'alice', 'Unshared'));
    await projectTenant(store, 'local.test');
    await db.tx((tx) =>
      reconcileDeviceRoom(tx, '!plain:local', [alice, bob], false, null, 3, [
        'local.test',
      ])
    );
    sender.wake(fake.name);
    await waitFor(() => received.length === 4);
    assertEquals(received[3].prev_id, []);
    assertEquals(received[3].stream_id, 3);
    // First reset after device-before-join is based on the immutable current cut.
    assertEquals(received[3].device_display_name, 'Unshared');
    const progress = (await db.query(
      'SELECT sent_stream FROM device_subscriptions WHERE subject=? AND destination=?',
      [alice, fake.name],
    ))[0];
    await waitFor(async () =>
      Number(
        (await db.query(
          'SELECT sent_stream FROM device_subscriptions WHERE subject=? AND destination=?',
          [alice, fake.name],
        ))[0].sent_stream,
      ) === 3
    );
    assert(progress);
  } finally {
    await sender?.stop();
    await recovery?.stop();
    await fake.close();
    await store.close();
    setConfigForTests({ federation: previous });
    resetCaCertsForTests();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('published plaintext membership owns subscription activation, replay and last-room removal', async () => {
  const dir = await Deno.makeTempDir();
  const store = await openStore(options(dir), {
    schemas: { server: serverSchema, tenant: tenantSchema, room: roomSchema },
  });
  try {
    const tenant = await openTenant(store, 'test', { create: true });
    await tenant.tx(async (tx) => {
      await tx.users.insert('dev', 'Dev');
      await tx.devices.upsert('PHONE', 'dev', 'Already here');
    });
    await projectTenant(store, 'test');
    const g = await genesis(store, { roomId: '!subscriptions:test' });
    await bobJoins(g, '@bob:remote.test');
    await project(store, g.roomId);
    const db = await store.server();
    const rows = await db.query(
      "SELECT payload FROM edu_outbox WHERE edu_type='m.device_list_update'",
    );
    assertEquals(rows.length, 1);
    assertEquals(JSON.parse(String(rows[0].payload)), {
      user_id: g.creator,
      device_id: 'PHONE',
      device_display_name: 'Already here',
      stream_id: 1,
      prev_id: [],
    });
    await project(store, g.roomId);
    assertEquals(
      (await db.query(
        "SELECT source FROM edu_outbox WHERE edu_type='m.device_list_update'",
      )).length,
      1,
    );
    await sendLocal(g.room, {
      type: 'm.room.member',
      sender: g.creator,
      state_key: '@bob:remote.test',
      content: { membership: 'leave' },
    }, g.signer);
    await project(store, g.roomId);
    assertEquals(
      (await db.query('SELECT active FROM device_subscriptions'))[0].active,
      0,
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('v8 upgrade seeds existing published subscriptions once and preserves frozen reliable work', async () => {
  const dir = await Deno.makeTempDir();
  let store = await openStore(options(dir), {
    schemas: {
      tenant: tenantSchema,
      server: {
        version: 8,
        apply: async (db) => {
          await serverSchema.apply(db);
          await db.exec('DROP TABLE device_subscriptions');
        },
      },
    },
  });
  try {
    await openTenant(store, 'local.test', { create: true });
    let db = await store.server();
    await db.tx(async (tx) => {
      await reconcileDeviceRoom(
        tx,
        '!old:local',
        ['@empty:local.test', '@bob:remote.test'],
        false,
        null,
        10,
      );
      await enqueueEdu(tx, 'kept', 'remote.test', 'm.direct_to_device', {
        message_id: 'kept',
      });
    });
    const batch = {
      txnId: 'old',
      body: 'exact frozen bytes',
      rows: [],
      sources: ['kept'],
    };
    assert(await freezeBatch(db, 'remote.test', batch));
    await store.close();
    installServerHooks();
    store = await openStore(options(dir), {
      schemas: { server: serverSchema, tenant: tenantSchema },
    });
    db = await store.server();
    assertEquals(await frozenBatch(db, 'remote.test'), batch);
    assertEquals(
      (await db.query('SELECT active,queued_stream FROM device_subscriptions'))[
        0
      ],
      { active: 1, queued_stream: 0 },
    );
    assertEquals(
      (await db.query(
        "SELECT source FROM edu_outbox WHERE edu_type='m.device_list_update'",
      )).length,
      1,
    );
    await store.close();
    store = await openStore(options(dir), {
      schemas: { server: serverSchema, tenant: tenantSchema },
    });
    assertEquals(
      (await (await store.server()).query(
        "SELECT source FROM edu_outbox WHERE edu_type='m.device_list_update'",
      )).length,
      1,
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
