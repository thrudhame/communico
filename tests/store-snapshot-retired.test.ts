import { assertEquals } from '@std/assert';
import { openStore } from '#engine/store/index.ts';
import { keyFor } from '#engine/store/layout.ts';

Deno.test('store snapshot: retired final files remain in the captured crash-consistent set', async () => {
  const root = await Deno.makeTempDir();
  const store = await openStore({
    dir: root + '/live',
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 2,
    idleseconds: 60,
  });
  try {
    await store.room('!retired:test', { create: true });
    await store.retireRoom('!retired:test');
    const cut = await store.snapshot(root + '/backup');
    assertEquals(
      cut.files.map((file) => file.id).sort(),
      ['!retired:test', null].sort(),
    );
    assertEquals(
      (await Deno.stat(
        root + '/backup/rooms/' + await keyFor('!retired:test') + '/data.db',
      )).isFile,
      true,
    );
  } finally {
    await store.close();
    await Deno.remove(root, { recursive: true });
  }
});
