import { assertEquals } from '@std/assert';
import { openStore } from '#engine/store/index.ts';
import type { Conn } from '#engine/store/db.ts';
import { serverSchema } from '#engine/server/schema.ts';
import type { PushPublication } from '#engine/server/push-project.ts';
import {
  advanceNotificationRead,
  applyPushPublication,
  captureIndependentPushes,
  notificationSnapshot,
  reconcileNotificationEvent,
  reconcileNotificationReads,
} from '#engine/server/notifications.ts';
import { projectReceiptGraph } from '#engine/server/receipt-frontier.ts';

const room = '!seeding:test', reader = '@reader:test';
const publication: PushPublication = {
  sender: '@author:remote',
  decisions: [{
    tenant: 'test',
    user: reader,
    ruleRevision: 0,
    ignoreRevision: 0,
    decision: {
      ruleId: 'notify',
      kind: 'underride',
      notify: true,
      highlight: false,
      actions: ['notify'],
      tweaks: {},
    },
  }],
};
async function held(
  tx: Conn,
  event: string,
  seq: number,
  parents: string[] = [],
) {
  await tx.execute(
    "INSERT INTO event_index(event,room,pos,standing,grounding,seq) VALUES(?,?,?,'accepted','grounded',?)",
    [event, room, seq, seq],
  );
  await projectReceiptGraph(tx, room, event, parents);
}
async function receipt(tx: Conn, events: string[]) {
  await tx.execute(
    "INSERT INTO receipts(room_id,user_id,receipt_type,thread_id,event_ids,ts_ms,seq) VALUES(?,?,?,'main',?,1,1)",
    [room, reader, 'm.read', JSON.stringify(events)],
  );
}
function settings(dir: string) {
  return {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
}

Deno.test('notification seeding: publication does no receipt-seeding work for already materialized targets after restart', async () => {
  const samples: { targets: number; seededTargetReads: number }[] = [];
  for (const count of [1, 8]) {
    const dir = await Deno.makeTempDir();
    let store = await openStore(settings(dir), {
      schemas: { server: serverSchema },
    });
    try {
      let db = await store.server();
      const targets = Array.from(
        { length: count },
        (_, i) => '$read-' + (i + 1),
      );
      await db.tx(async (tx) => {
        for (const [i, event] of targets.entries()) {
          await held(tx, event, i + 1);
          await advanceNotificationRead(tx, reader, room, 'main', event, 10);
        }
        await receipt(tx, targets);
        await held(tx, '$new', 100);
      });
      await store.close();
      store = await openStore(settings(dir), {
        schemas: { server: serverSchema },
      });
      db = await store.server();
      let seededTargetReads = 0;
      await db.tx(async (tx) => {
        const query = tx.query.bind(tx);
        tx.query = (sql, values = []) => {
          if (
            sql ===
              'SELECT room,seq,standing,grounding FROM event_index WHERE event=?' &&
            targets.includes(String(values[0]))
          ) seededTargetReads++;
          return query(sql, values);
        };
        await applyPushPublication(tx, room, '$new', 100, 100, publication, 20);
        await applyPushPublication(tx, room, '$new', 100, 100, publication, 20);
      });
      assertEquals(
        (await db.query('SELECT event FROM notifications')).map((r) => r.event),
        ['$new'],
      );
      assertEquals(
        (await db.tx((tx) => notificationSnapshot(tx, reader, 0))).rooms.get(
          room,
        )?.get('main')?.notification_count,
        1,
      );
      console.log(JSON.stringify({ targets: count, seededTargetReads }));
      samples.push({ targets: count, seededTargetReads });
    } finally {
      await store.close();
      await Deno.remove(dir, { recursive: true });
    }
  }
  assertEquals(
    samples.map((s) => s.seededTargetReads),
    [0, 0],
    'later publication must not replay durable seeded receipts',
  );
});

Deno.test('notification seeding: F1 at its receipt horizon stays read, missing horizon repairs, and replay never duplicates counts', async () => {
  for (const repair of [false, true]) {
    const dir = await Deno.makeTempDir();
    let store = await openStore(settings(dir), {
      schemas: { server: serverSchema },
    });
    try {
      let db = await store.server();
      await db.tx(async (tx) => {
        await held(tx, '$at-horizon', 100);
        await advanceNotificationRead(
          tx,
          reader,
          room,
          'main',
          '$at-horizon',
          10,
        );
        await receipt(tx, ['$at-horizon']);
        if (repair) {
          await tx.execute(
            'DELETE FROM notification_horizons WHERE user=? AND room=?',
            [reader, room],
          );
        }
      });
      await store.close();
      store = await openStore(settings(dir), {
        schemas: { server: serverSchema },
      });
      db = await store.server();
      await db.tx(async (tx) => {
        // Independent publication must use the same witness as general publication.
        const captured = await captureIndependentPushes(tx, [{
          room,
          event: '$at-horizon',
          pos: 100,
          publication,
        }]);
        assertEquals(
          captured === null,
          repair,
          'independent eligibility requires the same complete seeding witness',
        );
        await applyPushPublication(
          tx,
          room,
          '$at-horizon',
          100,
          100,
          publication,
          20,
        );
        await held(tx, '$after-horizon', 101);
        await applyPushPublication(
          tx,
          room,
          '$after-horizon',
          101,
          101,
          publication,
          30,
        );
        await applyPushPublication(
          tx,
          room,
          '$after-horizon',
          101,
          101,
          publication,
          30,
        );
      });
      assertEquals(
        await db.query(
          'SELECT event,read_ms FROM notifications ORDER BY event_seq',
        ),
        [
          { event: '$at-horizon', read_ms: 20 },
          { event: '$after-horizon', read_ms: null },
        ],
      );
      assertEquals(
        (await db.tx((tx) => notificationSnapshot(tx, reader, 0))).rooms.get(
          room,
        )?.get('main')?.notification_count,
        1,
      );
    } finally {
      await store.close();
      await Deno.remove(dir, { recursive: true });
    }
  }
});

for (const graph of [false, true]) {
  Deno.test(`notification seeding: ${graph ? 'graph' : 'F1'} pending target reconciles once, then later publication remains unread`, async () => {
    const dir = await Deno.makeTempDir();
    const store = await openStore(settings(dir), {
      schemas: { server: serverSchema },
    });
    try {
      const db = await store.server();
      await db.tx(async (tx) => {
        if (graph) {
          await tx.execute(
            "INSERT INTO facade_owner_activation VALUES('seeding-test',1,'verified-test')",
          );
        }
        await receipt(tx, ['$late']);
        await held(tx, '$before-late', 100);
        await applyPushPublication(
          tx,
          room,
          '$before-late',
          100,
          100,
          publication,
          10,
        );
      });
      assertEquals(
        (await db.tx((tx) => notificationSnapshot(tx, reader, 0))).rooms.get(
          room,
        )?.get('main')?.notification_count,
        1,
      );
      assertEquals(
        (await db.query(
          'SELECT event FROM notification_receipt_refs WHERE user=?',
          [reader],
        )).map((r) => r.event),
        ['$late'],
      );
      await db.tx(async (tx) => {
        await held(tx, '$late', 200, ['$before-late']);
        await reconcileNotificationEvent(tx, room, '$late', 20);
        await reconcileNotificationReads(tx, room, 20);
        await reconcileNotificationEvent(tx, room, '$late', 20);
      });
      assertEquals(
        (await db.tx((tx) => notificationSnapshot(tx, reader, 0))).rooms.get(
          room,
        )?.get('main')?.notification_count,
        0,
      );
      assertEquals(
        await db.query(
          'SELECT event FROM notification_receipt_refs WHERE user=?',
          [reader],
        ),
        [],
      );
      await db.tx(async (tx) => {
        await held(tx, '$after-late', 201, ['$late']);
        await applyPushPublication(
          tx,
          room,
          '$after-late',
          201,
          201,
          publication,
          30,
        );
        await applyPushPublication(
          tx,
          room,
          '$after-late',
          201,
          201,
          publication,
          30,
        );
        await reconcileNotificationReads(tx, room, 30);
      });
      assertEquals(
        (await db.query('SELECT event FROM notifications ORDER BY event_seq'))
          .map((r) => r.event),
        ['$before-late', '$after-late'],
      );
      assertEquals(
        (await db.tx((tx) => notificationSnapshot(tx, reader, 0))).rooms.get(
          room,
        )?.get('main')?.notification_count,
        1,
      );
    } finally {
      await store.close();
      await Deno.remove(dir, { recursive: true });
    }
  });
}
