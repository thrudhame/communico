import { assertEquals } from '@std/assert';
import { openStore } from '#engine/store/index.ts';
import { Pool } from '#engine/store/pool.ts';
import { drainEnrollment, watchdog } from '#tests/support/ordering.ts';

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
  const order: string[] = [];
  Pool.prototype.remove = async function (...args) {
    entered();
    await held;
    await remove.apply(this, args);
    order.push('removal-complete');
  };
  let removal: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  const drain = drainEnrollment(
    (store as unknown as { maintenance: Set<Promise<unknown>> }).maintenance,
  );
  const closePool = Pool.prototype.close;
  Pool.prototype.close = function () {
    order.push('pool-close');
    return closePool.call(this);
  };
  try {
    removal = store.removeRoom('!removing:test');
    await started;
    let closed = false;
    closing = store.close().then(() => {
      closed = true;
    });
    await watchdog(
      drain.wait,
      'store shutdown never enrolled the accepted lifecycle drain',
    );
    assertEquals(
      order,
      [],
      'native pool shutdown started before accepted removal completed',
    );
    assertEquals(
      closed,
      false,
      'store closed before its accepted lifecycle operation drained',
    );
    resume();
    await removal;
    await closing;
    assertEquals(order, ['removal-complete', 'pool-close']);
  } finally {
    resume();
    await Promise.allSettled([removal, closing]);
    drain.restore();
    Pool.prototype.remove = remove;
    Pool.prototype.close = closePool;
    await store.close();
    await Deno.remove(root, { recursive: true });
  }
});
