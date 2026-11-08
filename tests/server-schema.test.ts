// tests/server-schema.test.ts — server schema v1: the provider's tables
// land on create beside the store's watermarks, the recorded version
// opens and mismatches refuse, and the structural idempotency keys hold.
import { assertEquals, assertRejects } from '@std/assert';
import { serverSchema } from '#engine/server/schema.ts';
import { openStore } from '#engine/store/index.ts';

const config = (dir: string) => ({
  dir,
  library: './.native/libturso_ffi.so',
  checkpointlogbytes: 65536,
  maxopenfiles: 8,
  idleseconds: 300,
});

const TABLES = [
  'rooms',
  'event_index',
  'feed',
  'memberships',
  'redactions',
  'relations',
  'search',
  'outbox',
  'peer_status',
  'receipts',
  'presence',
  'aliases',
  'directory',
  'visibility',
  'forgotten',
  'counters',
  'federation_txns',
  'federation_peers',
  'federation_blocks',
  'federation_pending',
  'federation_invites',
  'server_keys',
  'server_key_docs',
  'server_key_changes',
  'device_changes',
  'e2ee_rooms',
  'e2ee_room_members',
  'device_tracking',
  'device_notices',
  'edu_outbox',
  'federation_batches',
  'remote_device_users',
  'remote_device_keys',
];

const INDEXES = [
  'event_index_room',
  'feed_room',
  'memberships_room',
  'relations_parent',
  'search_room',
  'outbox_due',
];

Deno.test('server schema: tables and indexes land on create, version recorded', async () => {
  const dir = await Deno.makeTempDir();
  try {
    const store = await openStore(config(dir), {
      schemas: { server: serverSchema },
    });
    const server = await store.server();
    const tables = await server.query(
      `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
    );
    const names = tables.map((row) => row.name);
    for (const name of [...TABLES, 'meta', 'watermarks']) {
      assertEquals(names.includes(name), true, `missing table ${name}`);
    }
    const indexes = await server.query(
      `SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name`,
    );
    for (const name of INDEXES) {
      assertEquals(
        indexes.some((row) => row.name === name),
        true,
        `missing index ${name}`,
      );
    }
    const version = await server.query(
      `SELECT v FROM meta WHERE k = 'schema_version'`,
    );
    assertEquals(version, [{ v: '8' }]);
    await store.close();
    // A second open with the same provider checks out.
    const again = await openStore(config(dir), {
      schemas: { server: serverSchema },
    });
    await again.close();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('server schema: the structural idempotency keys refuse duplicates', async () => {
  const dir = await Deno.makeTempDir();
  try {
    const store = await openStore(config(dir), {
      schemas: { server: serverSchema },
    });
    const server = await store.server();
    await server.execute(
      `INSERT INTO feed(room, pos, event, stay) VALUES('!r:test', 1, '$e1', 2)`,
    );
    // (room, pos) is the projection's idempotency key on the feed.
    await assertRejects(
      () =>
        server.execute(
          `INSERT INTO feed(room, pos, event, stay) VALUES('!r:test', 1, '$e2', 2)`,
        ),
    );
    await server.execute(
      `INSERT INTO outbox(room, pos, destination, event, state, added_ms)
       VALUES('!r:test', 3, 'remote.test', '$e2', 'pending', 1)`,
    );
    // (room, pos, destination) is the outbox's idempotency key.
    await assertRejects(
      () =>
        server.execute(
          `INSERT INTO outbox(room, pos, destination, event, state, added_ms)
           VALUES('!r:test', 3, 'remote.test', '$e3', 'pending', 1)`,
        ),
    );
    // a different destination of the same change is a second row
    await server.execute(
      `INSERT INTO outbox(room, pos, destination, event, state, added_ms)
       VALUES('!r:test', 3, 'other.test', '$e3', 'pending', 1)`,
    );
    assertEquals(
      await server.query(`SELECT destination FROM outbox ORDER BY destination`),
      [{ destination: 'other.test' }, { destination: 'remote.test' }],
    );
    // the feed's seq auto-assigns in insertion order (gaps are legal —
    // a failed insert can burn a rowid, like the old sequence burned on
    // rollback; strictly increasing is the contract, not gaplessness)
    await server.execute(
      `INSERT INTO feed(room, pos, event, stay) VALUES('!r:test', 2, '$e2', 2)`,
    );
    const seqs = await server.query(
      `SELECT seq, event FROM feed ORDER BY seq`,
    );
    assertEquals(seqs.map((row) => row.event), ['$e1', '$e2']);
    assertEquals(Number(seqs[1].seq) > Number(seqs[0].seq), true);
    await store.close();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
