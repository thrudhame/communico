// tests/room-lock.test.ts — R13: the per-room mutation lock serializes
// per room id, runs different rooms concurrently, and releases on throw.
import { assertEquals } from '@std/assert';
import { withRoomLock } from '#engine/room/lock.ts';

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

Deno.test('room lock: mutations of one room serialize in acquisition order', async () => {
  const order: string[] = [];
  const ops = Array.from(
    { length: 8 },
    (_, i) =>
      withRoomLock('!r:test', async () => {
        order.push(`start-${i}`);
        await tick();
        order.push(`end-${i}`);
      }),
  );
  await Promise.all(ops);
  // Strictly nested/serial: every start is immediately followed by its end.
  const expected: string[] = [];
  for (let i = 0; i < 8; i++) expected.push(`start-${i}`, `end-${i}`);
  assertEquals(order, expected);
});

Deno.test('room lock: different rooms run concurrently', async () => {
  const order: string[] = [];
  await Promise.all([
    withRoomLock('!a:test', async () => {
      order.push('a-start');
      await tick();
      await tick();
      order.push('a-end');
    }),
    withRoomLock('!b:test', async () => {
      order.push('b-start');
      await tick();
      order.push('b-end');
    }),
  ]);
  // b finished before a — the two locks did not serialize.
  assertEquals(order, ['a-start', 'b-start', 'b-end', 'a-end']);
});

Deno.test('room lock: a throw releases the lock for the next mutation', async () => {
  await withRoomLock('!r:test', () => {
    throw new Error('boom');
  }).then(
    () => {
      throw new Error('expected a rejection');
    },
    (error) => assertEquals(String(error), 'Error: boom'),
  );
  const ran = await withRoomLock('!r:test', () => Promise.resolve('acquired'));
  assertEquals(ran, 'acquired');
});
