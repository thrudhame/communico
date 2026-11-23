// Capture one authenticated client's causal obligations before selecting ANY
// projected view. Transactions end before waits; only successful consumers retire.
import type { Store } from '#engine/store/index.ts';
import type { Tenant } from '#engine/tenant/index.ts';
import type { DeviceIdentity } from '#engine/tenant/devices.ts';
import { completionService } from '#engine/server/completion.ts';
import type { CompletionCut } from '#engine/room/completion.ts';
import { roomsFor } from '#engine/server/read.ts';

type Owner = { store: Store; tenant: Tenant };

// The audience is the read's existing membership candidates, not every held room.
// This selects scoped reads, not publication dependencies. Visibility still
// decides what the consumer may disclose from the applied projection.
export async function completionAudience(owner: Owner, userId: string) {
  return (await roomsFor(await owner.store.server(), userId))
    .filter((room) => !room.forgotten)
    .map((room) => room.roomId);
}

async function published(
  owner: Owner,
  targets: readonly CompletionCut[],
  signal?: AbortSignal,
) {
  const cuts = new Map<string, CompletionCut>();
  for (const target of targets) {
    const key = JSON.stringify([target.roomId, target.generation]);
    if ((cuts.get(key)?.through ?? -1) < target.through) cuts.set(key, target);
  }
  await Promise.all(
    [...cuts.values()].map((target) =>
      completionService(owner.store).wait(
        target,
        'publication',
        signal,
        owner.tenant.serverName,
      )
    ),
  );
  signal?.throwIfAborted();
}

// Only this authenticated client's exact pending sends are causal dependencies.
// Other accepted room work is not a read barrier: consumers select applied cuts
// and their notifier wakes another capture when publication advances.
export async function roomCompletion(
  owner: Owner,
  rooms: readonly string[],
  signal?: AbortSignal,
  device: DeviceIdentity | null = null,
): Promise<void> {
  signal?.throwIfAborted();
  const captured = device === null
    ? []
    : await owner.tenant.tx((tx) => tx.completion.pending(device));
  const selected = new Set(rooms);
  await published(
    owner,
    captured.filter((cut) => selected.has(cut.roomId)),
    signal,
  );
}

export async function clientCompletion(
  owner: Owner,
  device: DeviceIdentity | null,
  signal?: AbortSignal,
): Promise<{ retire(): Promise<void> }> {
  signal?.throwIfAborted();
  const captured = device === null
    ? []
    : await owner.tenant.tx((tx) => tx.completion.pending(device));
  await published(owner, captured, signal);
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
