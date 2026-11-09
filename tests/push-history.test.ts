import { assertEquals } from '@std/assert';
import { setConfigForTests } from '#engine/config.ts';
import { openStore } from '#engine/store/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import {
  pruneNotificationHistory,
  syncNotificationHistory,
} from '#engine/server/notification-history.ts';
import { SERVER_V13 } from '#tests/fixtures/server-v13.ts';

Deno.test('history retention removes only expired read listing entries, never unread facts or exact counts', async () => {
  const dir = await Deno.makeTempDir();
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { server: serverSchema } });
  try {
    const db = await store.server();
    const now = Date.now();
    const cutoff = now - 30 * 86400000;
    await db.tx(async (tx) => {
      for (const [seq, read] of [[1, null], [2, cutoff - 1], [3, cutoff + 1]]) {
        await tx.execute(
          "INSERT INTO notifications(seq,tenant,user,event,room,event_seq,thread,actions,highlight,created_ms,read_ms,withdrawn) VALUES(?,'test','@bob:test',?,'!room:test',?,'main','[\"notify\"]',0,0,?,0)",
          [seq, '$' + seq, seq, read],
        );
        await syncNotificationHistory(tx, Number(seq), now - 86400000);
      }
      await tx.execute(
        "INSERT INTO notification_counts VALUES('@bob:test','!room:test','main',1,0)",
      );
      await pruneNotificationHistory(tx, now);
    });
    assertEquals(
      (await db.query('SELECT seq FROM notification_history ORDER BY seq')).map(
        (r) => r.seq,
      ),
      [1, 3],
    );
    assertEquals(
      (await db.query('SELECT COUNT(*) AS n FROM notifications'))[0].n,
      3,
    );
    assertEquals(
      (await db.query('SELECT unread FROM notification_counts'))[0].unread,
      1,
    );
    setConfigForTests({ push: { readretentiondays: 0 } });
    await db.tx((tx) => pruneNotificationHistory(tx, now));
    assertEquals(
      (await db.query('SELECT seq FROM notification_history')).map((r) =>
        r.seq
      ),
      [1],
    );
    assertEquals(
      (await db.query('SELECT unread FROM notification_counts'))[0].unread,
      1,
    );
  } finally {
    setConfigForTests({});
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('v16 upgrade seeds listing from saved decisions without feed or count replay', async () => {
  const dir = await Deno.makeTempDir();
  const cfg = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  const v16 = {
    version: 16,
    apply: async (db: Parameters<typeof serverSchema.apply>[0]) => {
      await db.exec(SERVER_V13);
      await db.tx(async (tx) => {
        for (const version of [13, 14, 15]) {
          await serverSchema.migrations![version](tx);
        }
      }, { mode: 'deferred' });
    },
  };
  let store = await openStore(cfg, { schemas: { server: v16 } });
  try {
    const db = await store.server();
    await db.execute(
      "INSERT INTO notifications VALUES(7,'test','@bob:test','$event','!room:test',5,'main','[\"notify\"]',1,123,NULL,0)",
    );
    await db.execute(
      "INSERT INTO notification_counts VALUES('@bob:test','!room:test','main',1,1)",
    );
    await db.execute("INSERT INTO counters VALUES('notifications',8)");
    await store.close();
    store = await openStore(cfg, { schemas: { server: serverSchema } });
    const upgraded = await store.server();
    assertEquals(
      await upgraded.query('SELECT seq,user FROM notification_history'),
      [{ seq: 7, user: '@bob:test' }],
    );
    assertEquals(
      await upgraded.query('SELECT unread,highlight FROM notification_counts'),
      [{ unread: 1, highlight: 1 }],
    );
    assertEquals(
      (await upgraded.query(
        "SELECT value FROM counters WHERE name='notifications'",
      ))[0].value,
      8,
    );
    assertEquals(await upgraded.query('SELECT 1 FROM feed'), []);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
