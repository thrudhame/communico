// tests/room-segments.test.ts — R8–R11 and the typed room handle: segments
// with stable ids and one open stay, first-owner positions with prepend
// without renumbering, extremities per stay, the waits lifecycle, the
// change log's order and paging, and atomic rollback of a room tx.
import { assert, assertEquals, assertRejects } from '@std/assert';
import type { Conn, Database as Db } from '#engine/store/db.ts';
import type { Value } from '#engine/store/ffi.ts';
import { openRoom, type Room, roomSchema } from '#engine/room/index.ts';
import { openStore, type Store } from '#engine/store/index.ts';

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

async function openTest(
  dir: string,
): Promise<{ store: Store; room: Room; db: Db }> {
  const store = await openStore(config(dir), { schemas: { room: roomSchema } });
  const room = await openRoom(store, '!r:test', { create: true });
  const db = await store.room('!r:test');
  return { store, room, db };
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

Deno.test('room segments: create/close/list, one open stay, stable ids', async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { store, room } = await openTest(dir);
    await room.tx(async (tx) => {
      const g0 = await tx.materialize.newGroup(null, []);
      const s1 = await tx.segments.create({ kind: 'history' });
      assertEquals(s1, 1);
      const s2 = await tx.segments.create({
        kind: 'stay',
        prev: s1,
        opening_group: g0,
      });
      assertEquals(s2, 2);
      assertEquals((await tx.segments.openStay())?.id, s2);
      // One open stay at a time.
      await assertRejects(
        () => tx.segments.create({ kind: 'stay' }),
        Error,
        'already has an open stay',
      );
      await tx.segments.close(s2);
      assertEquals(await tx.segments.openStay(), null);
      const s3 = await tx.segments.create({
        kind: 'stay',
        prev: s1,
        opening_group: g0,
      });
      assertEquals(s3, 3);
      await tx.segments.close(s1);
      const all = await tx.segments.list();
      assertEquals(all.map((segment) => segment.id), [1, 2, 3]);
      assertEquals(all[0].status, 'complete');
      assertEquals(all[1].status, 'closed');
      assertEquals(all[2].status, 'open');
      assertEquals((await tx.segments.get(s2))?.opening_group, g0);
    });
    await store.close();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('room segments: positions — append, prepend without renumbering, first owner', async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { store, room, db } = await openTest(dir);
    await room.tx(async (tx) => {
      const stay = await tx.segments.create({ kind: 'stay' });
      const history = await tx.segments.create({ kind: 'history' });
      for (const event of ['$e1', '$e2', '$h1', '$h2', '$h0']) {
        await tx.events.insert(event, pdu({ prev_events: [] }));
      }
      assertEquals(await tx.segments.appendPosition(stay, '$e1'), 0);
      assertEquals(await tx.segments.appendPosition(stay, '$e2'), 1);
      // History prepends go below the existing minimum, oldest first.
      assertEquals(
        await tx.segments.prependPositions(history, [
          '$h1',
          '$h2',
        ]),
        [-2, -1],
      );
      assertEquals(await tx.segments.prependPositions(history, ['$h0']), [
        -3,
      ]);
      assertEquals(await tx.segments.positionsPage(history, -1, 'b', 10), [
        { offset: -1, event: '$h2' },
        { offset: -2, event: '$h1' },
        { offset: -3, event: '$h0' },
      ]);
      assertEquals(await tx.segments.positionsPage(history, -2, 'f', 10), [
        { offset: -2, event: '$h1' },
        { offset: -1, event: '$h2' },
      ]);
      assertEquals(await tx.segments.positionOf('$h1'), {
        segment: history,
        offset: -2,
      });
      assertEquals(await tx.segments.positionOf('$nope'), null);
      // First owner wins: the same event never positions twice.
      await assertRejects(
        () => tx.segments.appendPosition(stay, '$h1'),
        Error,
        'already positioned',
      );
      await assertRejects(
        () => tx.segments.prependPositions(history, ['$e1']),
        Error,
        'already positioned',
      );
    });
    await db.tx(async (conn) => {
      await planUsesIndex(
        conn,
        'SELECT offset, event FROM positions WHERE segment = ? AND offset >= ? ORDER BY offset ASC LIMIT ?',
        [0, -2, 10],
      );
      await planUsesIndex(
        conn,
        'SELECT segment, offset FROM positions WHERE event = ?',
        ['$h1'],
      );
    });
    await store.close();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('room extremities and waits: per-stay frontier, waits lifecycle', async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { store, room, db } = await openTest(dir);
    await room.tx(async (tx) => {
      const stay = await tx.segments.create({ kind: 'stay' });
      const other = await tx.segments.create({
        kind: 'stay',
        status: 'closed',
      });
      await tx.extremities.add(stay, '$e1');
      await tx.extremities.add(stay, '$e2');
      assertEquals(await tx.extremities.frontier(stay), ['$e1', '$e2']);
      assertEquals(await tx.extremities.frontier(other), []);
      await tx.extremities.remove(stay, ['$e1']);
      assertEquals(await tx.extremities.frontier(stay), ['$e2']);
      await tx.waits.add({
        missing: '$m1',
        waiting: '$w1',
        kind: 'prev',
        since: 100,
        expires: 200,
        state: 'waiting',
      });
      await tx.waits.add({
        missing: '$m1',
        waiting: '$w2',
        kind: 'redaction',
        since: 110,
        expires: null,
        state: 'waiting',
      });
      assertEquals((await tx.waits.for('$m1')).length, 2);
      // Upsert refreshes since/expires/state for the same triple.
      await tx.waits.add({
        missing: '$m1',
        waiting: '$w1',
        kind: 'prev',
        since: 120,
        expires: 300,
        state: 'arrived',
      });
      assertEquals(await tx.waits.of('$w1'), [{
        missing: '$m1',
        waiting: '$w1',
        kind: 'prev',
        since: 120,
        expires: 300,
        state: 'arrived',
      }]);
      assertEquals(await tx.waits.expired(250), []);
      assertEquals((await tx.waits.expired(301)).length, 1);
      await tx.waits.remove('$m1', '$w1', 'prev');
      assertEquals(await tx.waits.of('$w1'), []);
      await tx.waits.removeOf('$w2');
      assertEquals(await tx.waits.for('$m1'), []);
    });
    await db.tx(async (conn) => {
      await planUsesIndex(
        conn,
        'SELECT event FROM extremities WHERE stay = ?',
        [1],
      );
      await planUsesIndex(
        conn,
        'SELECT * FROM waits WHERE expires IS NOT NULL AND expires <= ?',
        [1],
      );
    });
    await store.close();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('room changes: append order and after() paging', async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { store, room, db } = await openTest(dir);
    await room.tx(async (tx) => {
      const first = await tx.changes.append('event', '$e1', {
        stay: 1,
        kind_detail: 'new',
      });
      assertEquals(first, 1);
      await tx.changes.append('membership', '$e2', { user: '@a:test' });
      await tx.changes.append('delivery', '$e2', {
        destinations: ['b:test'],
      });
      await tx.changes.append('standing', '$e2', { standing: 'soft_failed' });
      await tx.changes.append('redaction', null, { target: '$e1' });
      const all = await tx.changes.after(0, 10);
      assertEquals(all.map((change) => change.pos), [1, 2, 3, 4, 5]);
      assertEquals(all[1].kind, 'membership');
      assertEquals(all[4].event, null);
      assertEquals(JSON.parse(all[2].data), { destinations: ['b:test'] });
      // Paging: after(pos, limit) resumes exactly.
      assertEquals(
        (await tx.changes.after(1, 2)).map((change) => change.pos),
        [2, 3],
      );
      assertEquals(
        (await tx.changes.after(3, 2)).map((change) => change.pos),
        [4, 5],
      );
      assertEquals(await tx.changes.after(5, 2), []);
    });
    await db.tx(async (conn) => {
      await planUsesIndex(
        conn,
        'SELECT pos, kind, event, data FROM changes WHERE pos > ? ORDER BY pos LIMIT ?',
        [0, 10],
      );
    });
    await store.close();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('room tx: everything inside a tx rolls back together on throw', async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { store, room } = await openTest(dir);
    const failure = new Error('abort');
    await assertRejects(
      () =>
        room.tx(async (tx) => {
          await tx.events.insert('$e1', pdu({ prev_events: [] }));
          const stay = await tx.segments.create({ kind: 'stay' });
          await tx.extremities.add(stay, '$e1');
          await tx.materialize.newGroup(null, [
            { type: 'm.room.create', state_key: '', event: '$e1' },
          ]);
          await tx.changes.append('event', '$e1', {});
          throw failure;
        }),
      Error,
      'abort',
    );
    await room.tx(async (tx) => {
      assertEquals(await tx.events.get('$e1'), null);
      assertEquals(await tx.segments.openStay(), null);
      assertEquals(await tx.changes.after(0, 10), []);
      await assertRejects(
        () => tx.state.groupMap(1),
        Error,
        'unknown state group',
      );
    });
    await store.close();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
