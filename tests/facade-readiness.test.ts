import { assertEquals, assertRejects } from '@std/assert';
import { MatrixError } from '#engine/matrix-error.ts';
import {
  ReplicaCutPending,
  ReplicaReadiness,
} from '#engine/facade/readiness.ts';

const pairing = 'pair';
const stream = 'room:target';
const signal = () => AbortSignal.timeout(1000);
const health = {
  canDeliver: () => false,
  onDeliveryLoss: () => () => {},
};

for (const outcome of ['success', 'refusal'] as const) {
  Deno.test(`PAIR503: recheck a stale admission ${outcome}`, async () => {
    const readiness = new ReplicaReadiness(health);
    const read = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let reads = 0;
    const result = readiness.wait(
      async (observe?: (p: string, s: string) => void) => {
        observe?.(pairing, stream);
        if (++reads === 1) {
          read.resolve();
          await release.promise;
          if (outcome === 'refusal') {
            throw new MatrixError(403, 'M_FORBIDDEN', 'stale');
          }
          return 'stale';
        }
        return 'current';
      },
      signal(),
    );
    await read.promise;
    readiness.applied(pairing, stream);
    release.resolve();
    assertEquals(await result, 'current');
  });
}

Deno.test('PAIR503: only consulted dependencies can invalidate a read', async () => {
  const readiness = new ReplicaReadiness(health);
  let reads = 0;
  await assertRejects(
    () =>
      readiness.wait(async (observe?: (p: string, s: string) => void) => {
        observe?.(pairing, stream);
        if (++reads === 1) readiness.applied(pairing, 'room:unrelated');
        await Promise.resolve();
        throw new ReplicaCutPending(pairing, stream, true);
      }, signal()),
    ReplicaCutPending,
  );
  assertEquals(reads, 1);
});

Deno.test('PAIR503: alternate consulted dependency can settle an admission', async () => {
  const readiness = new ReplicaReadiness(health);
  const waiting = Promise.withResolvers<void>();
  const alternate = 'auth:alternate';
  let ready = false;
  const result = readiness.wait(
    async (observe?: (p: string, s: string) => void) => {
      observe?.(pairing, alternate);
      if (ready) return 'ready';
      await Promise.resolve();
      setTimeout(waiting.resolve, 0);
      throw new ReplicaCutPending(pairing, 'auth:first', false);
    },
    signal(),
  );
  await waiting.promise;
  ready = true;
  readiness.applied(pairing, alternate);
  assertEquals(await result, 'ready');
});

Deno.test('PAIR503: receipt in flight wins over home delivery loss', async () => {
  let canDeliver = true;
  let received = false;
  let applied = false;
  const armed = Promise.withResolvers<() => void>();
  const local = Promise.withResolvers<void>();
  const readiness = new ReplicaReadiness({
    canDeliver: () => canDeliver,
    onDeliveryLoss: (_, wake) => {
      armed.resolve(wake);
      return () => {};
    },
  });
  const result = readiness.wait(async (observe) => {
    observe(pairing, stream);
    await Promise.resolve();
    if (applied) return 'current';
    if (received) local.resolve();
    throw new ReplicaCutPending(pairing, stream, !received, 0);
  }, signal());
  const disconnect = await armed.promise;
  const settle = readiness.receiving(pairing, stream);
  canDeliver = false;
  disconnect();
  await Promise.resolve();
  received = true;
  settle();
  await local.promise;
  applied = true;
  readiness.applied(pairing, stream);
  assertEquals(await result, 'current');
});

Deno.test('PAIR503: binding replacement and terminal refusal settle local waiters', async () => {
  const readiness = new ReplicaReadiness(health);
  let current = pairing;
  const read = Promise.withResolvers<void>();
  const swapped = Promise.withResolvers<void>();
  const result = readiness.wait(async (observe) => {
    const selected = current;
    observe(selected, stream);
    await Promise.resolve();
    (selected === pairing ? read : swapped).resolve();
    throw new ReplicaCutPending(selected, stream, false, 0);
  }, signal());
  const rejected = assertRejects(() => result, ReplicaCutPending);
  await read.promise;
  readiness.refused(pairing, stream, 1); // A refusal of a different head cannot settle it.
  current = 'replacement';
  readiness.bindingChanged();
  await swapped.promise;
  readiness.refused(current, stream, 0);
  assertEquals((await rejected).pairing, current);
});
