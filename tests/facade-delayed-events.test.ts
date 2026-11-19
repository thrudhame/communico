import { assert, assertEquals, assertRejects } from '@std/assert';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { activateTenantAuthority } from '#engine/tenant/session-authority.ts';
import { registerOperations, writeRegister } from '#engine/facade/registers.ts';
import { importOperation, replicas } from '#engine/tenant/delayed-events.ts';
import { registerUser } from '#engine/tenant/users.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { DelayedEvents } from '#engine/delayed-events.ts';
import type { Pdu } from '#engine/pdu.ts';
import { copyPrivate } from '#engine/store/files.ts';
import { withCandidateStore } from '#engine/store/candidate.ts';
import { sanitizeRestoredTenant } from '#engine/tenant/restore.ts';
import * as delayed from '#engine/tenant/delayed-events.ts';

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
    dir,
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

Deno.test('facade delayed restore: a pending backup cannot execute before the surviving terminal suffix', async () => {
  const f = await fixture();
  try {
    const id = await f.edge.tx((tx) => tx.delayedEvents.newId());
    const receipt = {
      device: { localpart: 'alice', deviceId: 'edge-device', generation: 1 },
      endpoint: JSON.stringify(['!held:logical.test', 'm.room.encrypted']),
      txnId: 'restore-once',
    };
    await f.edge.tx((tx) => tx.delayedEvents.add(event(id), 10, receipt));
    const cutFacts = await f.edge.tx((tx) =>
      tx.delayedEvents.operations('alice')
    );
    const cut = await f.stores[1].snapshot(f.dir + '/archive');
    await copyPrivate(f.dir + '/archive', f.dir + '/candidate');
    // The live issuer advances AFTER the backup, and its original facts survive
    // elsewhere. The restored copy cannot infer this from its pending row.
    await f.edge.tx((tx) => tx.delayedEvents.claim(id, 999999));
    await f.edge.tx((tx) =>
      tx.delayedEvents.prepare(id, {
        event_id: '$after-backup',
        room_id: event(id).roomId,
      } as Pdu)
    );
    await f.edge.tx((tx) => tx.delayedEvents.finish(id));
    await f.edge.tx((tx) => tx.delayedEvents.remove(id, 'accepted'));
    const terminal = await f.edge.tx((tx) =>
      tx.delayedEvents.operations('alice')
    );
    await withCandidateStore(
      {
        library: './.native/libturso_ffi.so',
        checkpointlogbytes: 65536,
      },
      f.dir + '/candidate',
      cut.files,
      { tenant: tenantSchema },
      async (candidate) => {
        const file = candidate.files.find((file) => file.kind === 'tenants')!;
        await candidate.tx(file, async (conn) => {
          await sanitizeRestoredTenant(conn);
          assertEquals(
            await delayed.due(conn, 999999),
            [],
            'restored schedule is runnable before suffix recovery',
          );
          assertEquals(await delayed.next(conn), null);
          assertEquals(await delayed.claim(conn, id, 999999), null);
          assertEquals(await delayed.operations(conn, 'alice'), cutFacts);
          assertEquals(await delayed.receipt(conn, receipt), id);
          assertEquals((await delayed.get(conn, id))!.phase, 'quarantined');
          for (
            const mutate of [
              () => delayed.action(conn, id, 'send', 999999),
              () => delayed.action(conn, id, 'restart', 999999),
              () => delayed.action(conn, id, 'cancel', 999999),
              () => delayed.remove(conn, id),
              () => delayed.retry(conn, [id], 999999),
              () => delayed.prepare(conn, id, {} as Pdu),
              () => delayed.finish(conn, id),
            ]
          ) {
            const error = await assertRejects(mutate, MatrixError);
            assertEquals(error.status, 503);
          }
          // Repeated sanitation and an old pending snapshot are not a release.
          await sanitizeRestoredTenant(conn);
          await delayed.importOperation(conn, cutFacts[0]);
          assertEquals(await delayed.due(conn, 999999), []);
          for (const op of terminal.toReversed()) {
            await delayed.importOperation(conn, op);
          }
          assertEquals(await delayed.get(conn, id), null);
          assertEquals(
            await delayed.operations(conn, 'alice'),
            terminal,
            'restore retirement authored an echo',
          );
          assertEquals(await delayed.receipt(conn, receipt), id);
        });
      },
    );
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

Deno.test('facade delayed restore: quarantine is atomic, preserves evidence and does not change standalone restoration', async () => {
  const f = await fixture();
  try {
    const raw = await f.stores[0].tenant('logical.test');
    const id = 'legacy-home-schedule';
    await f.home.tx((tx) => tx.delayedEvents.add(event(id), 10));
    await f.home.tx((tx) => tx.delayedEvents.claim(id, 999999));
    const facts = await f.home.tx((tx) => tx.delayedEvents.operations('alice'));
    await assertRejects(
      () =>
        raw.tx(async (conn) => {
          await sanitizeRestoredTenant(conn);
          assertEquals(await delayed.due(conn, 999999), []);
          throw new Error('candidate rollback');
        }),
      Error,
      'candidate rollback',
    );
    assertEquals(
      (await f.home.tx((tx) => tx.delayedEvents.get(id)))!.phase,
      'sending',
    );
    assertEquals(
      (await f.home.tx((tx) => tx.delayedEvents.due(999999))).length,
      1,
    );
    await raw.tx(sanitizeRestoredTenant);
    assertEquals(
      (await f.home.tx((tx) => tx.delayedEvents.get(id)))!.phase,
      'quarantined',
    );
    const worker = new DelayedEvents({ tenant: f.home, store: f.stores[0] });
    try {
      const listing = await worker.list('@alice:logical.test');
      assert('delayed_events' in listing);
      assertEquals(listing.delayed_events.length, 1);
      for (
        const request of [
          () => worker.list('@alice:logical.test', id),
          () => worker.action(id, 'send'),
          () => worker.action(id, 'cancel'),
        ]
      ) {
        const error = await assertRejects(request, MatrixError);
        assertEquals(error.status, 503);
      }
      await worker.drain();
      assertEquals(await f.home.tx((tx) => tx.delayedEvents.due(999999)), []);
    } finally {
      await worker.stop();
    }
    await f.home.tx((tx) => tx.users.markDeactivated('alice'));
    assertEquals(await f.home.tx((tx) => tx.delayedEvents.get(id)), null);
    assertEquals(
      await f.home.tx((tx) => tx.delayedEvents.operations('alice')),
      facts,
    );

    // A standalone homeserver has no independently advancing schedule replica.
    const standalone = await f.stores[1].tenant('logical.test');
    await standalone.execute('DELETE FROM tenant_authority');
    await f.edge.tx((tx) => tx.delayedEvents.add(event('standalone'), 10));
    await standalone.tx(sanitizeRestoredTenant);
    assertEquals(
      (await f.edge.tx((tx) => tx.delayedEvents.get('standalone')))!.phase,
      'pending',
    );
    assertEquals(
      (await f.edge.tx((tx) => tx.delayedEvents.claim('standalone', 999999)))!
        .id,
      'standalone',
    );
  } finally {
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
    for (const fact of facts.toReversed()) {
      await f.home.tx((tx) => tx.delayedEvents.import(fact));
    }
    assertEquals(
      await f.home.tx((tx) => tx.delayedEvents.operations('alice')),
      facts,
    );
    assertEquals(
      await f.home.tx((tx) => tx.delayedEvents.replicas('alice')),
      [],
    );
    assertEquals(await f.home.tx((tx) => tx.delayedEvents.next()), null);
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

Deno.test('facade delayed replicas: reordered originals retain terminal evidence without creating execution or local receipts', async () => {
  for (const order of [[0, 1, 2], [2, 0, 1], [1, 2, 0]]) {
    const f = await fixture();
    try {
      const id = await f.home.tx((tx) => tx.delayedEvents.newId());
      await f.home.tx((tx) => tx.delayedEvents.add(event(id), 10));
      await f.home.tx((tx) => tx.delayedEvents.action(id, 'restart', 2000));
      await f.home.tx((tx) => tx.delayedEvents.remove(id));
      const facts = await f.home.tx((tx) =>
        tx.delayedEvents.operations('alice')
      );
      assertEquals(facts.length, 3);
      const ed = await f.stores[1].tenant('logical.test');
      for (const index of order) {
        await ed.tx((conn) => importOperation(conn, facts[index]));
        await ed.tx((conn) => importOperation(conn, facts[index]));
        const known = await ed.tx((conn) => replicas(conn, 'alice'));
        if (order.slice(0, order.indexOf(index) + 1).includes(2)) {
          assertEquals(known, []);
        }
        assertEquals(await f.edge.tx((tx) => tx.delayedEvents.due(999999)), []);
        assertEquals(await ed.query('SELECT * FROM delayed_events'), []);
        assertEquals(
          await ed.query('SELECT * FROM delayed_event_receipts'),
          [],
        );
      }
      assertEquals(
        await f.edge.tx((tx) => tx.delayedEvents.operations('alice')),
        facts,
      );
      assertEquals(await ed.tx((conn) => replicas(conn, 'bob')), []);
    } finally {
      await f.close();
    }
  }
});

Deno.test('facade delayed replicas: forged issuer, changed source history and post-terminal resurrection roll back', async () => {
  const f = await fixture();
  try {
    const id = await f.home.tx((tx) => tx.delayedEvents.newId());
    await f.home.tx((tx) => tx.delayedEvents.add(event(id), 10));
    const [original] = await f.home.tx((tx) =>
      tx.delayedEvents.operations('alice')
    );
    const ed = await f.stores[1].tenant('logical.test');
    const forged = await (await f.stores[0].tenant('logical.test')).tx((conn) =>
      writeRegister(
        conn,
        { source: 'edge', incarnation: 'edge-store' },
        original.semanticKey,
        'delayed-event',
        original.payload,
      )
    );
    await assertRejects(
      () => ed.tx((conn) => importOperation(conn, forged.operation)),
      Error,
      'invalid delayed event',
    );
    await ed.tx((conn) => importOperation(conn, original));
    const changed = structuredClone(original);
    changed.payload = changed.payload.replace('retained', 'substituted');
    await assertRejects(
      () => ed.tx((conn) => importOperation(conn, changed)),
      Error,
      'hash',
    );
    assertEquals(
      (await ed.tx((conn) => replicas(conn, 'alice')))[0].content,
      event().content,
    );
    // A validly hashed source dot is still not permission to revive a terminal
    // command. Build the adversarial history only in the source test fixture.
    const source = await f.stores[0].tenant('logical.test');
    await source.execute('DELETE FROM domain_operations WHERE source=?', [
      'edge',
    ]);
    await f.home.tx((tx) => tx.delayedEvents.remove(id));
    const facts = await f.home.tx((tx) => tx.delayedEvents.operations('alice'));
    await ed.tx((conn) => importOperation(conn, facts.at(-1)!));
    const resurrect = await source.tx((conn) =>
      writeRegister(
        conn,
        { source: 'home', incarnation: 'home-store' },
        original.semanticKey,
        'delayed-event',
        original.payload,
      )
    );
    await assertRejects(
      () => ed.tx((conn) => importOperation(conn, resurrect.operation)),
      Error,
      'terminal',
    );
    assertEquals(await ed.tx((conn) => replicas(conn, 'alice')), []);
    assertEquals(
      await f.edge.tx((tx) => tx.delayedEvents.operations('alice')),
      facts,
    );
  } finally {
    await f.close();
  }
});

Deno.test('facade delayed replicas: immutable command and truthful terminal result are checked across source facts', async () => {
  for (const change of ['content', 'false-completion']) {
    const f = await fixture();
    try {
      const id = await f.home.tx((tx) => tx.delayedEvents.newId());
      await f.home.tx((tx) => tx.delayedEvents.add(event(id), 10));
      const [original] = await f.home.tx((tx) =>
        tx.delayedEvents.operations('alice')
      );
      await f.edge.tx((tx) => tx.delayedEvents.import(original));
      const payload = JSON.parse(original.payload);
      if (change === 'content') {
        payload.event.content = { ciphertext: 'different-command' };
      } else payload.event.phase = 'completed';
      const source = await f.stores[0].tenant('logical.test');
      const altered = await source.tx((conn) =>
        writeRegister(
          conn,
          { source: 'home', incarnation: 'home-store' },
          original.semanticKey,
          'delayed-event',
          JSON.stringify(payload),
        )
      );
      await assertRejects(
        () => f.edge.tx((tx) => tx.delayedEvents.import(altered.operation)),
        Error,
        'delayed event',
      );
      assertEquals(
        (await f.edge.tx((tx) => tx.delayedEvents.operations('alice'))).length,
        1,
      );
    } finally {
      await f.close();
    }
  }
});

Deno.test('facade delayed replicas: account retirement hides original pending facts and their replay', async () => {
  const f = await fixture();
  try {
    const id = await f.home.tx((tx) => tx.delayedEvents.newId());
    await f.home.tx((tx) => tx.delayedEvents.add(event(id), 10));
    const [original] = await f.home.tx((tx) =>
      tx.delayedEvents.operations('alice')
    );
    await f.edge.tx((tx) => tx.delayedEvents.import(original));
    assertEquals(
      (await f.edge.tx((tx) => tx.delayedEvents.replicas('alice'))).length,
      1,
    );
    await f.edge.tx((tx) => tx.users.markDeactivated('alice'));
    await f.edge.tx((tx) => tx.delayedEvents.import(original));
    assertEquals(
      await f.edge.tx((tx) => tx.delayedEvents.replicas('alice')),
      [],
    );
    assertEquals(
      await f.edge.tx((tx) => tx.delayedEvents.operations('alice')),
      [original],
    );
    assertEquals(await f.edge.tx((tx) => tx.delayedEvents.due(999999)), []);
  } finally {
    await f.close();
  }
});
