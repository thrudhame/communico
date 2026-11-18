// Capture one authenticated client's causal obligations before selecting ANY
// projected view. Transactions end before waits; only successful consumers retire.
import type { Store } from '#engine/store/index.ts';
import type { Tenant } from '#engine/tenant/index.ts';
import type { DeviceIdentity } from '#engine/tenant/devices.ts';
import { completionService } from '#engine/server/completion.ts';
import { openRoom } from '#engine/room/index.ts';
import type { CompletionCut } from '#engine/room/completion.ts';
import { roomsFor } from '#engine/server/read.ts';

type Owner = { store: Store; tenant: Tenant };

// The audience is the read's existing membership candidates, not every held room.
// This discovers dependencies only; ordinary visibility/selection still decides
// what the consumer may disclose after the barrier.
export async function completionAudience(owner: Owner, userId: string) {
  return (await roomsFor(await owner.store.server(), userId))
    .filter((room) => !room.forgotten)
    .map((room) => room.roomId);
}

async function roomCuts(owner: Owner, roomIds: readonly string[]) {
  return (await Promise.all([...new Set(roomIds)].map(async (roomId) => {
    let room;
    try {
      room = await openRoom(owner.store, roomId);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return null;
      throw error;
    }
    return await room.tx((tx) => tx.completion.accepted());
  }))).filter((cut): cut is CompletionCut => cut !== null);
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

// Capture accepted cuts once before waiting or selecting projected results. A
// later write cannot extend this read; missing rooms retain normal 403/404 rules.
export async function roomCompletion(
  owner: Owner,
  rooms: readonly string[],
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  await published(owner, await roomCuts(owner, rooms), signal);
}

export async function clientCompletion(
  owner: Owner,
  device: DeviceIdentity | null,
  signal?: AbortSignal,
  rooms: readonly string[] = [],
): Promise<{ retire(): Promise<void> }> {
  signal?.throwIfAborted();
  const captured = device === null
    ? []
    : await owner.tenant.tx((tx) => tx.completion.pending(device));
  await published(
    owner,
    [...captured, ...await roomCuts(owner, rooms)],
    signal,
  );
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
