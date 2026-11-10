import { theApp } from '#engine/app.ts';
import { serverName } from '#engine/config.ts';
import { currentSnapshot } from '#engine/federation/room.ts';
import { productionFetcher } from '#engine/federation/fetcher.ts';
import { productionKeyResolver } from '#engine/federation/keyresolver.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { searchTimestamp } from '#engine/room/timestamp-search.ts';
import type { TimestampQuery } from '#engine/room/timestamp.ts';
import { membershipOf } from '#engine/server/read.ts';
import { requireRoom } from './room.ts';
import { canSeeEventAt } from './visibility.ts';

export async function timestampToEvent(
  user: string,
  roomId: string,
  query: TimestampQuery,
) {
  const app = theApp(), room = await requireRoom(roomId);
  const member = await membershipOf(app.server, roomId, user);
  if (member?.forgotten) {
    throw new MatrixError(403, 'M_FORBIDDEN', 'room forgotten');
  }
  if (member === null || member.membership === 'knock') {
    const worldReadable = await room.tx(async (tx) => {
      const snapshot = await currentSnapshot(tx);
      const id = snapshot.state.get('m.room.history_visibility\0');
      const row = id === undefined ? null : await tx.events.get(id);
      return row !== null &&
        JSON.parse(row.pdu).content?.history_visibility === 'world_readable';
    });
    if (!worldReadable) {
      throw new MatrixError(403, 'M_FORBIDDEN', 'not a member');
    }
  }
  const signer = app.tenant.signer();
  const hit = await searchTimestamp(
    room,
    query,
    (tx, id) => canSeeEventAt(user, tx, id),
    {
      self: serverName(),
      fetcher: productionFetcher(app.server, signer, app.store),
      keys: productionKeyResolver(app.server, signer),
    },
  );
  if (hit === null) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'no visible event at timestamp');
  }
  return hit;
}
