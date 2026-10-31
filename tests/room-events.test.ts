// tests/room-events.test.ts — R1–R3: insert/get/list, edge reads and their
// indexes, bounded walks with limits and stop sets, status transitions.
import { assert, assertEquals, assertRejects } from '@std/assert';
import type { Conn } from '#engine/store/db.ts';
import type { Value } from '#engine/store/ffi.ts';
import {
  ancestors,
  authChildrenOf,
  authClosure,
  authsOf,
  childrenOf,
  getEvent,
  getEvents,
  getStatus,
  insertEvent,
  prevsOf,
  setStatus,
  statuses,
} from '#engine/room/events.ts';
import { roomSchema } from '#engine/room/schema.ts';
import { openStore } from '#engine/store/index.ts';

const config = (dir: string) => ({
  dir,
  library: './.native/libturso_ffi.so',
  checkpointlogbytes: 65536,
  maxopenfiles: 8,
  idleseconds: 300,
});

function pdu(fields: Record<string, unknown>): string {
  return JSON.stringify({
    type: 'm.room.message',
    sender: '@a:test',
    depth: 1,
    origin_server_ts: 1000,
    content: { body: 'x' },
    ...fields,
  });
}

async function withRoom(
  dir: string,
  fn: (conn: Conn) => Promise<void>,
): Promise<void> {
  const store = await openStore(config(dir), { schemas: { room: roomSchema } });
  try {
    const db = await store.room('!r:test', { create: true });
    await db.tx(fn);
  } finally {
    await store.close();
  }
}

async function planUsesIndex(
  conn: Conn,
  sql: string,
  values: readonly Value[],
): Promise<void> {
  const rows = await conn.query('EXPLAIN QUERY PLAN ' + sql, values);
  const detail = rows.map((row) => Object.values(row).join(' ')).join('\n');
  assert(/SEARCH|USING (COVERING )?INDEX/.test(detail), `${sql}: ${detail}`);
}

Deno.test('room events: insert/get/list and edges from the PDU', async () => {
  const dir = await Deno.makeTempDir();
  try {
    await withRoom(dir, async (conn) => {
      const create = pdu({
        type: 'm.room.create',
        state_key: '',
        depth: 1,
        origin_server_ts: 1,
        prev_events: [],
        auth_events: [],
      });
      const m1 = pdu({
        depth: 2,
        origin_server_ts: 2,
        prev_events: ['$c'],
        auth_events: ['$c'],
      });
      const m2 = pdu({
        depth: 3,
        origin_server_ts: 3,
        prev_events: ['$m1', '$c'],
        auth_events: ['$c', '$m1'],
      });
      await insertEvent(conn, '$c', create);
      await insertEvent(conn, '$m1', m1);
      await insertEvent(conn, '$m2', m2);
      assertEquals(await getEvent(conn, '$c'), {
        id: '$c',
        pdu: create,
        type: 'm.room.create',
        state_key: '',
        sender: '@a:test',
        depth: 1,
        origin_ts: 1,
      });
      assertEquals(await getEvent(conn, '$nope'), null);
      const listed = await getEvents(conn, ['$m1', '$nope', '$m2']);
      assertEquals([...listed.keys()].sort(), ['$m1', '$m2']);
      assertEquals(listed.get('$m1')?.depth, 2);
      assertEquals(await prevsOf(conn, '$m2'), ['$m1', '$c']);
      assertEquals(await authsOf(conn, '$m2'), ['$c', '$m1']);
      assertEquals(await childrenOf(conn, '$c'), ['$m1', '$m2']);
      assertEquals(await authChildrenOf(conn, '$m1'), ['$m2']);
      // Legacy [id, {hashes}] pairs normalize to plain ids.
      await insertEvent(
        conn,
        '$old',
        pdu({
          depth: 2,
          origin_server_ts: 2,
          prev_events: [['$c', { sha256: 'x' }]],
          auth_events: [['$c', { sha256: 'x' }]],
        }),
      );
      assertEquals(await prevsOf(conn, '$old'), ['$c']);
      // Edge reads are index-backed.
      await planUsesIndex(conn, 'SELECT * FROM events WHERE id = ?', ['$c']);
      await planUsesIndex(
        conn,
        'SELECT prev FROM prev_edges WHERE event = ? ORDER BY ord',
        ['$m2'],
      );
      await planUsesIndex(
        conn,
        'SELECT event FROM prev_edges WHERE prev = ?',
        ['$c'],
      );
      await planUsesIndex(
        conn,
        'SELECT event FROM auth_edges WHERE auth = ?',
        ['$c'],
      );
      // A duplicate id is a constraint error; events never change.
      await assertRejects(() => insertEvent(conn, '$c', create));
      // Malformed facets are rejected before any row.
      await assertRejects(
        () => insertEvent(conn, '$bad', pdu({ depth: 1.5 })),
        TypeError,
        'type/sender/depth/origin_server_ts',
      );
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('room events: status set/get/transitions per event', async () => {
  const dir = await Deno.makeTempDir();
  try {
    await withRoom(dir, async (conn) => {
      await insertEvent(conn, '$e1', pdu({ depth: 1 }));
      await insertEvent(conn, '$e2', pdu({ depth: 1 }));
      assertEquals(await getStatus(conn, '$e1'), null);
      await setStatus(conn, '$e1', {
        standing: 'accepted',
        grounding: 'grounded',
        origin: null,
        received_ts: 10,
      });
      await setStatus(conn, '$e2', {
        standing: 'rejected',
        grounding: 'grounded',
        origin: 'remote:test',
        received_ts: 11,
      });
      assertEquals(await getStatus(conn, '$e1'), {
        standing: 'accepted',
        grounding: 'grounded',
        origin: null,
        received_ts: 10,
      });
      // A placeholder recovery changes knowledge, never the event row.
      await setStatus(conn, '$e2', {
        standing: 'soft_failed',
        grounding: 'pending',
        origin: 'remote:test',
        received_ts: 12,
      });
      assertEquals((await getStatus(conn, '$e2'))?.standing, 'soft_failed');
      assertEquals((await getEvent(conn, '$e2'))?.pdu, pdu({ depth: 1 }));
      const both = await statuses(conn, ['$e1', '$e2', '$nope']);
      assertEquals(both.size, 2);
      assertEquals(both.get('$e2')?.grounding, 'pending');
      await assertRejects(
        () =>
          setStatus(conn, '$e1', {
            standing: 'bogus' as never,
            grounding: 'grounded',
            origin: null,
            received_ts: 1,
          }),
        TypeError,
        'unknown standing/grounding',
      );
      await planUsesIndex(
        conn,
        'SELECT * FROM event_status WHERE event = ?',
        ['$e1'],
      );
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('room events: bounded auth closure and ancestry walks', async () => {
  const dir = await Deno.makeTempDir();
  try {
    await withRoom(dir, async (conn) => {
      // Auth graph: c0 <- s1 <- s2 <- m1; prev graph: c0 <- m1 <- m2 <- m3.
      await insertEvent(
        conn,
        'c0',
        pdu({
          type: 'm.room.create',
          state_key: '',
          prev_events: [],
          auth_events: [],
        }),
      );
      await insertEvent(
        conn,
        's1',
        pdu({
          type: 'm.room.power_levels',
          state_key: '',
          prev_events: [],
          auth_events: ['c0'],
        }),
      );
      await insertEvent(
        conn,
        's2',
        pdu({
          type: 'm.room.member',
          state_key: '@a:test',
          prev_events: [],
          auth_events: ['c0', 's1'],
        }),
      );
      await insertEvent(
        conn,
        'm1',
        pdu({
          prev_events: ['c0'],
          auth_events: ['s2'],
        }),
      );
      await insertEvent(conn, 'm2', pdu({ prev_events: ['m1'] }));
      await insertEvent(conn, 'm3', pdu({ prev_events: ['m2'] }));
      assertEquals(await authClosure(conn, ['m1'], 100), {
        ids: ['m1', 's2', 'c0', 's1'],
        truncated: false,
      });
      assertEquals(await authClosure(conn, ['s1'], 100), {
        ids: ['s1', 'c0'],
        truncated: false,
      });
      const limited = await authClosure(conn, ['m1'], 2);
      assertEquals(limited, { ids: ['m1', 's2'], truncated: true });
      assertEquals(await ancestors(conn, ['m3'], [], 100), {
        ids: ['m3', 'm2', 'm1', 'c0'],
        truncated: false,
      });
      assertEquals(await ancestors(conn, ['m3'], ['m1'], 100), {
        ids: ['m3', 'm2', 'm1'],
        truncated: false,
      });
      const stopped = await ancestors(conn, ['m3'], [], 2);
      assertEquals(stopped, { ids: ['m3', 'm2'], truncated: true });
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
