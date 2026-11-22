import { assertEquals, assertRejects } from '@std/assert';
import { openStore } from '#engine/store/index.ts';
import { advanceAll, getAll } from '#engine/store/watermark.ts';

Deno.test('watermark reads: one snapshot preserves missing, duplicate and ordered source cuts', async () => {
  const dir = await Deno.makeTempDir();
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  });
  try {
    const server = await store.server();
    const sources = Array.from({ length: 12 }, (_, i) => `source:${i}`);
    await server.tx((tx) => advanceAll(tx, sources.map((s, i) => [s, i + 1])));
    const original = server.query.bind(server);
    let statements = 0;
    server.query = (sql, args) => {
      statements++;
      return original(sql, args);
    };
    try {
      assertEquals(await getAll(server, []), []);
      assertEquals(statements, 0);
      assertEquals(await getAll(server, [...sources, 'missing', sources[0]]), [
        ...sources.map((_, i) => i + 1),
        0,
        1,
      ]);
      assertEquals(statements, 1);
      await server.execute(
        "UPDATE watermarks SET position='invalid' WHERE source=?",
        [sources[0]],
      );
      await assertRejects(
        () => getAll(server, [sources[0]]),
        Error,
        'watermark position is not numeric',
      );
    } finally {
      server.query = original;
    }
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
