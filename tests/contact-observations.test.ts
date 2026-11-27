import { assertEquals, assertRejects, assertThrows } from '@std/assert';
import { ContactObservations } from '#engine/federation/pending-contacts.ts';
import { Capacity } from '#engine/store/capacity.ts';
import {
  StorageBusyError,
  StoragePressureError,
} from '#engine/store/pressure.ts';

Deno.test('contact observations merge exact maxima across overlapping drain and independent keys', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const following = Promise.withResolvers<void>();
  const releaseFollowing = Promise.withResolvers<void>();
  const independent = Promise.withResolvers<void>();
  const writes: [string, number][] = [];
  const contacts = new ContactObservations<number>(async (key, value) => {
    writes.push([key, value]);
    if (key === 'other') independent.resolve();
    else if (writes.filter(([key]) => key === 'home').length === 1) {
      entered.resolve();
      await release.promise;
    } else if (value === 900) {
      following.resolve();
      await releaseFollowing.promise;
    }
  }, Math.max);
  try {
    contacts.observe('home', 200);
    await entered.promise;
    contacts.observe('home', 900);
    contacts.observe('home', 300);
    contacts.observe('other', 100);
    await independent.promise;
    const drained = contacts.drain();
    release.resolve();
    await following.promise;
    contacts.observe('home', 1000);
    contacts.observe('home', 800);
    releaseFollowing.resolve();
    await drained;
    assertEquals(writes.filter(([key]) => key === 'home'), [
      ['home', 200],
      ['home', 900],
      ['home', 1000],
    ]);
    assertEquals(writes.filter(([key]) => key === 'other'), [['other', 100]]);
    await contacts.close();
    assertThrows(() => contacts.observe('home', 2000), Error, 'closing');
  } finally {
    release.resolve();
    releaseFollowing.resolve();
    await contacts.close();
  }
});

Deno.test('contact observations resume after a capacity grant releases and close cleanly when full', async () => {
  const dir = await Deno.makeTempDir();
  const budget = 256 * 1024;
  const capacity = new Capacity([dir], budget);
  // Both known footprints fit separately, but not simultaneously.
  const held = await capacity.reserveNative(dir, 2, 192 * 1024, false);
  const started = Promise.withResolvers<void>();
  const persisted: number[] = [];
  const reported: unknown[] = [];
  const contacts = new ContactObservations<number>(
    async (_key, value) => {
      started.resolve();
      const grant = await capacity.reserveNative(dir, 2, 32 * 1024);
      persisted.push(value);
      grant.release();
    },
    Math.max,
    (error) => reported.push(error),
  );
  try {
    contacts.observe('edge', 1);
    await started.promise;
    assertEquals(persisted, []);
    held.release();
    await contacts.drain();
    assertEquals(persisted, [1]);
    assertEquals(reported, []);
    const filler = `${dir}/filler`;
    await Deno.writeFile(filler, new Uint8Array(budget).fill(1));
    await capacity.status();
    contacts.observe('edge', 2);
    const error = await assertRejects(
      () => contacts.drain(),
      StoragePressureError,
    );
    assertEquals(error instanceof StorageBusyError, false);
    assertEquals(reported, [error]);
    await capacity.remove(filler);
    contacts.observe('edge', 3);
    await contacts.drain();
    assertEquals(persisted, [1, 3]);
    await Deno.writeFile(filler, new Uint8Array(budget).fill(1));
    await capacity.status();
    contacts.observe('edge', 4);
    await contacts.close();
    assertEquals(persisted, [1, 3]);
    assertEquals(reported.length, 2);
  } finally {
    held.release();
    await contacts.close();
    await Deno.remove(dir, { recursive: true });
  }
});
