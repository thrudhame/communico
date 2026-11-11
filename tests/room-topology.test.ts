import { assert, assertEquals, assertRejects } from '@std/assert';
import { openStore } from '#engine/store/index.ts';
import { openRoom } from '#engine/room/index.ts';
import { ROOM_SCHEMA_SQL, roomSchema } from '#engine/room/schema.ts';
import { stableCausalOrder } from '#engine/room/order.ts';
import { orderKeys } from '#engine/room/topology.ts';
import { insertEvent } from '#engine/room/events.ts';

const pdu = (prev_events: string[], depth = 999999) =>
  JSON.stringify({
    type: 'm.room.message',
    sender: '@a:test',
    depth,
    origin_server_ts: 1,
    content: { body: 'unchanged' },
    prev_events,
    auth_events: [],
  });
const options = (dir: string) => ({
  dir,
  library: './.native/libturso_ffi.so',
  checkpointlogbytes: 65536,
  maxopenfiles: 8,
  idleseconds: 300,
});

Deno.test('room topology: v1 upgrade, child-first anchors, late parents, rollback and reopen preserve derived DAG keys and PDUs', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'topology-upgrade-' });
  const id = '!topology:test';
  let store = await openStore(options(dir), {
    schemas: {
      room: { version: 1, apply: (db) => db.exec(ROOM_SCHEMA_SQL) },
    },
  });
  try {
    let db = await store.room(id, { create: true });
    const graph: Record<string, string[]> = {
      x: ['a'],
      y: [],
      a: [],
      bridge: ['x'],
      z: ['bridge'],
      pending: ['later'],
    };
    // A real old room, with first-owner anchor positions deliberately unlike
    // causal order and arbitrary remote depths. No new topology writer is used.
    await db.tx(async (tx) => {
      let segment = 0;
      for (const [event, prevs] of Object.entries(graph)) {
        await tx.execute('INSERT INTO events VALUES(?,?,?,?,?,?,?)', [
          event,
          pdu(prevs),
          'm.room.message',
          null,
          '@a:test',
          999999,
          1,
        ]);
        for (const [ord, prev] of prevs.entries()) {
          await tx.execute('INSERT INTO prev_edges VALUES(?,?,?)', [
            event,
            prev,
            ord,
          ]);
        }
        await tx.execute(
          "INSERT INTO segments VALUES(?,'anchor',NULL,?,NULL,NULL,'open')",
          [++segment, event],
        );
        await tx.execute('INSERT INTO positions VALUES(?,0,?)', [
          segment,
          event,
        ]);
      }
      await tx.execute("INSERT INTO meta(k,v) VALUES('next_segment',?)", [
        String(segment + 1),
      ]);
    });
    const original = await db.query('SELECT id,pdu FROM events ORDER BY id');
    assertEquals(
      await db.query(
        "SELECT name FROM sqlite_master WHERE name='event_topology'",
      ),
      [],
    );
    await store.close();
    store = await openStore(options(dir), { schemas: { room: roomSchema } });
    const room = await openRoom(store, id);
    db = await store.room(id);
    assertEquals(
      (await db.query("SELECT v FROM meta WHERE k='schema_version'"))[0].v,
      '3',
    );
    const before = await room.tx((tx) =>
      tx.events.orderKeys(Object.keys(graph))
    );
    assertEquals(
      [...before].map(([event, key]) => [event, key.height]).sort(),
      [
        ['a', 1],
        ['bridge', 3],
        ['pending', 1],
        ['x', 2],
        ['y', 1],
        ['z', 4],
      ],
    );
    const subset = await room.tx((tx) =>
      stableCausalOrder(tx, ['x', 'y', 'z'])
    );
    const anchored = await room.tx((tx) =>
      stableCausalOrder(tx, ['a', 'x', 'y', 'z'])
    );
    assertEquals(anchored.filter((event) => event !== 'a'), subset);
    await room.tx(async (tx) => {
      await tx.events.insert('later', pdu(['z'], 1));
      const segment = await tx.segments.create({
        kind: 'anchor',
        opened_by: 'later',
      });
      await tx.segments.appendPosition(segment, 'later');
      await tx.events.insert('wait', pdu(['future'], 1));
    });
    assertEquals(
      (await room.tx((tx) => tx.events.orderKeys(['pending']))).get('pending')!
        .height,
      6,
    );
    assertEquals(
      await room.tx((tx) => stableCausalOrder(tx, ['pending', 'later', 'z'])),
      ['z', 'later', 'pending'],
    );
    await assertRejects(
      () =>
        room.tx(async (tx) => {
          await tx.events.insert('future', pdu(['pending']));
          assertEquals(
            (await tx.events.orderKeys(['wait'])).get('wait')!.height,
            8,
          );
          throw new Error('rollback topology');
        }),
      Error,
      'rollback topology',
    );
    assertEquals(
      (await room.tx((tx) => tx.events.orderKeys(['wait']))).get('wait')!
        .height,
      1,
    );
    assertEquals(await room.tx((tx) => tx.events.get('future')), null);
    await assertRejects(
      () => room.tx((tx) => tx.events.insert('self', pdu(['self']))),
      Error,
      'cycle',
    );
    assertEquals(await room.tx((tx) => tx.events.get('self')), null);
    assertEquals(
      await db.query(
        "SELECT id,pdu FROM events WHERE id NOT IN ('later','wait') ORDER BY id",
      ),
      original,
    );
    await store.close();
    store = await openStore(options(dir), { schemas: { room: roomSchema } });
    const reopened = await openRoom(store, id);
    assertEquals(
      (await reopened.tx((tx) => tx.events.orderKeys(['pending']))).get(
        'pending',
      )!.height,
      6,
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('room topology: real long-prefix reads use candidate indexes and parent-first append never repairs the old prefix', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'topology-cost-' });
  const store = await openStore(options(dir), {
    schemas: { room: roomSchema },
  });
  try {
    const room = await openRoom(store, '!cost:test', { create: true });
    await room.tx(async (tx) => {
      for (let i = 0; i < 2000; i++) {
        await tx.events.insert(
          String(i),
          pdu(i === 0 ? [] : [String(i - 1)], 1),
        );
      }
    });
    const db = await store.room(room.id);
    let queries = 0;
    await db.tx(async (tx) => {
      const measured = new Proxy(tx, {
        get(target, key) {
          if (key === 'query') {
            return (...args: Parameters<typeof tx.query>) => {
              queries++;
              return target.query(...args);
            };
          }
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      await insertEvent(measured, '2000', pdu(['1999'], 1));
      assertEquals(
        queries,
        2,
        'append reads parent height and indexed children, not old ancestry',
      );
      queries = 0;
      const keys = await orderKeys(measured, ['1998', '1999']);
      assertEquals(keys.get('1999')!.height, 2000);
      assertEquals(queries, 1);
      const plan = await tx.query(
        "EXPLAIN QUERY PLAN SELECT t.event,t.height,p.segment,p.offset FROM event_topology t LEFT JOIN positions p ON p.event=t.event WHERE t.event IN ('1998','1999')",
      );
      const text = plan.map((row) => Object.values(row).join(' ')).join('\n');
      assert(/SEARCH.*(?:INDEX|PRIMARY KEY)/i.test(text), text);
    });
    assertEquals(
      await room.tx((tx) => stableCausalOrder(tx, ['1999', '1998'])),
      ['1998', '1999'],
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
