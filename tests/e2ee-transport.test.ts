import { assert, assertEquals, assertRejects } from '@std/assert';
import { config, setConfigForTests } from '#engine/config.ts';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { roomSchema } from '#engine/room/schema.ts';
import { installServerHooks } from '#engine/server/startup.ts';
import { projectTenant } from '#engine/server/project-tenant.ts';
import { type Sender, startSender } from '#engine/federation/sender.ts';
import { resetCaCertsForTests } from '#engine/federation/client.ts';
import { registerToDevice } from '#engine/federation/todevice.ts';
import { eduState } from '#engine/federation/edus.ts';
import { receiveTransaction } from '#engine/federation/transactions.ts';
import { deviceIdentity } from '#engine/tenant/txns.ts';
import { startFakeServer } from './federation/fake-server.ts';
import { fakeFetcher } from './fixtures/remote.ts';
import { sendMessages } from '#engine/tenant/todevice.ts';
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
    const edus = eduState(await remote.server(), fake.name);
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
    await assertRejects(() => send(alice, 'three'));
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
      await tenantSchema.apply(conn);
      await conn.exec(
        'DROP TABLE inbound_to_device; DROP INDEX to_device_intents_sender; ALTER TABLE to_device_intents DROP COLUMN sender;',
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
