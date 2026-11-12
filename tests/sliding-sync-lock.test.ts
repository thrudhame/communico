import { assertEquals, assertRejects } from '@std/assert';
import type { Tenant } from '#engine/tenant/index.ts';
import type { DeviceIdentity } from '#engine/tenant/devices.ts';
import { withSlidingConnection } from '#engine/sliding-sync/lock.ts';

const device: DeviceIdentity = {
  localpart: 'alice',
  deviceId: 'PHONE',
  generation: 1,
};

Deno.test('connection lock serializes one owner without blocking independent SDK connections', async () => {
  const tenant = {} as Tenant;
  const gate = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const seen: string[] = [];
  const first = withSlidingConnection(
    tenant,
    device,
    'room-list',
    undefined,
    async () => {
      seen.push('first');
      started.resolve();
      await gate.promise;
      seen.push('released');
    },
  );
  await started.promise;
  const second = withSlidingConnection(
    tenant,
    device,
    'room-list',
    undefined,
    () => {
      seen.push('second');
      return Promise.resolve();
    },
  );
  await withSlidingConnection(tenant, device, 'encryption', undefined, () => {
    seen.push('independent');
    return Promise.resolve();
  });
  await withSlidingConnection(
    tenant,
    { ...device, generation: 2 },
    'room-list',
    undefined,
    () => {
      seen.push('incarnation');
      return Promise.resolve();
    },
  );
  await withSlidingConnection(
    {} as Tenant,
    device,
    'room-list',
    undefined,
    () => {
      seen.push('tenant');
      return Promise.resolve();
    },
  );
  assertEquals(seen, ['first', 'independent', 'incarnation', 'tenant']);
  gate.resolve();
  await Promise.all([first, second]);
  assertEquals(seen.slice(-2), ['released', 'second']);
});

Deno.test('queued cancellation is immediate but cannot let a later request barge past its active predecessor', async () => {
  const tenant = {} as Tenant;
  const gate = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const first = withSlidingConnection(
    tenant,
    device,
    '',
    undefined,
    async () => {
      started.resolve();
      await gate.promise;
    },
  );
  await started.promise;
  const abort = new AbortController();
  let cancelledRan = false, laterRan = false;
  const cancelled = withSlidingConnection(
    tenant,
    device,
    '',
    abort.signal,
    () => {
      cancelledRan = true;
      return Promise.resolve();
    },
  );
  abort.abort(new Error('queued-abort'));
  await assertRejects(() => cancelled, Error, 'queued-abort');
  const later = withSlidingConnection(tenant, device, '', undefined, () => {
    laterRan = true;
    return Promise.resolve();
  });
  await Promise.resolve();
  await Promise.resolve();
  assertEquals(cancelledRan, false);
  assertEquals(laterRan, false);
  gate.resolve();
  await Promise.all([first, later]);
  assertEquals(laterRan, true);
});

Deno.test('connection lock releases after failure and refuses already aborted work', async () => {
  const tenant = {} as Tenant;
  await assertRejects(
    () =>
      withSlidingConnection(tenant, device, 'a', undefined, () => {
        throw new Error('render-failed');
      }),
    Error,
    'render-failed',
  );
  assertEquals(
    await withSlidingConnection(
      tenant,
      device,
      'a',
      undefined,
      () => Promise.resolve('next'),
    ),
    'next',
  );
  const abort = new AbortController();
  abort.abort(new Error('early-abort'));
  let ran = false;
  await assertRejects(
    () =>
      withSlidingConnection(tenant, device, 'a', abort.signal, () => {
        ran = true;
        return Promise.resolve();
      }),
    Error,
    'early-abort',
  );
  assertEquals(ran, false);
});
