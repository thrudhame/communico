import { assertEquals, assertRejects } from '@std/assert';
import { Admission } from '#engine/store/admission.ts';

function latch() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => release = resolve);
  return { wait, release };
}

Deno.test('store admission: common cut drains admitted operations and fences successors', async () => {
  const gate = new Admission();
  const held = latch(), ready = latch(), paused = latch(), resume = latch();
  const order: string[] = [];
  const first = gate.run(async () => {
    ready.release();
    await held.wait;
    order.push('first');
  });
  await ready.wait;
  const cut = gate.exclusive(async () => {
    order.push('cut');
    paused.release();
    await resume.wait;
  });
  // Allow exclusive admission to close before asking for the successor.
  await Promise.resolve();
  const second = gate.run(() => {
    order.push('second');
    return Promise.resolve();
  });
  assertEquals(order, []);
  held.release();
  await paused.wait;
  assertEquals(order, ['first', 'cut']);
  resume.release();
  await Promise.all([first, cut, second]);
  assertEquals(order, ['first', 'cut', 'second']);
});

Deno.test('store admission: draining waits for completion of the admitted transaction', async () => {
  const gate = new Admission(), held = latch(), ready = latch();
  let completed = false, captured = false;
  const first = gate.run(async () => {
    ready.release();
    await held.wait;
    completed = true;
  });
  await ready.wait;
  const snapshot = gate.exclusive(() => {
    captured = true;
    return Promise.resolve();
  });
  await Promise.resolve();
  assertEquals(captured, false);
  assertEquals(completed, false);
  held.release();
  await Promise.all([first, snapshot]);
  assertEquals(completed, true);
  assertEquals(captured, true);
  assertEquals(
    (await gate.exclusive(() => Promise.resolve(42))).value,
    42,
  );
});

Deno.test('store admission: failed snapshot releases admission and serializes the next cut', async () => {
  const gate = new Admission(), paused = latch(), finish = latch();
  const order: string[] = [];
  const failed = gate.exclusive(async () => {
    order.push('first');
    paused.release();
    await finish.wait;
    throw new Error('snapshot failed');
  });
  const checked = assertRejects(() => failed, Error, 'snapshot failed');
  await paused.wait;
  const next = gate.exclusive(() => {
    order.push('next');
    return Promise.resolve();
  });
  assertEquals(order, ['first']);
  finish.release();
  await Promise.all([checked, next]);
  assertEquals(order, ['first', 'next']);
  await gate.run(() => {
    order.push('writer');
    return Promise.resolve();
  });
  assertEquals(order, ['first', 'next', 'writer']);
});
