import { assert, assertEquals, assertRejects } from '@std/assert';
import { config, setConfigForTests } from '#engine/config.ts';
import { openStore } from '#engine/store/index.ts';
import { TENANT_V12 } from '#tests/fixtures/tenant-v12.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { roomSchema } from '#engine/room/schema.ts';
import { installServerHooks } from '#engine/server/startup.ts';
import { projectTenant } from '#engine/server/project-tenant.ts';
import { enqueueEdu } from '#engine/server/delivery.ts';
import { type Sender, startSender } from '#engine/federation/sender.ts';
import { resetCaCertsForTests } from '#engine/federation/client.ts';
import { registerToDevice } from '#engine/federation/todevice.ts';
import { eduState } from '#engine/federation/edus.ts';
import { receiveTransaction } from '#engine/federation/transactions.ts';
import { deviceIdentity } from '#engine/tenant/txns.ts';
import { startFakeServer } from './federation/fake-server.ts';
import { fakeFetcher } from './fixtures/remote.ts';
import { type Message, sendMessages } from '#engine/tenant/todevice.ts';
import { parseStreamToken } from '#engine/client/tokens.ts';

installServerHooks();
const schemas = {
  tenant: tenantSchema,
  server: serverSchema,
  room: roomSchema,
};
const options = (dir: string) => ({
  dir,
  library: './.native/libturso_ffi.so',
  checkpointlogbytes: 65536,
  maxopenfiles: 8,
  idleseconds: 300,
});
async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  ms = 10000,
) {
  const deadline = Date.now() + ms;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error('transport consumer timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

Deno.test('E3 tenant intents survive unprojected restart, retain admission until success and reach remote inbox exactly once', async () => {
  const dir = await Deno.makeTempDir();
  const previous = config().federation;
  setConfigForTests({
    federation: {
      cacerts: ['tests/fixtures/tls/ca.crt'],
      backoffstartmillihours: 1,
    },
  });
  resetCaCertsForTests();
  let store = await openStore(options(dir + '/source'), { schemas });
  const remote = await openStore(options(dir + '/recipient'), { schemas });
  let sender: Sender | undefined;
  let succeed = false;
  const requests: { path: string; body: string }[] = [];
  let accept: (id: string, body: unknown) => Promise<void>;
  let tenant = await openTenant(store, 'local.test', { create: true });
  const fake = await startFakeServer({
    ourKeyDoc: () =>
      Promise.resolve({
        server_name: tenant.serverName,
        verify_keys: { [tenant.keyId]: { key: tenant.publicB64 } },
      }),
    handlers: (req) => {
      if (!req.url.pathname.startsWith('/_matrix/federation/v1/send/')) {
        return null;
      }
      assert(req.verified);
      requests.push({
        path: req.path,
        body: new TextDecoder().decode(req.body!),
      });
      return accept(req.url.pathname.split('/').pop()!, req.json()).then(() =>
        Response.json({ pdus: {} }, { status: succeed ? 200 : 503 })
      );
    },
  });
  try {
    const recipient = await openTenant(remote, fake.name, { create: true });
    await recipient.tx(async (tx) => {
      await tx.users.insert('bob', 'Bob');
      await tx.devices.upsert('PHONE', 'bob', null);
    });
    const device = await deviceIdentity(recipient, 'bob', 'PHONE');
    const edus = eduState(await remote.server(), fake.name, remote);
    registerToDevice(edus, recipient);
    accept = async (id, body) => {
      await receiveTransaction('local.test', id, body, {
        store: remote,
        self: fake.name,
        edus,
        keys: { verifyEventSignature: () => Promise.resolve(false) },
        fetcher: fakeFetcher({}).fetcher,
      });
    };
    await tenant.tx(async (tx) => {
      for (const lp of ['alice', 'carol']) {
        await tx.users.insert(lp, lp);
        await tx.devices.upsert('PHONE', lp, null);
      }
    });
    const alice = await deviceIdentity(tenant, 'alice', 'PHONE');
    const carol = await deviceIdentity(tenant, 'carol', 'PHONE');
    const limits = { ...config().e2ee, maxkeys: 2, maxinboxmessages: 4 };
    const policy = { enabled: true, maxBytes: 1048576 };
    const messages = [{
      user: '@bob:' + fake.name,
      id: '*',
      content: { ciphertext: 'kept' },
    }];
    // Deliberately interrupt between tenant commit and its projection hook.
    await (await store.tenant('local.test')).tx((conn) =>
      sendMessages(
        conn,
        alice,
        'local.test',
        'm.test',
        'one',
        'logical-one',
        messages,
        limits,
        policy,
      )
    );
    assertEquals(
      await (await store.server()).query('SELECT * FROM edu_outbox'),
      [],
    );
    await store.close();
    store = await openStore(options(dir + '/source'), { schemas });
    tenant = await openTenant(store, 'local.test');
    const send = (d: typeof alice, id: string) =>
      tenant.tx((tx) =>
        tx.toDevice.send(
          d,
          'local.test',
          'm.test',
          id,
          id,
          messages,
          limits,
          policy,
        )
      );
    await send(alice, 'two');
    await assertRejects(() =>
      tenant.tx((tx) =>
        tx.toDevice.send(
          alice,
          'local.test',
          'm.test',
          'three',
          'three',
          [
            { user: '@alice:local.test', id: '*', content: { local: true } },
            ...messages,
          ],
          limits,
          policy,
        )
      )
    );
    assertEquals(
      (await tenant.tx((tx) =>
        tx.toDevice.deliver(alice, parseStreamToken('s0')!, limits)
      )).events,
      [],
    );
    assertEquals(
      await (await store.tenant('local.test')).query(
        "SELECT 1 FROM to_device_transactions WHERE txn_id='three'",
      ),
      [],
    );
    await send(carol, 'independent');
    const db = await store.tenant('local.test');
    assertEquals(
      (await db.query('SELECT COUNT(*) AS n FROM to_device_intents'))[0].n,
      3,
    );
    sender = startSender({
      store,
      signer: tenant.signer(),
      onDelivered: () => projectTenant(store, 'local.test'),
    });
    await waitFor(() => requests.length > 0);
    await sender.stop();
    sender = undefined;
    assertEquals(
      (await db.query('SELECT COUNT(*) AS n FROM to_device_intents'))[0].n,
      3,
      'failed transport cannot free admission',
    );
    const first = requests[0];
    await store.close();
    store = await openStore(options(dir + '/source'), { schemas });
    tenant = await openTenant(store, 'local.test');
    succeed = true;
    const resumedAt = requests.length;
    sender = startSender({
      store,
      signer: tenant.signer(),
      onDelivered: () => projectTenant(store, 'local.test'),
    });
    await waitFor(async () =>
      (await (await store.tenant('local.test')).query(
        'SELECT * FROM to_device_intents',
      )).length === 0
    );
    assertEquals(
      requests[resumedAt],
      first,
      'retry exact body and id after restart',
    );
    const delivered = await recipient.tx((tx) =>
      tx.toDevice.deliver(device, parseStreamToken('s0')!, limits)
    );
    assertEquals(delivered.events.length, 3);
    assertEquals(delivered.events.map((e) => e.sender).sort(), [
      '@alice:local.test',
      '@alice:local.test',
      '@carol:local.test',
    ]);
    await send(alice, 'three'); // Freed only after durable success.
    await waitFor(async () =>
      (await recipient.tx((tx) =>
        tx.toDevice.deliver(device, parseStreamToken('s0')!, limits)
      )).events.length === 4
    );
    await send(alice, 'one'); // Original client receipt still suppresses a new send.
    assertEquals(
      (await recipient.tx((tx) =>
        tx.toDevice.deliver(device, parseStreamToken('s0')!, limits)
      )).events.length,
      4,
    );
    await assertRejects(() =>
      tenant.tx((tx) =>
        tx.toDevice.send(
          alice,
          'local.test',
          'm.test',
          'oversize',
          'oversize',
          messages,
          limits,
          { enabled: true, maxBytes: 100 },
        )
      )
    );
    assertEquals(
      await (await store.tenant('local.test')).query(
        "SELECT 1 FROM to_device_transactions WHERE txn_id='oversize'",
      ),
      [],
    );
  } finally {
    await sender?.stop();
    await fake.close();
    await store.close();
    await remote.close();
    setConfigForTests({ federation: previous });
    resetCaCertsForTests();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('E3 v6 tenant upgrade preserves pending payloads, sender admission and inbox data', async () => {
  const dir = await Deno.makeTempDir();
  const previous = {
    version: 6,
    apply: async (conn: Parameters<typeof tenantSchema.apply>[0]) => {
      await conn.exec(TENANT_V12);
      await conn.exec(
        'DROP TABLE backup_sessions; DROP TABLE backup_versions; DROP TABLE key_signatures; DROP TABLE cross_signing_keys; DROP TABLE inbound_to_device; DROP INDEX to_device_intents_sender; ALTER TABLE to_device_intents DROP COLUMN sender; DROP INDEX to_device_intents_projection; ALTER TABLE to_device_intents DROP COLUMN projected; DROP INDEX to_device_intents_destination;',
      );
    },
  };
  let store = await openStore(options(dir), { schemas: { tenant: previous } });
  try {
    const db = await store.tenant('old.test', { create: true });
    const payload = JSON.stringify({
      sender: '@alice:old.test',
      type: 'm.test',
      message_id: 'old',
      messages: {},
    });
    await db.execute('INSERT INTO to_device_intents VALUES(?,?,?)', [
      'old:remote.test',
      'remote.test',
      payload,
    ]);
    await db.execute('INSERT INTO to_device_inbox VALUES(?,?,?,?,?,?)', [
      'alice',
      'PHONE',
      7,
      42,
      'old-inbox',
      '{"content":{"opaque":true}}',
    ]);
    await store.close();
    store = await openStore(options(dir), {
      schemas: { tenant: tenantSchema },
    });
    const upgraded = await store.tenant('old.test');
    assertEquals(await upgraded.query('SELECT * FROM to_device_intents'), [{
      source_id: 'old:remote.test',
      destination: 'remote.test',
      payload,
      sender: '@alice:old.test',
      projected: 0,
    }]);
    assertEquals(
      (await upgraded.query('SELECT msg_pos FROM to_device_inbox'))[0].msg_pos,
      42,
    );
    assertEquals(await upgraded.query('SELECT * FROM inbound_to_device'), []);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('E3 destination pressure preserves healthy delivery and atomic mixed-send admission across restart', async () => {
  const dir = await Deno.makeTempDir();
  const previous = config().federation;
  setConfigForTests({
    federation: {
      cacerts: ['tests/fixtures/tls/ca.crt'],
      backoffstartmillihours: 1,
    },
  });
  resetCaCertsForTests();
  let store = await openStore(options(dir + '/source'), { schemas });
  const remote = await openStore(options(dir + '/recipient'), { schemas });
  let tenant = await openTenant(store, 'local.test', { create: true });
  let sender: Sender | undefined;
  let blockedSucceeds = false, blockedRequests = 0;
  const ourKeyDoc = () =>
    Promise.resolve({
      server_name: tenant.serverName,
      verify_keys: { [tenant.keyId]: { key: tenant.publicB64 } },
    });
  const blocked = await startFakeServer({
    ourKeyDoc,
    handlers: (req) => {
      if (
        !req.url.pathname.startsWith('/_matrix/federation/v1/send/')
      ) return null;
      assert(req.verified);
      blockedRequests++;
      return Response.json({ pdus: {} }, {
        status: blockedSucceeds ? 200 : 503,
      });
    },
  });
  let accept: (id: string, body: unknown) => Promise<void>;
  const healthy = await startFakeServer({
    ourKeyDoc,
    handlers: (req) => {
      if (
        !req.url.pathname.startsWith('/_matrix/federation/v1/send/')
      ) return null;
      assert(req.verified);
      return accept(req.url.pathname.split('/').pop()!, req.json()).then(() =>
        Response.json({ pdus: {} })
      );
    },
  });
  try {
    const recipient = await openTenant(remote, healthy.name, { create: true });
    await recipient.tx(async (tx) => {
      await tx.users.insert('bob', 'Bob');
      await tx.devices.upsert('PHONE', 'bob', null);
    });
    const bob = await deviceIdentity(recipient, 'bob', 'PHONE');
    const edus = eduState(await remote.server(), healthy.name, remote);
    registerToDevice(edus, recipient);
    accept = async (id, body) => {
      await receiveTransaction('local.test', id, body, {
        store: remote,
        self: healthy.name,
        edus,
        keys: { verifyEventSignature: () => Promise.resolve(false) },
        fetcher: fakeFetcher({}).fetcher,
      });
    };
    await tenant.tx(async (tx) => {
      for (const lp of ['alice', 'carol', 'dave']) {
        await tx.users.insert(lp, lp);
        await tx.devices.upsert('PHONE', lp, null);
      }
    });
    const devices = await Promise.all(
      ['alice', 'carol', 'dave'].map((lp) =>
        deviceIdentity(tenant, lp, 'PHONE')
      ),
    );
    const limits = {
      ...config().e2ee,
      maxkeys: 4,
      maxinboxmessages: 4,
      maxdestinationmessages: 2,
    };
    const policy = { enabled: true, maxBytes: 1048576 };
    const message = (destination: string): Message => ({
      user: '@bob:' + destination,
      id: '*',
      content: { ciphertext: 'kept' },
    });
    const send = (
      index: number,
      id: string,
      messages = [message(blocked.name)],
      bounds = limits,
    ) =>
      tenant.tx((tx) =>
        tx.toDevice.send(
          devices[index],
          'local.test',
          'm.test',
          id,
          id,
          messages,
          bounds,
          policy,
        )
      );
    await send(0, 'blocked-one');
    await send(1, 'blocked-two');
    // A third sender cannot consume the reserved capacity; the whole send rolls back.
    await assertRejects(() =>
      send(2, 'mixed', [
        { user: '@dave:local.test', id: '*', content: { local: true } },
        message(healthy.name),
        message(blocked.name),
      ])
    );
    const db = await store.tenant('local.test');
    assertEquals(
      await db.query(
        "SELECT 1 FROM to_device_transactions WHERE txn_id='mixed'",
      ),
      [],
    );
    assertEquals(
      (await tenant.tx((tx) =>
        tx.toDevice.deliver(devices[2], parseStreamToken('s0')!, limits)
      )).events,
      [],
    );
    const retained = await db.query(
      'SELECT * FROM to_device_intents ORDER BY source_id',
    );
    assertEquals(retained.length, 2);
    await store.close();
    store = await openStore(options(dir + '/source'), { schemas });
    tenant = await openTenant(store, 'local.test');
    await assertRejects(() => send(2, 'blocked-three'));
    // Even a destination setting above the tenant budget must retain one slot for another peer.
    await assertRejects(() =>
      send(2, 'no-reserve', [message(blocked.name)], {
        ...limits,
        maxinboxmessages: 3,
        maxdestinationmessages: 100,
      })
    );
    await send(2, 'mixed', [message(healthy.name)]);
    sender = startSender({
      store,
      signer: tenant.signer(),
      onDelivered: () => projectTenant(store, 'local.test'),
    });
    await waitFor(async () =>
      blockedRequests > 0 &&
      (await recipient.tx((tx) =>
          tx.toDevice.deliver(bob, parseStreamToken('s0')!, limits)
        )).events.length === 1
    );
    assertEquals(
      (await recipient.tx((tx) =>
        tx.toDevice.deliver(bob, parseStreamToken('s0')!, limits)
      )).events[0].content,
      { ciphertext: 'kept' },
    );
    await waitFor(async () =>
      (await (await store.tenant('local.test')).query(
        'SELECT * FROM to_device_intents',
      )).length === 2
    );
    assertEquals(
      await (await store.tenant('local.test')).query(
        'SELECT * FROM to_device_intents ORDER BY source_id',
      ),
      retained,
    );
    await sender.stop();
    sender = undefined;
    blockedSucceeds = true;
    sender = startSender({
      store,
      signer: tenant.signer(),
      onDelivered: () => projectTenant(store, 'local.test'),
    });
    await waitFor(async () =>
      (await (await store.tenant('local.test')).query(
        'SELECT * FROM to_device_intents',
      )).length === 0
    );
    await send(2, 'blocked-three');
    await waitFor(async () =>
      (await (await store.tenant('local.test')).query(
        'SELECT * FROM to_device_intents',
      )).length === 0
    );
  } finally {
    await sender?.stop();
    await blocked.close();
    await healthy.close();
    await store.close();
    await remote.close();
    setConfigForTests({ federation: previous });
    resetCaCertsForTests();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('E3 v8 destination admission upgrade retains over-cap accepted intents', async () => {
  const dir = await Deno.makeTempDir();
  const oldSchema = {
    version: 8,
    apply: async (conn: Parameters<typeof tenantSchema.apply>[0]) => {
      await conn.exec(TENANT_V12);
      await conn.exec(
        'DROP TABLE backup_sessions; DROP TABLE backup_versions; DROP TABLE key_signatures; DROP TABLE cross_signing_keys; DROP INDEX to_device_intents_destination',
      );
    },
  };
  let store = await openStore(options(dir), {
    schemas: { ...schemas, tenant: oldSchema },
  });
  try {
    let tenant = await openTenant(store, 'upgrade.test', { create: true });
    const db = await store.tenant('upgrade.test');
    await db.exec(
      "INSERT INTO users(localpart,display_name) VALUES('alice','Alice'); INSERT INTO devices VALUES('PHONE','alice',1,NULL);",
    );
    for (let i = 0; i < 3; i++) {
      await db.execute(
        'INSERT INTO to_device_intents(source_id,destination,payload,sender,projected) VALUES(?,?,?,?,1)',
        [
          'kept-' + i,
          'blocked.test',
          JSON.stringify({
            sender: '@alice:upgrade.test',
            message_id: String(i),
          }),
          '@alice:upgrade.test',
        ],
      );
    }
    const kept = await db.query(
      'SELECT * FROM to_device_intents ORDER BY source_id',
    );
    await store.close();
    store = await openStore(options(dir), { schemas });
    tenant = await openTenant(store, 'upgrade.test');
    const upgraded = await store.tenant('upgrade.test');
    assertEquals(
      await upgraded.query(
        'SELECT * FROM to_device_intents ORDER BY source_id',
      ),
      kept,
    );
    assertEquals(
      (await upgraded.query("SELECT v FROM meta WHERE k='schema_version'"))[0]
        .v,
      String(tenantSchema.version),
    );
    assertEquals(
      (await upgraded.query(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='to_device_intents_destination'",
      )).length,
      1,
    );
    const alice = await deviceIdentity(tenant, 'alice', 'PHONE');
    const limits = {
      ...config().e2ee,
      maxkeys: 10,
      maxinboxmessages: 5,
      maxdestinationmessages: 2,
    };
    const send = (destination: string) =>
      tenant.tx((tx) =>
        tx.toDevice.send(
          alice,
          'upgrade.test',
          'm.test',
          'retry',
          'retry',
          [{
            user: '@bob:' + destination,
            id: '*',
            content: { ciphertext: 'kept' },
          }],
          limits,
          { enabled: true, maxBytes: 1048576 },
        )
      );
    await assertRejects(() => send('blocked.test'));
    await send('healthy.test');
    assertEquals(
      await upgraded.query(
        "SELECT * FROM to_device_intents WHERE destination='blocked.test' ORDER BY source_id",
      ),
      kept,
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('E3 intent projection batches new work and never rescans retained admission payloads', async () => {
  const dir = await Deno.makeTempDir();
  const store = await openStore(options(dir), { schemas });
  try {
    const db = await store.tenant('projection.test', { create: true });
    await db.tx(async (tx) => {
      for (let i = 0; i < 575; i++) {
        await tx.execute(
          'INSERT INTO to_device_intents(source_id,destination,payload,sender) VALUES(?,?,?,?)',
          [
            'intent-' + i,
            'remote.test',
            JSON.stringify({ message_id: String(i) }),
            '@a:projection.test',
          ],
        );
      }
    });
    const server = await store.server();
    const actualTenant = store.tenant.bind(store);
    let transactions = 0, payloadReads = 0;
    store.server = () =>
      Promise.resolve({
        ...server,
        tx: (fn, opts) => {
          transactions++;
          return server.tx(fn, opts);
        },
      });
    store.tenant = async (...args) => {
      const tenant = await actualTenant(...args);
      return {
        ...tenant,
        query: async (sql, values) => {
          const rows = await tenant.query(sql, values);
          if (sql.includes('to_device_intents')) {
            payloadReads += rows.filter((r) =>
              Object.hasOwn(r, 'payload')
            ).length;
          }
          return rows;
        },
      };
    };
    await projectTenant(store, 'projection.test');
    assertEquals((await server.query('SELECT * FROM edu_outbox')).length, 575);
    assert(
      transactions <= 2,
      'one server transaction per bounded batch, not per row: ' + transactions,
    );
    transactions = 0;
    payloadReads = 0;
    await projectTenant(store, 'projection.test');
    assertEquals(payloadReads, 0, 'retained admission is not unprojected work');
    assertEquals(transactions, 0);
    // Completion clears only this tenant's rows, not other owners' sent work.
    await server.tx(async (tx) => {
      await enqueueEdu(
        tx,
        'tenant:other.test:to-device:kept',
        'remote.test',
        'm.direct_to_device',
        {},
      );
      await enqueueEdu(
        tx,
        'tenant:projection.test:to-device:other-kind',
        'remote.test',
        'm.device_list_update',
        {},
      );
    });
    await server.execute("UPDATE edu_outbox SET state='sent'");
    await projectTenant(store, 'projection.test');
    assertEquals(await db.query('SELECT * FROM to_device_intents'), []);
    assertEquals(
      (await server.query('SELECT source FROM edu_outbox ORDER BY source')).map(
        (r) => r.source,
      ),
      [
        'tenant:other.test:to-device:kept',
        'tenant:projection.test:to-device:other-kind',
      ],
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('E3 intent projection resumes both cross-file commit boundaries without replaying a completed send', async () => {
  const dir = await Deno.makeTempDir();
  let store = await openStore(options(dir), { schemas });
  try {
    const db = await store.tenant('crash.test', { create: true });
    await db.execute(
      'INSERT INTO to_device_intents(source_id,destination,payload,sender) VALUES(?,?,?,?)',
      ['kept', 'remote.test', '{"message_id":"kept"}', '@a:crash.test'],
    );
    const originalTenant = store.tenant.bind(store);
    store.tenant = async (...args) => {
      const tenant = await originalTenant(...args);
      return {
        ...tenant,
        tx: () => Promise.reject(new Error('interrupted after server enqueue')),
      };
    };
    await assertRejects(
      () => projectTenant(store, 'crash.test'),
      Error,
      'interrupted after server enqueue',
    );
    const before = await (await store.server()).query(
      'SELECT * FROM edu_outbox',
    );
    assertEquals(before.length, 1);
    await store.close();
    store = await openStore(options(dir), { schemas });
    await projectTenant(store, 'crash.test');
    const server = await store.server();
    assertEquals(
      await server.query('SELECT * FROM edu_outbox'),
      before,
      'roll-forward retains position and immutable payload',
    );
    await server.execute("UPDATE edu_outbox SET state='sent'");
    store.server = () =>
      Promise.resolve({
        ...server,
        tx: () =>
          Promise.reject(new Error('interrupted after tenant completion')),
      });
    await assertRejects(
      () => projectTenant(store, 'crash.test'),
      Error,
      'interrupted after tenant completion',
    );
    assertEquals(
      await (await store.tenant('crash.test')).query(
        'SELECT * FROM to_device_intents',
      ),
      [],
    );
    assertEquals(
      (await server.query('SELECT state FROM edu_outbox'))[0].state,
      'sent',
    );
    await store.close();
    store = await openStore(options(dir), { schemas });
    await projectTenant(store, 'crash.test');
    assertEquals(
      await (await store.server()).query('SELECT * FROM edu_outbox'),
      [],
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
