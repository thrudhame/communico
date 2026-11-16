import { assertEquals } from '@std/assert';
import { buildInTx } from '#engine/room/build.ts';
import { openRoom, roomSchema } from '#engine/room/index.ts';
import { ingestInTx, redactEvent } from '#engine/room/ingest.ts';
import { registerRoom } from '#engine/server/registry.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { recoverRoomWaits } from '#engine/server/startup.ts';
import { openStore } from '#engine/store/index.ts';
import { tenantSchema } from '#engine/tenant/index.ts';
import { genesis } from './fixtures/genesis.ts';

Deno.test('startup drains committed dependency work before any new arrival and projects exactly once', async () => {
  const dir = await Deno.makeTempDir();
  const config = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  const schemas = {
    room: roomSchema,
    server: serverSchema,
    tenant: tenantSchema,
  };
  let store = await openStore(config, { schemas });
  try {
    const g = await genesis(store, { roomId: '!wait-startup:test' });
    await registerRoom(store, g.room.id);
    const target = await g.room.tx((tx) =>
      buildInTx(tx, g.room.id, {
        type: 'm.room.message',
        sender: g.creator,
        content: { body: 'target' },
      }, g.signer)
    );
    const redaction = await redactEvent(
      g.room,
      g.creator,
      target.event_id!,
      g.signer,
    );
    await g.room.tx((tx) =>
      ingestInTx(tx, g.room.id, target, { self: g.signer.serverName })
    );
    assertEquals(
      (await g.room.tx((tx) => tx.waits.ready())).map((wait) => wait.waiting),
      [redaction.eventId],
    );
    await store.close();
    store = await openStore(config, { schemas });
    await recoverRoomWaits(store, g.signer.serverName);
    const room = await openRoom(store, g.room.id);
    assertEquals(await room.tx((tx) => tx.waits.of(redaction.eventId)), []);
    const before = await (await store.server()).query(
      'SELECT * FROM feed ORDER BY seq',
    );
    await recoverRoomWaits(store, g.signer.serverName);
    assertEquals(
      await (await store.server()).query('SELECT * FROM feed ORDER BY seq'),
      before,
    );
    assertEquals(
      (await room.tx((tx) => tx.changes.after(0, 200))).filter((change) =>
        change.kind === 'redaction' && change.event === redaction.eventId
      ).length,
      1,
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
