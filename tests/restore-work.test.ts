import { assert, assertEquals } from '@std/assert';
import { join } from '@std/path';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { roomSchema } from '#engine/room/schema.ts';
import { inventoryRestoredWork, restoreWarnings } from '#engine/backup/work.ts';
import { inspectSnapshot } from '#engine/store/inspect.ts';
import { describePayload } from '#engine/backup/manifest.ts';
import { enqueueEdu, freezeBatch } from '#engine/server/delivery.ts';

Deno.test('restore work inventory: every delayed command, pending/frozen federation and push work are disclosed from immutable captured files without executing work', async () => {
  const root = await Deno.makeTempDir({ prefix: 'restore-work-' });
  const settings = {
    dir: join(root, 'live'),
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  const schemas = {
    tenant: tenantSchema,
    server: serverSchema,
    room: roomSchema,
  };
  const store = await openStore(settings, { schemas });
  try {
    await openTenant(store, 'restore.test', { create: true });
    const tenant = await store.tenant('restore.test');
    const now = Date.now();
    await tenant.tx(async (tx) => {
      for (let n = 0; n < 260; n++) {
        await tx.execute(
          'INSERT INTO delayed_events(id,localpart,room_id,type,content,delay_ms,since_ms,due_ms,room_pos,event_id,pending_pdu,phase,completed) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
          [
            'delay-' + n,
            'alice',
            '!room:test',
            'm.room.message',
            '{"private":"command body"}',
            100,
            now - 200,
            n < 259 ? now - 100 : now + 100,
            1,
            n === 258 ? '$prepared' : null,
            n === 258 ? '{"private":"signed pdu"}' : null,
            n === 258 ? 'sending' : 'pending',
            n === 257 ? 1 : 0,
          ],
        );
      }
      await tx.execute(
        'INSERT INTO to_device_intents(source_id,destination,payload,sender,projected) VALUES(?,?,?,?,?)',
        [
          'intent',
          'peer.test',
          '{"private":"Olm body"}',
          '@alice:restore.test',
          0,
        ],
      );
      await tx.execute('INSERT INTO e2ee_changes VALUES(?,?,?,?,?,?)', [
        1,
        'alice',
        '',
        0,
        10,
        '{"kind":"restore_reset","device_id":"","deleted":true}',
      ]);
    });
    const room = await store.room('!room:test', { create: true });
    await room.execute(
      'INSERT INTO changes(pos,kind,event,data) VALUES(?,?,?,?)',
      [1, 'delivery', '$event', '{"destinations":["peer.test"]}'],
    );
    const db = await store.server();
    await db.tx(async (tx) => {
      await tx.execute('INSERT INTO outbox VALUES(?,?,?,?,?,?,?,?)', [
        '!room:test',
        1,
        'peer.test',
        '$event',
        'pending',
        2,
        now + 100,
        now - 100,
      ]);
      await enqueueEdu(
        tx,
        'reliable-source',
        'peer.test',
        'm.direct_to_device',
        { private: 'Olm envelope' },
      );
      await tx.execute(
        'INSERT INTO push_delivery(incarnation,notification_seq,user,room,event,created_ms,state,attempts,next_ms) VALUES(?,?,?,?,?,?,?,?,?)',
        [
          'pusher',
          1,
          '@alice:restore.test',
          '!room:test',
          '$event',
          now - 100,
          'pending',
          1,
          now + 100,
        ],
      );
      await tx.execute(
        'INSERT INTO push_badges(incarnation,user,revision,sent_revision,expired_revision,attempts,next_ms,created_ms) VALUES(?,?,?,?,?,?,?,?)',
        ['pusher', '@alice:restore.test', 3, 2, 0, 0, 0, now - 100],
      );
    });
    assert(
      await freezeBatch(db, 'peer.test', {
        txnId: 'frozen-id',
        body: '{"private":"frozen keys"}',
        rows: [],
        sources: ['reliable-source'],
      }),
    );
    const cut = await store.snapshot(join(root, 'archive'));
    await store.close();
    const before = await Promise.all(
      cut.files.map((file) =>
        describePayload(join(root, 'archive'), file.path)
      ),
    );
    await inspectSnapshot(
      settings,
      join(root, 'archive'),
      cut.files,
      root,
      schemas,
      async (snapshot) => {
        const result = await inventoryRestoredWork(snapshot, now);
        const restored = result.tenants.find((tenant) =>
          tenant.id === 'restore.test'
        )!;
        assert(restored, 'restored tenant is missing from the work report');
        assertEquals(restored.delayed.length, 260);
        assertEquals(
          restored.delayed.filter((r) => r.overdue === 1).length,
          258,
        );
        assertEquals(
          restored.delayed.filter((r) => r.prepared === 1).length,
          1,
        );
        assertEquals(
          restored.delayed.filter((r) => r.completed === 1).length,
          1,
        );
        assertEquals(restored.toDevice.length, 1);
        assertEquals(result.federation.pdus.length, 1);
        assertEquals(result.federation.edus.length, 1);
        assertEquals(result.federation.frozen.length, 1);
        assertEquals(result.federation.frozen[0].txn_id, 'frozen-id');
        assertEquals(String(result.federation.frozen[0].sha256).length, 64);
        assertEquals(result.push.deliveries.length, 1);
        assertEquals(result.push.badges.length, 1);
        assert(
          restored.unprojected.length > 0,
          'tenant projection lag is disclosed',
        );
        assertEquals(result.rooms[0].deliveries.length, 1);
        assertEquals(result.rooms[0].unprojectedChanges, 1);
        assert(
          !JSON.stringify(result).includes('private'),
          'work report must not duplicate message/key payloads',
        );
      },
    );
    assertEquals(
      await Promise.all(
        cut.files.map((file) =>
          describePayload(join(root, 'archive'), file.path)
        ),
      ),
      before,
    );
  } finally {
    await store.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('restore report warnings: lost revocations, cancellations, peer effects and private-key RPO are explicit, without an extra approval gate', () => {
  const warnings = restoreWarnings(['COMMUNICO_TURN_SECRET']);
  const text = warnings.join('\n');
  for (
    const disclosure of [
      'cancellations',
      'overdue',
      'revocation',
      'old credentials',
      'private crypto stores',
      'Frozen federation',
      'COMMUNICO_TURN_SECRET',
    ]
  ) assert(text.includes(disclosure), disclosure);
  assert(!text.includes('approval'));
});
