import { assert, assertEquals, assertRejects } from '@std/assert';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { activateTenantAuthority } from '#engine/tenant/session-authority.ts';
import { registerOperations } from '#engine/facade/registers.ts';
import { registerUser } from '#engine/tenant/users.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { DelayedEvents } from '#engine/delayed-events.ts';
import type { Pdu } from '#engine/pdu.ts';

async function fixture() {
  const dir = await Deno.makeTempDir({ prefix: 'facade-delayed-' });
  const stores: Awaited<ReturnType<typeof openStore>>[] = [];
  const tenants: Awaited<ReturnType<typeof openTenant>>[] = [];
  for (const node of ['home', 'edge']) {
    const store = await openStore({
      dir: dir + '/' + node,
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 300,
    }, { schemas: { tenant: tenantSchema } });
    stores.push(store);
    const tenant = await openTenant(store, 'logical.test', { create: true });
    await registerUser(tenant, { localpart: 'alice', password: 'pw' });
    await (await store.tenant('logical.test')).tx((conn) =>
      activateTenantAuthority(conn, {
        node,
        incarnation: node + '-store',
        homeIncarnation: 'home-store',
        edgeNode: 'edge',
        edgeIncarnation: 'edge-store',
      })
    );
    tenants.push(tenant);
  }
  return {
    home: tenants[0],
    edge: tenants[1],
    stores,
    async close() {
      for (const store of stores) await store.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

function event(id: string = crypto.randomUUID()) {
  return {
    id,
    localpart: 'alice',
    roomId: '!held:logical.test',
    type: 'm.room.encrypted',
    stateKey: null,
    content: { algorithm: 'test', ciphertext: 'retained' },
    delay: 60000,
    since: 1000,
    due: 61000,
    roomPos: 7,
    stateEvent: null,
    phase: 'pending',
  };
}

Deno.test('facade delayed: acknowledgment retains the schedule fact atomically', async () => {
  const f = await fixture();
  try {
    const row = event();
    await f.home.tx((tx) => tx.delayedEvents.add(row, 10));
    const operations = await (await f.stores[0].tenant('logical.test')).tx((
      conn,
    ) =>
      registerOperations(
        conn,
        JSON.stringify(['delayed-event', 'alice', row.id]),
      )
    );
    assertEquals(
      operations.length,
      1,
      'schedule ACK has no retained export fact',
    );
    assertEquals(operations[0].source, 'home');
    assertEquals(JSON.parse(operations[0].payload).event.content, row.content);
  } finally {
    await f.close();
  }
});

Deno.test('facade delayed: foreign delay bearer refuses at its owner boundary', async () => {
  const f = await fixture();
  const worker = new DelayedEvents({ tenant: f.edge, store: f.stores[1] });
  try {
    const error = await assertRejects(
      () => worker.action('legacy-home-delay', 'cancel'),
      MatrixError,
    );
    assertEquals(error.status, 503);
    assertEquals(
      error.message.includes('operation owner unavailable at this ingress'),
      true,
    );
    assert(
      await f.home.tx((tx) => tx.delayedEvents.get('legacy-home-delay')) ===
        null,
    );
  } finally {
    await worker.stop();
    await f.close();
  }
});

Deno.test('facade delayed: namespaced bearer IDs fence every native mutation and read', async () => {
  const f = await fixture();
  try {
    const id = await f.edge.tx((tx) => tx.delayedEvents.newId());
    assert(id.startsWith('d.'));
    await f.edge.tx((tx) => tx.delayedEvents.add(event(id), 10));
    assertEquals(
      (await f.edge.tx((tx) => tx.delayedEvents.list('alice'))).length,
      1,
    );
    for (
      const operation of [
        () => f.home.tx((tx) => tx.delayedEvents.get(id)),
        () => f.home.tx((tx) => tx.delayedEvents.remove(id)),
        () => f.home.tx((tx) => tx.delayedEvents.action(id, 'restart', 1000)),
        () => f.home.tx((tx) => tx.delayedEvents.claim(id, 61001)),
        () => f.home.tx((tx) => tx.delayedEvents.retry([id], 62000)),
        () => f.home.tx((tx) => tx.delayedEvents.submission(id)),
        () => f.home.tx((tx) => tx.delayedEvents.prepare(id, {} as Pdu)),
        () => f.home.tx((tx) => tx.delayedEvents.finish(id)),
        () => f.home.tx((tx) => tx.delayedEvents.add(event(id), 10)),
      ]
    ) {
      const error = await assertRejects(operation, MatrixError);
      assertEquals(error.status, 503);
      assertEquals(error.errcode, 'M_UNAVAILABLE');
    }
    assertEquals(
      await f.home.tx((tx) => tx.delayedEvents.operations('alice')),
      [],
    );
    const worker = new DelayedEvents({ tenant: f.home, store: f.stores[0] });
    try {
      const error = await assertRejects(
        () => worker.list('@alice:logical.test', id),
        MatrixError,
      );
      assertEquals(error.status, 503);
    } finally {
      await worker.stop();
    }
  } finally {
    await f.close();
  }
});

Deno.test('facade delayed: exact preparation and terminal completion survive executable row deletion', async () => {
  const f = await fixture();
  try {
    const id = await f.edge.tx((tx) => tx.delayedEvents.newId());
    await f.edge.tx((tx) => tx.delayedEvents.add(event(id), 10));
    await f.edge.tx((tx) => tx.delayedEvents.claim(id, 61001));
    const pdu = {
      event_id: '$prepared',
      room_id: '!held:logical.test',
      type: 'm.room.encrypted',
      sender: '@alice:logical.test',
      content: { algorithm: 'test', ciphertext: 'exact' },
      origin_server_ts: 1234,
      prev_events: [],
      auth_events: [],
      depth: 1,
      hashes: { sha256: 'saved-hash' },
      signatures: { 'logical.test': { 'ed25519:edge': 'saved' } },
    } as Pdu;
    assertEquals(await f.edge.tx((tx) => tx.delayedEvents.prepare(id, pdu)), {
      eventId: '$prepared',
      pdu,
    });
    const prepared = await f.edge.tx((tx) =>
      tx.delayedEvents.operations('alice')
    );
    await f.edge.tx((tx) =>
      tx.delayedEvents.prepare(id, { ...pdu, origin_server_ts: 9999 })
    );
    assertEquals(
      await f.edge.tx((tx) => tx.delayedEvents.operations('alice')),
      prepared,
    );
    await f.edge.tx((tx) => tx.delayedEvents.finish(id));
    await f.edge.tx((tx) => tx.delayedEvents.remove(id, 'rejected'));
    assertEquals(await f.edge.tx((tx) => tx.delayedEvents.get(id)), null);
    const facts = await f.edge.tx((tx) => tx.delayedEvents.operations('alice'));
    assert(
      facts.some((fact) =>
        JSON.stringify(JSON.parse(fact.payload).pdu) ===
          JSON.stringify(JSON.parse(prepared.at(-1)!.payload).pdu)
      ),
    );
    assertEquals(JSON.parse(facts.at(-1)!.payload).event.phase, 'completed');
    assertEquals(JSON.parse(facts.at(-1)!.payload).eventId, '$prepared');
    assertEquals(
      JSON.parse(facts.at(-1)!.payload).standing,
      'rejected',
      'completion lost the actual rejected result',
    );
    assertEquals(facts.map((fact) => fact.sequence), [1, 2, 3, 4, 5]);
    await assertRejects(
      () => f.edge.tx((tx) => tx.delayedEvents.add(event(id), 10)),
      Error,
      'terminal',
    );
    assertEquals(await f.edge.tx((tx) => tx.delayedEvents.get(id)), null);
  } finally {
    await f.close();
  }
});

Deno.test('facade delayed: cancel and account deactivation retain terminal facts with atomic rollback', async () => {
  const f = await fixture();
  try {
    const id = await f.edge.tx((tx) => tx.delayedEvents.newId());
    await assertRejects(
      () =>
        f.edge.tx(async (tx) => {
          await tx.delayedEvents.add(event(id), 10);
          throw new Error('rollback add');
        }),
      Error,
      'rollback add',
    );
    assertEquals(await f.edge.tx((tx) => tx.delayedEvents.get(id)), null);
    assertEquals(
      await f.edge.tx((tx) => tx.delayedEvents.operations('alice')),
      [],
    );
    await f.edge.tx((tx) => tx.delayedEvents.add(event(id), 10));
    await assertRejects(
      () =>
        f.edge.tx(async (tx) => {
          await tx.delayedEvents.remove(id);
          throw new Error('rollback cancel');
        }),
      Error,
      'rollback cancel',
    );
    assert(await f.edge.tx((tx) => tx.delayedEvents.get(id)));
    assertEquals(
      (await f.edge.tx((tx) => tx.delayedEvents.operations('alice'))).length,
      1,
    );
    await f.edge.tx((tx) => tx.delayedEvents.action(id, 'cancel', 2000));
    const second = await f.edge.tx((tx) => tx.delayedEvents.newId());
    await f.edge.tx((tx) => tx.delayedEvents.add(event(second), 10));
    await f.edge.tx((tx) => tx.users.markDeactivated('alice'));
    assertEquals(await f.edge.tx((tx) => tx.delayedEvents.list('alice')), []);
    const operations = await f.edge.tx((tx) =>
      tx.delayedEvents.operations('alice')
    );
    assertEquals(
      operations.filter((fact) =>
        JSON.parse(fact.payload).event.phase === 'cancelled'
      ).length,
      2,
    );
    await assertRejects(
      () =>
        f.edge.tx(async (tx) =>
          tx.delayedEvents.add(event(await tx.delayedEvents.newId()), 10)
        ),
      MatrixError,
    );
  } finally {
    await f.close();
  }
});

Deno.test('facade delayed: send transaction retry retains its original cancelled schedule and no new export', async () => {
  const f = await fixture();
  try {
    const id = await f.edge.tx((tx) => tx.delayedEvents.newId());
    const receipt = {
      device: { localpart: 'alice', deviceId: 'edge-device', generation: 1 },
      endpoint: JSON.stringify(['!held:logical.test', 'm.room.encrypted']),
      txnId: 'once',
    };
    await f.edge.tx((tx) => tx.delayedEvents.add(event(id), 10, receipt));
    const first = await f.edge.tx((tx) => tx.delayedEvents.operations('alice'));
    assertEquals(JSON.parse(first[0].payload).receipts, [{
      localpart: 'alice',
      device_id: 'edge-device',
      generation: 1,
      endpoint: receipt.endpoint,
      txn_id: 'once',
    }]);
    await f.edge.tx((tx) => tx.delayedEvents.action(id, 'cancel', 2000));
    const before = await f.edge.tx((tx) =>
      tx.delayedEvents.operations('alice')
    );
    const retryId = await f.edge.tx((tx) => tx.delayedEvents.newId());
    assertEquals(
      await f.edge.tx((tx) =>
        tx.delayedEvents.add(event(retryId), 10, receipt)
      ),
      id,
    );
    assertEquals(
      await f.edge.tx((tx) => tx.delayedEvents.operations('alice')),
      before,
    );
    assertEquals(await f.edge.tx((tx) => tx.delayedEvents.get(retryId)), null);
    assertEquals(await f.edge.tx((tx) => tx.delayedEvents.due(100000)), []);
    assertEquals(await f.edge.tx((tx) => tx.delayedEvents.next()), null);
  } finally {
    await f.close();
  }
});
