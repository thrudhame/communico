import { assert, assertEquals, assertRejects } from '@std/assert';
import { openStore } from '#engine/store/index.ts';

Deno.test('store drain: every creation entry point closes while existing owner capabilities finish', async (t) => {
  const root = await Deno.makeTempDir({ prefix: 'store-drain-admission-' });
  const store = await openStore({
    dir: root + '/live',
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 4,
    idleseconds: 300,
  });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let closing: Promise<void> | undefined;
  try {
    const room = await store.room('!owned:test', { create: true });
    await room.exec(
      'CREATE TABLE owned(n INTEGER); INSERT INTO owned VALUES(1)',
    );
    store.onDrain(async () => {
      entered.resolve();
      await release.promise;
      const held = await store.room('!owned:test');
      await held.execute('INSERT INTO owned VALUES(2)');
    });
    let closed = false;
    closing = store.close().then(() => {
      closed = true;
    });
    await entered.promise;
    const attempts = [
      ['room', () => store.room('!new:test', { create: true })],
      ['tenant', () => store.tenant('new.test', { create: true })],
      ['lease', async () => {
        const lease = await store.leaseRoom('!leased:test', { create: true });
        await lease.release();
      }],
      [
        'initialize',
        () =>
          store.initializeRoom('!initialized:test', () => Promise.resolve()),
      ],
    ] as const;
    for (const [name, attempt] of attempts) {
      await t.step(name, async () => {
        await assertRejects(attempt, Error, 'closed');
      });
    }
    assertEquals(await room.query('SELECT n FROM owned'), [{ n: 1 }]);
    assertEquals(closed, false);
    release.resolve();
    await closing;
    assert(closed);
    await assertRejects(
      () => room.query('SELECT n FROM owned'),
      Error,
      'closed',
    );
  } finally {
    release.resolve();
    await closing;
    await store.close();
    await Deno.remove(root, { recursive: true });
  }
});
