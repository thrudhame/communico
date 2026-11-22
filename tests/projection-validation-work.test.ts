import { assertEquals } from '@std/assert';
import { openStore } from '#engine/store/index.ts';
import { roomSchema } from '#engine/room/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { sendLocal } from '#engine/room/ingest.ts';
import { project, projectThrough, sourceOf } from '#engine/server/project.ts';
import { get } from '#engine/store/watermark.ts';
import { genesis } from '#tests/fixtures/genesis.ts';

Deno.test('projection validation work: one captured room witness and one set-valued watermark read', async () => {
  const dir = await Deno.makeTempDir();
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, {
    schemas: { room: roomSchema, server: serverSchema, tenant: tenantSchema },
  });
  try {
    const tenant = await openTenant(store, 'test', { create: true });
    await tenant.tx((tx) => tx.users.insert('dev', 'Dev'));
    const g = await genesis(store, { roomId: '!validation-work:test' });
    await project(store, g.roomId);
    const event = await sendLocal(g.room, {
      type: 'm.room.message',
      sender: g.creator,
      content: { msgtype: 'm.text', body: 'validation work' },
    }, g.signer);
    const originalRoom = store.room.bind(store);
    let redundantHeadReads = 0;
    store.room = async (...args) => {
      const db = await originalRoom(...args);
      const originalTx = db.tx.bind(db);
      db.tx = (fn, options) =>
        originalTx((tx) => {
          const query = tx.query.bind(tx);
          let validated = false;
          tx.query = (sql, values) => {
            if (
              sql.includes('AS receipt_through FROM completion_state')
            ) validated = true;
            if (
              validated &&
              sql === 'SELECT COALESCE(MAX(pos), 0) AS pos FROM changes'
            ) redundantHeadReads++;
            return query(sql, values);
          };
          return fn(tx);
        }, options);
      return db;
    };
    const server = await store.server();
    const originalQuery = server.query.bind(server);
    let groupedReads = 0;
    server.query = (sql, values) => {
      if (sql.includes('json_each(?)') && sql.includes('JOIN watermarks')) {
        groupedReads++;
      }
      return originalQuery(sql, values);
    };
    try {
      await projectThrough(store, event.completion!);
    } finally {
      store.room = originalRoom;
      server.query = originalQuery;
    }
    assertEquals(
      (await server.query('SELECT event FROM feed WHERE event=?', [
        event.eventId,
      ])).length,
      1,
    );
    assertEquals(
      await get(server, sourceOf(g.roomId)) >= event.completion!.through,
      true,
    );
    console.log(JSON.stringify({ redundantHeadReads, groupedReads }));
    assertEquals(
      redundantHeadReads,
      0,
      'completion validation already captured and checked the room head in this attempt',
    );
    assertEquals(
      groupedReads,
      1,
      'publication validates all three source cuts in one server snapshot',
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
