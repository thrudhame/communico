// Creation is one room-first operation, including registry/feed consumers.
import { assertEquals, assertRejects } from '@std/assert';
import { createRoom, type CreateRoomOptions } from '#engine/room/create.ts';
import { roomSchema } from '#engine/room/index.ts';
import { listRooms } from '#engine/server/registry.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { installServerHooks } from '#engine/server/startup.ts';
import { openStore, type Store } from '#engine/store/index.ts';
import { testSigner } from './fixtures/signer.ts';

installServerHooks();

async function published(store: Store, dir: string) {
  const server = await store.server();
  let files: string[];
  try {
    files = (await Array.fromAsync(Deno.readDir(dir + '/rooms'))).map((e) =>
      e.name
    ).sort();
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    files = [];
  }
  return {
    registry: await listRooms(store),
    feed: await server.query('SELECT room, event FROM feed'),
    files,
  };
}

const invalidOptions: Record<string, Partial<CreateRoomOptions>> = {
  'invalid power levels': { power_level_content_override: { invite: 0.5 } },
  'invalid initial state': {
    initial_state: [{ type: 'm.room.topic', content: { bad: 0.5 } }],
  },
  'late auth rejection': {
    initial_state: [
      { type: 'm.room.topic', content: { topic: 'first succeeds' } },
      { type: 'm.room.power_levels', content: { users: { '@dev:test': 0 } } },
      { type: 'm.room.topic', content: { topic: 'then forbidden' } },
    ],
  },
};

for (const [name, options] of Object.entries(invalidOptions)) {
  Deno.test(`review creation: ${name} leaves no file, registry or feed, including after startup`, async () => {
    const dir = await Deno.makeTempDir();
    const config = {
      dir,
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 300,
    };
    let store = await openStore(config, {
      schemas: { room: roomSchema, server: serverSchema },
    });
    try {
      const signer = await testSigner();
      await assertRejects(() =>
        createRoom(store, { creator: '@dev:test', ...options }, signer)
      );
      assertEquals(await published(store, dir), {
        registry: [],
        feed: [],
        files: [],
      });
      await store.close();
      store = await openStore(config, {
        schemas: { room: roomSchema, server: serverSchema },
      });
      assertEquals(await published(store, dir), {
        registry: [],
        feed: [],
        files: [],
      });
    } finally {
      await store.close();
      await Deno.remove(dir, { recursive: true });
    }
  });
}

Deno.test('review creation: registration and feed follow complete initialization', async () => {
  const dir = await Deno.makeTempDir();
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { room: roomSchema, server: serverSchema } });
  try {
    const signer = await testSigner();
    let signs = 0;
    const result = await createRoom(store, {
      creator: '@dev:test',
      name: 'complete',
    }, {
      ...signer,
      sign: async (bytes) => {
        signs++;
        const state = await published(store, dir);
        assertEquals(state.registry, []);
        assertEquals(state.feed, []);
        assertEquals(state.files.filter((name) => !name.endsWith('.new')), []);
        return await signer.sign(bytes);
      },
    });
    const state = await published(store, dir);
    assertEquals(state.registry, [result.roomId]);
    assertEquals(state.files.length, 1);
    assertEquals(state.feed.length, signs);
    assertEquals(new Set(state.feed.map((row) => row.event)).size, signs);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
