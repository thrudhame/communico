import { assertEquals, assertRejects } from '@std/assert';
import { openStore } from '#engine/store/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { advanceNotificationRead } from '#engine/server/notifications.ts';

for (const scope of ['', 'main', '$thread']) {
  Deno.test(`notification read work: ${scope || 'unthreaded'} updates only newly read facts and their listing`, async () => {
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
      await db.tx(async (tx) => {
        // An old read prefix, an unread main event, a named-thread event,
        // a later main event and a withdrawn fact all share the same room.
        for (let seq = 1; seq <= 68; seq++) {
          const thread = seq === 66 ? '$thread' : 'main';
          const read = seq <= 64 ? seq : null;
          const withdrawn = seq === 68 ? 1 : 0;
          await tx.execute(
            `INSERT INTO notifications VALUES(?,'test','@bob:test',?,'!room:test',?,?,'["notify"]',1,0,?,?)`,
            [seq, '$' + seq, seq, thread, read, withdrawn],
          );
          if (!withdrawn) {
            await tx.execute(
              "INSERT INTO notification_history VALUES(?,'@bob:test','!room:test',1,?)",
              [seq, read],
            );
          }
        }
        await tx.execute(
          "INSERT INTO notification_counts VALUES('@bob:test','!room:test','main',2,2)",
        );
        await tx.execute(
          "INSERT INTO notification_counts VALUES('@bob:test','!room:test','$thread',1,1)",
        );
        for (const seq of [65, 66, 68]) {
          await tx.execute(
            "INSERT INTO event_index(event,room,pos,standing,grounding,seq) VALUES(?,'!room:test',?,'accepted','grounded',?)",
            ['$' + seq, seq, seq],
          );
        }
        await tx.execute(
          "INSERT INTO event_index(event,room,pos,standing,grounding,seq) VALUES('$thread','!room:test',0,'accepted','grounded',0)",
        );
        await tx.execute(
          "INSERT INTO relations VALUES('$66','$thread','m.thread','!room:test',66)",
        );
      });
      const before = await db.query(
        'SELECT seq,read_ms FROM notification_history ORDER BY seq',
      );
      await assertRejects(
        () =>
          db.tx(async (tx) => {
            await advanceNotificationRead(
              tx,
              '@bob:test',
              '!room:test',
              scope,
              '$66',
              1000,
            );
            throw new Error('abort read');
          }),
        Error,
        'abort read',
      );
      assertEquals(
        await db.query(
          'SELECT seq,read_ms FROM notification_history ORDER BY seq',
        ),
        before,
      );
      const writes = await db.tx(async (tx) => {
        const execute = tx.execute.bind(tx);
        let changed = 0;
        tx.execute = async (sql, values) => {
          const count = await execute(sql, values);
          if (sql.startsWith('UPDATE notification_history ')) changed += count;
          return count;
        };
        // A main receipt must target a main event, while the unthreaded
        // receipt includes both buckets through the named-thread event.
        await advanceNotificationRead(
          tx,
          '@bob:test',
          '!room:test',
          scope,
          scope === 'main' ? '$65' : '$66',
          1000,
        );
        return changed;
      });
      assertEquals(
        writes,
        scope ? 1 : 2,
        'retained read history is not part of this transition',
      );
      assertEquals(
        await db.query(
          'SELECT seq,read_ms FROM notification_history WHERE seq<=64 ORDER BY seq',
        ),
        before.slice(0, 64),
      );
      assertEquals(
        await db.query(
          'SELECT seq,read_ms FROM notification_history WHERE seq>64 ORDER BY seq',
        ),
        [
          { seq: 65, read_ms: scope === '$thread' ? null : 1000 },
          { seq: 66, read_ms: scope === 'main' ? null : 1000 },
          { seq: 67, read_ms: null },
        ],
      );
      const noop = await db.tx(async (tx) => {
        const execute = tx.execute.bind(tx);
        let changed = 0;
        tx.execute = async (sql, values) => {
          const count = await execute(sql, values);
          if (sql.startsWith('UPDATE notification_history ')) changed += count;
          return count;
        };
        await advanceNotificationRead(
          tx,
          '@bob:test',
          '!room:test',
          scope,
          scope === '$thread' ? '$66' : '$65',
          2000,
        );
        return changed;
      });
      assertEquals(
        noop,
        0,
        'repeated or regressing receipts do not rewrite history',
      );
      assertEquals(
        await db.query(
          'SELECT thread,unread,highlight FROM notification_counts ORDER BY thread',
        ),
        [
          {
            thread: '$thread',
            unread: scope === 'main' ? 1 : 0,
            highlight: scope === 'main' ? 1 : 0,
          },
          {
            thread: 'main',
            unread: scope === '$thread' ? 2 : 1,
            highlight: scope === '$thread' ? 2 : 1,
          },
        ],
      );
    } finally {
      await store.close();
      await Deno.remove(dir, { recursive: true });
    }
  });
}
