import { assertEquals, assertRejects } from '@std/assert';
import { openStore } from '#engine/store/index.ts';
import type { Conn } from '#engine/store/db.ts';
import { serverSchema } from '#engine/server/schema.ts';
import {
  holdPublication,
  observePublication,
} from '#tests/support/hold-publication.ts';

async function writeFeed(tx: Conn, encoding: 'scalar' | 'set', room: string) {
  if (encoding === 'scalar') {
    await tx.execute(
      'INSERT INTO feed(seq,room,pos,event,stay) VALUES(?,?,?,?,?)',
      [1, room, 1, '$held', 1],
    );
  } else {
    await tx.execute(
      `INSERT INTO feed(seq,room,pos,event,stay)
      SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]'),json_extract(value,'$[2]'),json_extract(value,'$[3]'),json_extract(value,'$[4]') FROM json_each(?)`,
      [JSON.stringify([[1, '!other:test', 1, '$other', 1], [
        2,
        room,
        1,
        '$held',
        1,
      ]])],
    );
  }
}

for (const encoding of ['scalar', 'set'] as const) {
  Deno.test(`publication holder: ${encoding} native feed writes retain the transaction until release`, async () => {
    const dir = await Deno.makeTempDir();
    const store = await openStore({
      dir,
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 300,
    }, { schemas: { server: serverSchema } });
    const server = await store.server();
    const room = '!held:test';
    const hold = holdPublication({ server }, room);
    let committed = false;
    const write = server.tx((tx) => writeFeed(tx, encoding, room)).then(() => {
      committed = true;
    });
    try {
      assertEquals(
        await Promise.race([
          hold.entered.then(() => true),
          write.then(() => false),
        ]),
        true,
        'the real publication transaction must be held regardless of native input encoding',
      );
      assertEquals(committed, false);
      hold.release();
      await write;
      assertEquals(
        (await server.query('SELECT event FROM feed WHERE room=?', [room])).map(
          (row) => row.event,
        ),
        ['$held'],
      );
    } finally {
      hold.release();
      await write;
      hold.restore();
      await store.close();
      await Deno.remove(dir, { recursive: true });
    }
  });

  Deno.test(`publication observer: ${encoding} fault rejects the real transaction and rolls back its feed`, async () => {
    const dir = await Deno.makeTempDir();
    const store = await openStore({
      dir,
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 300,
    }, { schemas: { server: serverSchema } });
    const server = await store.server();
    const room = '!fault:test';
    let observed = 0;
    const restore = observePublication({ server }, room, async (tx) => {
      assertEquals(
        (await tx.query('SELECT event FROM feed WHERE room=?', [room])).map(
          (row) => row.event,
        ),
        ['$held'],
      );
      observed++;
      throw new Error('native publication fault');
    });
    try {
      await assertRejects(
        () => server.tx((tx) => writeFeed(tx, encoding, room)),
        Error,
        'native publication fault',
      );
      assertEquals(observed, 1);
      assertEquals(await server.query('SELECT event FROM feed'), []);
      restore();
      await server.tx((tx) => writeFeed(tx, encoding, room));
      assertEquals(
        (await server.query('SELECT event FROM feed WHERE room=?', [room])).map(
          (row) => row.event,
        ),
        ['$held'],
      );
    } finally {
      restore();
      await store.close();
      await Deno.remove(dir, { recursive: true });
    }
  });
}
