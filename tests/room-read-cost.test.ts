import { assert, assertEquals, assertRejects } from '@std/assert';
import { openStore } from '#engine/store/index.ts';
import { openRoom } from '#engine/room/index.ts';
import { ROOM_SCHEMA_SQL, roomSchema } from '#engine/room/schema.ts';
import { TOPOLOGY_SQL } from '#engine/room/topology.ts';
import { changePosOf, redactionOf } from '#engine/room/changes.ts';
import { publishedGroupsAfter } from '#engine/room/state.ts';
import { causalOrder } from '#engine/room/order.ts';
import type { Conn } from '#engine/store/db.ts';
import type { RoomTx } from '#engine/room/index.ts';
import { canSeeEventAt } from '#engine/client/visibility.ts';

const options = (dir: string) => ({
  dir,
  library: './.native/libturso_ffi.so',
  checkpointlogbytes: 65536,
  maxopenfiles: 8,
  idleseconds: 300,
});

Deno.test('room read costs: existing v2 files upgrade selective JSON and event receipt indexes', async () => {
  const dir = await Deno.makeTempDir();
  let store = await openStore(options(dir), {
    schemas: {
      room: {
        version: 2,
        apply: (db) => db.exec(ROOM_SCHEMA_SQL + TOPOLOGY_SQL),
      },
    },
  });
  try {
    const id = '!change-index:test';
    let db = await store.room(id, { create: true });
    await db.tx(async (tx) => {
      for (let i = 0; i < 600; i++) {
        await tx.execute('INSERT INTO changes(kind,event,data) VALUES(?,?,?)', [
          'redaction',
          '$redaction' + i,
          JSON.stringify({ target: '$target' + i }),
        ]);
      }
      await tx.execute(
        "INSERT INTO changes(kind,event,data) VALUES('event','$live','{}')",
      );
      await tx.execute(
        "INSERT INTO changes(kind,event,data) VALUES('redaction','$later','{\"target\":\"$target599\"}')",
      );
    });
    await store.close();
    store = await openStore(options(dir), { schemas: { room: roomSchema } });
    db = await store.room(id);
    await db.tx(async (tx) => {
      let rowsRead = 0;
      const measured = new Proxy(tx, {
        get(target, key) {
          if (key === 'query') {
            return async (...args: Parameters<Conn['query']>) => {
              const rows = await target.query(...args);
              rowsRead += rows.length;
              return rows;
            };
          }
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const start = performance.now();
      assertEquals(await redactionOf(measured, '$target599'), '$redaction599');
      assertEquals(await redactionOf(measured, '$absent'), null);
      assertEquals(await changePosOf(measured, '$live'), 601);
      console.log(
        'selective change rows/time',
        rowsRead,
        performance.now() - start,
      );
      assert(
        rowsRead <= 2,
        'targeted reads must not hydrate unrelated redactions: ' + rowsRead,
      );
      for (
        const [sql, index] of [
          [
            "SELECT event FROM changes WHERE kind='redaction' AND json_extract(data,'$.target')='$target599' ORDER BY pos LIMIT 1",
            'changes_redaction_target',
          ],
          [
            "SELECT pos FROM changes WHERE event='$live' AND kind IN ('event','transition') ORDER BY pos DESC LIMIT 1",
            'changes_event',
          ],
        ]
      ) {
        const plan = await tx.query('EXPLAIN QUERY PLAN ' + sql);
        const text = plan.map((row) => Object.values(row).join(' ')).join('\n');
        console.log(text);
        assert(text.includes(index) && /SEARCH/i.test(text), text);
      }
      assertEquals(
        (await tx.query("SELECT v FROM meta WHERE k='schema_version'"))[0].v,
        String(roomSchema.version),
      );
    });
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('room read costs: isolated publication qualification walks the descendant graph once', async () => {
  let graphReads = 0, hydrated = 0;
  const conn = {
    query: (sql: string, args: unknown[] = []) => {
      if (sql.includes("s.kind = 'anchor'")) {
        return Promise.resolve([{ event: '$0' }]);
      }
      if (sql.includes('prev_edges')) {
        graphReads++;
        const n = Number(String(args[0]).slice(1));
        if (sql.includes('WHERE prev =')) {
          return Promise.resolve(n < 400 ? [{ event: '$' + (n + 1) }] : []);
        }
        return Promise.resolve(n > 0 ? [{ prev: '$' + (n - 1) }] : []);
      }
      const bounded = sql.includes(' IN (');
      const ids = bounded
        ? args.filter((v) => typeof v === 'string' && v.startsWith('$'))
        : Array.from({ length: 401 }, (_, i) => '$' + i);
      hydrated += ids.length;
      return Promise.resolve(
        ids.map((event) => ({
          grp: Number(String(event).slice(1)) + 1,
          event,
        })),
      );
    },
  } as unknown as Conn;
  const start = performance.now();
  const groups = await publishedGroupsAfter(conn, '$0');
  console.log(
    'publication graph reads/rows/time',
    graphReads,
    hydrated,
    performance.now() - start,
  );
  assertEquals(groups.length, 401);
  assert(
    graphReads <= 401,
    'one shared descendant walk, not one walk per publication: ' + graphReads,
  );
});

Deno.test('room read costs: native anchor publications share one graph walk and indexed snapshot selection', async () => {
  const dir = await Deno.makeTempDir();
  const store = await openStore(options(dir), {
    schemas: { room: roomSchema },
  });
  try {
    const room = await openRoom(store, '!publication-cost:test', {
      create: true,
    });
    await room.tx(async (tx) => {
      const group = await tx.materialize.newGroup(null, []);
      const stay = await tx.segments.create({
        kind: 'stay',
        opening_group: group,
      });
      const anchor = await tx.segments.create({ kind: 'anchor', prev: stay });
      for (let i = 0; i < 80; i++) {
        const id = '$pub' + i;
        await tx.events.insert(
          id,
          JSON.stringify({
            type: 'm.room.message',
            sender: '@a:test',
            depth: 1,
            origin_server_ts: i,
            prev_events: i === 0 ? [] : ['$pub' + (i - 1)],
            auth_events: [],
            content: {},
          }),
        );
        await tx.segments.appendPosition(i === 0 ? anchor : stay, id);
        const pos = await tx.changes.append('event', id, {});
        const changed = await tx.materialize.newGroup(null, [{
          type: 'u.test',
          state_key: '',
          event: id,
        }]);
        await tx.materialize.publish(pos, stay, changed);
      }
    });
    const db = await store.room(room.id);
    await db.tx(async (tx) => {
      let reads = 0, rowsRead = 0;
      const measured = new Proxy(tx, {
        get(target, key) {
          if (key === 'query') {
            return async (...args: Parameters<Conn['query']>) => {
              reads++;
              const rows = await target.query(...args);
              rowsRead += rows.length;
              return rows;
            };
          }
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const start = performance.now();
      assertEquals((await publishedGroupsAfter(measured, '$pub0')).length, 80);
      console.log(
        'native publication queries/rows/time',
        reads,
        rowsRead,
        performance.now() - start,
      );
      assert(
        reads <= 82,
        'one walk, not repeated ancestor/descendant searches: ' + reads,
      );
    });
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('room read costs: visibility hydrates a shared membership event once per read', async () => {
  let memberReads = 0;
  const tx = {
    events: {
      get: (id: string) => {
        if (id === '$message') {
          return Promise.resolve({ type: 'm.room.message' });
        }
        if (id === '$member') memberReads++;
        return Promise.resolve({
          pdu: JSON.stringify({
            content: id === '$member'
              ? { membership: 'leave' }
              : { history_visibility: 'shared' },
          }),
        });
      },
      getStatus: () =>
        Promise.resolve({ standing: 'accepted', grounding: 'grounded' }),
    },
    state: {
      eventReadState: () =>
        Promise.resolve({ before: { group: 1 }, after: { group: 1 } }),
      groupKey: (_group: number, type: string) =>
        Promise.resolve(type === 'm.room.member' ? '$member' : '$hv'),
      publishedGroupsAfter: () =>
        Promise.resolve(Array.from({ length: 300 }, (_, i) => i + 1)),
    },
  } as unknown as RoomTx;
  assertEquals(await canSeeEventAt('@viewer:test', tx, '$message'), false);
  console.log('membership payload reads', memberReads);
  assertEquals(memberReads, 1);
});

Deno.test('room read costs: large native timestamp ties preserve transitive and first-owner order', async () => {
  const dir = await Deno.makeTempDir();
  const store = await openStore(options(dir), {
    schemas: { room: roomSchema },
  });
  try {
    const room = await openRoom(store, '!ties-cost:test', { create: true });
    const ids: string[] = [];
    await room.tx(async (tx) => {
      const segment = await tx.segments.create({ kind: 'anchor' });
      for (let i = 0; i < 160; i++) {
        const id = '$' + i;
        await tx.events.insert(
          id,
          JSON.stringify({
            type: 'm.room.message',
            sender: '@a:test',
            depth: 1,
            origin_server_ts: i % 2,
            prev_events: i === 0 ? [] : ['$' + (i - 1)],
            auth_events: [],
            content: {},
          }),
        );
        await tx.segments.appendPosition(segment, id);
        if (i % 2 === 0) ids.unshift(id);
      }
    });
    await room.tx(async (tx) => {
      let reads = 0;
      const prevs = tx.events.prevsOf, children = tx.events.childrenOf;
      tx.events.prevsOf = (id) => {
        reads++;
        return prevs(id);
      };
      tx.events.childrenOf = (id) => {
        reads++;
        return children(id);
      };
      const start = performance.now();
      const ordered = await causalOrder(tx, ids);
      console.log(
        'native tie graph reads/time',
        reads,
        performance.now() - start,
      );
      assertEquals(ordered, [...ids].reverse());
      assert(reads <= 160, 'read each shared DAG node at most once: ' + reads);
    });
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('room read costs: unproved publication reachability fails explicitly at its budget', async () => {
  const conn = {
    query: (sql: string, args: unknown[] = []) => {
      if (sql.includes("s.kind = 'anchor'")) {
        return Promise.resolve([{ event: '$0' }]);
      }
      if (sql.includes('prev_edges')) {
        return Promise.resolve([{
          event: '$' + (Number(String(args[0]).slice(1)) + 1),
          prev: '$missing',
        }]);
      }
      return Promise.resolve([]);
    },
  } as unknown as Conn;
  await assertRejects(() => publishedGroupsAfter(conn, '$0'), Error, 'bounded');
});
