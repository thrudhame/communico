// The old answer-from-held profile lookup. Public requests never dial a peer.
import { openRoom } from '#engine/room/index.ts';
import { roomsFor } from '#engine/server/read.ts';
import type { Database } from '#engine/store/db.ts';
import type { Store } from '#engine/store/index.ts';
import { pduAt } from './room.ts';

export type { Profile } from '#engine/tenant/profiles.ts';
import type { Profile } from '#engine/tenant/profiles.ts';

export async function remoteUserFromMembers(
  userId: string,
  deps: { store: Store; server: Database },
): Promise<Profile | null> {
  const memberships = (await roomsFor(deps.server, userId)).sort((a, b) =>
    a.roomId.localeCompare(b.roomId)
  );
  for (const membership of memberships) {
    const room = await openRoom(deps.store, membership.roomId);
    const pdu = await room.tx((tx) => pduAt(tx, membership.eventId));
    if (pdu === null) continue;
    const profile: Profile = {};
    if (typeof pdu.content?.displayname === 'string') {
      profile.displayname = pdu.content.displayname;
    }
    if (typeof pdu.content?.avatar_url === 'string') {
      profile.avatar_url = pdu.content.avatar_url;
    }
    return profile;
  }
  return null;
}
