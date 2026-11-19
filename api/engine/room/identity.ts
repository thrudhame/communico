// Room identity has two wire forms. Inventories can validate its shape without
// room state; event consumers additionally bind v12 creates to their reference.
import { eventIdFor } from '#engine/eventid.ts';
import { splitId, validEventUserId } from '#engine/ids.ts';
import type { Pdu } from '#engine/pdu.ts';
import { getRulebook } from '#engine/rulebook/index.ts';

export function validRoomId(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith('!')) return false;
  const { localpart, server } = splitId(value);
  return server === null
    ? value.length === 44 && /^![A-Za-z0-9_-]{43}$/.test(value)
    : localpart.length > 0 && validEventUserId('@' + value.slice(1));
}

/** Stored creates retain their derived event_id, but v12 omits room_id. Never
 * trust that stored annotation as the create's reference hash. */
export async function eventRoomId(pdu: Pdu): Promise<string | undefined> {
  if (pdu.type === 'm.room.create') {
    const version = pdu.content?.room_version;
    if (getRulebook(version).spec.roomIdFromCreateEvent) {
      if (Object.hasOwn(pdu, 'room_id')) return undefined;
      const id = await eventIdFor(
        pdu as unknown as Record<string, unknown>,
        String(version),
      );
      const room = '!' + id.slice(1);
      return validRoomId(room) ? room : undefined;
    }
  }
  return validRoomId(pdu.room_id) ? pdu.room_id : undefined;
}
