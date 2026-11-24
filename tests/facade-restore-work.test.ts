import { assert, assertEquals, assertObjectMatch } from '@std/assert';
import { join } from '@std/path';
import { inventoryRestoredWork } from '#engine/backup/work.ts';
import { describePayload } from '#engine/backup/manifest.ts';
import { Journal } from '#engine/facade/journal.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { tenantSchema } from '#engine/tenant/schema.ts';
import { openStore } from '#engine/store/index.ts';
import { inspectSnapshot } from '#engine/store/inspect.ts';

Deno.test('facade restore work: closed cut discloses owner evidence and all pending or terminal transfer identities without payloads or mutation', async () => {
  const root = await Deno.makeTempDir({ prefix: 'facade-restore-work-' });
  const settings = {
    dir: join(root, 'live'),
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  const schemas = { server: serverSchema, tenant: tenantSchema };
  const store = await openStore(settings, { schemas });
  try {
    const server = await store.server();
    const tenant = await store.tenant('restore.test', { create: true });
    const journal = new Journal(server, [{ type: 'control', version: 1 }]);
    const stream = { source: 'home', incarnation: 'grant', stream: 'control' };
    const first = await journal.append('edge', {
      ...stream,
      type: 'control',
      version: 1,
      operationId: 'completed-record',
      payload: { secret: 'private-record' },
    });
    await journal.receive('home', [first]);
    await journal.apply(
      'home',
      stream,
      () => Promise.resolve({ secret: 'private-result' }),
    );
    const last = await journal.append('edge', {
      ...stream,
      type: 'control',
      version: 1,
      operationId: 'pending-record',
      payload: { secret: 'private-record' },
    });
    await journal.receive('home', [last]);
    await journal.ack('edge', stream, { sequence: 2, hash: last.hash }, {
      sequence: 1,
      hash: first.hash,
    }, [{
      sequence: 1,
      hash: first.hash,
      result: { secret: 'private-result' },
    }]);
    await server.execute(
      'INSERT INTO facade_ingress(origin,txn_id,input_hash,evidence_json,bytes,pairing,revision,source,incarnation,response_json,record_sequence,record_hash,ingress_phase) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        'peer.test',
        'accepted',
        'input',
        '{"secret":"private-envelope"}',
        29,
        'grant',
        3,
        'edge',
        'era',
        '{"secret":"private-response"}',
        1,
        'record',
        'f2',
      ],
    );
    await server.execute(
      'INSERT INTO facade_ingress_children VALUES(?,?,?,?,?)',
      [
        'peer.test',
        'accepted',
        'pdu',
        '$event',
        '{"secret":"private-verdict"}',
      ],
    );
    for (const [txn, result] of [['pending', null], ['finished', '{}']]) {
      await server.execute('INSERT INTO facade_egress VALUES(?,?,?,?,?,?,?)', [
        'peer.test',
        txn,
        '{"secret":"private-frozen"}',
        'direct',
        'grant',
        'fence-' + txn,
        result,
      ]);
    }
    await server.execute('INSERT INTO membership_operations VALUES(?,?,?,?)', [
      'membership',
      '!room:test',
      'input',
      '{"secret":"private-membership"}',
    ]);
    for (const db of [server, tenant]) {
      await db.execute('INSERT INTO facade_owner_controls VALUES(?,?,?,?)', [
        'grant',
        3,
        'control',
        '{"secret":"private-control"}',
      ]);
      await db.execute('INSERT INTO facade_owner_activation VALUES(?,?,?)', [
        'grant',
        3,
        'control',
      ]);
      await db.execute(
        'INSERT INTO domain_operations VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        [
          'operation',
          'edge',
          'era',
          'account:alice',
          1,
          'key',
          'account-data',
          '[]',
          'payload',
          '{"secret":"private-domain"}',
          1,
        ],
      );
      await db.execute('INSERT INTO domain_frontiers VALUES(?,?)', [
        'key',
        'operation',
      ]);
      await db.execute('INSERT INTO domain_conflicts VALUES(?,?)', [
        'key',
        'operation',
      ]);
    }
    await tenant.execute('INSERT INTO to_device_routes VALUES(?,?,?,?)', [
      'route',
      'alice',
      '{"secret":"private-selectors"}',
      1,
    ]);
    for (const state of ['pending', 'acked', 'cancelled']) {
      await tenant.execute(
        'INSERT INTO to_device_targets VALUES(?,?,?,?,?,?,?,?)',
        [
          'target-' + state,
          'route',
          'alice',
          'PHONE',
          'creation',
          1,
          '{"secret":"private-message"}',
          state,
        ],
      );
    }
    await tenant.execute('INSERT INTO key_consumptions VALUES(?,?,?,?,?,?)', [
      'alice',
      'PHONE',
      1,
      'signed_curve25519',
      'consumed',
      'material',
    ]);
    await tenant.execute('INSERT INTO device_ack VALUES(?,?,?,?)', [
      'alice',
      'PHONE',
      1,
      8,
    ]);
    await tenant.execute(
      'INSERT INTO facade_link_applications VALUES(?,?,?,?,?,?,?,?)',
      [
        'home',
        'edge',
        'era',
        'devices',
        1,
        'hash',
        '{"secret":"private-application"}',
        7,
      ],
    );
    const cut = await store.snapshot(join(root, 'archive'));
    await store.close();
    const describe = () =>
      Promise.all(
        cut.files.map((file) =>
          describePayload(join(root, 'archive'), file.path)
        ),
      );
    const before = await describe();
    await inspectSnapshot(
      settings,
      join(root, 'archive'),
      cut.files,
      root,
      schemas,
      async (snapshot) => {
        const result = await inventoryRestoredWork(snapshot, Date.now());
        assertObjectMatch(result, {
          facade: {
            streams: [{
              peer: 'edge',
              direction: 'out',
              received: 2,
              applied: 0,
            }, { peer: 'home', direction: 'in', received: 2, applied: 1 }],
            acknowledgements: [{ peer: 'edge', received: 2, applied: 1 }],
            records: [
              { operation_id: 'completed-record', completed: 1 },
              { operation_id: 'completed-record', completed: 1 },
              { operation_id: 'pending-record', completed: 0 },
              { operation_id: 'pending-record', completed: 0 },
            ],
            ingress: [{
              txn_id: 'accepted',
              ingress_phase: 'f2',
              completed: 1,
              record_sequence: 1,
            }],
            children: [{ txn_id: 'accepted', child_key: '$event' }],
            egress: [{ txn_id: 'pending', completed: 0 }, {
              txn_id: 'finished',
              completed: 1,
            }],
            membership: [{ operation: 'membership' }],
            controls: [{ revision: 3 }],
            activation: [{ revision: 3 }],
            operations: [{ operation_id: 'operation' }],
            frontiers: [{ operation_id: 'operation' }],
            conflicts: [{ operation_id: 'operation' }],
          },
          tenants: [{
            id: 'restore.test',
            facade: {
              controls: [{ revision: 3 }],
              activation: [{ revision: 3 }],
              operations: [{ operation_id: 'operation' }],
              frontiers: [{ operation_id: 'operation' }],
              conflicts: [{ operation_id: 'operation' }],
              routes: [{ route_id: 'route', expanded: 1 }],
              targets: [{ target_id: 'target-pending', state: 'pending' }, {
                target_id: 'target-acked',
                state: 'acked',
              }, { target_id: 'target-cancelled', state: 'cancelled' }],
              consumptions: [{ key_id: 'consumed' }],
              acknowledgements: [{ msg_pos: 8 }],
              applications: [{ sequence: 1, projection_revision: 7 }],
            },
          }],
        });
        assert(
          !JSON.stringify(result).includes('private-'),
          'restore report duplicated a protected payload',
        );
      },
    );
    assertEquals(await describe(), before);
  } finally {
    await store.close();
    await Deno.remove(root, { recursive: true });
  }
});
