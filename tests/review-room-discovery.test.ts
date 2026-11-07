import { assertEquals, assertRejects } from '@std/assert';
import { dirname, join } from '@std/path';
import { startHttp } from '#tests/http-app.ts';
import { genesis } from '#tests/fixtures/genesis.ts';
import { registerRoom } from '#engine/server/registry.ts';
import {
  listOperatorRooms,
  purgeOperatorRooms,
} from '#engine/room/operator.ts';

Deno.test('review discovery: an absent database is skipped without creating an empty file', async () => {
  const http = await startHttp();
  try {
    const g = await genesis(http.app.store, { roomId: '!healthy:test' });
    const db = await http.app.store.room(g.roomId);
    const absent = join(dirname(dirname(db.path)), 'empty');
    await Deno.mkdir(absent);
    assertEquals(await http.app.store.rooms(), [g.roomId]);
    await assertRejects(
      () => Deno.stat(join(absent, 'data.db')),
      Deno.errors.NotFound,
    );
  } finally {
    await http.close();
  }
});

Deno.test('review discovery: one stale registry entry cannot break offered listing or purge', async () => {
  const http = await startHttp();
  try {
    const app = http.app;
    const g = await genesis(app.store, { roomId: '!healthy:test' });
    await registerRoom(app.store, g.roomId);
    await registerRoom(app.store, '!absent:test');
    for (const id of [g.roomId, '!absent:test']) {
      await app.server.execute(
        'INSERT INTO directory(room_id,purgeable_ms) VALUES(?,?)',
        [id, 1],
      );
    }
    assertEquals((await listOperatorRooms(app, false)).map((r) => r.room_id), [
      g.roomId,
    ]);
    assertEquals((await purgeOperatorRooms(app, null)).map((r) => r.room_id), [
      g.roomId,
    ]);
    await assertRejects(() => app.store.room(g.roomId), Deno.errors.NotFound);
    assertEquals(await app.server.query('SELECT room_id FROM rooms'), [{
      room_id: '!absent:test',
    }]);
  } finally {
    await http.close();
  }
});
