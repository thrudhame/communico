import { assertEquals } from '@std/assert';
import { openStore } from '#engine/store/index.ts';
import { Pool } from '#engine/store/pool.ts';

Deno.test('store shutdown drains an accepted removal outside transaction admission', async () => {
  const root = await Deno.makeTempDir();
  const store = await openStore({
    dir: root + '/live',
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 2,
    idleseconds: 3600,
  });
  await store.room('!removing:test', { create: true });
  const remove = Pool.prototype.remove;
  let entered!: () => void, resume!: () => void;
  const started = new Promise<void>((resolve) => entered = resolve);
  const held = new Promise<void>((resolve) => resume = resolve);
  Pool.prototype.remove = async function (...args) {
    entered();
    await held;
    await remove.apply(this, args);
  };
  let removal: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  try {
    removal = store.removeRoom('!removing:test');
    await started;
    let closed = false;
    closing = store.close().then(() => {
      closed = true;
    });
    await Promise.race([
      closing,
      new Promise((resolve) => setTimeout(resolve, 30)),
    ]);
    assertEquals(
      closed,
      false,
      'store closed before its accepted lifecycle operation drained',
    );
    resume();
    await removal;
    await closing;
  } finally {
    resume();
    await Promise.allSettled([removal, closing]);
    Pool.prototype.remove = remove;
    await store.close();
    await Deno.remove(root, { recursive: true });
  }
});
