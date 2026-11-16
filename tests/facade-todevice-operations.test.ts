import { assert, assertEquals, assertRejects } from '@std/assert';
import { createHash } from 'node:crypto';
import { canonicalJson } from '#engine/canonical.ts';
import { config, setConfigForTests } from '#engine/config.ts';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import {
  deleteDevice,
  deleteDevices,
  upsertDevice,
  upsertDeviceRow,
} from '#engine/tenant/devices.ts';
import { deviceIdentity } from '#engine/tenant/txns.ts';
import {
  captureAccountAuth,
  installAccountAuth,
} from '#engine/tenant/account-auth.ts';
import {
  activateTenantAuthority,
  captureSessionAuthority,
  installSessionAuthority,
} from '#engine/tenant/session-authority.ts';
import * as routing from '#engine/tenant/todevice-routing.ts';
import type { Conn } from '#engine/store/db.ts';
import {
  deliverSliding,
  insertMessage,
  receiveMessages,
} from '#engine/tenant/todevice.ts';

const expected = (source: string) => ({
  source,
  incarnation: source + '-store',
  localpart: 'alice',
});
const apply = (conn: Conn, fact: routing.ToDeviceOperation, source: string) => {
  const importer = (routing as unknown as {
    importToDeviceOperation: (
      conn: Conn,
      fact: routing.ToDeviceOperation,
      binding: ReturnType<typeof expected>,
      server: string,
    ) => Promise<void>;
  }).importToDeviceOperation;
  assertEquals(
    typeof importer,
    'function',
    'semantic transfer must have an owner-local import boundary',
  );
  return importer(conn, fact, expected(source), 'logical.test');
};
function rehash(op: routing.ToDeviceOperation): routing.ToDeviceOperation {
  const { payloadHash: _hash, ...body } = op;
  return {
    ...body,
    payloadHash: createHash('sha256').update(canonicalJson(body)).digest('hex'),
  };
}
async function fixture() {
  const dir = await Deno.makeTempDir({ prefix: 'facade-todevice-operations-' });
  const open = () =>
    openStore({
      dir,
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 300,
    }, { schemas: { tenant: tenantSchema } });
  let store = await open();
  const home = await openTenant(store, 'home-file.test', { create: true });
  const edge = await openTenant(store, 'edge-file.test', { create: true });
  // Separate tenant files stand in for the two stores. Wire identities stay the
  // same logical Matrix server; no public snapshot is used as inbox authority.
  for (const [tenant, node] of [[home, 'home'], [edge, 'edge']] as const) {
    await tenant.tx((tx) => tx.users.insert('alice', 'Alice'));
    await (await store.tenant(tenant.serverName)).tx((conn) =>
      activateTenantAuthority(conn, {
        node,
        incarnation: node + '-store',
        homeIncarnation: 'home-store',
        edgeNode: 'edge',
        edgeIncarnation: 'edge-store',
      })
    );
  }
  const hd = await store.tenant(home.serverName),
    ed = await store.tenant(edge.serverName);
  await upsertDevice(home, 'alice', 'LAN');
  const snapshot = await hd.tx((conn) =>
    captureAccountAuth(
      conn,
      {
        server: 'logical.test',
        pairing: 'pair',
        grantRevision: 1,
        ownerRevision: 1,
      },
      'alice',
      false,
      Date.now(),
    )
  );
  await ed.tx((conn) => installAccountAuth(conn, snapshot));
  await upsertDevice(edge, 'alice', 'PHONE');
  const facts = await ed.tx((conn) => captureSessionAuthority(conn, 'alice'));
  await hd.tx((conn) => installSessionAuthority(conn, 'alice', facts));
  const source = await deviceIdentity(edge, 'alice', 'PHONE');
  const send = (id: string) =>
    edge.tx((tx) =>
      tx.toDevice.send(
        source,
        'logical.test',
        'm.room_key',
        id,
        id,
        [{ user: '@alice:logical.test', id: '*', content: { key: id } }],
        config().e2ee,
        { enabled: true, maxBytes: 1048576 },
      )
    );
  return {
    dir,
    store,
    home,
    edge,
    hd,
    ed,
    send,
    async reopen() {
      await store.close();
      store = await open();
      return {
        hd: await store.tenant(home.serverName),
        ed: await store.tenant(edge.serverName),
      };
    },
    async close() {
      await store.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test('to-device semantic import: destination alone expands; exact ACK facts cannot delete the other inbox', async () => {
  const f = await fixture();
  try {
    await f.send('first');
    const source = await f.ed.tx((conn) =>
      routing.captureToDeviceOperations(conn, 'alice')
    );
    const local = source.find((op) => op.kind === 'expansion');
    assert(local?.kind === 'expansion');
    const edgeBefore = await f.ed.query('SELECT * FROM to_device_targets');
    const homeBefore = await f.hd.query('SELECT * FROM devices');
    for (const op of source) await f.hd.tx((conn) => apply(conn, op, 'edge'));
    assertEquals(await f.hd.query('SELECT * FROM devices'), homeBefore);
    assertEquals((await f.hd.query('SELECT * FROM to_device_inbox')).length, 1);
    assertEquals(
      (await f.hd.query('SELECT * FROM to_device_targets')).length,
      1,
      'foreign targets are evidence, never local inbox handles',
    );
    const facts = await f.hd.tx((conn) =>
      routing.captureToDeviceOperations(conn, 'alice')
    );
    assert(
      facts.every((op) => op.source === 'home'),
      'foreign facts cannot echo as local source intent',
    );
    for (const op of facts) await f.ed.tx((conn) => apply(conn, op, 'home'));
    assertEquals(
      await f.ed.query('SELECT * FROM to_device_targets'),
      edgeBefore,
    );
    const lan = await deviceIdentity(f.home, 'alice', 'LAN');
    const delivered = await f.home.tx((tx) =>
      tx.toDevice.deliverSliding(lan, 'lan', 100, config().e2ee)
    );
    assertEquals(delivered.events.map((event) => event.content), [{
      key: 'first',
    }]);
    await f.home.tx((tx) =>
      tx.toDevice.acknowledgeSliding(lan, 'lan', delivered.nextBatch)
    );
    const completed = await f.hd.tx((conn) =>
      routing.captureToDeviceOperations(conn, 'alice')
    );
    for (const op of completed) {
      await f.ed.tx((conn) => apply(conn, op, 'home'));
    }
    assertEquals(
      await f.ed.query('SELECT * FROM to_device_targets'),
      edgeBefore,
      'foreign ACK must never mutate local delivery state',
    );
    for (const op of source) await f.hd.tx((conn) => apply(conn, op, 'edge'));
    assertEquals(
      await f.hd.query('SELECT * FROM to_device_inbox'),
      [],
      'lost transfer/ACK response cannot recreate acknowledged inbox material',
    );
    await deleteDevices(f.home, 'alice', ['LAN']);
    await upsertDevice(f.home, 'alice', 'LAN');
    for (const op of source) await f.hd.tx((conn) => apply(conn, op, 'edge'));
    assertEquals(
      await f.hd.query('SELECT * FROM to_device_inbox'),
      [],
      'old wildcard never expands at replacement generation',
    );
    const reopened = await f.reopen();
    for (const op of source) {
      await reopened.hd.tx((conn) => apply(conn, op, 'edge'));
    }
    for (const op of completed) {
      await reopened.ed.tx((conn) => apply(conn, op, 'home'));
    }
    assertEquals(
      await reopened.hd.query('SELECT * FROM to_device_inbox'),
      [],
      'cold replay preserves exact committed ACK and expansion cuts',
    );
    assertEquals(
      await reopened.ed.query('SELECT * FROM to_device_targets'),
      edgeBefore,
    );
  } finally {
    await f.close();
  }
});

Deno.test('to-device logical admission: imported federation hash fences changed recipients across ingress paths', async () => {
  const f = await fixture();
  try {
    await f.edge.tx((tx) =>
      tx.toDevice.receive(
        'remote.test',
        'logical-id',
        '@bob:remote.test',
        'm.room_key',
        'logical.test',
        [
          {
            user: '@alice:logical.test',
            id: '*',
            content: { key: 'original' },
          },
        ],
        config().e2ee,
      )
    );
    const source = await f.ed.tx((conn) =>
      routing.captureToDeviceOperations(conn, 'alice')
    );
    for (const op of source) await f.hd.tx((conn) => apply(conn, op, 'edge'));
    const before = await f.hd.query('SELECT * FROM to_device_inbox');
    await assertRejects(
      () =>
        f.home.tx((tx) =>
          tx.toDevice.receive(
            'remote.test',
            'logical-id',
            '@bob:remote.test',
            'm.room_key',
            'logical.test',
            [
              {
                user: '@other:logical.test',
                id: '*',
                content: { key: 'changed' },
              },
            ],
            config().e2ee,
          )
        ),
      Error,
      'to-device operation identity changed',
    );
    assertEquals(await f.hd.query('SELECT * FROM to_device_inbox'), before);
    const reopened = await f.reopen();
    await assertRejects(
      () =>
        reopened.hd.tx((conn) =>
          routing.routeToDeviceMessages(
            conn,
            { kind: 'federation', origin: 'remote.test', id: 'logical-id' },
            '@bob:remote.test',
            'm.room_key',
            'logical.test',
            [
              {
                user: '@other:logical.test',
                id: '*',
                content: { key: 'changed' },
              },
            ],
            config().e2ee,
          )
        ),
      Error,
      'to-device operation identity changed',
    );
  } finally {
    await f.close();
  }
});

Deno.test('to-device logical admission: legacy receipt fences later imported routes and replacement expansion', async () => {
  const f = await fixture();
  try {
    await f.hd.execute('INSERT INTO inbound_to_device VALUES(?,?)', [
      'remote.test',
      'legacy-id',
    ]);
    await deleteDevices(f.home, 'alice', ['LAN']);
    await upsertDevice(f.home, 'alice', 'LAN');
    await f.edge.tx((tx) =>
      tx.toDevice.receive(
        'remote.test',
        'legacy-id',
        '@bob:remote.test',
        'm.room_key',
        'logical.test',
        [
          { user: '@alice:logical.test', id: '*', content: { key: 'old' } },
        ],
        config().e2ee,
      )
    );
    const source = await f.ed.tx((conn) =>
      routing.captureToDeviceOperations(conn, 'alice')
    );
    for (const op of source) await f.hd.tx((conn) => apply(conn, op, 'edge'));
    assertEquals(
      await f.hd.query('SELECT * FROM to_device_inbox'),
      [],
      'legacy receipt must suppress routed re-expansion into replacement devices',
    );
    const reopened = await f.reopen();
    for (const op of source) {
      await reopened.hd.tx((conn) => apply(conn, op, 'edge'));
    }
    await reopened.hd.tx((conn) =>
      routing.captureToDeviceOperations(conn, 'alice')
    );
    assertEquals(await reopened.hd.query('SELECT * FROM to_device_inbox'), []);
  } finally {
    await f.close();
  }
});

Deno.test('to-device logical admission: direct-first and imported-first retain one target after ACK and recreation', async () => {
  for (const order of ['direct', 'imported']) {
    const f = await fixture();
    try {
      const receive = () =>
        f.home.tx((tx) =>
          tx.toDevice.receive(
            'remote.test',
            order,
            '@bob:remote.test',
            'm.test',
            'logical.test',
            [
              { user: '@alice:logical.test', id: '*', content: { order } },
            ],
            config().e2ee,
          )
        );
      await f.edge.tx((tx) =>
        tx.toDevice.receive(
          'remote.test',
          order,
          '@bob:remote.test',
          'm.test',
          'logical.test',
          [
            { user: '@alice:logical.test', id: '*', content: { order } },
          ],
          config().e2ee,
        )
      );
      const source = await f.ed.tx((conn) =>
        routing.captureToDeviceOperations(conn, 'alice')
      );
      if (order === 'direct') await receive();
      for (const op of source) await f.hd.tx((conn) => apply(conn, op, 'edge'));
      if (order === 'imported') await receive();
      const lan = await deviceIdentity(f.home, 'alice', 'LAN');
      const delivered = await f.home.tx((tx) =>
        tx.toDevice.deliverSliding(lan, order, 100, config().e2ee)
      );
      assertEquals(delivered.events.map((event) => event.content), [{ order }]);
      await f.home.tx((tx) =>
        tx.toDevice.acknowledgeSliding(lan, order, delivered.nextBatch)
      );
      await deleteDevices(f.home, 'alice', ['LAN']);
      await upsertDevice(f.home, 'alice', 'LAN');
      await receive();
      for (const op of source) await f.hd.tx((conn) => apply(conn, op, 'edge'));
      assertEquals(await f.hd.query('SELECT * FROM to_device_inbox'), []);
    } finally {
      await f.close();
    }
  }
});

Deno.test('to-device logical admission: historical imported routes fence hash substitution before receipt repair', async () => {
  const f = await fixture();
  try {
    await f.edge.tx((tx) =>
      tx.toDevice.receive(
        'remote.test',
        'old-reader',
        '@bob:remote.test',
        'm.test',
        'logical.test',
        [
          { user: '@alice:logical.test', id: '*', content: { kept: true } },
        ],
        config().e2ee,
      )
    );
    const source = await f.ed.tx((conn) =>
      routing.captureToDeviceOperations(conn, 'alice')
    );
    for (const op of source) await f.hd.tx((conn) => apply(conn, op, 'edge'));
    // Reproduce a retained old-reader route, not a future schema relabeled old.
    await f.hd.execute('DELETE FROM to_device_admissions');
    const before = await f.hd.query('SELECT * FROM to_device_inbox');
    await assertRejects(
      () =>
        f.home.tx((tx) =>
          tx.toDevice.receive(
            'remote.test',
            'old-reader',
            '@bob:remote.test',
            'm.test',
            'logical.test',
            [
              {
                user: '@other:logical.test',
                id: '*',
                content: { changed: true },
              },
            ],
            config().e2ee,
          )
        ),
      Error,
      'to-device operation identity changed',
    );
    await assertRejects(
      () =>
        f.hd.tx(async (conn) => {
          await apply(conn, source.find((op) => op.kind === 'route')!, 'edge');
          throw new Error('rollback repair');
        }),
      Error,
      'rollback repair',
    );
    assertEquals(await f.hd.query('SELECT * FROM to_device_admissions'), []);
    for (const op of source) await f.hd.tx((conn) => apply(conn, op, 'edge'));
    assertEquals(
      (await f.hd.query('SELECT policy FROM to_device_admissions'))[0].policy,
      'routed',
    );
    assertEquals(await f.hd.query('SELECT * FROM to_device_inbox'), before);
  } finally {
    await f.close();
  }
});

Deno.test('to-device logical admission: partial import leaves a different recipient retryable without rebuilding routes', async () => {
  const f = await fixture();
  const messages = [
    { user: '@alice:logical.test', id: '*', content: { key: 'alice' } },
    { user: '@bob:logical.test', id: '*', content: { key: 'bob' } },
  ];
  try {
    await f.home.tx((tx) => tx.users.insert('bob', 'Bob'));
    await upsertDevice(f.home, 'bob', 'BOB_LAN');
    await f.edge.tx((tx) =>
      tx.toDevice.receive(
        'remote.test',
        'partial',
        '@sender:remote.test',
        'm.test',
        'logical.test',
        messages,
        config().e2ee,
      )
    );
    const alice = await f.ed.tx((conn) =>
      routing.captureToDeviceOperations(conn, 'alice')
    );
    const bob = await f.ed.tx((conn) =>
      routing.captureToDeviceOperations(conn, 'bob')
    );
    for (const op of alice) await f.hd.tx((conn) => apply(conn, op, 'edge'));
    const receive = () =>
      f.home.tx((tx) =>
        tx.toDevice.receive(
          'remote.test',
          'partial',
          '@sender:remote.test',
          'm.test',
          'logical.test',
          messages,
          config().e2ee,
        )
      );
    const routes = await f.hd.query('SELECT * FROM to_device_routes');
    await assertRejects(
      receive,
      Error,
      'to-device operation awaits retained recipient routes',
    );
    assertEquals(
      await f.hd.query('SELECT * FROM inbound_to_device'),
      [],
      'partial recipient coverage cannot acknowledge a direct retry',
    );
    assertEquals(
      await f.hd.query('SELECT * FROM to_device_routes'),
      routes,
      'retry must not manufacture missing routes from current control',
    );
    const lan = await deviceIdentity(f.home, 'alice', 'LAN');
    const issued = await f.home.tx((tx) =>
      tx.toDevice.deliverSliding(lan, 'partial', 100, config().e2ee)
    );
    assertEquals(issued.events.map((event) => event.content), [{
      key: 'alice',
    }]);
    await f.home.tx((tx) =>
      tx.toDevice.acknowledgeSliding(lan, 'partial', issued.nextBatch)
    );
    await deleteDevices(f.home, 'alice', ['LAN']);
    await upsertDevice(f.home, 'alice', 'LAN');
    for (const op of bob) {
      await f.hd.tx((conn) =>
        routing.importToDeviceOperation(conn, op, {
          ...expected('edge'),
          localpart: 'bob',
        }, 'logical.test')
      );
    }
    await receive();
    assertEquals(
      (await f.hd.query('SELECT localpart,event_json FROM to_device_inbox'))
        .map((row) => ({
          localpart: row.localpart,
          content: JSON.parse(String(row.event_json)).content,
        })),
      [{ localpart: 'bob', content: { key: 'bob' } }],
    );
    const reopened = await f.reopen();
    await reopened.hd.tx((conn) =>
      receiveMessages(
        conn,
        'remote.test',
        'partial',
        '@sender:remote.test',
        'm.test',
        'logical.test',
        messages,
        config().e2ee,
      )
    );
    assertEquals(
      (await reopened.hd.query('SELECT localpart FROM to_device_inbox')).map((
        row,
      ) => row.localpart),
      ['bob'],
      'cold retry cannot expand the acknowledged wildcard into its replacement',
    );
  } finally {
    await f.close();
  }
});

Deno.test('to-device semantic import: collision, forged expansion/ACK and missing dependencies roll back without delivery authority', async () => {
  const f = await fixture();
  try {
    await f.send('forgery');
    const source = await f.ed.tx((conn) =>
      routing.captureToDeviceOperations(conn, 'alice')
    );
    const route = source.find((op) =>
      op.kind === 'route' && op.value.owner === 'edge'
    );
    const expansion = source.find((op) => op.kind === 'expansion');
    assert(route?.kind === 'route' && expansion?.kind === 'expansion');
    await assertRejects(
      () => f.hd.tx((conn) => apply(conn, expansion, 'edge')),
      Error,
      'awaits route',
    );
    assertEquals(await f.hd.query('SELECT * FROM to_device_operations'), []);
    await f.hd.tx((conn) => apply(conn, route, 'edge'));
    const before = await f.hd.query('SELECT * FROM to_device_operations');
    const changed = rehash({
      ...route,
      value: { ...route.value, type: 'changed' },
    });
    await assertRejects(
      () => f.hd.tx((conn) => apply(conn, changed, 'edge')),
      Error,
      'identity changed',
    );
    const forged = rehash({
      ...expansion,
      source: 'home',
      incarnation: 'home-store',
      operationId: canonicalJson([
        'home',
        'home-store',
        'to-device',
        expansion.sequence,
      ]),
    });
    await assertRejects(
      () => f.hd.tx((conn) => apply(conn, forged, 'home')),
      Error,
      'destination owner',
    );
    const badTarget = rehash({
      ...expansion,
      value: {
        ...expansion.value,
        targets: expansion.value.targets.map((target) => ({
          ...target,
          event: {
            type: 'm.room_key',
            sender: '@alice:logical.test',
            content: { forged: true },
          },
        })),
      },
    });
    await assertRejects(
      () => f.hd.tx((conn) => apply(conn, badTarget, 'edge')),
      Error,
      'target differs',
    );
    assertEquals(
      await f.hd.query('SELECT * FROM to_device_operations'),
      before,
    );
    const authority = await f.ed.tx((conn) =>
      captureSessionAuthority(conn, 'alice')
    );
    await f.hd.execute("DELETE FROM authority_facts WHERE node='edge'");
    const legacy = rehash({
      ...expansion,
      value: {
        ...expansion.value,
        targets: expansion.value.targets.map((
          { creation: _creation, ...target },
        ) => target),
      },
    });
    await assertRejects(
      () => f.hd.tx((conn) => apply(conn, legacy, 'edge')),
      Error,
      'awaits target incarnation',
    );
    assertEquals(
      await f.hd.query('SELECT * FROM to_device_operations'),
      before,
    );
    await f.hd.tx((conn) => installSessionAuthority(conn, 'alice', authority));
    const wrongCreation = rehash({
      ...expansion,
      value: {
        ...expansion.value,
        targets: expansion.value.targets.map((target) => ({
          ...target,
          creation: { ...target.creation!, localpart: 'another-account' },
        })),
      },
    });
    await assertRejects(
      () => f.hd.tx((conn) => apply(conn, wrongCreation, 'edge')),
      Error,
      'target differs',
    );
    await f.hd.tx((conn) => apply(conn, expansion, 'edge'));
    const badAck = rehash({
      ...expansion,
      sequence: expansion.sequence + 50,
      operationId: canonicalJson([
        'edge',
        'edge-store',
        'to-device',
        expansion.sequence + 50,
      ]),
      kind: 'ack',
      value: { routeId: route.value.routeId, targetIds: ['unseen-target'] },
    });
    await assertRejects(
      () => f.hd.tx((conn) => apply(conn, badAck, 'edge')),
      Error,
      'target differs',
    );
    await assertRejects(
      () =>
        f.hd.tx(async (conn) => {
          await apply(
            conn,
            source.find((op) =>
              op.kind === 'route' && op.value.owner === 'home'
            )!,
            'edge',
          );
          throw new Error('rollback inbox and expansion');
        }),
      Error,
      'rollback inbox',
    );
    assertEquals(await f.hd.query('SELECT * FROM to_device_inbox'), []);
    assertEquals(await f.hd.query('SELECT * FROM to_device_targets'), []);
  } finally {
    await f.close();
  }
});

Deno.test('to-device semantic import: cross-account targets use the recipient registry, not the sender stream or foreign generation', async () => {
  const f = await fixture();
  try {
    await f.home.tx((tx) => tx.users.insert('bob', 'Bob'));
    await upsertDevice(f.home, 'bob', 'BOB');
    const sender = await deviceIdentity(f.edge, 'alice', 'PHONE');
    await f.edge.tx((tx) =>
      tx.toDevice.send(
        sender,
        'logical.test',
        'm.room_key',
        'cross-user',
        'cross-user',
        [{ user: '@bob:logical.test', id: '*', content: { cross: true } }],
        config().e2ee,
        { enabled: true, maxBytes: 1048576 },
      )
    );
    const source = await f.ed.tx((conn) =>
      routing.captureToDeviceOperations(conn, 'alice')
    );
    for (const op of source) await f.hd.tx((conn) => apply(conn, op, 'edge'));
    const bob = await deviceIdentity(f.home, 'bob', 'BOB');
    const delivered = await f.home.tx((tx) =>
      tx.toDevice.deliverSliding(bob, 'bob', 100, config().e2ee)
    );
    assertEquals(delivered.events, [{
      sender: '@alice:logical.test',
      type: 'm.room_key',
      content: { cross: true },
    }]);
    assertEquals(
      (await f.hd.query('SELECT localpart,device_id FROM to_device_targets'))
        .map((row) => [row.localpart, row.device_id]),
      [['bob', 'BOB']],
    );
    const disposition = await f.hd.tx((conn) =>
      routing.captureToDeviceOperations(conn, 'alice')
    );
    assertEquals(disposition.map((op) => op.localpart), ['alice']);
    for (const op of disposition) {
      await f.ed.tx((conn) => apply(conn, op, 'home'));
    }
    assertEquals(
      await f.ed.query("SELECT * FROM authority_facts WHERE localpart='bob'"),
      [],
      'a target disposition cannot install another account or its registry authority',
    );
  } finally {
    await f.close();
  }
});

Deno.test('to-device semantic import: recipient auth alone resumes a cold cross-account selector atomically without sender retry', async () => {
  const f = await fixture();
  const previous = { ...config().e2ee };
  try {
    setConfigForTests({ e2ee: { maxinboxmessages: 1 } });
    await f.home.tx((tx) => tx.users.insert('bob', 'Bob'));
    await f.edge.tx((tx) => tx.users.insert('bob', 'Bob'));
    // Independent device authority can already be held while auth bootstrap
    // for this account has not yet arrived. It is not an empty registry.
    await upsertDevice(f.edge, 'bob', 'BOB');
    await upsertDevice(f.edge, 'bob', 'SECOND');
    const recipient = await deviceIdentity(f.edge, 'bob', 'BOB');
    const second = await deviceIdentity(f.edge, 'bob', 'SECOND');
    const retained = {
      sender: '@alice:logical.test',
      type: 'm.room_key',
      content: { key: 'retained-before-auth' },
    };
    await f.ed.tx((conn) =>
      insertMessage(conn, recipient, 'retained', retained, config().e2ee)
    );
    const before = await f.ed.query('SELECT * FROM to_device_inbox');
    const sender = await deviceIdentity(f.home, 'alice', 'LAN');
    await f.home.tx((tx) =>
      tx.toDevice.send(
        sender,
        'logical.test',
        'm.room_key',
        'pending-bob',
        'pending-bob',
        [
          { user: '@bob:logical.test', id: '*', content: { key: 'deferred' } },
        ],
        config().e2ee,
        { enabled: true, maxBytes: 1048576 },
      )
    );
    const operations = await f.hd.tx((conn) =>
      routing.captureToDeviceOperations(conn, 'alice')
    );
    const route = operations.find((op) =>
      op.kind === 'route' && op.value.owner === 'edge'
    )!;
    assert(route);
    await f.ed.tx((conn) => apply(conn, route, 'home'));
    assertEquals(
      await f.ed.query(
        'SELECT expanded FROM to_device_routes WHERE route_id=?',
        [route.kind === 'route' ? route.value.routeId : ''],
      ),
      [{ expanded: 0 }],
    );
    assertEquals(await f.ed.query('SELECT * FROM to_device_inbox'), before);
    const snapshot = await f.hd.tx((conn) =>
      captureAccountAuth(
        conn,
        {
          server: 'logical.test',
          pairing: 'pair',
          grantRevision: 1,
          ownerRevision: 1,
        },
        'bob',
        false,
        Date.now(),
      )
    );
    const { ed } = await f.reopen();
    await assertRejects(
      () =>
        ed.tx(async (conn) => {
          await installAccountAuth(conn, snapshot);
          throw new Error('rollback recipient bootstrap');
        }),
      Error,
      'rollback recipient bootstrap',
    );
    assertEquals(await ed.query('SELECT * FROM to_device_inbox'), before);
    assertEquals(
      await ed.query('SELECT * FROM account_auth_snapshots WHERE localpart=?', [
        'bob',
      ]),
      [],
    );
    await ed.tx((conn) => installAccountAuth(conn, snapshot));
    const delivered = await ed.tx((conn) =>
      deliverSliding(conn, recipient, 'bob', 100, config().e2ee)
    );
    const resumed = {
      sender: '@alice:logical.test',
      type: 'm.room_key',
      content: { key: 'deferred' },
    };
    assertEquals(delivered.events, [retained, resumed]);
    assertEquals(
      (await ed.tx((conn) =>
        deliverSliding(conn, second, 'second', 100, config().e2ee)
      )).events,
      [resumed],
    );
    await ed.tx((conn) => installAccountAuth(conn, snapshot));
    assertEquals(
      (await ed.query('SELECT source_id FROM to_device_inbox')).length,
      3,
    );
    const facts = await ed.query(
      'SELECT localpart,kind FROM to_device_operations ORDER BY sequence',
    );
    assert(facts.every((fact) => fact.localpart === 'alice'));
    assertEquals(facts.map((fact) => fact.kind).sort(), ['expansion', 'route']);
    assertEquals(
      await ed.query(
        'SELECT payload_json FROM to_device_operations WHERE operation_id=?',
        [route.operationId],
      ),
      [{ payload_json: canonicalJson(route) }],
    );
    await ed.tx(async (conn) => {
      await deleteDevice(conn, 'BOB', 'bob');
      await upsertDeviceRow(conn, 'BOB', 'bob', null);
      await installAccountAuth(conn, snapshot);
    });
    const [replacement] = await ed.query(
      "SELECT generation FROM devices WHERE localpart='bob' AND device_id='BOB'",
    );
    assert(Number(replacement.generation) > recipient.generation);
    assertEquals(
      (await ed.tx((conn) =>
        deliverSliding(
          conn,
          { ...recipient, generation: Number(replacement.generation) },
          'replacement',
          100,
          config().e2ee,
        )
      )).events,
      [],
    );
  } finally {
    setConfigForTests({ e2ee: previous });
    await f.close();
  }
});
