import { assertEquals } from '@std/assert';
import { Turso } from '#engine/store/ffi.ts';
import { Pool } from '#engine/store/pool.ts';
import { idleTurns } from '#tests/support/pool-turn.ts';

Deno.test('pool turns: queued release precedes the chosen idle age', async () => {
  const root = await Deno.makeTempDir({ prefix: 'pool-turn-' });
  const ffi = new Turso('./.native/libturso_ffi.so');
  const { value: pool, turn } = await idleTurns(
    () =>
      new Pool(ffi, root, {
        checkpointlogbytes: 65536,
        maxopenfiles: 2,
        idleseconds: 1,
      }),
    (pool) => pool,
  );
  try {
    const lease = await pool.acquire('rooms', '!queued-release:test', {
      create: true,
    });
    const releasing = lease.release();
    await turn(1001);
    await releasing;
    assertEquals(pool.size, 0, 'queued release must precede idle aging');
  } finally {
    await pool.close();
    ffi.close();
    await Deno.remove(root, { recursive: true });
  }
});
