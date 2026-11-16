import { assertEquals, assertRejects } from '@std/assert';
import { openStore } from '#engine/store/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { syncNotificationHistory } from '#engine/server/notification-history.ts';
import {
  advanceNotificationRead,
  notificationSnapshot,
} from '#engine/server/notifications.ts';

for (const scope of ['', 'main']) {
  Deno.test(`notification read work: ${scope || 'unthreaded'} changes only newly read listing rows`, async () => {
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
      const user = '@reader:test';
      const room = '!read-work:test';
      await db.tx(async (tx) => {
        for (let seq = 1; seq <= 130; seq++) {
          const thread = seq === 129 ? '$thread' : 'main';
          const read = seq <= 128 ? now - 1000 : null;
          await tx.execute(
            "INSERT INTO notifications VALUES(?,'test',?,?,?, ?,?,'[\"notify\"]',0,?,?,0)",
            [seq, user, '$' + seq, room, seq, thread, now - 2000, read],
          );
          await syncNotificationHistory(tx, seq, now);
        }
        for (const thread of ['main', '$thread']) {
          await tx.execute(
            'INSERT INTO notification_counts VALUES(?,?,?,1,0)',
            [user, room, thread],
          );
        }
        await tx.execute(
          "INSERT INTO event_index(event,room,pos,standing,grounding,seq) VALUES('$130',?,130,'accepted','grounded',130)",
          [room],
        );
      });
      const before = await db.query(
        'SELECT seq,read_ms FROM notification_history ORDER BY seq',
      );
      await assertRejects(
        () =>
          db.tx(async (tx) => {
            await advanceNotificationRead(tx, user, room, scope, '$130', now);
            throw new Error('read rollback');
          }),
        Error,
        'read rollback',
      );
      assertEquals(
        await db.query(
          'SELECT seq,read_ms FROM notification_history ORDER BY seq',
        ),
        before,
      );
      assertEquals(await db.query('SELECT * FROM notification_horizons'), []);
      assertEquals(
        (await db.query(
          'SELECT COUNT(*) AS n FROM notifications WHERE read_ms IS NULL',
        ))[0].n,
        2,
      );
      const advance = () =>
        db.tx(async (tx) => {
          const execute = tx.execute.bind(tx);
          let touched = 0;
          tx.execute = async (sql, values = []) => {
            const changed = await execute(sql, values);
            if (/UPDATE\s+notification_history\b/i.test(sql)) {
              touched += changed;
            }
            return changed;
          };
          assertEquals(
            await advanceNotificationRead(tx, user, room, scope, '$130', now),
            true,
          );
          return touched;
        });
      assertEquals(
        await advance(),
        scope === '' ? 2 : 1,
        'listing writes follow changed unread facts, not retained read history',
      );
      assertEquals(
        await db.query(
          'SELECT seq,read_ms FROM notification_history WHERE seq<=128 ORDER BY seq',
        ),
        before.slice(0, 128),
      );
      assertEquals(
        await db.query(
          'SELECT seq,read_ms FROM notification_history WHERE seq>128 ORDER BY seq',
        ),
        [{ seq: 129, read_ms: scope === '' ? now : null }, {
          seq: 130,
          read_ms: now,
        }],
      );
      const counts = await db.tx((tx) => notificationSnapshot(tx, user, 0));
      assertEquals(counts.rooms.get(room)?.get('main')?.notification_count, 0);
      assertEquals(
        counts.rooms.get(room)?.get('$thread')?.notification_count,
        scope === '' ? 0 : 1,
      );
      assertEquals(
        await advance(),
        0,
        'replay does not rewrite old listing rows',
      );
    } finally {
      await store.close();
      await Deno.remove(dir, { recursive: true });
    }
  });
}
