import { assert, assertEquals, assertRejects } from '@std/assert';
import {
  type CacheIdentity,
  type CachePolicy,
  MediaCache,
  mediaCacheKey,
} from '#engine/media/cache.ts';
import { listCachedMedia } from '#engine/server/media.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openStore } from '#engine/store/index.ts';

Deno.test('media cache: v20 upgrade preserves server truth and adds only the cache owner', async () => {
  const root = await Deno.makeTempDir({ prefix: 'media-cache-upgrade-' });
  const settings = {
    dir: root,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  const oldSchema = {
    version: 20,
    apply: async (db: Parameters<typeof serverSchema.apply>[0]) => {
      await serverSchema.apply(db);
      await db.exec('DROP TABLE media_cache');
    },
  };
  let store = await openStore(settings, { schemas: { server: oldSchema } });
  try {
    await (await store.server()).execute(
      "INSERT INTO counters(name,value) VALUES('media-test-preserved',42)",
    );
    await store.close();
    store = await openStore(settings, { schemas: { server: serverSchema } });
    const db = await store.server();
    assertEquals(
      await db.query(
        "SELECT value FROM counters WHERE name='media-test-preserved'",
      ),
      [{ value: 42 }],
    );
    assertEquals(await listCachedMedia(db), []);
  } finally {
    await store.close();
    await Deno.remove(root, { recursive: true });
  }
});

const identity = (origin = 'a.test', variant = 'original'): CacheIdentity => ({
  origin,
  mediaId: 'media',
  variant,
  scope: variant === 'original' ? 'remote' : 'thumbnail',
});
const disabled: CachePolicy = {
  maxbytes: 0,
  remote: { maxagedays: 0, unopenedday: 0, maxbytes: 0 },
  thumbnail: { maxagedays: 0, unopenedday: 0, maxbytes: 0 },
};
const producer = async (out: WritableStream<Uint8Array>) => {
  const w = out.getWriter();
  await w.write(new Uint8Array([1, 2, 3]));
  await w.close();
  return { contentType: 'image/png', filename: 'a.png', size: 3 };
};
async function fixture(
  fn: (
    cache: MediaCache,
    db: Awaited<ReturnType<Awaited<ReturnType<typeof openStore>>['server']>>,
    root: string,
  ) => Promise<void>,
) {
  const root = await Deno.makeTempDir({ prefix: 'media-cache-' });
  const store = await openStore({
    dir: root + '/store',
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { server: serverSchema } });
  const db = await store.server();
  const cache = new MediaCache(db, root);
  await cache.start();
  try {
    await fn(cache, db, root);
  } finally {
    await cache.close();
    await store.close();
    await Deno.remove(root, { recursive: true });
  }
}
Deno.test('media cache: concurrent same-key requests deduplicate; origins and variants never collide', async () => {
  await fixture(async (cache, db) => {
    let calls = 0;
    const fetch = () =>
      cache.fetch(identity(), 2, async (out) => {
        calls++;
        await new Promise((r) => setTimeout(r, 10));
        return await producer(out);
      });
    const [a, b] = await Promise.all([fetch(), fetch()]);
    assertEquals(a.blob, b.blob);
    assertEquals(calls, 1);
    assertEquals(
      new Uint8Array(await new Response(await cache.open(a)).arrayBuffer()),
      new Uint8Array([1, 2, 3]),
    );
    await cache.fetch(identity('b.test'), 2, producer);
    await cache.fetch(identity('a.test', 'scale:10:10:png:false'), 2, producer);
    assertEquals((await listCachedMedia(db)).length, 3);
    assert(
      (await mediaCacheKey(identity())) !==
        (await mediaCacheKey(identity('b.test'))),
    );
  });
});
Deno.test('media cache: malformed/truncated producers and byte mismatch leave no usable metadata or partial file', async () => {
  await fixture(async (cache, db) => {
    await assertRejects(() =>
      cache.fetch(identity(), 1, async (out) => {
        await producer(out);
        throw new Error('truncated envelope');
      })
    );
    await assertRejects(() =>
      cache.fetch(
        identity(),
        1,
        async (out) => ({ ...await producer(out), size: 4 }),
      )
    );
    assertEquals(await listCachedMedia(db), []);
    assertEquals([...Deno.readDirSync(cache.directory)], []);
  });
});
Deno.test('media cache: off by default; LRU/age/scope cleanup cannot unlink a live serving lease', async () => {
  await fixture(async (cache, db) => {
    const a = await cache.fetch(identity(), 1, producer);
    const b = await cache.fetch(
      identity('b.test', 'crop:1:1:png:false'),
      1,
      producer,
    );
    const stream = await cache.open(a);
    await cache.cleanup(disabled, Date.now() + 1000 * 86400000);
    assertEquals((await listCachedMedia(db)).length, 2);
    await cache.cleanup({ ...disabled, maxbytes: 1 });
    assertEquals((await listCachedMedia(db)).map((r) => r.blob), [a.blob]);
    assertEquals((await Deno.stat(cache.directory + '/' + a.blob)).size, 3);
    await stream.cancel();
    await cache.cleanup({
      ...disabled,
      remote: { ...disabled.remote, maxagedays: 1 },
    }, Date.now() + 2 * 86400000);
    assertEquals(await listCachedMedia(db), []);
    await assertRejects(() => Deno.stat(cache.directory + '/' + b.blob));
  });
});
Deno.test('media cache: restart removes partial/orphan/missing records without touching uploads', async () => {
  await fixture(async (cache, db, root) => {
    const row = await cache.fetch(identity(), 1, producer);
    await Deno.remove(cache.directory + '/' + row.blob);
    const stem = await mediaCacheKey(identity('orphan.test')) + '-' +
      crypto.randomUUID();
    await Deno.writeFile(
      cache.directory + '/' + stem + '.part',
      new Uint8Array([1]),
    );
    await Deno.writeFile(
      cache.directory + '/' + stem + '.blob',
      new Uint8Array([1]),
    );
    await Deno.writeTextFile(root + '/local-upload', 'leave me');
    await cache.close();
    const reopened = new MediaCache(db, root);
    await reopened.start();
    try {
      assertEquals(await listCachedMedia(db), []);
      assertEquals([...Deno.readDirSync(cache.directory)], []);
      assertEquals(await Deno.readTextFile(root + '/local-upload'), 'leave me');
    } finally {
      await reopened.close();
    }
  });
});
Deno.test('media cache: distinct downloads obey the shared concurrency limit and shutdown aborts work', async () => {
  await fixture(async (cache) => {
    let active = 0, peak = 0;
    await Promise.all(
      Array.from(
        { length: 6 },
        (_, i) =>
          cache.fetch(identity(i + '.test'), 2, async (out) => {
            active++;
            peak = Math.max(peak, active);
            await new Promise((r) => setTimeout(r, 10));
            const m = await producer(out);
            active--;
            return m;
          }),
      ),
    );
    assertEquals(peak, 2);
    let began!: () => void;
    const ready = new Promise<void>((r) => began = r);
    const pending = cache.fetch(identity('cancel.test'), 1, (_out, signal) => {
      began();
      return new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        })
      );
    });
    const rejected = assertRejects(() => pending);
    await ready;
    await cache.close();
    await rejected;
  });
});

Deno.test('media cache: one disconnected subscriber cannot cancel another; last subscriber closes the owned transfer', async () => {
  await fixture(async (cache) => {
    const a = new AbortController(), b = new AbortController();
    let cancelled = false;
    let began!: () => void;
    const ready = new Promise<void>((resolve) => began = resolve);
    const work = (_out: WritableStream<Uint8Array>, signal: AbortSignal) => {
      began();
      return new Promise<never>((_resolve, reject) =>
        signal.addEventListener('abort', () => {
          cancelled = true;
          reject(signal.reason);
        }, { once: true })
      );
    };
    const first = cache.fetch(identity(), 1, work, a.signal);
    const second = cache.fetch(identity(), 1, work, b.signal);
    const rejected = Promise.all([
      assertRejects(() => first),
      assertRejects(() => second),
    ]);
    await ready;
    a.abort();
    await new Promise((r) => setTimeout(r, 10));
    assertEquals(cancelled, false);
    b.abort();
    await new Promise((r) => setTimeout(r, 10));
    try {
      assertEquals(cancelled, true);
    } finally {
      await cache.close();
      await rejected;
    }
  });
});
