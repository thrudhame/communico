// Requests serialize before acquiring a durable position lease, never across
// independent room-list/encryption connections or device incarnations.
import type { Tenant } from '#engine/tenant/index.ts';
import type { DeviceIdentity } from '#engine/tenant/devices.ts';

const tenants = new WeakMap<Tenant, Map<string, Promise<void>>>();

export async function withSlidingConnection<T>(
  tenant: Tenant,
  device: DeviceIdentity,
  name: string,
  signal: AbortSignal | undefined,
  run: () => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  let locks = tenants.get(tenant);
  if (!locks) {
    locks = new Map();
    tenants.set(tenant, locks);
  }
  const key = JSON.stringify([
    device.localpart,
    device.deviceId,
    device.generation,
    name,
  ]);
  const previous = locks.get(key) ?? Promise.resolve();
  const mine = Promise.withResolvers<void>();
  const tail = previous.then(() => mine.promise);
  locks.set(key, tail);
  const aborted = Promise.withResolvers<never>();
  const abort = () => aborted.reject(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    await Promise.race([previous, aborted.promise]);
    signal?.throwIfAborted();
    signal?.removeEventListener('abort', abort);
    return await run();
  } finally {
    signal?.removeEventListener('abort', abort);
    mine.resolve();
    // A cancelled waiter still sits behind its predecessor. Deleting its tail
    // now would let a new request bypass the active predecessor's lease.
    void tail.then(() => {
      if (locks.get(key) === tail) locks.delete(key);
    });
  }
}
