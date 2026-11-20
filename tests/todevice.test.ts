import { assert, assertEquals, assertRejects } from '@std/assert';
import { openStore } from '#engine/store/index.ts';
import { TENANT_V12 } from '#tests/fixtures/tenant-v12.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { registerUser } from '#engine/tenant/users.ts';
import { deviceIdentity } from '#engine/tenant/txns.ts';
import {
  encodeStreamToken,
  parseStreamToken,
  type StreamToken,
} from '#engine/client/tokens.ts';
import type { KeyLimits } from '#engine/tenant/e2ee.ts';

const limits: KeyLimits = {
  maxrequestbytes: 1048576,
  maxkeybytes: 65536,
  maxkeys: 1000,
  maxonetimekeys: 10000,
  maxinboxmessages: 10000,
  maxdestinationmessages: 1000,
  maxbackupsessions: 100000,
  maxbackupversions: 100,
  maxbackupbytes: 67108864,
};
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

Deno.test('E2 v5 upgrade preserves accepted keys and credentials while adding inbox storage', async () => {
  const dir = await Deno.makeTempDir();
  const config = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  const previous = {
    version: 5,
    apply: async (db: Parameters<typeof tenantSchema.apply>[0]) => {
      await db.exec(TENANT_V12);
      for (
        const table of [
          'to_device_inbox',
          'to_device_transactions',
          'sync_deliveries',
          'device_ack',
          'to_device_intents',
          'inbound_to_device',
          'cross_signing_keys',
          'key_signatures',
          'backup_sessions',
          'backup_versions',
        ]
      ) await db.exec('DROP TABLE ' + table);
    },
  };
  let store = await openStore(config, { schemas: { tenant: previous } });
  try {
    const db = await store.tenant('upgrade.test', { create: true });
    await db.exec(
      "INSERT INTO users(localpart) VALUES('a'); INSERT INTO devices VALUES('PHONE','a',7,'name'); INSERT INTO one_time_keys VALUES('a','PHONE',7,'curve25519','one',1,'\"kept\"'); INSERT INTO credentials(localpart,kind,hash) VALUES('a','password','kept-phc')",
    );
    await store.close();
    store = await openStore(config, { schemas: { tenant: tenantSchema } });
    const upgraded = await store.tenant('upgrade.test');
    assertEquals(
      (await upgraded.query('SELECT key_json FROM one_time_keys'))[0].key_json,
      '"kept"',
    );
    assertEquals(
      (await upgraded.query('SELECT hash FROM credentials'))[0].hash,
      'kept-phc',
    );
    assertEquals(
      (await upgraded.query('SELECT generation FROM devices'))[0].generation,
      7,
    );
    assertEquals(await upgraded.query('SELECT * FROM to_device_inbox'), []);
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
Deno.test('E2 token grammar preserves legacy positions and rejects malformed/unsafe components', () => {
  assertEquals(parseStreamToken('s1_p2_t3_r4_a5'), {
    ...token,
    eSeq: 1,
    pSeq: 2,
    tSeq: 3,
    rSeq: 4,
    aSeq: 5,
  });
  assertEquals(
    parseStreamToken(
      encodeStreamToken({ ...token, dSeq: 6, mSeq: 7, kSeq: 8 }),
    ),
    { ...token, dSeq: 6, mSeq: 7, kSeq: 8 },
  );
  for (
    const raw of ['s-1', 's1_m9007199254740992', 's1_k1_m2', 's1_mNaN', 's1_j2']
  ) assertEquals(parseStreamToken(raw), null);
});

Deno.test('E2 inbox survives reopen and concurrent/out-of-order issued cuts cannot skip unseen rows', async () => {
  const dir = await Deno.makeTempDir();
  const config = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  let store = await openStore(config, { schemas: { tenant: tenantSchema } });
  try {
    let tenant = await openTenant(store, 'a.test', { create: true });
    const a = await registerUser(tenant, {
      localpart: 'a',
      password: 'pw',
      deviceId: 'PHONE',
    });
    await registerUser(tenant, {
      localpart: 'b',
      password: 'pw',
      deviceId: 'PHONE',
    });
    const sender = await deviceIdentity(tenant, 'a', 'PHONE');
    const receiver = await deviceIdentity(tenant, 'b', 'PHONE');
    const send = (id: string, n: number) =>
      tenant.tx((tx) =>
        tx.toDevice.send(
          sender,
          'a.test',
          'm.test',
          id,
          id,
          [{
            user: '@b:a.test',
            id: '*',
            content: { n },
          }],
          limits,
          { enabled: true, maxBytes: 1048576 },
        )
      );
    await send('1', 1);
    const old = await tenant.tx((tx) =>
      tx.toDevice.deliver(receiver, token, limits)
    );
    await store.close();
    store = await openStore(config, { schemas: { tenant: tenantSchema } });
    tenant = await openTenant(store, 'a.test');
    const pending = await tenant.tx((tx) =>
      tx.toDevice.deliver(receiver, token, limits)
    );
    assertEquals(pending.events, [{
      sender: a.user_id,
      type: 'm.test',
      content: { n: 1 },
    }]);
    await send('2', 2);
    const newer = await tenant.tx((tx) =>
      tx.toDevice.deliver(receiver, token, limits)
    );
    assertEquals(newer.events.length, 2);
    // The older response acknowledges only the cut it returned, even if a newer one is in flight.
    await tenant.tx((tx) => tx.toDevice.acknowledge(receiver, old.token));
    assertEquals(
      (await tenant.tx((tx) => tx.toDevice.deliver(receiver, token, limits)))
        .events.map((e) => e.content),
      [{ n: 2 }],
    );
    await Promise.all([
      tenant.tx((tx) => tx.toDevice.acknowledge(receiver, newer.token)),
      tenant.tx((tx) => tx.toDevice.acknowledge(receiver, old.token)),
    ]);
    assertEquals(await tenant.tx((tx) => tx.toDevice.pending(receiver)), false);
    await send('3', 3);
    await tenant.tx((tx) => tx.toDevice.acknowledge(receiver, old.token));
    assertEquals(
      (await tenant.tx((tx) => tx.toDevice.deliver(receiver, token, limits)))
        .events.map((e) => e.content),
      [{ n: 3 }],
    );
    await assertRejects(() =>
      tenant.tx((tx) =>
        tx.toDevice.acknowledge(receiver, { ...token, kSeq: 99999 })
      )
    );
    const raw = await store.tenant('a.test');
    assertEquals(
      (await raw.query("SELECT v FROM meta WHERE k='schema_version'"))[0].v,
      String(tenantSchema.version),
    );
    assert(await tenant.tx((tx) => tx.toDevice.head()) >= 3);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('E2 inbox grows beyond the remote intent budget, survives reopen, and only issued page ACKs delete it', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'inbox-retention-' });
  const options = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  let store = await openStore(options, { schemas: { tenant: tenantSchema } });
  const bounds = { ...limits, maxinboxmessages: 1 };
  try {
    let tenant = await openTenant(store, 'growth.test', { create: true });
    await tenant.tx(async (tx) => {
      await tx.users.insert('alice', 'Alice');
      await tx.devices.upsert('PHONE', 'alice', null);
    });
    const device = await deviceIdentity(tenant, 'alice', 'PHONE');
    const send = (
      tx: Parameters<Parameters<typeof tenant.tx>[0]>[0],
      n: number,
    ) =>
      tx.toDevice.send(
        device,
        tenant.serverName,
        'm.room_key',
        String(n),
        String(n),
        [{
          user: '@alice:growth.test',
          id: '*',
          content: { n },
        }],
        bounds,
        { enabled: true, maxBytes: 1048576 },
      );
    await tenant.tx(async (tx) => {
      for (let n = 0; n < 105; n++) await send(tx, n);
    });
    await store.close();
    store = await openStore(options, { schemas: { tenant: tenantSchema } });
    tenant = await openTenant(store, 'growth.test');
    const raw = await store.tenant('growth.test');
    const contents = (events: { content?: unknown }[]) =>
      events.map((e) => e.content);
    const all = Array.from({ length: 105 }, (_, n) => ({ n }));
    const first = await tenant.tx((tx) =>
      tx.toDevice.deliver(device, token, bounds)
    );
    assertEquals(contents(first.events), all.slice(0, 100));
    assertEquals(
      (await raw.query('SELECT * FROM to_device_inbox')).length,
      105,
    );
    await tenant.tx((tx) =>
      tx.toDevice.acknowledge(device, { ...token, mSeq: first.token.mSeq + 1 })
    );
    assertEquals(
      (await raw.query('SELECT * FROM to_device_inbox')).length,
      105,
      'an unissued position cannot delete retained rows',
    );
    const sliding = await tenant.tx((tx) =>
      tx.toDevice.deliverSliding(device, 'one', 100, bounds)
    );
    assertEquals(contents(sliding.events), all.slice(0, 100));
    await tenant.tx((tx) =>
      tx.toDevice.acknowledgeSliding(device, 'two', sliding.nextBatch)
    );
    assertEquals(
      (await raw.query('SELECT * FROM to_device_inbox')).length,
      105,
    );
    await tenant.tx((tx) => tx.toDevice.acknowledge(device, first.token));
    const rest = await tenant.tx((tx) =>
      tx.toDevice.deliverSliding(device, 'one', 100, bounds)
    );
    assertEquals(contents(rest.events), all.slice(100));
    await tenant.tx((tx) =>
      tx.toDevice.acknowledgeSliding(device, 'one', rest.nextBatch)
    );
    assertEquals(await raw.query('SELECT * FROM to_device_inbox'), []);
    await tenant.tx((tx) => send(tx, 105));
    await tenant.tx((tx) => tx.toDevice.acknowledge(device, first.token));
    assertEquals(
      contents(
        (await tenant.tx((tx) => tx.toDevice.deliver(device, token, bounds)))
          .events,
      ),
      [{ n: 105 }],
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
