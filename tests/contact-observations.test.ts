import { assertEquals, assertThrows } from '@std/assert';
import { ContactObservations } from '#engine/federation/pending-contacts.ts';

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
