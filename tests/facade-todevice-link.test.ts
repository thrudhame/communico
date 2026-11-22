import { assert, assertEquals, assertRejects } from '@std/assert';
import Olm from '@matrix-org/olm';
import { validateUpload } from '#engine/tenant/e2ee.ts';
import { config, setConfigForTests } from '#engine/config.ts';
import {
  AccountSnapshots,
  exportAccountAuth,
} from '#engine/facade/accounts.ts';
import type { DeviceOperations } from '#engine/facade/devices.ts';
import type { ToDeviceOperations } from '#engine/facade/todevice.ts';
import { enrolledTenant, initializeNode } from '#engine/facade/identity.ts';
import { Journal } from '#engine/facade/journal.ts';
import { exportOwnerControl, OwnerControls } from '#engine/facade/ownership.ts';
import { Pairings } from '#engine/facade/pairing.ts';
import {
  LINK_CAPABILITIES,
  LINK_SUPPORTED,
  LinkError,
  type LinkRecord,
  recordHash,
} from '#engine/facade/protocol.ts';
import { bindRole } from '#engine/facade/role.ts';
import { serverSchema } from '#engine/server/schema.ts';
import type { Conn } from '#engine/store/db.ts';
import { openStore, type Store } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { deleteDevices, upsertDevice } from '#engine/tenant/devices.ts';
import { deviceIdentity } from '#engine/tenant/txns.ts';
import { onTenantStream } from '#engine/tenant/streams.ts';
import { projectTenant } from '#engine/server/project-tenant.ts';
import {
  pendingTenantProjection,
  recordTenantProjection,
  setTenantProjector,
} from '#engine/tenant/hooks.ts';
import { insertMessage } from '#engine/tenant/todevice.ts';
import { acceptIngressEdu } from '#engine/facade/ingress-edus.ts';
import { eduState } from '#engine/federation/edus.ts';
import { registerToDevice } from '#engine/federation/todevice.ts';
import { Mailbox } from '#engine/facade/mailbox.ts';
import { HomeIngress } from '#engine/facade/drain.ts';
import {
  fakeFetcher,
  fakeKeyResolver,
  makeRemoteServer,
} from './fixtures/remote.ts';
import { directOnly, makeDoc } from './federation/doc-helper.ts';
import { requestCanonical } from '#engine/federation/request-signature.ts';
import { captureRequestEvidence } from '#engine/federation/request-evidence.ts';
import { keyStore } from '#engine/federation/keys.ts';
import { signJson } from '#engine/signing-primitives.js';
import { canonicalJson } from '#engine/canonical.ts';
import {
  captureDeviceStreamFloor,
  installDeviceStreamFloor,
} from '#engine/tenant/device-stream.ts';

// Let the capability regression fail before the new module exists, rather than
// mistaking a static resolution error for the missing durable reader contract.
async function coordinator(
  ...args: ConstructorParameters<typeof DeviceOperations>
) {
  const module = await import('#engine/facade/' + 'todevice.ts');
  return new module.ToDeviceOperations(...args) as ToDeviceOperations;
}

async function fixture() {
  const dir = await Deno.makeTempDir({ prefix: 'facade-todevice-link-' });
  const open = (side: string) =>
    openStore({
      dir: dir + '/' + side,
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 300,
    }, { schemas: { server: serverSchema, tenant: tenantSchema } });
  const home = await open('home'), edge = await open('edge');
  await bindRole(home, { role: 'home', server: 'logical.test', node: '' });
  await bindRole(edge, {
    role: 'facade',
    server: 'logical.test',
    node: 'edge_a',
  });
  const ht = await openTenant(home, 'logical.test', { create: true });
  await ht.tx(async (tx) => {
    await tx.users.insert('alice', 'Alice');
    await tx.users.insert('bob', 'Bob');
  });
  await upsertDevice(ht, 'alice', 'LAN');
  const node = await initializeNode(
    await edge.server(),
    'logical.test',
    'edge_a',
  );
  const hp = new Pairings(
    await home.server(),
    ht.signer(),
    ht.publicB64,
    'a'.repeat(64),
  );
  const fp = new Pairings(
    await edge.server(),
    node.signer(),
    node.publicKey,
    'b'.repeat(64),
    node,
  );
  const bundle = await hp.create({
    node: 'edge_a',
    url: 'https://facade.test',
    facadePin: 'b'.repeat(64),
    expires: Date.now() + 60000,
    required: [...LINK_CAPABILITIES],
  });
  await fp.accept(bundle);
  await hp.confirm(
    bundle.id,
    await fp.complete(
      bundle.id,
      await hp.grant(
        bundle.id,
        await fp.challenge(bundle.id, bundle.secret, 'a'.repeat(64)),
      ),
      'a'.repeat(64),
    ),
  );
  const et = await enrolledTenant(edge, fp, 'logical.test', 'edge_a');
  const hj = new Journal(await home.server(), LINK_SUPPORTED),
    ej = new Journal(await edge.server(), LINK_SUPPORTED);
  const owners = new OwnerControls(
    await edge.server(),
    await edge.tenant('logical.test'),
    fp,
    node,
  );
  const control = await exportOwnerControl(home, ht, hp, bundle.id);
  await ej.receive('home', [control]);
  await owners.apply(ej, control);
  const auth = await exportAccountAuth(home, ht, hp, bundle.id, 'alice', false);
  await ej.receive('home', [auth]);
  await new AccountSnapshots(edge, et, fp, owners).apply(ej, auth);
  await upsertDevice(et, 'alice', 'PHONE');
  return {
    open,
    home,
    edge,
    ht,
    et,
    hp,
    fp,
    node,
    bundle,
    owners,
    hj,
    ej,
    hs: await coordinator(home, ht, hp),
    es: await coordinator(edge, et, fp, node),
    async close() {
      await home.close();
      await edge.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

async function send(
  f: Awaited<ReturnType<typeof fixture>>,
  side: 'home' | 'edge' = 'edge',
) {
  const tenant = side === 'home' ? f.ht : f.et;
  const device = await deviceIdentity(
    tenant,
    'alice',
    side === 'home' ? 'LAN' : 'PHONE',
  );
  await tenant.tx((tx) =>
    tx.toDevice.send(
      device,
      tenant.serverName,
      'm.room_key_request',
      'retry',
      'source',
      [{
        user: '@alice:logical.test',
        id: '*',
        content: { request_id: 'fresh-session' },
      }],
      config().e2ee,
      { enabled: true, maxBytes: 1048576 },
    )
  );
  return device;
}

function rehash(record: LinkRecord): LinkRecord {
  const { hash: _hash, ...body } = record;
  return { ...body, hash: recordHash(body) };
}

Deno.test('review capture: legacy projection debt cannot freeze an empty export before later to-device delivery', async () => {
  const f = await fixture();
  try {
    const db = await f.edge.tenant('logical.test');
    const legacy = await db.tx(recordTenantProjection);
    await db.execute(
      "INSERT INTO counters(name,value) VALUES('facade_projection_legacy',?)",
      [legacy],
    );
    setTenantProjector(projectTenant);
    assertEquals(await f.es.export('alice'), []);
    assertEquals(
      await pendingTenantProjection(db),
      0,
      'the independent old projection debt is discharged',
    );
    await send(f);
    const records = await f.es.export('alice');
    assert(
      records.length > 0,
      'an empty capture must remain eligible under the same export binding',
    );
    for (const record of records) {
      await f.hj.receive('edge_a', [record]);
      await f.hs.apply(f.hj, record, f.bundle.id);
    }
    const lan = await deviceIdentity(f.ht, 'alice', 'LAN');
    const page = await f.ht.tx((tx) =>
      tx.toDevice.deliverSliding(lan, 'legacy-capture', 100, config().e2ee)
    );
    assertEquals(page.events.length, 1);
    assertEquals(page.events[0].content, { request_id: 'fresh-session' });
    assertEquals(
      await f.es.export('alice'),
      [],
      'nonempty capture retains its exact completed cut',
    );
  } finally {
    setTenantProjector(undefined);
    await f.close();
  }
});

Deno.test('to-device link: idle exports do no retained-history signing or journal work', async () => {
  const f = await fixture();
  try {
    await send(f);
    let signatures = 0;
    const signer = f.node.signer();
    const owner = await coordinator(f.edge, f.et, f.fp, {
      ...f.node,
      signer: () => ({
        ...signer,
        sign: (body: string) => {
          signatures++;
          return signer.sign(body);
        },
      }),
    });
    const records = await owner.export('alice');
    assert(records.length > 0);
    const first = signatures;
    const db = await f.edge.server();
    const rows = await db.query('SELECT * FROM facade_records');
    await owner.export('alice');
    assertEquals(
      signatures,
      first,
      'an idle scan must not sign retained operations',
    );
    assertEquals(await db.query('SELECT * FROM facade_records'), rows);
    assertEquals(await owner.export('alice'), []);
    // An independent coordinator after reopening the server file observes the
    // same durable export cut; source history is retained, not destructively read.
    const operations = await (await f.edge.tenant('logical.test')).query(
      'SELECT * FROM to_device_operations',
    );
    await f.edge.close();
    const cold = await f.open('edge');
    try {
      const node = await initializeNode(
        await cold.server(),
        'logical.test',
        'edge_a',
      );
      const pairings = new Pairings(
        await cold.server(),
        node.signer(),
        node.publicKey,
        'b'.repeat(64),
        node,
      );
      const tenant = await enrolledTenant(
        cold,
        pairings,
        'logical.test',
        'edge_a',
      );
      assertEquals(
        await (await coordinator(cold, tenant, pairings, node)).export('alice'),
        [],
      );
      assertEquals(
        await (await cold.tenant('logical.test')).query(
          'SELECT * FROM to_device_operations',
        ),
        operations,
      );
    } finally {
      await cold.close();
    }
  } finally {
    await f.close();
  }
});

Deno.test('to-device link: export cut rolls back with journal append and later scans export only new intent', async () => {
  for (const side of ['home', 'edge'] as const) {
    const f = await fixture();
    const store = side === 'home' ? f.home : f.edge;
    const original = store.server.bind(store);
    const owner = side === 'home' ? f.hs : f.es;
    const pairing = side === 'home' ? f.bundle.id : undefined;
    try {
      await send(f, side);
      const db = await original();
      const recordsBefore = await db.query('SELECT * FROM facade_records');
      const cutsBefore = await db.query('SELECT * FROM facade_exports');
      let faults = 0;
      store.server = () =>
        Promise.resolve({
          ...db,
          tx: (fn, options) =>
            db.tx((conn) =>
              fn(
                new Proxy(conn, {
                  get(target, key) {
                    if (key === 'execute') {
                      return async (...args: Parameters<Conn['execute']>) => {
                        const result = await target.execute(...args);
                        if (args[0].startsWith('INSERT INTO facade_exports(')) {
                          faults++;
                          throw new Error('fault after source cut write');
                        }
                        return result;
                      };
                    }
                    const value = Reflect.get(target, key);
                    return typeof value === 'function'
                      ? value.bind(target)
                      : value;
                  },
                }),
              ), options),
        });
      await assertRejects(
        () => owner.export('alice', pairing),
        Error,
        'fault after source cut write',
      );
      store.server = original;
      assertEquals(faults, 1);
      assertEquals(
        await db.query('SELECT * FROM facade_records'),
        recordsBefore,
      );
      assertEquals(await db.query('SELECT * FROM facade_exports'), cutsBefore);
      const first = await owner.export('alice', pairing);
      assert(
        first.length > 0,
        'rollback must leave every source operation exportable',
      );
      assertEquals(await owner.export('alice', pairing), []);
      const tenant = side === 'home' ? f.ht : f.et;
      const device = await deviceIdentity(
        tenant,
        'alice',
        side === 'home' ? 'LAN' : 'PHONE',
      );
      await tenant.tx((tx) =>
        tx.toDevice.send(
          device,
          tenant.serverName,
          'm.room_key_request',
          'new-intent',
          'new-body',
          [{
            user: '@alice:logical.test',
            id: '*',
            content: { request_id: 'second-session' },
          }],
          config().e2ee,
          { enabled: true, maxBytes: 1048576 },
        )
      );
      const second = await owner.export('alice', pairing);
      assert(second.length > 0);
      const previous = new Set(first.map((record) => record.operationId));
      assert(second.every((record) => !previous.has(record.operationId)));
      assertEquals(await owner.export('alice', pairing), []);
    } finally {
      store.server = original;
      await f.close();
    }
  }
});

Deno.test('to-device crypto: owner-claimed fresh Olm key carries a Megolm session across cold home drain and back', async () => {
  await Olm.init();
  const alice = new Olm.Account(), bob = new Olm.Account();
  const outbound = new Olm.Session(), inbound = new Olm.Session();
  const group = new Olm.OutboundGroupSession();
  let receiveGroup = new Olm.InboundGroupSession();
  const f = await fixture();
  let resumed: Store | undefined;
  try {
    alice.create();
    bob.create();
    bob.generate_one_time_keys(1);
    const aliceKeys = JSON.parse(alice.identity_keys());
    const bobKeys = JSON.parse(bob.identity_keys());
    const oneTimeKeys = JSON.parse(bob.one_time_keys()).curve25519;
    const lan = await deviceIdentity(f.ht, 'alice', 'LAN');
    const phone = await deviceIdentity(f.et, 'alice', 'PHONE');
    await f.ht.tx((tx) =>
      tx.e2ee.upload(
        lan,
        validateUpload(
          {
            one_time_keys: Object.fromEntries(
              Object.entries(oneTimeKeys).map((
                [id, key],
              ) => ['curve25519:' + id, key]),
            ),
          },
          '@alice:logical.test',
          'LAN',
          config().e2ee,
        ),
      )
    );
    const claimed = await f.ht.tx((tx) =>
      tx.e2ee.claim('alice', 'LAN', 'curve25519')
    );
    assert(claimed);
    assertEquals(
      await f.ht.tx((tx) => tx.e2ee.claim('alice', 'LAN', 'curve25519')),
      null,
    );
    outbound.create_outbound(
      alice,
      bobKeys.curve25519,
      String(Object.values(claimed)[0]),
    );
    bob.mark_keys_as_published();
    group.create();
    const roomId = '!fresh-crypto:logical.test';
    const keyMessage = {
      sender: '@alice:logical.test',
      sender_device: 'PHONE',
      keys: { ed25519: aliceKeys.ed25519 },
      recipient: '@alice:logical.test',
      recipient_keys: { ed25519: bobKeys.ed25519 },
      type: 'm.room_key',
      content: {
        algorithm: 'm.megolm.v1.aes-sha2',
        room_id: roomId,
        session_id: group.session_id(),
        session_key: group.session_key(),
      },
    };
    const encrypted = {
      algorithm: 'm.olm.v1.curve25519-aes-sha2',
      sender_key: aliceKeys.curve25519,
      ciphertext: {
        [bobKeys.curve25519]: outbound.encrypt(JSON.stringify(keyMessage)),
      },
    };
    await f.home.close();
    await f.et.tx((tx) =>
      tx.toDevice.send(
        phone,
        'logical.test',
        'm.room.encrypted',
        'fresh-session',
        'fresh-session-source',
        [{ user: '@alice:logical.test', id: 'LAN', content: encrypted }],
        config().e2ee,
        { enabled: true, maxBytes: 1048576 },
      )
    );
    const records = await f.es.export('alice');
    assert(records.length > 0);
    assertEquals(
      await (await f.edge.tenant('logical.test')).query(
        'SELECT * FROM to_device_intents',
      ),
      [],
    );
    resumed = await f.open('home');
    const ht = await openTenant(resumed, 'logical.test');
    const hp = new Pairings(
      await resumed.server(),
      ht.signer(),
      ht.publicB64,
      'a'.repeat(64),
    );
    const journal = new Journal(await resumed.server(), LINK_SUPPORTED);
    const owner = await coordinator(resumed, ht, hp);
    for (const record of records) {
      await journal.receive('edge_a', [record]);
      await owner.apply(journal, record, f.bundle.id);
    }
    const page = await ht.tx((tx) =>
      tx.toDevice.deliverSliding(lan, 'fresh-crypto', 100, config().e2ee)
    );
    assertEquals(page.events.length, 1);
    assertEquals(page.events[0].type, 'm.room.encrypted');
    const content = page.events[0].content as typeof encrypted;
    assertEquals(content, encrypted);
    const ciphertext = content.ciphertext[bobKeys.curve25519];
    assertEquals(
      ciphertext.type,
      0,
      'first message must establish a new Olm session',
    );
    inbound.create_inbound_from(bob, content.sender_key, ciphertext.body);
    const decrypted = JSON.parse(
      inbound.decrypt(ciphertext.type, ciphertext.body),
    );
    bob.remove_one_time_keys(inbound);
    assert(
      canonicalJson(decrypted) === canonicalJson(keyMessage),
      'Olm plaintext must match the sent room key',
    );
    receiveGroup.create(decrypted.content.session_key);
    assertEquals(receiveGroup.session_id(), group.session_id());
    const clear = JSON.stringify({
      room_id: roomId,
      type: 'm.room.message',
      content: { msgtype: 'm.text', body: 'fresh-session plaintext' },
    });
    assertEquals(receiveGroup.decrypt(group.encrypt(clear)).plaintext, clear);
    // Client restart restores client-owned state, not a pre-shared group key.
    const pickleKey = crypto.randomUUID();
    const pickle = receiveGroup.pickle(pickleKey);
    receiveGroup.free();
    receiveGroup = new Olm.InboundGroupSession();
    receiveGroup.unpickle(pickleKey, pickle);
    assertEquals(receiveGroup.decrypt(group.encrypt(clear)).plaintext, clear);
    await ht.tx((tx) =>
      tx.toDevice.acknowledgeSliding(lan, 'fresh-crypto', page.nextBatch)
    );
    const replyPlain = JSON.stringify({
      type: 'm.key.verification.ready',
      content: { transaction_id: 'fresh-verification' },
    });
    const reply = {
      algorithm: 'm.olm.v1.curve25519-aes-sha2',
      sender_key: bobKeys.curve25519,
      ciphertext: { [aliceKeys.curve25519]: inbound.encrypt(replyPlain) },
    };
    await ht.tx((tx) =>
      tx.toDevice.send(
        lan,
        'logical.test',
        'm.room.encrypted',
        'fresh-reply',
        'fresh-reply-source',
        [{ user: '@alice:logical.test', id: 'PHONE', content: reply }],
        config().e2ee,
        { enabled: true, maxBytes: 1048576 },
      )
    );
    for (const record of await owner.export('alice', f.bundle.id)) {
      await f.ej.receive('home', [record]);
      await f.es.apply(f.ej, record);
    }
    const returned = await f.et.tx((tx) =>
      tx.toDevice.deliverSliding(phone, 'reply-crypto', 100, config().e2ee)
    );
    assertEquals(returned.events.length, 1);
    const returnedCipher = (returned.events[0].content as typeof reply)
      .ciphertext[aliceKeys.curve25519];
    assertEquals(
      outbound.decrypt(returnedCipher.type, returnedCipher.body),
      replyPlain,
    );
    assertEquals(
      await (await resumed.tenant('logical.test')).query(
        'SELECT * FROM to_device_inbox',
      ),
      [],
    );
  } finally {
    await resumed?.close();
    await f.close();
    receiveGroup.free();
    group.free();
    inbound.free();
    outbound.free();
    bob.free();
    alice.free();
  }
});

Deno.test('to-device ingress: F2 delivers the local owner before success and freezes home work', async () => {
  const f = await fixture();
  // This isolated owner fixture has no live app projector. Discharge its setup
  // revision before observing only this admission's source-export hints.
  await projectTenant(f.edge, 'logical.test');
  const notifications: string[] = [];
  const stop = onTenantStream((store, name, source) => {
    if (store === f.edge && name === 'logical.test') notifications.push(source);
  });
  try {
    const edus = eduState(await f.edge.server(), 'logical.test', f.edge);
    registerToDevice(edus, f.et);
    const raw = {
      edu_type: 'm.direct_to_device',
      content: {
        sender: '@remote:remote.test',
        type: 'm.room_key',
        message_id: 'ingress',
        messages: { '@alice:logical.test': { '*': { session_id: 'fresh' } } },
      },
    };
    const accepted = await acceptIngressEdu(
      'remote.test',
      'logical.test',
      raw,
      edus,
      'f2',
      (origin, content) => f.es.ingress(origin, content),
    );
    const db = await f.edge.tenant('logical.test');
    assertEquals(
      (await db.query('SELECT * FROM to_device_inbox')).length,
      1,
      'HTTP success must follow actual owner inbox insertion',
    );
    assertEquals(
      (await db.query('SELECT * FROM to_device_routes')).length,
      2,
      'the unseen home registry remains an immutable owner obligation',
    );
    assert(accepted.kind === 'routed');
    await assertRejects(
      () =>
        f.hs.ingress('remote.test', raw.content, accepted.receipt, f.bundle.id),
      Error,
      'signed semantic routes',
    );
    const records = await f.es.export('alice');
    await f.hj.receive('edge_a', records);
    for (const record of records) await f.hs.apply(f.hj, record, f.bundle.id);
    await f.hs.ingress(
      'remote.test',
      raw.content,
      accepted.receipt,
      f.bundle.id,
    );
    const homeDb = await f.home.tenant('logical.test');
    assertEquals(
      (await homeDb.query('SELECT * FROM to_device_inbox')).length,
      1,
    );
    assertEquals((await db.query('SELECT * FROM to_device_inbox')).length, 1);
    // Both owners have already captured their wildcard, not the replacement.
    await deleteDevices(f.ht, 'alice', ['LAN']);
    await upsertDevice(f.ht, 'alice', 'LAN');
    await f.hs.ingress(
      'remote.test',
      raw.content,
      accepted.receipt,
      f.bundle.id,
    );
    assertEquals(
      (await homeDb.query('SELECT * FROM to_device_inbox')).length,
      0,
    );
    const retried = await acceptIngressEdu(
      'remote.test',
      'logical.test',
      raw,
      edus,
      'f2',
      (origin, content) => f.es.ingress(origin, content),
    );
    assertEquals(
      retried,
      accepted,
      'child completion loss reuses the exact frozen manifest',
    );
    assertEquals(
      notifications,
      ['local'],
      'local durable routes wake the export owner once, not an import echo',
    );
    const forged = structuredClone(accepted.receipt);
    forged.routes.pop();
    await assertRejects(
      () => f.hs.ingress('remote.test', raw.content, forged, f.bundle.id),
      Error,
      'identity changed',
    );
  } finally {
    stop();
    await f.close();
  }
});

Deno.test('to-device ingress: original signed mailbox completion waits for semantic home routes without full redispatch', async () => {
  const f = await fixture();
  try {
    const remote = await makeRemoteServer('remote.test');
    const content = {
      sender: '@remote:remote.test',
      type: 'm.room_key',
      message_id: 'mailbox',
      messages: { '@alice:logical.test': { '*': { session_id: 'actual' } } },
    };
    const raw = { edu_type: 'm.direct_to_device', content };
    const request = {
      method: 'PUT',
      uri: '/_matrix/federation/v1/send/mailbox',
      authorization: '',
      body: new TextEncoder().encode(
        JSON.stringify({
          origin: remote.name,
          origin_server_ts: 1,
          pdus: [],
          edus: [raw],
        }),
      ),
    };
    const signed = JSON.parse(
      requestCanonical('logical.test', request, remote.name),
    );
    await signJson(signed, remote.name, remote.keyId, remote.kp.privateKey);
    request.authorization =
      `X-Matrix origin="${remote.name}",destination="logical.test",key="${remote.keyId}",sig="${
        signed.signatures[remote.name][remote.keyId]
      }"`;
    const edgeServer = await f.edge.server();
    const keys = keyStore(edgeServer, {
      deps: directOnly(await makeDoc(remote)),
    });
    const publicKey = await keys.getVerifyKey(
      remote.name,
      remote.keyId,
      Date.now(),
      'request',
    );
    const evidence = await captureRequestEvidence(
      keys,
      'logical.test',
      request,
      { origin: remote.name, keyId: remote.keyId, publicKey },
    );
    const edus = eduState(edgeServer, 'logical.test', f.edge);
    const dependencies = {
      self: 'logical.test',
      store: f.edge,
      keys: fakeKeyResolver(remote),
      fetcher: fakeFetcher({}).fetcher,
      edus,
    };
    let cut = true;
    const interrupted = {
      ...edgeServer,
      tx: <T>(
        fn: (conn: Conn) => Promise<T>,
        options?: Parameters<typeof edgeServer.tx>[1],
      ) =>
        edgeServer.tx((conn) =>
          fn(
            new Proxy(conn, {
              get(target, key) {
                if (key === 'execute') {
                  return (...args: Parameters<Conn['execute']>) => {
                    if (
                      cut &&
                      args[0].startsWith('INSERT INTO facade_ingress_children')
                    ) {
                      cut = false;
                      throw new Error('child completion loss');
                    }
                    return target.execute(...args);
                  };
                }
                const value = Reflect.get(target, key);
                return typeof value === 'function' ? value.bind(target) : value;
              },
            }),
          ), options),
    };
    const box = new Mailbox(interrupted, {
      self: 'logical.test',
      node: f.node,
      pairings: f.fp,
      phase: 'f2',
      transaction: dependencies,
      scopeState: () => Promise.resolve('ready'),
      acceptEdu: (origin, raw, phase) =>
        acceptIngressEdu(
          origin,
          'logical.test',
          raw,
          edus,
          phase,
          (origin, content) => f.es.ingress(origin, content),
        ),
      changed() {},
    });
    await box.stage('mailbox', evidence);
    await assertRejects(() => box.receive(remote.name, 'mailbox'), Error);
    const edgeDb = await f.edge.tenant('logical.test');
    assertEquals(
      (await edgeDb.query('SELECT * FROM to_device_inbox')).length,
      1,
    );
    assertEquals(
      await edgeServer.query(
        "SELECT * FROM facade_records WHERE stream LIKE 'ingress:%'",
      ),
      [],
    );
    await box.receive(remote.name, 'mailbox');
    const [saved] = await edgeServer.query(
      "SELECT record_json FROM facade_records WHERE stream LIKE 'ingress:%'",
    );
    const record = JSON.parse(String(saved.record_json)) as LinkRecord;
    assertEquals(record.version, 3);
    const old = new Journal(
      await f.home.server(),
      LINK_SUPPORTED.filter((cap) => cap.type !== 'ingress' || cap.version < 3),
    );
    await assertRejects(
      () => old.receive('edge_a', [record]),
      Error,
      'unsupported record',
    );
    await f.hj.receive('edge_a', [record]);
    let redispatched = 0;
    const homeServer = await f.home.server();
    const homeDependencies = {
      ...dependencies,
      store: f.home,
      edus: {
        dispatch: () => {
          redispatched++;
          return Promise.resolve();
        },
      },
    };
    const noOwner = new HomeIngress(homeServer, {
      peer: 'edge_a',
      pairing: f.bundle.id,
      pairings: f.hp,
      transaction: homeDependencies,
    });
    await assertRejects(
      () => noOwner.apply(f.hj, record),
      Error,
      'home owner unavailable',
    );
    let homeCut = true;
    const homeInterrupted = {
      ...homeServer,
      tx: <T>(
        fn: (conn: Conn) => Promise<T>,
        options?: Parameters<typeof homeServer.tx>[1],
      ) =>
        homeServer.tx((conn) =>
          fn(
            new Proxy(conn, {
              get(target, key) {
                if (key === 'execute') {
                  return (...args: Parameters<Conn['execute']>) => {
                    if (
                      homeCut &&
                      args[0].startsWith('INSERT INTO facade_ingress_children')
                    ) {
                      homeCut = false;
                      throw new Error('home child completion loss');
                    }
                    return target.execute(...args);
                  };
                }
                const value = Reflect.get(target, key);
                return typeof value === 'function' ? value.bind(target) : value;
              },
            }),
          ), options),
    };
    const drain = new HomeIngress(homeInterrupted, {
      peer: 'edge_a',
      pairing: f.bundle.id,
      pairings: f.hp,
      transaction: homeDependencies,
      toDevice: (origin, raw, receipt) =>
        f.hs.ingress(origin, raw, receipt, f.bundle.id),
    });
    await assertRejects(
      () => drain.apply(f.hj, record),
      Error,
      'signed semantic routes',
    );
    assertEquals(
      (await f.hj.heads('edge_a', 'in', record)).applied.sequence,
      0,
    );
    assertEquals(
      await homeServer.query(
        "SELECT * FROM facade_ingress_children WHERE kind='edu'",
      ),
      [],
    );
    const routes = await f.es.export('alice');
    await f.hj.receive('edge_a', routes);
    for (const item of routes) await f.hs.apply(f.hj, item, f.bundle.id);
    await assertRejects(
      () => drain.apply(f.hj, record),
      Error,
      'home child completion loss',
    );
    assertEquals(
      (await f.hj.heads('edge_a', 'in', record)).applied.sequence,
      0,
    );
    assertEquals(await drain.apply(f.hj, record), true);
    assertEquals(await drain.apply(f.hj, record), false);
    assertEquals(
      redispatched,
      0,
      'home never invokes the whole original to-device handler',
    );
    const homeDb = await f.home.tenant('logical.test');
    assertEquals(
      (await homeDb.query('SELECT * FROM to_device_inbox')).length,
      1,
    );
    assertEquals(
      (await edgeDb.query('SELECT * FROM to_device_inbox')).length,
      1,
    );
    const [held] = await homeServer.query(
      'SELECT evidence_json FROM facade_ingress',
    );
    assertEquals(String(held.evidence_json), canonicalJson(evidence));
  } finally {
    await f.close();
  }
});

Deno.test('to-device ingress: unknown and deleted explicit device targets finish without delivering to replacements', async () => {
  const f = await fixture();
  try {
    await deleteDevices(f.et, 'alice', ['PHONE']);
    for (const deviceId of ['UNKNOWN', 'PHONE']) {
      const content = {
        sender: '@remote:remote.test',
        type: 'm.room_key',
        message_id: 'absent-' + deviceId,
        messages: {
          '@alice:logical.test': { [deviceId]: { key: 'not-for-replacement' } },
        },
      };
      const receipt = await f.es.ingress('remote.test', content);
      const routes = await f.es.export('alice');
      await f.hj.receive('edge_a', routes);
      for (const record of routes) await f.hs.apply(f.hj, record, f.bundle.id);
      await f.hs.ingress('remote.test', content, receipt, f.bundle.id);
    }
    await upsertDevice(f.et, 'alice', 'PHONE');
    for (const store of [f.home, f.edge]) {
      assertEquals(
        await (await store.tenant('logical.test')).query(
          'SELECT * FROM to_device_inbox',
        ),
        [],
      );
    }
  } finally {
    await f.close();
  }
});

Deno.test('to-device ingress: missing tenant control cannot fall back to standalone delivery', async () => {
  const f = await fixture();
  try {
    const db = await f.edge.tenant('logical.test');
    await db.execute('DELETE FROM facade_owner_activation');
    await assertRejects(() =>
      f.es.ingress('remote.test', {
        sender: '@remote:remote.test',
        type: 'm.room_key',
        message_id: 'unready',
        messages: { '@alice:logical.test': { '*': { key: 'not-admitted' } } },
      }), Error);
    for (
      const table of [
        'to_device_inbox',
        'to_device_routes',
        'to_device_admissions',
        'inbound_to_device',
      ]
    ) {
      assertEquals(await db.query('SELECT * FROM ' + table), []);
    }
  } finally {
    await f.close();
  }
});

for (
  const cut of ['home-export', 'account-selection', 'tenant-authority'] as const
) {
  Deno.test(`to-device readiness: ${cut} waits without inbox or cursor effects`, async () => {
    const f = await fixture();
    try {
      const home = cut === 'home-export';
      const store = home ? f.home : f.edge;
      const db = await store.tenant('logical.test');
      const server = await store.server();
      const table = home
        ? 'facade_exports'
        : cut === 'account-selection'
        ? 'account_auth_snapshots'
        : 'tenant_authority';
      const owner = home ? server : db;
      const predicate = home
        ? "scope='auth:@alice:logical.test'"
        : cut === 'account-selection'
        ? "localpart='alice'"
        : 'singleton=1';
      const [held] = await owner.query(
        'SELECT * FROM ' + table + ' WHERE ' + predicate,
      );
      await owner.execute('DELETE FROM ' + table + ' WHERE ' + predicate);
      const before = await server.query(
        'SELECT * FROM facade_streams ORDER BY stream',
      );
      const content = {
        sender: '@remote:remote.test',
        type: 'm.room_key',
        message_id: 'held-' + cut,
        messages: {
          '@alice:logical.test': { [home ? 'LAN' : 'PHONE']: { key: cut } },
        },
      };
      const attempt = () =>
        home
          ? f.hs.ingress('remote.test', content, undefined, f.bundle.id)
          : f.es.ingress('remote.test', content);
      const pending = await assertRejects(attempt, LinkError);
      assertEquals(pending.code, 'LINK_UNAVAILABLE');
      assertEquals(pending.status, 503);
      assertEquals(
        await server.query('SELECT * FROM facade_streams ORDER BY stream'),
        before,
      );
      for (
        const table of [
          'to_device_inbox',
          'to_device_routes',
          'to_device_admissions',
          'inbound_to_device',
        ]
      ) {
        assertEquals(await db.query('SELECT * FROM ' + table), []);
      }
      const columns = Object.keys(held);
      await owner.execute(
        'INSERT INTO ' + table + '(' + columns.join(',') + ') VALUES(' +
          columns.map(() => '?').join(',') + ')',
        Object.values(held),
      );
      await attempt();
      assertEquals((await db.query('SELECT * FROM to_device_inbox')).length, 1);
    } finally {
      await f.close();
    }
  });
}

Deno.test('to-device ingress: a completed legacy home receipt discharges imported frozen work without re-expansion', async () => {
  const f = await fixture();
  try {
    const content = {
      sender: '@remote:remote.test',
      type: 'm.room_key',
      message_id: 'home-legacy',
      messages: {
        '@alice:logical.test': { '*': { key: 'original-home-cut' } },
      },
    };
    await f.ht.tx((tx) =>
      tx.toDevice.receive(
        'remote.test',
        content.message_id,
        content.sender,
        content.type,
        'logical.test',
        [{
          user: '@alice:logical.test',
          id: '*',
          content: { key: 'original-home-cut' },
        }],
        config().e2ee,
        'legacy',
      )
    );
    await deleteDevices(f.ht, 'alice', ['LAN']);
    await upsertDevice(f.ht, 'alice', 'LAN');
    const receipt = await f.es.ingress('remote.test', content);
    const records = await f.es.export('alice');
    await f.hj.receive('edge_a', records);
    for (const record of records) await f.hs.apply(f.hj, record, f.bundle.id);
    await f.hs.ingress('remote.test', content, receipt, f.bundle.id);
    assertEquals(
      await (await f.home.tenant('logical.test')).query(
        'SELECT * FROM to_device_inbox',
      ),
      [],
      'the completed F1 home expansion must not attach to its later replacement',
    );
    assertEquals(
      (await (await f.edge.tenant('logical.test')).query(
        'SELECT * FROM to_device_inbox',
      )).length,
      1,
    );
  } finally {
    await f.close();
  }
});

Deno.test('to-device link: reader capability is additive and old readers refuse before receive effects', async () => {
  assert(
    LINK_SUPPORTED.some((cap) => cap.type === 'to-device' && cap.version === 1),
    'missing durable to-device reader',
  );
  assertEquals(
    LINK_CAPABILITIES.some((cap) => cap.type === 'to-device'),
    false,
  );
  const f = await fixture();
  try {
    await send(f);
    const [record] = await f.es.export('alice');
    const old = new Journal(
      await f.home.server(),
      LINK_SUPPORTED.filter((cap) => cap.type !== 'to-device'),
    );
    await assertRejects(
      () => old.receive('edge_a', [record]),
      Error,
      'unsupported record type',
    );
    assertEquals(
      (await old.heads('edge_a', 'in', record)).received.sequence,
      0,
    );
  } finally {
    await f.close();
  }
});

Deno.test('to-device link: recipient auth commits and wakes a pending other-account inbox without sender export or unrelated news', async () => {
  const f = await fixture();
  const previous = { ...config().e2ee };
  let stop = () => {};
  try {
    setConfigForTests({ e2ee: { maxinboxmessages: 1 } });
    await f.et.tx((tx) => tx.users.insert('bob', 'Bob'));
    // The independently deliverable key bootstrap can install this genuine
    // home allocation floor without granting credential/auth readiness.
    const floor = await (await f.home.tenant('logical.test')).tx((conn) =>
      captureDeviceStreamFloor(conn, 'bob')
    );
    assert(typeof floor === 'number');
    await (await f.edge.tenant('logical.test')).tx((conn) =>
      installDeviceStreamFloor(conn, 'bob', floor)
    );
    await upsertDevice(f.et, 'bob', 'BOB');
    const recipient = await deviceIdentity(f.et, 'bob', 'BOB');
    const retained = {
      sender: '@alice:logical.test',
      type: 'm.room_key',
      content: { key: 'retained-before-auth' },
    };
    const db = await f.edge.tenant('logical.test');
    await db.tx((conn) =>
      insertMessage(conn, recipient, 'retained', retained, config().e2ee)
    );
    const sender = await deviceIdentity(f.ht, 'alice', 'LAN');
    await f.ht.tx((tx) =>
      tx.toDevice.send(
        sender,
        'logical.test',
        'm.room_key',
        'bob-wake',
        'bob-wake',
        [
          {
            user: '@bob:logical.test',
            id: '*',
            content: { key: 'new-session' },
          },
        ],
        config().e2ee,
        { enabled: true, maxBytes: 1048576 },
      )
    );
    for (const record of await f.hs.export('alice', f.bundle.id)) {
      await f.ej.receive('home', [record]);
      await f.es.apply(f.ej, record);
    }
    assertEquals((await db.query('SELECT * FROM to_device_inbox')).length, 1);
    await projectTenant(f.edge, 'logical.test');
    assertEquals(await pendingTenantProjection(db), 0);
    let hints = 0;
    stop = onTenantStream((store, tenant, source) => {
      if (
        store === f.edge && tenant === 'logical.test' && source === 'replica'
      ) hints++;
    });
    const snapshots = new AccountSnapshots(f.edge, f.et, f.fp, f.owners);
    for (const expectedHints of [1, 1]) {
      const auth = await exportAccountAuth(
        f.home,
        f.ht,
        f.hp,
        f.bundle.id,
        'bob',
        false,
      );
      await f.ej.receive('home', [auth]);
      assertEquals(await snapshots.apply(f.ej, auth), true);
      assertEquals(
        hints,
        expectedHints,
        'inbox-only publication must wake once after commit',
      );
      assertEquals(await snapshots.apply(f.ej, auth), false);
    }
    assertEquals(await pendingTenantProjection(db), 0);
    const delivered = await f.et.tx((tx) =>
      tx.toDevice.deliverSliding(recipient, 'bob', 100, config().e2ee)
    );
    assertEquals(delivered.events, [retained, {
      sender: '@alice:logical.test',
      type: 'm.room_key',
      content: { key: 'new-session' },
    }]);
    assertEquals((await db.query('SELECT * FROM to_device_inbox')).length, 2);
  } finally {
    stop();
    setConfigForTests({ e2ee: previous });
    await f.close();
  }
});

Deno.test('to-device link: signed owner admission precedes ACK, reverse dispositions never copy inbox authority', async () => {
  const f = await fixture();
  try {
    await send(f);
    const records = await f.es.export('alice');
    assert(records.length > 0);
    assertEquals(await f.es.export('alice'), []);
    const hdb = await f.home.tenant('logical.test'),
      edb = await f.edge.tenant('logical.test');
    const before = await edb.query('SELECT * FROM to_device_inbox');
    // The fixture does not install the app's normal postcommit projector. Drain
    // its pre-existing user/device work before measuring inbox-only publications.
    await projectTenant(f.home, 'logical.test');
    await projectTenant(f.edge, 'logical.test');
    let homeWakes = 0, edgeWakes = 0;
    const stop = onTenantStream((store, server, source) => {
      if (server !== 'logical.test' || source !== 'replica') return;
      if (store === f.home) homeWakes++;
      if (store === f.edge) edgeWakes++;
    });
    try {
      for (const record of records) {
        assertEquals([record.type, record.version, record.stream], [
          'to-device',
          1,
          'to-device:@alice:logical.test',
        ]);
        await f.hj.receive('edge_a', [record]);
        assertEquals(await f.hs.apply(f.hj, record, f.bundle.id), true);
        assertEquals(
          (await f.hj.heads('edge_a', 'in', record)).applied.hash,
          record.hash,
        );
      }
      assertEquals(
        (await hdb.query('SELECT device_id FROM to_device_inbox')).map((r) =>
          r.device_id
        ),
        ['LAN'],
      );
      const lan = await deviceIdentity(f.ht, 'alice', 'LAN');
      const page = await f.ht.tx((tx) =>
        tx.toDevice.deliver(lan, {
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
      assertEquals(page.events, [{
        sender: '@alice:logical.test',
        type: 'm.room_key_request',
        content: { request_id: 'fresh-session' },
      }]);
      assertEquals(
        homeWakes,
        1,
        'one actual inbox publication before client ACK',
      );
      await f.ht.tx((tx) => tx.toDevice.acknowledge(lan, page.token));
      await projectTenant(f.home, 'logical.test');
      const reverse = await f.hs.export('alice', f.bundle.id);
      assert(reverse.length > 0);
      for (const record of reverse) {
        await f.ej.receive('home', [record]);
        assertEquals(await f.es.apply(f.ej, record), true);
      }
      assertEquals(await edb.query('SELECT * FROM to_device_inbox'), before);
      assertEquals(
        await f.es.export('alice'),
        [],
        'foreign dispositions cannot echo as local intent',
      );
      assertEquals(await hdb.query('SELECT * FROM to_device_inbox'), []);
      assertEquals(
        homeWakes,
        1,
        'only actual receiving inbox publication wakes home',
      );
      assertEquals(
        edgeWakes,
        0,
        'foreign dispositions and repeated export publish no inbox news',
      );
    } finally {
      stop();
    }
  } finally {
    await f.close();
  }
});

Deno.test('to-device link: server selection, tenant selection and tenant control independently fence admission', async () => {
  for (
    const cut of ['server-selection', 'tenant-selection', 'tenant-control']
  ) {
    const f = await fixture();
    try {
      const side = cut === 'server-selection' ? 'home' : 'edge';
      await send(f, side === 'home' ? 'edge' : 'home');
      const records = side === 'home'
        ? await f.es.export('alice')
        : await f.hs.export('alice', f.bundle.id);
      const record = records[0],
        journal = side === 'home' ? f.hj : f.ej,
        owner = side === 'home' ? f.hs : f.es;
      const peer = side === 'home' ? 'edge_a' : 'home',
        store = side === 'home' ? f.home : f.edge;
      const db = await store.tenant('logical.test');
      await journal.receive(peer, [record]);
      if (cut === 'server-selection') {
        await (await store.server()).execute(
          'DELETE FROM facade_exports',
        );
      }
      if (cut === 'tenant-selection') {
        await db.execute(
          'DELETE FROM account_auth_snapshots',
        );
      }
      if (cut === 'tenant-control') {
        await db.execute(
          'DELETE FROM facade_owner_activation',
        );
      }
      await assertRejects(
        () =>
          owner.apply(
            journal,
            record,
            side === 'home' ? f.bundle.id : undefined,
          ),
        Error,
      );
      assertEquals(await db.query('SELECT * FROM to_device_operations'), []);
      assertEquals(await db.query('SELECT * FROM to_device_inbox'), []);
      assertEquals(
        await db.query('SELECT * FROM facade_link_applications WHERE hash=?', [
          record.hash,
        ]),
        [],
      );
      assertEquals(
        (await journal.heads(peer, 'in', record)).applied.sequence,
        0,
      );
    } finally {
      await f.close();
    }
  }
});

Deno.test('to-device link: signature, stream, source, scope, version and operation identities refuse without tenant effects', async () => {
  for (
    const change of [
      'signature',
      'stream',
      'source',
      'account',
      'operation',
      'version',
    ]
  ) {
    const f = await fixture();
    try {
      await send(f);
      const [original] = await f.es.export('alice');
      const bad = structuredClone(original);
      const signed = bad.payload as {
        body: { localpart: string };
        signature: string;
      };
      if (change === 'signature') signed.signature = 'A'.repeat(86);
      if (change === 'stream') bad.stream = 'to-device:@bob:logical.test';
      if (change === 'source') bad.incarnation = 'another-store';
      if (change === 'account') signed.body.localpart = 'bob';
      if (change === 'operation') bad.operationId = 'substitution';
      if (change === 'version') bad.version = 2;
      const record = rehash(bad);
      const db = await f.home.tenant('logical.test');
      if (change === 'version') {
        await assertRejects(
          () => f.hj.receive('edge_a', [record]),
          Error,
          'unsupported record type',
        );
      } else {
        await f.hj.receive('edge_a', [record]);
        await assertRejects(() => f.hs.apply(f.hj, record, f.bundle.id), Error);
        assertEquals(
          (await f.hj.heads('edge_a', 'in', record)).applied.sequence,
          0,
        );
      }
      assertEquals(await db.query('SELECT * FROM to_device_operations'), []);
      assertEquals(await db.query('SELECT * FROM to_device_inbox'), []);
      assertEquals(
        await db.query('SELECT * FROM facade_link_applications WHERE hash=?', [
          record.hash,
        ]),
        [],
      );
    } finally {
      await f.close();
    }
  }
});

// Pause only the owning tenant transaction; no cross-file call is made under it.
function pauseImport(store: Store, cut: 'before' | 'during' | 'after') {
  const reached = Promise.withResolvers<void>(),
    proceed = Promise.withResolvers<void>();
  const original = store.tenant.bind(store);
  let paused = false;
  const pause = async () => {
    if (!paused) {
      paused = true;
      reached.resolve();
      await proceed.promise;
    }
  };
  store.tenant = async (...args) => {
    const db = await original(...args);
    return {
      ...db,
      tx: async (fn, options) => {
        let imported = false;
        const result = await db.tx((conn) =>
          fn(
            new Proxy(conn, {
              get(target, key) {
                if (key === 'query') {
                  return async (...a: Parameters<Conn['query']>) => {
                    if (
                      cut === 'before' &&
                      a[0].includes('facade_owner_activation')
                    ) await pause();
                    return await target.query(...a);
                  };
                }
                if (key === 'execute') {
                  return async (...a: Parameters<Conn['execute']>) => {
                    const result = await target.execute(...a);
                    if (a[0].startsWith('INSERT INTO to_device_operations ')) {
                      imported = true;
                      if (cut === 'during') await pause();
                    }
                    return result;
                  };
                }
                const value = Reflect.get(target, key);
                return typeof value === 'function' ? value.bind(target) : value;
              },
            }),
          ), options);
        if (imported && cut === 'after') {
          await pause();
        }
        return result;
      },
    };
  };
  return {
    reached: reached.promise,
    resume: () => proceed.resolve(),
    restore: () => {
      store.tenant = original;
    },
  };
}

Deno.test('to-device link: retirement before or during admission rolls back inbox, fact and exact receipt on both owners', async () => {
  for (const side of ['home', 'edge'] as const) {
    for (const cut of ['before', 'during'] as const) {
      const f = await fixture();
      try {
        await send(f, side === 'home' ? 'edge' : 'home');
        const records = side === 'home'
          ? await f.es.export('alice')
          : await f.hs.export('alice', f.bundle.id);
        const record = records[0],
          journal = side === 'home' ? f.hj : f.ej,
          owner = side === 'home' ? f.hs : f.es;
        const peer = side === 'home' ? 'edge_a' : 'home',
          store = side === 'home' ? f.home : f.edge;
        await journal.receive(peer, [record]);
        const paused = pauseImport(store, cut);
        const outcome = owner.apply(
          journal,
          record,
          side === 'home' ? f.bundle.id : undefined,
        ).then(() => null, (e) => e);
        try {
          await Promise.race([
            paused.reached,
            outcome.then((e) => {
              throw e ?? new Error('admission missed cut');
            }),
          ]);
          const revoked = await f.hp.revoke(f.bundle.id);
          if (side === 'edge') await f.fp.retire(revoked, 'a'.repeat(64));
        } finally {
          paused.resume();
          paused.restore();
        }
        assert(await outcome instanceof Error);
        const db = await store.tenant('logical.test');
        assertEquals(await db.query('SELECT * FROM to_device_operations'), []);
        assertEquals(await db.query('SELECT * FROM to_device_inbox'), []);
        assertEquals(
          await db.query(
            'SELECT * FROM facade_link_applications WHERE hash=?',
            [record.hash],
          ),
          [],
        );
        assertEquals(
          (await journal.heads(peer, 'in', record)).applied.sequence,
          0,
        );
      } finally {
        await f.close();
      }
    }
  }
});

for (const phase of ['capture', 'new application', 'replay']) {
  Deno.test(`to-device projection obligation: ${phase} does not adopt unrelated work`, async () => {
    const f = await fixture();
    try {
      await send(f, 'home');
      const source = await f.home.tenant('logical.test');
      const unrelatedSource = phase === 'capture'
        ? await source.tx(recordTenantProjection)
        : 0;
      let projections = 0;
      setTenantProjector(() => {
        projections++;
        return Promise.resolve();
      });
      const records = await f.hs.export('alice', f.bundle.id);
      if (phase === 'capture') {
        assertEquals(
          projections,
          0,
          'source capture owns no unrelated projection',
        );
        assertEquals(await pendingTenantProjection(source), unrelatedSource);
        return;
      }
      const db = await f.edge.tenant('logical.test');
      const unrelated = phase === 'new application'
        ? await db.tx(recordTenantProjection)
        : 0;
      for (const record of records) {
        await f.ej.receive('home', [record]);
        const complete = f.ej.complete.bind(f.ej);
        f.ej.complete = () => Promise.reject(new Error('projection ACK loss'));
        await assertRejects(
          () => f.es.apply(f.ej, record),
          Error,
          'projection ACK loss',
        );
        f.ej.complete = complete;
        if (phase === 'new application') {
          assertEquals(
            projections,
            0,
            'new application owns no unrelated projection',
          );
          assertEquals(await pendingTenantProjection(db), unrelated);
          continue;
        }
        const later = await db.tx(recordTenantProjection);
        assertEquals(await f.es.apply(f.ej, record), true);
        assertEquals(projections, 0, 'replay owns no later projection');
        assertEquals(await pendingTenantProjection(db), later);
      }
      assert(records.length > 0);
    } finally {
      setTenantProjector(undefined);
      await f.close();
    }
  });
}

for (const phase of ['ingress', 'ingress retry']) {
  Deno.test(`to-device projection obligation: ${phase} keeps its own cut, not unrelated projection`, async () => {
    const f = await fixture();
    try {
      const db = await f.edge.tenant('logical.test');
      await projectTenant(f.edge, 'logical.test');
      const earlier = phase === 'ingress'
        ? await db.tx(recordTenantProjection)
        : 0;
      const raw = {
        sender: '@remote:remote.test',
        type: 'm.room_key',
        message_id: 'projection-ingress',
        messages: { '@alice:logical.test': { '*': { session_id: 'fresh' } } },
      };
      let projections = 0;
      setTenantProjector(() => {
        projections++;
        return Promise.resolve();
      });
      const receipt = await f.es.ingress('remote.test', raw);
      if (phase === 'ingress') {
        assertEquals(projections, 0, 'ingress owns no earlier projection');
        assertEquals(await pendingTenantProjection(db), earlier);
        return;
      }
      const later = await db.tx(recordTenantProjection);
      assertEquals(await f.es.ingress('remote.test', raw), receipt);
      assertEquals(projections, 0, 'ingress retry owns no later projection');
      assertEquals(await pendingTenantProjection(db), later);
      assertEquals((await db.query('SELECT * FROM to_device_inbox')).length, 1);
    } finally {
      setTenantProjector(undefined);
      await f.close();
    }
  });
}

for (
  const phase of ['selector ordering', 'manifest ordering', 'forged manifest']
) {
  Deno.test(`to-device ingress receipt: ${phase} preserves exact replay validation`, async () => {
    const f = await fixture();
    try {
      const content = {
        sender: '@remote:remote.test',
        type: 'm.room_key',
        message_id: 'receipt-order',
        messages: {
          '@alice:logical.test': {
            '*': { session_id: 'wildcard' },
            PHONE: { session_id: 'phone' },
          },
        },
      };
      const receipt = await f.es.ingress('remote.test', content);
      const records = await f.es.export('alice');
      await f.hj.receive('edge_a', records);
      for (const record of records) await f.hs.apply(f.hj, record, f.bundle.id);
      await f.hs.ingress('remote.test', content, receipt, f.bundle.id);
      const reordered = structuredClone(content);
      reordered.messages['@alice:logical.test'] = Object.fromEntries(
        Object.entries(content.messages['@alice:logical.test']).reverse(),
      ) as typeof content.messages['@alice:logical.test'];
      if (phase === 'selector ordering') {
        assertEquals(await f.es.ingress('remote.test', reordered), receipt);
        return;
      }
      const manifest = structuredClone(receipt);
      manifest.routes.reverse();
      if (phase === 'manifest ordering') {
        assertEquals(
          await f.hs.ingress('remote.test', content, manifest, f.bundle.id),
          receipt,
        );
        return;
      }
      const forged = structuredClone(receipt);
      forged.routes.pop();
      const error = await assertRejects(
        () => f.hs.ingress('remote.test', content, forged, f.bundle.id),
        Error,
        'identity changed',
      );
      assertEquals((error as Error & { status: number }).status, 400);
    } finally {
      await f.close();
    }
  });
}

Deno.test('to-device link: committed receipt survives retirement, ACK loss and cold replay without expansion to replacement', async () => {
  for (const side of ['home', 'edge'] as const) {
    const f = await fixture();
    try {
      await send(f, side === 'home' ? 'edge' : 'home');
      const records = side === 'home'
        ? await f.es.export('alice')
        : await f.hs.export('alice', f.bundle.id);
      const record = records.find((r) =>
        (r.payload as { body: { operation: { value: { owner?: string } } } })
          .body.operation.value.owner === (side === 'home' ? 'home' : 'edge_a')
      )!;
      assert(record);
      const journal = side === 'home' ? f.hj : f.ej,
        owner = side === 'home' ? f.hs : f.es;
      const peer = side === 'home' ? 'edge_a' : 'home',
        store = side === 'home' ? f.home : f.edge;
      for (const prior of records.slice(0, records.indexOf(record))) {
        await journal.receive(peer, [prior]);
        await owner.apply(
          journal,
          prior,
          side === 'home' ? f.bundle.id : undefined,
        );
      }
      await journal.receive(peer, [record]);
      const complete = journal.complete.bind(journal);
      journal.complete = () => Promise.reject(new Error('lost to-device ACK'));
      const paused = pauseImport(store, 'after');
      const outcome = owner.apply(
        journal,
        record,
        side === 'home' ? f.bundle.id : undefined,
      ).then(() => null, (e) => e);
      try {
        await Promise.race([
          paused.reached,
          outcome.then((e) => {
            throw e ?? new Error('commit missed cut');
          }),
        ]);
        const revoked = await f.hp.revoke(f.bundle.id);
        if (side === 'edge') await f.fp.retire(revoked, 'a'.repeat(64));
      } finally {
        paused.resume();
        paused.restore();
      }
      const lost = await outcome;
      journal.complete = complete;
      assert(lost instanceof Error);
      assertEquals(lost.message, 'lost to-device ACK');
      const db = await store.tenant('logical.test');
      assertEquals((await db.query('SELECT * FROM to_device_inbox')).length, 1);
      const tenant = side === 'home' ? f.ht : f.et,
        id = side === 'home' ? 'LAN' : 'PHONE';
      await deleteDevices(tenant, 'alice', [id]);
      await upsertDevice(tenant, 'alice', id);
      const facts = await db.query('SELECT * FROM to_device_operations');
      await store.close();
      const cold = await f.open(side);
      try {
        const pairings = side === 'home'
          ? new Pairings(
            await cold.server(),
            f.ht.signer(),
            f.ht.publicB64,
            'a'.repeat(64),
          )
          : new Pairings(
            await cold.server(),
            f.node.signer(),
            f.node.publicKey,
            'b'.repeat(64),
            f.node,
          );
        const coldJournal = new Journal(await cold.server(), LINK_SUPPORTED);
        const coldOwner = await coordinator(
          cold,
          tenant,
          pairings,
          side === 'edge' ? f.node : undefined,
        );
        assertEquals(
          await coldOwner.apply(
            coldJournal,
            record,
            side === 'home' ? f.bundle.id : undefined,
          ),
          true,
        );
        assertEquals(
          (await coldJournal.heads(peer, 'in', record)).applied.hash,
          record.hash,
        );
        const cdb = await cold.tenant('logical.test');
        assertEquals(
          await cdb.query('SELECT * FROM to_device_operations'),
          facts,
        );
        assertEquals(await cdb.query('SELECT * FROM to_device_inbox'), []);
        assertEquals(
          await coldOwner.apply(
            coldJournal,
            record,
            side === 'home' ? f.bundle.id : undefined,
          ),
          false,
        );
      } finally {
        await cold.close();
      }
    } finally {
      await f.close();
    }
  }
});
