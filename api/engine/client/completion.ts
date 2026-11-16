// Capture one authenticated client's causal obligations before selecting ANY
// projected view. Transactions end before waits; only successful consumers retire.
import type { Store } from '#engine/store/index.ts';
import type { Tenant } from '#engine/tenant/index.ts';
import type { DeviceIdentity } from '#engine/tenant/devices.ts';
import { completionService } from '#engine/server/completion.ts';

export async function clientCompletion(
  owner: { store: Store; tenant: Tenant },
  device: DeviceIdentity | null,
  signal?: AbortSignal,
): Promise<{ retire(): Promise<void> }> {
  signal?.throwIfAborted();
  const captured = device === null
    ? []
    : await owner.tenant.tx((tx) => tx.completion.pending(device));
  await Promise.all(
    captured.map((target) =>
      completionService(owner.store).wait(
        target,
        'publication',
        signal,
        owner.tenant.serverName,
      )
    ),
  );
  signal?.throwIfAborted();
  return {
    retire: async () => {
      signal?.throwIfAborted();
      if (device !== null && captured.length) {
        await owner.tenant.tx(async (tx) => {
          signal?.throwIfAborted();
          for (const target of captured) {
            await tx.completion.retire(device, target);
          }
          signal?.throwIfAborted();
        });
      }
    },
  };
}
