// Render first; publish the tenant-owned successor and inbox effects together.
import type { Tenant } from '#engine/tenant/index.ts';
import type { DeviceIdentity } from '#engine/tenant/devices.ts';
import type { PositionLease } from '#engine/tenant/sliding-sync.ts';
import type { Extensions } from './types.ts';
import { config } from '#engine/config.ts';

type Json = Record<string, unknown>;

export async function publishSlidingResponse(input: {
  tenant: Tenant;
  device: DeviceIdentity;
  lease: PositionLease;
  state: Json;
  response: Json & { extensions?: Json };
  toDevice?: Extensions['to_device'];
  signal?: AbortSignal;
}): Promise<Json> {
  const { tenant, device, lease, state, response, toDevice, signal } = input;
  signal?.throwIfAborted();
  return await tenant.tx(async (tx) => {
    signal?.throwIfAborted();
    const extensions = { ...response.extensions };
    if (toDevice?.enabled) {
      // Neither a top-level pos nor a different connection's receipt can
      // acknowledge this inbox. Lease rejection below rolls back both effects.
      await tx.toDevice.acknowledgeSliding(
        device,
        lease.connection,
        toDevice.since,
      );
      signal?.throwIfAborted();
      const page = await tx.toDevice.deliverSliding(
        device,
        lease.connection,
        toDevice.limit,
        config().e2ee,
      );
      extensions.to_device = {
        next_batch: page.nextBatch,
        events: page.events,
      };
    }
    signal?.throwIfAborted();
    const pos = await tx.slidingSync.commit(device, lease, state);
    // Abort during the final native operations must still roll back the
    // successor, acknowledgment and delivery proof before returning any body.
    signal?.throwIfAborted();
    return { ...response, pos, extensions };
  });
}
