// Explicit dependency for fixtures consuming raw projections or driving an
// asynchronous worker. HTTP send helpers deliberately retain acceptance only.
import { openRoom } from '#engine/room/index.ts';
import { completionService } from '#engine/server/completion.ts';
import type { Store } from '#engine/store/index.ts';
import type { Tenant } from '#engine/tenant/index.ts';

export async function completeAccepted(
  owner: { store: Store; tenant: Tenant },
  roomId: string,
  eventId?: string,
): Promise<void> {
  await completeRoomCut(owner.store, owner.tenant.serverName, roomId, eventId);
}

// The same exact obligation for store-level fixtures without a tenant.
export async function completeRoomCut(
  store: Store,
  self: string,
  roomId: string,
  eventId?: string,
): Promise<void> {
  const room = await openRoom(store, roomId);
  const target = await room.tx((tx) =>
    eventId === undefined
      ? tx.completion.capture()
      : tx.completion.receipt(eventId)
  );
  if (target === null) {
    throw new Error('accepted fixture event has no completion receipt');
  }
  await completionService(store).complete(room, self, target);
}
