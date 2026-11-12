// tests/room-state.test.ts — R4–R7: state-group chains with snapshot at
// depth 33, dedup, reconstruction vs a naive map, event-state provenance,
// publications at/before/between positions, the current pointer.
import { assert, assertEquals, assertRejects } from '@std/assert';
import type { Conn } from '#engine/store/db.ts';
import type { Value } from '#engine/store/ffi.ts';
import { insertEvent } from '#engine/room/events.ts';
import {
  newGroup,
  publish,
  setCurrent,
  setEventState,
} from '#engine/room/materialize.ts';
import {
  changedByOther,
  current,
  eventStateAfter,
  eventStateBefore,
  groupKey,
  groupMap,
  publishedAt,
} from '#engine/room/state.ts';
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

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

Deno.test('room state: keyed publication journal follows resolved snapshots, not unrelated state', async () => {
  const dir = await Deno.makeTempDir();
  try {
    await withRoom(dir, async (conn) => {
      for (
        const [id, sender] of [['$own', '@a:test'], ['$other', '@b:test'], [
          '$unrelated',
          '@b:test',
        ]]
      ) await insertEvent(conn, id, pdu({ sender }));
      const opening = await newGroup(conn, null, [{
        type: 'call',
        state_key: 'key',
        event: '$own',
      }]);
      await conn.execute(
        "INSERT INTO segments(id,kind,opening_group,status) VALUES(1,'stay',?,'open')",
        [opening],
      );
      const unchanged = await newGroup(conn, null, [{
        type: 'call',
        state_key: 'key',
        event: '$own',
      }, { type: 'elsewhere', state_key: 'key', event: '$unrelated' }]);
      await publish(conn, 1, 1, unchanged);
      assertEquals(
        await changedByOther(conn, 'call', 'key', '@a:test', 0, null),
        false,
      );
      const resolved = await newGroup(conn, null, [{
        type: 'call',
        state_key: 'key',
        event: '$other',
      }]);
      await publish(conn, 2, 1, resolved);
      const returned = await newGroup(conn, null, [{
        type: 'call',
        state_key: 'key',
        event: '$own',
      }]);
      await publish(conn, 3, 1, returned);
      assertEquals(
        await changedByOther(conn, 'call', 'key', '@a:test', 1, null),
        true,
      );
      assertEquals(
        await changedByOther(conn, 'call', 'key', '@a:test', 2, null),
        false,
      );
      await planUsesIndex(
        conn,
        'SELECT 1 FROM publication_keys WHERE type=? AND state_key=? AND change_pos>? AND sender<>? LIMIT 1',
        ['call', 'key', 0, '@a:test'],
      );
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

async function rejoinPublication(extra: boolean, unpublishedStays = 0) {
  const dir = await Deno.makeTempDir();
  try {
    await withRoom(dir, async (conn) => {
      for (
        const [id, sender] of [
          ['$old', '@a:test'],
          ['$replacement', '@b:test'],
          ['$join', '@a:test'],
        ]
      ) await insertEvent(conn, id, pdu({ sender }));
      const old = await newGroup(conn, null, [{
        type: 'call',
        state_key: 'key',
        event: '$old',
      }]);
      await conn.execute(
        "INSERT INTO segments(id,kind,status) VALUES(1,'stay','closed')",
      );
      await publish(conn, 1, 1, old);
      for (let id = 2; id < unpublishedStays + 2; id++) {
        await conn.execute(
          "INSERT INTO segments(id,kind,prev,opening_group,status) VALUES(?,'stay',?,?,'closed')",
          [id, id - 1, old],
        );
        assertEquals(await publish(conn, id, id, old), false);
      }
      const imported = await newGroup(conn, null, [{
        type: 'call',
        state_key: 'key',
        event: '$replacement',
      }]);
      await conn.execute(
        "INSERT INTO segments(id,kind,prev,opening_group,status) VALUES(?,'stay',?,?,'open')",
        [unpublishedStays + 2, unpublishedStays + 1, imported],
      );
      const joined = extra
        ? await newGroup(conn, imported, [{
          type: 'join',
          state_key: 'key',
          event: '$join',
        }])
        : imported;
      assertEquals(
        await publish(conn, unpublishedStays + 2, unpublishedStays + 2, joined),
        true,
        'a rejoin publication compares against the predecessor, not its imported opening',
      );
      assertEquals(
        await changedByOther(conn, 'call', 'key', '@a:test', 1, null),
        true,
        'foreign replacement during the gap must cancel old delayed work',
      );
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}
Deno.test('room state: rejoin snapshot records replacement made during the gap', () =>
  rejoinPublication(false));
Deno.test('room state: first rejoin delta also records imported replacement made during the gap', () =>
  rejoinPublication(true));
for (const unpublishedStays of [1, 3]) {
  Deno.test(`room state: rejoin snapshot crosses ${unpublishedStays} unpublished predecessor stays`, () =>
    rejoinPublication(false, unpublishedStays));
  Deno.test(`room state: first rejoin delta crosses ${unpublishedStays} unpublished predecessor stays`, () =>
    rejoinPublication(true, unpublishedStays));
}

Deno.test('room state: groups — deltas, removal, dedup, selected-key reads', async () => {
  const dir = await Deno.makeTempDir();
  try {
    await withRoom(dir, async (conn) => {
      const g1 = await newGroup(conn, null, [
        { type: 'm.room.create', state_key: '', event: '$c' },
      ]);
      const g2 = await newGroup(conn, g1, [
        { type: 'm.room.power_levels', state_key: '', event: '$pl' },
      ]);
      assertEquals(
        await groupMap(conn, g2),
        new Map([
          ['m.room.create\0', '$c'],
          ['m.room.power_levels\0', '$pl'],
        ]),
      );
      // A delta with a NULL event removes the key.
      const g3 = await newGroup(conn, g2, [
        { type: 'm.room.create', state_key: '', event: null },
      ]);
      assertEquals(
        await groupMap(conn, g3),
        new Map([
          ['m.room.power_levels\0', '$pl'],
        ]),
      );
      assertEquals(await groupKey(conn, g3, 'm.room.create', ''), null);
      assertEquals(await groupKey(conn, g3, 'm.room.power_levels', ''), '$pl');
      assertEquals(await groupKey(conn, g3, 'm.room.name', ''), null);
      // Zero changes return the parent; identical changes dedup.
      assertEquals(await newGroup(conn, g2, []), g2);
      assertEquals(
        await newGroup(conn, g1, [
          { type: 'm.room.power_levels', state_key: '', event: '$pl' },
        ]),
        g2,
      );
      assertEquals(
        await newGroup(conn, null, [
          { type: 'm.room.create', state_key: '', event: '$c' },
        ]),
        g1,
      );
      // Chain bookkeeping: g3 is a delta at depth 2 on g2.
      const row = await conn.query(
        'SELECT parent, depth FROM state_groups WHERE id = ?',
        [g3],
      );
      assertEquals(row, [{ parent: g2, depth: 2 }]);
      await planUsesIndex(
        conn,
        'SELECT event FROM state_entries WHERE grp = ? AND type = ? AND state_key = ?',
        [g3, 'm.room.create', ''],
      );
      await planUsesIndex(
        conn,
        'SELECT id FROM state_groups WHERE fingerprint = ?',
        ['x'],
      );
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('room state: a chain past depth 32 flattens into a snapshot', async () => {
  const dir = await Deno.makeTempDir();
  try {
    await withRoom(dir, async (conn) => {
      let cursor = await newGroup(conn, null, [
        { type: 't', state_key: 'k0', event: '$e0' },
      ]);
      for (let index = 1; index <= 32; index++) {
        cursor = await newGroup(conn, cursor, [
          { type: 't', state_key: `k${index}`, event: `$e${index}` },
        ]);
      }
      const atBound = await conn.query(
        'SELECT depth FROM state_groups WHERE id = ?',
        [cursor],
      );
      assertEquals(Number(atBound[0].depth), 32);
      // The 33rd delta would exceed the bound: a snapshot is written.
      const flattened = await newGroup(conn, cursor, [
        { type: 't', state_key: 'k33', event: '$e33' },
      ]);
      const row = await conn.query(
        'SELECT parent, depth FROM state_groups WHERE id = ?',
        [flattened],
      );
      assertEquals(row, [{ parent: null, depth: 0 }]);
      const map = await groupMap(conn, flattened);
      assertEquals(map.size, 34);
      assertEquals(map.get('t\0k33'), '$e33');
      assertEquals(map.get('t\0k0'), '$e0');
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('room state: 500 random changes reconstruct the naive map', async () => {
  const dir = await Deno.makeTempDir();
  try {
    await withRoom(dir, async (conn) => {
      const random = mulberry32(42);
      const naive = new Map<string, string>();
      let cursor = await newGroup(conn, null, []);
      for (let step = 0; step < 500; step++) {
        const changes: {
          type: string;
          state_key: string;
          event: string | null;
        }[] = [];
        const count = 1 + Math.floor(random() * 3);
        for (let index = 0; index < count; index++) {
          const type = `t${Math.floor(random() * 5)}`;
          const key = `k${Math.floor(random() * 10)}`;
          if (random() < 0.3 && naive.has(`${type}\0${key}`)) {
            changes.push({ type, state_key: key, event: null });
            naive.delete(`${type}\0${key}`);
          } else {
            const event = `$e${step}_${index}`;
            changes.push({ type, state_key: key, event });
            naive.set(`${type}\0${key}`, event);
          }
        }
        cursor = await newGroup(conn, cursor, changes);
        const row = await conn.query(
          'SELECT depth FROM state_groups WHERE id = ?',
          [cursor],
        );
        assert(Number(row[0].depth) <= 32, 'chain stays within the bound');
      }
      assertEquals(await groupMap(conn, cursor), naive);
      for (const [key, event] of naive) {
        const [type, stateKey] = key.split('\0');
        assertEquals(await groupKey(conn, cursor, type, stateKey), event);
      }
      assertEquals(await groupKey(conn, cursor, 'absent', 'key'), null);
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('room state: event-state refs with all three provenances', async () => {
  const dir = await Deno.makeTempDir();
  try {
    await withRoom(dir, async (conn) => {
      await insertEvent(conn, '$e1', pdu({ depth: 1 }));
      await insertEvent(conn, '$e2', pdu({ depth: 2 }));
      await insertEvent(conn, '$e3', pdu({ depth: 3 }));
      const g1 = await newGroup(conn, null, [
        { type: 'm.room.create', state_key: '', event: '$c' },
      ]);
      const g2 = await newGroup(conn, g1, [
        { type: 'm.room.member', state_key: '@a:test', event: '$m' },
      ]);
      await setEventState(conn, '$e1', g1, g2, 'dag');
      assertEquals(await eventStateBefore(conn, '$e1'), {
        group: g1,
        provenance: 'dag',
      });
      assertEquals(await eventStateAfter(conn, '$e1'), {
        group: g2,
        provenance: 'dag',
      });
      await setEventState(conn, '$e2', g1, g2, 'imported');
      assertEquals(
        (await eventStateBefore(conn, '$e2'))?.provenance,
        'imported',
      );
      // Unknown is `none`: both refs NULL, never a fake snapshot.
      await setEventState(conn, '$e3', null, null, 'none');
      assertEquals(await eventStateBefore(conn, '$e3'), null);
      assertEquals(await eventStateAfter(conn, '$e3'), null);
      // Recovery moves none → dag, and provenance/rows stay consistent.
      await setEventState(conn, '$e3', g1, g2, 'dag');
      assertEquals((await eventStateAfter(conn, '$e3'))?.group, g2);
      await assertRejects(
        () => setEventState(conn, '$e1', null, null, 'dag'),
        TypeError,
        'none requires NULL groups',
      );
      await assertRejects(
        () => setEventState(conn, '$e1', g1, null, 'dag'),
        TypeError,
        'set together',
      );
      await planUsesIndex(
        conn,
        'SELECT before_group AS grp, provenance FROM event_state WHERE event = ?',
        ['$e1'],
      );
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('room state: publications at, before and between positions; the pointer', async () => {
  const dir = await Deno.makeTempDir();
  try {
    await withRoom(dir, async (conn) => {
      const g0 = await newGroup(conn, null, [
        { type: 'm.room.create', state_key: '', event: '$c' },
      ]);
      const g1 = await newGroup(conn, g0, [
        { type: 'm.room.name', state_key: '', event: '$n' },
      ]);
      const g2 = await newGroup(conn, g1, [
        { type: 'm.room.topic', state_key: '', event: '$t' },
      ]);
      // Stay 1 opens with g0 (fixture; segments.ts lands in commit 5).
      await conn.execute(
        `INSERT INTO segments(id, kind, prev, opened_by, opening_group, current_group, status)
         VALUES(1, 'stay', NULL, NULL, ?, NULL, 'open')`,
        [g0],
      );
      // Publishing the opening group first is a no-op.
      assertEquals(await publish(conn, 5, 1, g0), false);
      assertEquals(await publish(conn, 5, 1, g1), true);
      assertEquals(await publish(conn, 7, 1, g1), false); // unchanged
      assertEquals(await publish(conn, 10, 1, g2), true);
      assertEquals(await publishedAt(conn, 1, 4), g0); // before: opening
      assertEquals(await publishedAt(conn, 1, 5), g1); // at
      assertEquals(await publishedAt(conn, 1, 7), g1); // between
      assertEquals(await publishedAt(conn, 1, 10), g2);
      assertEquals(await publishedAt(conn, 1, 15), g2);
      // The pointer: opening until setCurrent moves it.
      assertEquals(await current(conn, 1), g0);
      await setCurrent(conn, 1, g2);
      assertEquals(await current(conn, 1), g2);
      await assertRejects(
        () => setCurrent(conn, 99, g2),
        Error,
        'unknown stay',
      );
      await planUsesIndex(
        conn,
        'SELECT grp FROM publications WHERE stay = ? AND change_pos <= ? ORDER BY change_pos DESC LIMIT 1',
        [1, 7],
      );
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
