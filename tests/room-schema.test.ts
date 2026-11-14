// tests/room-schema.test.ts - the provider's tables land on
// create, the recorded version opens and mismatches refuse.
import { assertEquals, assertRejects } from '@std/assert';
import { roomSchema } from '#engine/room/schema.ts';
import { openStore } from '#engine/store/index.ts';

const config = (dir: string) => ({
  dir,
  library: './.native/libturso_ffi.so',
  checkpointlogbytes: 65536,
  maxopenfiles: 8,
  idleseconds: 300,
});

const TABLES = [
  'events',
  'event_status',
  'event_topology',
  'prev_edges',
  'auth_edges',
  'state_groups',
  'state_entries',
  'event_state',
  'publications',
  'publication_keys',
  'segments',
  'positions',
  'extremities',
  'waits',
  'changes',
  'remote_batches',
];

const INDEXES = [
  'events_type',
  'events_sender',
  'events_depth',
  'events_origin_ts',
  'events_annotation_target',
  'prev_edges_reverse',
  'auth_edges_reverse',
  'positions_event',
  'waits_waiting',
  'waits_expires',
  'changes_event',
  'changes_redaction_target',
  'publications_change',
  'segments_opener',
];

Deno.test('room schema: tables and indexes land on create, version recorded', async () => {
  const dir = await Deno.makeTempDir();
  try {
    const store = await openStore(config(dir), {
      schemas: { room: roomSchema },
    });
    const room = await store.room('!r:test', { create: true });
    const tables = await room.query(
      `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
    );
    const names = tables.map((row) => row.name);
    for (const name of [...TABLES, 'id', 'meta']) {
      assertEquals(names.includes(name), true, `missing table ${name}`);
    }
    const indexes = await room.query(
      `SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name`,
    );
    for (const name of INDEXES) {
      assertEquals(
        indexes.some((row) => row.name === name),
        true,
        `missing index ${name}`,
      );
    }
    assertEquals(await room.query('SELECT v FROM meta'), [{
      v: String(roomSchema.version),
    }]);
    await store.close();
    const again = await openStore(config(dir), {
      schemas: { room: roomSchema },
    });
    await again.room('!r:test');
    await again.close();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('room schema: the empty provider refuses a room file and vice versa', async () => {
  const dir = await Deno.makeTempDir();
  try {
    const store = await openStore(config(dir), {
      schemas: { room: roomSchema },
    });
    await store.room('!r:test', { create: true });
    await store.close();
    const plain = await openStore(config(dir));
    await assertRejects(
      () => plain.room('!r:test'),
      Error,
      'schema version mismatch',
    );
    await plain.close();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('room schema: v3 upgrade preserves old data and starts the future publication-key journal', async () => {
  const dir = await Deno.makeTempDir();
  let store = await openStore(config(dir), {
    schemas: {
      room: {
        version: 3,
        apply: async (db) => {
          await roomSchema.apply(db);
          await db.exec(
            'DROP TABLE publication_keys; DROP INDEX events_annotation_target; DROP TABLE remote_batches',
          );
        },
      },
    },
  });
  try {
    const room = await store.room('!upgrade:test', { create: true });
    await room.execute(
      "INSERT INTO events(id,pdu,type,sender,depth,origin_ts) VALUES('$old','{}','test','@a:test',1,1)",
    );
    await store.close();
    store = await openStore(config(dir), { schemas: { room: roomSchema } });
    const upgraded = await store.room('!upgrade:test');
    assertEquals(await upgraded.query('SELECT id FROM events'), [{
      id: '$old',
    }]);
    assertEquals(await upgraded.query('SELECT * FROM publication_keys'), []);
    assertEquals(await upgraded.query('SELECT v FROM meta'), [{
      v: String(roomSchema.version),
    }]);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('room schema: v4 annotation index upgrade preserves events and uses target/key lookup', async () => {
  const dir = await Deno.makeTempDir();
  let store = await openStore(config(dir), {
    schemas: {
      room: {
        version: 4,
        apply: async (db) => {
          await roomSchema.apply(db);
          await db.exec(
            'DROP INDEX events_annotation_target; DROP TABLE remote_batches',
          );
        },
      },
    },
  });
  const pdu = JSON.stringify({
    content: {
      'm.relates_to': {
        event_id: '$target',
        rel_type: 'm.annotation',
        key: 'yes',
      },
    },
  });
  try {
    const room = await store.room('!annotation-upgrade:test', { create: true });
    await room.execute(
      "INSERT INTO events(id,pdu,type,sender,depth,origin_ts) VALUES('$reaction',?,'m.reaction','@a:test',1,1)",
      [pdu],
    );
    await store.close();
    store = await openStore(config(dir), { schemas: { room: roomSchema } });
    const upgraded = await store.room('!annotation-upgrade:test');
    assertEquals(await upgraded.query('SELECT id,pdu FROM events'), [{
      id: '$reaction',
      pdu,
    }]);
    const plan = await upgraded.query(
      `EXPLAIN QUERY PLAN SELECT id FROM events
      WHERE sender=? AND type=? AND json_extract(pdu, '$.content."m.relates_to".event_id')=?
      AND json_extract(pdu, '$.content."m.relates_to".rel_type')='m.annotation'
      AND json_extract(pdu, '$.content."m.relates_to".key')=?`,
      ['@a:test', 'm.reaction', '$target', 'yes'],
    );
    assertEquals(
      plan.some((row) =>
        String(row.detail).includes('events_annotation_target')
      ),
      true,
      JSON.stringify(plan),
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('room schema: v5 adds durable remote batch receipts without changing events', async () => {
  const dir = await Deno.makeTempDir();
  let store = await openStore(config(dir), {
    schemas: {
      room: {
        version: 5,
        apply: async (db) => {
          await roomSchema.apply(db);
          await db.exec('DROP TABLE remote_batches');
        },
      },
    },
  });
  try {
    const room = await store.room('!receipt-upgrade:test', { create: true });
    await room.execute(
      "INSERT INTO events(id,pdu,type,sender,depth,origin_ts) VALUES('$old','{}','test','@a:test',1,1)",
    );
    await store.close();
    store = await openStore(config(dir), { schemas: { room: roomSchema } });
    const upgraded = await store.room('!receipt-upgrade:test');
    assertEquals(await upgraded.query('SELECT id FROM events'), [{
      id: '$old',
    }]);
    assertEquals(await upgraded.query('SELECT * FROM remote_batches'), []);
    assertEquals(await upgraded.query('SELECT v FROM meta'), [{
      v: String(roomSchema.version),
    }]);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
