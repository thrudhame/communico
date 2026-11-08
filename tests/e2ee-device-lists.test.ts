import { assertEquals } from '@std/assert';
import { openStore } from '#engine/store/index.ts';
import { roomSchema } from '#engine/room/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { project, sourceOf } from '#engine/server/project.ts';
import {
  deviceListsBetween,
  deviceStreamMax,
  reconcileDeviceRoom,
} from '#engine/server/e2ee.ts';
import type { Conn } from '#engine/store/db.ts';
import { bobJoins, genesis } from '#tests/fixtures/genesis.ts';
import { redactEvent, sendLocal } from '#engine/room/ingest.ts';

Deno.test('E2: publication reconciliation queries only relationship pairs affected by the change', async () => {
  const dir = await Deno.makeTempDir();
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { server: serverSchema } });
  try {
    const server = await store.server();
    const members = Array.from({ length: 12 }, (_, i) => `@u${i}:test`);
    await server.tx((tx) =>
      reconcileDeviceRoom(tx, '!pairs:test', members, true, '$enc', 1)
    );
    const reconcile = (users: string[], encrypted: boolean, pos: number) =>
      server.tx(async (tx) => {
        let pairQueries = 0;
        const measured = {
          query: (sql: string, values?: Parameters<Conn['query']>[1]) => {
            if (sql.startsWith('SELECT start_seq FROM device_tracking')) {
              pairQueries++;
            }
            return tx.query(sql, values);
          },
          execute: tx.execute.bind(tx),
        } as Conn;
        await reconcileDeviceRoom(
          measured,
          '!pairs:test',
          users,
          encrypted,
          encrypted ? '$enc' : null,
          pos,
        );
        return pairQueries;
      });
    const before = await deviceStreamMax(server);
    assertEquals(await reconcile(members, true, 2), 0);
    assertEquals(await deviceStreamMax(server), before);
    assertEquals(
      await reconcile([...members, '@new:test'], true, 3),
      members.length * 4,
    );
    assertEquals(await reconcile([...members, '@new:test'], false, 4), 0);
    const after = await deviceStreamMax(server);
    assertEquals(
      await deviceListsBetween(server, members[0], before, after, 'sync'),
      {
        changed: ['@new:test'],
        left: [],
      },
    );
    assertEquals(
      await deviceListsBetween(server, members[0], before, after, 'keys'),
      {
        changed: ['@new:test'],
        left: [],
      },
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('E2: v4 server upgrade seeds its projected cut, preserves feed truth and rolls forward once', async () => {
  const dir = await Deno.makeTempDir();
  const config = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  const previous = {
    version: 4,
    apply: async (db: Parameters<typeof serverSchema.apply>[0]) => {
      await serverSchema.apply(db);
      for (
        const name of [
          'e2ee_rooms',
          'e2ee_room_members',
          'device_tracking',
          'device_notices',
          'edu_outbox',
          'federation_batches',
          'remote_device_keys',
          'remote_device_users',
          'device_subscriptions',
        ]
      ) await db.exec('DROP TABLE ' + name);
      await db.exec("DELETE FROM counters WHERE name='reliable-edus'");
    },
  };
  let store = await openStore(config, {
    schemas: { room: roomSchema, server: previous },
  });
  try {
    const g = await genesis(store, { roomId: '!upgrade:test' });
    const bob = '@bob:test';
    const join = await bobJoins(g, bob);
    const enc = await sendLocal(g.room, {
      type: 'm.room.encryption',
      sender: g.creator,
      state_key: '',
      content: { algorithm: 'm.megolm.v1.aes-sha2' },
    }, g.signer);
    const changes = await g.room.tx((tx) => tx.changes.after(0, 1000));
    const pos = changes.find((c) =>
      c.event === enc.eventId && c.kind === 'event'
    )!.pos;
    const last = changes[changes.length - 1].pos;
    const db = await store.server();
    await db.execute('INSERT INTO feed VALUES(41,?,?,?,?)', [
      g.roomId,
      pos,
      enc.eventId,
      1,
    ]);
    await db.execute("INSERT INTO counters VALUES('events',41)");
    await db.execute('INSERT INTO memberships VALUES(?,?,?,?,?)', [
      g.creator,
      g.roomId,
      'join',
      g.tipId,
      20,
    ]);
    await db.execute('INSERT INTO memberships VALUES(?,?,?,?,?)', [
      bob,
      g.roomId,
      'join',
      join,
      30,
    ]);
    await db.execute('INSERT INTO watermarks VALUES(?,?)', [
      sourceOf(g.roomId),
      last,
    ]);
    await store.close();
    store = await openStore(config, {
      schemas: { room: roomSchema, server: serverSchema },
    });
    await project(store, g.roomId);
    const migrated = await store.server();
    const head = await deviceStreamMax(migrated);
    assertEquals(
      await deviceListsBetween(migrated, g.creator, 0, head, 'sync'),
      { changed: [bob], left: [] },
    );
    assertEquals((await migrated.query('SELECT seq FROM feed'))[0].seq, 41);
    await project(store, g.roomId);
    assertEquals(await deviceStreamMax(migrated), head);
    assertEquals(
      (await migrated.query("SELECT v FROM meta WHERE k='schema_version'"))[0]
        .v,
      '9',
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('E3: encryption redaction leaves all-room device tracking intact', async () => {
  const dir = await Deno.makeTempDir();
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { room: roomSchema, server: serverSchema } });
  try {
    const g = await genesis(store, { roomId: '!redact:test' });
    const bob = '@bob:test';
    await bobJoins(g, bob);
    const enc = await sendLocal(g.room, {
      type: 'm.room.encryption',
      sender: g.creator,
      state_key: '',
      content: { algorithm: 'm.megolm.v1.aes-sha2' },
    }, g.signer);
    await project(store, g.roomId);
    const server = await store.server();
    const before = await deviceStreamMax(server);
    await redactEvent(g.room, g.creator, enc.eventId, g.signer);
    await project(store, g.roomId);
    const after = await deviceStreamMax(server);
    assertEquals(
      await deviceListsBetween(server, g.creator, before, after, 'sync'),
      { changed: [], left: [] },
    );
    assertEquals(
      await deviceListsBetween(server, g.creator, before, after, 'keys'),
      { changed: [], left: [] },
    );
    assertEquals(
      await deviceListsBetween(server, g.creator, 0, before, 'sync'),
      { changed: [bob], left: [] },
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
