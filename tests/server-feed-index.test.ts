import { assert, assertEquals } from '@std/assert';
import { outboxDue } from '#engine/server/read.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { roomSchema } from '#engine/room/schema.ts';
import { openStore } from '#engine/store/index.ts';

for (const mode of ['fresh', 'upgrade']) {
  Deno.test(
    'feed event access path: ' + mode +
      ' keeps due delivery and point reads independent of room history',
    async () => {
      const dir = await Deno.makeTempDir({ prefix: 'feed-event-index-' });
      const settings = {
        dir,
        library: './.native/libturso_ffi.so',
        checkpointlogbytes: 65536,
        maxopenfiles: 8,
        idleseconds: 300,
      };
      if (mode === 'upgrade') {
        const old = await openStore(settings, {
          schemas: {
            room: roomSchema,
            server: {
              version: 35,
              apply: async (db) => {
                await serverSchema.apply(db);
                await db.exec('DROP INDEX IF EXISTS feed_event');
              },
            },
          },
        });
        await old.close();
      }
      const store = await openStore(settings, {
        schemas: { room: roomSchema, server: serverSchema },
      });
      try {
        const db = await store.server();
        await db.exec(`INSERT INTO feed(seq,room,pos,event,stay) VALUES
        (10,'!a:test',1,'$first',1),(20,'!b:test',2,'$second',1);
        INSERT INTO outbox(room,pos,destination,event,state,next_attempt_ms,added_ms) VALUES
        ('!a:test',9,'peer.test','$first','pending',0,1),
        ('!b:test',8,'peer.test','$second','pending',0,1),
        ('!wrong:test',7,'peer.test','$first','pending',0,1);`);
        let plan: string[] = [];
        const due = await outboxDue(
          {
            ...db,
            query: async (sql, values) => {
              plan = (await db.query('EXPLAIN QUERY PLAN ' + sql, values)).map((
                row,
              ) => String(row.detail));
              return await db.query(sql, values);
            },
          },
          'peer.test',
          100,
          50,
        );
        assertEquals(
          due.map((row) => [row.room, row.pos, row.event, row.seq]),
          [
            ['!a:test', 9, '$first', 10],
            ['!b:test', 8, '$second', 20],
          ],
          'delivery-change positions differ from event positions; room identity still fences the join',
        );
        assert(
          plan.some((line) =>
            /SEARCH f USING INDEX feed_event \(event=\?\)/.test(line)
          ),
          plan.join('\n'),
        );
        for (const where of ['event=?', 'room=? AND event=?']) {
          const values = where.startsWith('room')
            ? ['!b:test', '$second']
            : ['$second'];
          assertEquals(
            await db.query('SELECT seq FROM feed WHERE ' + where, values),
            [{ seq: 20 }],
          );
          const point = await db.query(
            'EXPLAIN QUERY PLAN SELECT seq FROM feed WHERE ' + where,
            values,
          );
          assert(
            point.some((row) =>
              String(row.detail).includes('feed_event (event=?)')
            ),
            JSON.stringify(point),
          );
        }
      } finally {
        await store.close();
        await Deno.remove(dir, { recursive: true });
      }
    },
  );
}
