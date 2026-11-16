import { assertEquals, assertRejects } from '@std/assert';
import { openStore } from '#engine/store/index.ts';
import { roomSchema } from '#engine/room/schema.ts';
import { indexTopology } from '#engine/room/topology.ts';
import type { Conn } from '#engine/store/db.ts';
import type { Value } from '#engine/store/ffi.ts';

const options = (dir: string) => ({
  dir,
  library: './.native/libturso_ffi.so',
  checkpointlogbytes: 65536,
  maxopenfiles: 8,
  idleseconds: 300,
});

Deno.test('topology repair settles each affected descendant once across converging paths', async () => {
  const dir = await Deno.makeTempDir();
  const store = await openStore(options(dir), {
    schemas: { room: roomSchema },
  });
  try {
    const db = await store.room('!topology-work:test', { create: true });
    const count = 128;
    await db.tx(async (conn) => {
      for (let i = 0; i < count; i++) {
        for (const id of ['source-' + i, 'child-' + i]) {
          await conn.execute(
            "INSERT INTO events VALUES(?,'{}','test',NULL,'@a:test',1,1)",
            [id],
          );
          await conn.execute('INSERT INTO event_topology VALUES(?,?)', [
            id,
            i + 1,
          ]);
        }
        if (i > 0) {
          await conn.execute('INSERT INTO prev_edges VALUES(?,?,0)', [
            'source-' + i,
            'source-' + (i - 1),
          ]);
          await conn.execute('INSERT INTO prev_edges VALUES(?,?,0)', [
            'child-' + i,
            'child-' + (i - 1),
          ]);
        }
        await conn.execute('INSERT INTO prev_edges VALUES(?,?,1)', [
          'child-' + i,
          'late',
        ]);
      }
      await conn.execute(
        "INSERT INTO events VALUES('late','{}','test',NULL,'@a:test',1,1)",
      );
      await conn.execute('INSERT INTO prev_edges VALUES(?,?,0)', [
        'late',
        'source-' + (count - 1),
      ]);
    });
    let updates = 0;
    await db.tx(async (conn) => {
      const observed = new Proxy(conn, {
        get(target, key) {
          if (key === 'execute') {
            return (sql: string, args: readonly Value[] = []) => {
              if (sql.startsWith('UPDATE event_topology')) updates++;
              return target.execute(sql, args);
            };
          }
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as Conn;
      await indexTopology(observed, 'late');
    });
    const heights = await db.query(
      "SELECT event,height FROM event_topology WHERE event LIKE 'child-%'",
    );
    for (const row of heights) {
      assertEquals(row.height, count + 2 + Number(String(row.event).slice(6)));
    }
    assertEquals(
      updates,
      count,
      'each genuinely changed key must settle once, not once per arriving path',
    );
    await assertRejects(
      () =>
        db.tx(async (conn) => {
          await conn.execute(
            "INSERT INTO events VALUES('cycle','{}','test',NULL,'@a:test',1,1)",
          );
          await conn.execute(
            "INSERT INTO prev_edges VALUES('cycle','cycle',0)",
          );
          await indexTopology(conn, 'cycle');
        }),
      Error,
      'cycle',
    );
    assertEquals(
      await db.query("SELECT event FROM event_topology WHERE event='cycle'"),
      [],
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
