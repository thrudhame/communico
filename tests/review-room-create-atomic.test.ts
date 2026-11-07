import { assertEquals, assertRejects } from '@std/assert';
import { createRoom } from '#engine/room/create.ts';
import { roomSchema } from '#engine/room/index.ts';
import { openStore } from '#engine/store/index.ts';
import { testSigner } from './fixtures/signer.ts';

async function roomDirectories(root: string): Promise<string[]> {
  try {
    return (await Array.fromAsync(Deno.readDir(root + '/rooms')))
      .map((entry) => entry.name).sort();
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
}

for (
  const field of ['power_level_content_override', 'initial_state'] as const
) {
  Deno.test(`creation atomicity: invalid ${field} writes no room and never signs`, async () => {
    const dir = await Deno.makeTempDir();
    const store = await openStore({
      dir,
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 300,
    }, { schemas: { room: roomSchema } });
    try {
      const signer = await testSigner();
      let signs = 0;
      const error = await assertRejects(() =>
        createRoom(store, {
          creator: '@dev:test',
          ...(field === 'initial_state'
            ? {
              initial_state: [{ type: 'm.room.topic', content: { bad: 0.5 } }],
            }
            : { power_level_content_override: { invite: 0.5 } }),
        }, {
          ...signer,
          sign: (bytes) => {
            signs++;
            return signer.sign(bytes);
          },
        })
      );
      assertEquals(String(error).includes('canonical JSON'), true);
      assertEquals(await roomDirectories(dir), []);
      assertEquals(signs, 0);
    } finally {
      await store.close();
      await Deno.remove(dir, { recursive: true });
    }
  });
}

Deno.test('creation atomicity: late auth rejection removes the unpublished file', async () => {
  const dir = await Deno.makeTempDir();
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { room: roomSchema } });
  try {
    const signer = await testSigner();
    const error = await assertRejects(() =>
      createRoom(store, {
        creator: '@dev:test',
        initial_state: [
          { type: 'm.room.topic', content: { topic: 'first succeeds' } },
          {
            type: 'm.room.power_levels',
            content: { users: { '@dev:test': 0 } },
          },
          { type: 'm.room.topic', content: { topic: 'then forbidden' } },
        ],
      }, signer)
    );
    assertEquals(String(error).includes('E_CREATE_ROOM_REJECT'), true);
    assertEquals(await roomDirectories(dir), []);
    assertEquals(store.stats().openFiles, 0);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('creation atomicity: the sequence is invisible until it is complete', async () => {
  const dir = await Deno.makeTempDir();
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { room: roomSchema } });
  try {
    const signer = await testSigner();
    const visibleWhileSigning: string[][] = [];
    await createRoom(store, { creator: '@dev:test', name: 'complete' }, {
      ...signer,
      sign: async (bytes) => {
        visibleWhileSigning.push((await roomDirectories(dir))
          .filter((name) => !name.endsWith('.new')));
        return await signer.sign(bytes);
      },
    });
    assertEquals(
      visibleWhileSigning.every((entries) => entries.length === 0),
      true,
    );
    assertEquals((await roomDirectories(dir)).length, 1);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
