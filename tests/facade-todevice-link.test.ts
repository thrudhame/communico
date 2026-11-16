import { assert, assertEquals, assertRejects } from '@std/assert';
import { config } from '#engine/config.ts';
import {
  AccountSnapshots,
  exportAccountAuth,
} from '#engine/facade/accounts.ts';
import type { DeviceOperations } from '#engine/facade/devices.ts';
import { enrolledTenant, initializeNode } from '#engine/facade/identity.ts';
import { Journal } from '#engine/facade/journal.ts';
import { exportOwnerControl, OwnerControls } from '#engine/facade/ownership.ts';
import { Pairings } from '#engine/facade/pairing.ts';
import {
  LINK_CAPABILITIES,
  LINK_SUPPORTED,
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
import { pendingTenantProjection } from '#engine/tenant/hooks.ts';
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
  return new module.ToDeviceOperations(...args) as Pick<
    DeviceOperations,
    'export' | 'apply'
  >;
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
  let stop = () => {};
  try {
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
    const db = await f.edge.tenant('logical.test');
    assertEquals(await db.query('SELECT * FROM to_device_inbox'), []);
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
    assertEquals(delivered.events, [{
      sender: '@alice:logical.test',
      type: 'm.room_key',
      content: { key: 'new-session' },
    }]);
    assertEquals((await db.query('SELECT * FROM to_device_inbox')).length, 1);
  } finally {
    stop();
    await f.close();
  }
});

Deno.test('to-device link: signed owner admission precedes ACK, reverse dispositions never copy inbox authority', async () => {
  const f = await fixture();
  try {
    await send(f);
    const records = await f.es.export('alice');
    assert(records.length > 0);
    assertEquals(await f.es.export('alice'), records);
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
        records,
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
        await db.query('SELECT * FROM facade_link_applications'),
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
        await db.query('SELECT * FROM facade_link_applications'),
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
          await db.query('SELECT * FROM facade_link_applications'),
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
