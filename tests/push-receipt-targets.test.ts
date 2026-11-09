import { assertEquals } from '@std/assert';
import { openStore } from '#engine/store/index.ts';
import { roomSchema } from '#engine/room/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { sendLocal } from '#engine/room/ingest.ts';
import { project } from '#engine/server/project.ts';
import { setReceipt } from '#engine/server/ephemeral.ts';
import {
  notificationSnapshot,
  roomNotificationCounts,
} from '#engine/server/notifications.ts';
import { bobJoins, genesis } from '#tests/fixtures/genesis.ts';

Deno.test('push receipt targets: known history/wrong-room targets are inert; unresolved targets retain identity until valid live publication', async () => {
  const dir = await Deno.makeTempDir();
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, {
    schemas: { room: roomSchema, tenant: tenantSchema, server: serverSchema },
  });
  try {
    const tenant = await openTenant(store, 'test', { create: true });
    await tenant.tx(async (tx) => {
      await tx.users.insert('dev', 'Dev');
      await tx.users.insert('bob', 'Bob');
    });
    const g = await genesis(store, { roomId: '!targets:test' });
    await bobJoins(g);
    const other = await genesis(store, { roomId: '!other:test' });
    const first = await sendLocal(g.room, {
      type: 'm.room.message',
      sender: g.creator,
      content: { body: 'first' },
    }, g.signer);
    await project(store, g.roomId);
    await project(store, other.roomId);
    const db = await store.server();
    const counts = () =>
      db.tx(async (tx) =>
        roomNotificationCounts(
          (await notificationSnapshot(tx, '@bob:test', 0)).rooms.get(g.roomId),
        )
      );
    const read = (event: string, threadId?: string) =>
      setReceipt(db, g.roomId, '@bob:test', 'm.read', event, { threadId });
    await read(other.createId);
    assertEquals(
      await db.query('SELECT * FROM notification_receipt_refs WHERE event=?', [
        other.createId,
      ]),
      [],
    );
    // A history target has no live-order horizon; timestamps cannot supply one.
    await db.execute(
      "INSERT INTO event_index(event,room,pos,standing,grounding,seq) VALUES('$history',?,10000,'accepted','grounded',NULL)",
      [g.roomId],
    );
    await read('$history');
    assertEquals(
      await db.query(
        "SELECT * FROM notification_receipt_refs WHERE event='$history'",
      ),
      [],
    );
    assertEquals((await counts()).notification_count, 1);
    const future = await sendLocal(g.room, {
      type: 'm.room.message',
      sender: g.creator,
      content: { body: 'future' },
      origin_server_ts: 1,
    }, g.signer);
    await read(future.eventId);
    assertEquals(
      (await db.query(
        'SELECT event FROM notification_receipt_refs WHERE event=?',
        [future.eventId],
      )).length,
      1,
    );
    assertEquals((await counts()).notification_count, 1);
    await project(store, g.roomId);
    assertEquals((await counts()).notification_count, 0);
    assertEquals(
      await db.query('SELECT * FROM notification_receipt_refs WHERE event=?', [
        future.eventId,
      ]),
      [],
    );
    // Untrusted named references cannot acknowledge an unrelated live target.
    const latest = await sendLocal(g.room, {
      type: 'm.room.message',
      sender: g.creator,
      content: { body: 'unrelated' },
    }, g.signer);
    await read(latest.eventId, first.eventId);
    await project(store, g.roomId);
    assertEquals(
      (await db.query(
        'SELECT * FROM notification_horizons WHERE user=? AND room=? AND scope=?',
        ['@bob:test', g.roomId, first.eventId],
      )).length,
      0,
    );
    assertEquals(
      await db.query('SELECT * FROM notification_receipt_refs WHERE event=?', [
        latest.eventId,
      ]),
      [],
    );
    assertEquals((await counts()).notification_count, 1);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
