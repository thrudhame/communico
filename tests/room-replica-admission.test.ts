import { assertEquals, assertRejects } from '@std/assert';
import {
  initializeRoom,
  openRoom,
  roomSchema,
  type RoomTx,
} from '#engine/room/index.ts';
import { openStore } from '#engine/store/index.ts';

Deno.test('room admission: invalidation inside normal and unpublished transactions rolls back their facts', async () => {
  const dir = await Deno.makeTempDir();
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { room: roomSchema } });
  try {
    let current = true;
    const admit = () => {
      if (!current) throw new Error('grant retired');
    };
    const write = async (tx: RoomTx) => {
      await tx.events.insert('$event', {
        type: 'm.room.message',
        sender: '@dev:test',
        depth: 1,
        origin_server_ts: 1,
        content: {},
        signatures: {},
        hashes: { sha256: 'unused' },
        auth_events: [],
        prev_events: [],
      });
      current = false;
    };
    const plain = await openRoom(store, '!normal:test', { create: true });
    const guarded = await openRoom(store, '!normal:test', { admit });
    await assertRejects(() => guarded.tx(write), Error, 'grant retired');
    assertEquals(await plain.tx((tx) => tx.events.get('$event')), null);
    current = true;
    await assertRejects(
      () => initializeRoom(store, '!new:test', write, admit),
      Error,
      'grant retired',
    );
    assertEquals((await store.rooms()).includes('!new:test'), false);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
